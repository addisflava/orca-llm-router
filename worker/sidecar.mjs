// LLM Router sidecar: a self-contained local gateway.
// It talks directly to providers with conditional routing rules, rewrites,
// model aliases, ordered fallback / retry policies, credential pools with
// limits, gateway client API keys, request logging and usage accounting.
//
// Config shape (persisted by worker/main.mjs in Orca storage 'router.config'):
//   token, providers[] (or legacy upstreams[]), routes[] (rules), aliases{},
//   defaultFallback, clientKeys[], agentProfiles[], timeoutMs, retries,
//   baseDelayMs, logBodyCapture, exposeRoutingHeaders
//
// Provider shape:
//   { name, baseUrl?, endpoints?: [{baseUrl, protocols}], protocols: [...],
//     models: [{id, description?}], keys: [{id, secretKey, enabled?, priority?,
//     weight?, limits?, forwardClientAuth?}], enabled?, pricing?, usageFetch? }
// Rule shape:
//   { id?, name, enabled?, condition?: {source, field, operator, value},
//     rewrites?: [{key, operation?, value?, match?}], model?,
//     fallback?: {mode:'off'|'retry'|'model-chain', models?, retryCount?} }

import { createServer } from 'node:http'
import { createDecipheriv, scryptSync, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const SIDECAR_MAX_BODY_BYTES = 64 * 1024 * 1024 // 64 MiB, the Orca cap
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504])
// A key-level failure: retry the same target with the next key in the pool.
const KEY_ROTATE_STATUSES = new Set([401, 403, 429])
// How long a key is skipped after it fails, so later requests keep rotating.
const KEY_COOLDOWN_MS = { 401: 300_000, 403: 300_000, 429: 60_000, 408: 30_000, 409: 30_000, 500: 30_000, 502: 30_000, 503: 30_000, 504: 30_000 }
const MAX_KEY_ATTEMPTS = 8
const DOWNSTREAM_FALLBACK_STATUSES = (s) => s >= 400 && s < 600

// ---------------------------------------------------------------------------
// Provider presets. Endpoints, protocols and default models are the same as
// Provider presets are ported from common gateway defaults.
// are mapped to the sidecar's own protocol names when a provider is created.
// ---------------------------------------------------------------------------
export const PROVIDER_PRESETS = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', capabilities: ['openai_chat_completions', 'openai_responses'], defaultModels: ['gpt-4o'], websiteUrl: 'https://openai.com/' },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', capabilities: ['anthropic_messages'], defaultModels: ['claude-sonnet-4-20250514'], websiteUrl: 'https://www.anthropic.com/' },
  { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com', capabilities: ['gemini_generate_content', 'gemini_interactions'], defaultModels: [], websiteUrl: 'https://gemini.google.com/' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', capabilities: ['openai_chat_completions', 'openai_responses'], defaultModels: [], websiteUrl: 'https://openrouter.ai/', usage: { endpoint: 'https://openrouter.ai/api/v1/credits', auth: 'provider-api-key', mapping: { meters: [
    { id: 'balance', kind: 'balance', label: 'Balance', limit: '$.data.total_credits', used: '$.data.total_usage', unit: 'USD' }
  ] } } },
  { id: 'nvidia', name: 'NVIDIA', baseUrl: 'https://integrate.api.nvidia.com/v1', capabilities: ['openai_chat_completions'], defaultModels: ['nvidia/nemotron-3-super-120b-a12b', 'nvidia/nemotron-3-ultra-550b-a55b'], websiteUrl: 'https://build.nvidia.com/models' },
  { id: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', capabilities: ['openai_chat_completions', 'openai_responses', 'anthropic_messages'], defaultModels: [], websiteUrl: 'https://opencode.ai/docs/go/', usage: { endpoint: 'https://opencode.ai/zen/go/v1/usage', auth: 'provider-api-key', mapping: { meters: [
    { id: 'opencode_go_5h', kind: 'quota', label: '5h limit', limit: 100, remaining: '100 - $.usage.rolling.percent', used: '$.usage.rolling.percent', unit: '%', window: '5h' },
    { id: 'opencode_go_weekly', kind: 'quota', label: 'Weekly limit', limit: 100, remaining: '100 - $.usage.weekly.percent', used: '$.usage.weekly.percent', unit: '%', window: 'weekly' },
    { id: 'opencode_go_monthly', kind: 'quota', label: 'Monthly limit', limit: 100, remaining: '100 - $.usage.monthly.percent', used: '$.usage.monthly.percent', unit: '%', window: 'monthly' }
  ] } } },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', capabilities: ['openai_chat_completions'], defaultModels: ['deepseek-chat'], websiteUrl: 'https://www.deepseek.com/', usage: { endpoint: 'https://api.deepseek.com/user/balance', auth: 'provider-api-key', mapping: { meters: [
    { id: 'balance', kind: 'balance', label: 'Balance', remaining: '$.balance_infos[0].total_balance', unit: '$.balance_infos[0].currency' }
  ] } } },
  { id: 'xiaomi', name: 'Xiaomi MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', capabilities: ['openai_chat_completions', 'openai_responses'], defaultModels: ['mimo-v2.5-pro', 'mimo-v2.5'], websiteUrl: 'https://platform.xiaomimimo.com/' },
  { id: 'xiaomi-token-plan-cn', name: 'Xiaomi Token Plan (China)', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', capabilities: ['openai_chat_completions', 'openai_responses'], defaultModels: ['mimo-v2.5-pro', 'mimo-v2.5'], websiteUrl: 'https://platform.xiaomimimo.com/' },
  { id: 'xiaomi-token-plan-sgp', name: 'Xiaomi Token Plan (Singapore)', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1', capabilities: ['openai_chat_completions', 'openai_responses'], defaultModels: ['mimo-v2.5-pro', 'mimo-v2.5'], websiteUrl: 'https://platform.xiaomimimo.com/' },
  { id: 'xiaomi-token-plan-ams', name: 'Xiaomi Token Plan (Europe)', baseUrl: 'https://token-plan-ams.xiaomimimo.com/v1', capabilities: ['openai_chat_completions', 'openai_responses'], defaultModels: ['mimo-v2.5-pro', 'mimo-v2.5'], websiteUrl: 'https://platform.xiaomimimo.com/' },
  { id: 'kimi-coding', name: 'Kimi Code - Coding Plan', baseUrl: 'https://api.kimi.com/coding/v1', capabilities: ['openai_chat_completions'], defaultModels: ['kimi-for-coding'], websiteUrl: 'https://www.kimi.com/code?aff=ccr' },
  { id: 'zhipu-cn-coding', name: 'Zhipu AI (China) - Coding Plan', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', capabilities: ['openai_chat_completions'], defaultModels: ['glm-5.2', 'glm-5.1', 'glm-4.7', 'glm-4.5-air'], websiteUrl: 'https://www.bigmodel.cn/' },
  { id: 'zhipu-cn-general', name: 'Zhipu AI (China) - General', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', capabilities: ['openai_chat_completions'], defaultModels: ['glm-4.5', 'glm-4.5-air'], websiteUrl: 'https://www.bigmodel.cn/' },
  { id: 'zai-global-coding', name: 'Z.AI (Global) - Coding Plan', baseUrl: 'https://api.z.ai/api/coding/paas/v4', capabilities: ['openai_chat_completions'], defaultModels: ['glm-5.2', 'glm-5.1'], websiteUrl: 'https://z.ai/' },
  { id: 'zai-global-general', name: 'Z.AI (Global) - General', baseUrl: 'https://api.z.ai/api/paas/v4', capabilities: ['openai_chat_completions'], defaultModels: ['glm-4.5', 'glm-4.5-air'], websiteUrl: 'https://z.ai/' },
  { id: 'minimax-global', name: 'MiniMax (Global)', baseUrl: 'https://api.minimax.io/v1', capabilities: ['openai_chat_completions'], defaultModels: ['MiniMax-M3'], websiteUrl: 'https://platform.minimax.io/docs' },
  { id: 'minimax-cn', name: 'MiniMax (China)', baseUrl: 'https://api.minimaxi.com/v1', capabilities: ['openai_chat_completions'], defaultModels: ['MiniMax-M3'], websiteUrl: 'https://platform.minimaxi.com/docs' },
  { id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', capabilities: ['openai_chat_completions'], defaultModels: [], websiteUrl: 'https://mistral.ai/', usage: { endpoint: 'https://api.mistral.ai/v1/billing/subscription', auth: 'provider-api-key', mapping: { meters: [
    { id: 'credit_balance', kind: 'balance', label: 'Credit balance', remaining: '$.credit_balance', unit: 'EUR' },
    { id: 'monthly_budget', kind: 'quota', label: 'Monthly budget', limit: '$.monthly_budget', unit: 'EUR', window: 'monthly' }
  ] } } },
  { id: 'moonshot', name: 'Kimi API (China)', baseUrl: 'https://api.moonshot.cn/v1', capabilities: ['openai_chat_completions'], defaultModels: ['kimi-k2.7-code'], websiteUrl: 'https://platform.kimi.com/', usage: { endpoint: 'https://api.moonshot.cn/v1/users/me/balance', auth: 'provider-api-key', mapping: { meters: [
    { id: 'balance', kind: 'balance', label: 'Balance', remaining: '$.data.available_balance', unit: 'CNY' }
  ] } } },
  { id: 'moonshot-global', name: 'Kimi API (Global)', baseUrl: 'https://api.moonshot.ai/v1', capabilities: ['openai_chat_completions'], defaultModels: ['kimi-k2.7-code'], websiteUrl: 'https://platform.kimi.ai/', usage: { endpoint: 'https://api.moonshot.ai/v1/users/me/balance', auth: 'provider-api-key', mapping: { meters: [
    { id: 'balance', kind: 'balance', label: 'Balance', remaining: '$.data.available_balance', unit: 'CNY' }
  ] } } },
  { id: 'bailian', name: 'Alibaba Bailian', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', capabilities: ['openai_chat_completions'], defaultModels: [], websiteUrl: 'https://bailian.console.aliyun.com/' },
  { id: 'siliconflow', name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', capabilities: ['openai_chat_completions'], defaultModels: [], websiteUrl: 'https://siliconflow.cn/', usage: { endpoint: 'https://api.siliconflow.cn/v1/user/info', auth: 'provider-api-key', mapping: { meters: [
    { id: 'balance', kind: 'balance', label: 'Balance', remaining: '$.data.totalBalance', unit: 'CNY' }
  ] } } },
  { id: 'qiniu-ai', name: '七牛云 AI', baseUrl: 'https://api.qnaigc.com', capabilities: ['openai_chat_completions', 'anthropic_messages'], defaultModels: [], websiteUrl: 'https://s.qiniu.com/AVjMVf' },
  { id: 'fenno', name: 'Fenno.ai', baseUrl: 'https://api.fenno.ai', capabilities: ['openai_chat_completions', 'openai_responses', 'anthropic_messages'], defaultModels: [], websiteUrl: 'https://api.fenno.ai/' },
  { id: 'infistar-ai', name: '无限星河', baseUrl: 'https://infistar.ai/v1', capabilities: ['openai_chat_completions'], defaultModels: ['gpt-4o'], websiteUrl: 'https://www.infistar.cc/' },
  { id: 'runapi', name: 'RunAPI', baseUrl: 'https://runapi.co/v1', capabilities: ['openai_chat_completions', 'openai_responses'], defaultModels: [], websiteUrl: 'https://runapi.co/' },
  { id: 'teamorouter', name: 'TeamoRouter', baseUrl: 'https://api.teamorouter.com', capabilities: ['openai_chat_completions', 'openai_responses', 'anthropic_messages'], defaultModels: [], websiteUrl: 'https://teamorouter.com/' },
  { id: 'unity2', name: 'Unity2.Ai', baseUrl: 'https://unity2.ai/v1', capabilities: ['openai_chat_completions'], defaultModels: [], websiteUrl: 'https://unity2.ai/' },
  { id: 'code0', name: 'code0.ai', baseUrl: 'https://console.code0.ai', capabilities: ['openai_chat_completions', 'openai_responses', 'anthropic_messages'], defaultModels: [], websiteUrl: 'https://code0.ai/' },
  { id: 'claudeapi', name: 'claudeapi', baseUrl: 'https://gw.claudeapi.com', capabilities: ['anthropic_messages'], defaultModels: [], websiteUrl: 'https://console.claudeapi.com/' },
  { id: 'y-api', name: 'Y-API', baseUrl: 'https://api.y-api.bestvirtualgoods.com/v1', capabilities: ['openai_chat_completions', 'anthropic_messages'], defaultModels: [], websiteUrl: 'https://y-api.bestvirtualgoods.com/' }
]

export const SUPPORTED_PROTOCOLS = ['anthropic', 'openai', 'responses', 'gemini', 'passthrough']

const LEGACY_TO_SIDECAR_PROTOCOL = {
  anthropic_messages: 'anthropic',
  openai_chat_completions: 'openai',
  openai_responses: 'responses',
  gemini_generate_content: 'gemini',
  gemini_interactions: 'gemini'
}

function mapLegacyProtocol(proto) {
  if (!proto) return 'openai'
  const normalized = String(proto).toLowerCase().replace(/[-_]/g, '_')
  if (normalized.includes('anthropic')) return 'anthropic'
  if (normalized.includes('responses')) return 'responses'
  if (normalized.includes('gemini') || normalized.includes('google')) return 'gemini'
  if (normalized.includes('openai') || normalized.includes('chat')) return 'openai'
  return LEGACY_TO_SIDECAR_PROTOCOL[proto] ?? proto
}

export function providerFromPreset(presetId, { name, apiKeySecretKey } = {}) {
  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId)
  if (!preset) return null
  const protocols = [...new Set((preset.capabilities ?? []).map(mapLegacyProtocol))]
  const endpoints = [{ baseUrl: preset.baseUrl, protocols }]
  const keys = apiKeySecretKey ? [{ id: `${preset.id}-key-1`, secretKey: apiKeySecretKey, enabled: true, priority: 0, weight: 1 }] : []
  return {
    name: name || preset.id,
    displayName: preset.name,
    baseUrl: preset.baseUrl,
    endpoints,
    protocols: protocols.length ? protocols : ['openai'],
    models: (preset.defaultModels ?? []).map((id) => ({ id })),
    keys,
    usageFetch: preset.usage
      ? { enabled: true, connectors: [{ id: preset.id, type: 'http-json', ...preset.usage }] }
      : undefined
  }
}

// ---------------------------------------------------------------------------
// Config defaults and normalization (including legacy upstreams -> providers).
// ---------------------------------------------------------------------------
export const DEFAULT_CONFIG = {
  version: 2,
  token: 'orca-router',
  providers: [],
  routes: [],
  aliases: {},
  defaultProvider: '',
  defaultModel: '',
  defaultFallback: { mode: 'retry', models: [], retryCount: 2 },
  clientKeys: [],
  // Agents route by default: an entry only exists to turn one off. The panel
  // lists Orca's own agents and writes `{ agent, name, enabled }` here.
  agentProfiles: [],
  timeoutMs: 600000,
  retries: 2,
  baseDelayMs: 200,
  logBodyCapture: 'errors',
  exposeRoutingHeaders: false,
  allowUnauthenticatedRemote: false
}

const LOG_BODY_LIMIT = 4096
const MAX_WINDOW_ENTRIES = 5000

const slug = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-')

function normalizeModelEntry(model) {
  if (typeof model === 'string') return { id: model }
  if (model && typeof model === 'object' && model.id) return { ...model, id: String(model.id) }
  return null
}

export function normalizeProvider(provider) {
  const endpoints = Array.isArray(provider.endpoints) ? provider.endpoints : null
  const baseUrl = provider.baseUrl ?? endpoints?.[0]?.baseUrl ?? ''
  const protocols = provider.protocols ?? provider.capabilities ?? []
  const keys = (provider.keys ?? []).map((key, index) => ({
    id: key.id ?? `${slug(provider.name)}-key-${index + 1}`,
    secretKey: key.secretKey,
    enabled: key.enabled !== false,
    priority: Number(key.priority ?? 0),
    weight: Number(key.weight ?? 1),
    limits: key.limits ?? {},
    ...(key.forwardClientAuth ? { forwardClientAuth: true } : {})
  }))
  const normalized = {
    name: slug(provider.name),
    displayName: provider.displayName ?? provider.name,
    baseUrl,
    endpoints: endpoints ?? (baseUrl ? [{ baseUrl, protocols: protocols.map(mapLegacyProtocol) }] : []),
    protocols: protocols.map(mapLegacyProtocol),
    models: (provider.models ?? []).map(normalizeModelEntry).filter(Boolean),
    keys,
    // A provider is active while at least one of its keys is active. The
    // provider-level flag only applies to keyless providers, so legacy
    // configs that marked a keyed provider disabled still route through it.
    enabled: keys.length ? keys.some((key) => key.enabled !== false) : provider.enabled !== false,
    pricing: provider.pricing ?? {},
    usageFetch: provider.usageFetch,
    // Most third-party Responses endpoints reject Codex's Lark-constrained
    // custom tools; only providers that explicitly opt in keep the grammar.
    supportsCustomToolGrammar: provider.supportsCustomToolGrammar === true
  }
  return normalized
}

function migrateLegacyUpstreams(upstreams) {
  const legacyBackends = [/127\.0\.0\.1:(3456|20128)/, /localhost:(3456|20128)/]
  return (upstreams ?? [])
    .filter((upstream) => !legacyBackends.some((pattern) => pattern.test(upstream.baseUrl ?? '')))
    .map((upstream) => normalizeProvider({
      name: upstream.name,
      baseUrl: upstream.baseUrl,
      protocols: upstream.protocols,
      models: [],
      keys: upstream.keys ?? []
    }))
}

function legacyMatchToCondition(match) {
  if (!match || match === '*' || match === '') return null
  if (match.startsWith('prefix:')) return { source: 'request.body', field: 'model', operator: 'starts-with', value: match.slice(7) }
  if (match.endsWith('/*')) return { source: 'request.body', field: 'model', operator: 'starts-with', value: match.slice(0, -1) }
  if (match.includes('*')) return { source: 'request.body', field: 'model', operator: 'matches', value: match }
  return { source: 'request.body', field: 'model', operator: '==', value: match }
}

function migrateOneLegacyRoute(route, index) {
  return {
    id: route.id ?? `legacy-${index + 1}`,
    name: route.name ?? route.match ?? `Legacy route ${index + 1}`,
    enabled: route.enabled !== false,
    condition: legacyMatchToCondition(route.match),
    rewrites: route.model ? [{ key: 'request.body.model', operation: 'set', value: route.model }] : [],
    fallback: route.fallback?.length ? { mode: 'model-chain', models: route.fallback, retryCount: 0 } : undefined
  }
}

export function normalizeConfig(input) {
  const source = input && typeof input === 'object' ? structuredClone(input) : {}
  let providers = source.providers ?? source.upstreams
  if (Array.isArray(source.upstreams) && !Array.isArray(source.providers)) {
    providers = migrateLegacyUpstreams(source.upstreams)
  } else if (Array.isArray(providers)) {
    providers = providers.map(normalizeProvider)
  }
  const rawRoutes = source.routes ?? []
  const routes = rawRoutes
    .map((rule, index) => rule?.match && !rule.condition ? migrateOneLegacyRoute(rule, index) : rule)
    .filter((rule) => {
      const fallbackModels = rule?.fallback?.models ?? []
      const legacyReference = rule?.id?.startsWith('legacy-') && (rule?.name === 'omniroute/*' || rule?.name === '*' || fallbackModels.some((item) => item === 'ccr' || item === 'omniroute'))
      return !legacyReference
    })
  return {
    ...structuredClone(DEFAULT_CONFIG),
    version: 2,
    token: source.token ?? DEFAULT_CONFIG.token,
    defaultProvider: source.defaultProvider ?? DEFAULT_CONFIG.defaultProvider,
    defaultModel: typeof source.defaultModel === 'string' ? source.defaultModel : DEFAULT_CONFIG.defaultModel,
    providers: providers ?? [],
    routes: routes.map((rule, index) => ({
      id: rule.id ?? `rule-${index + 1}`,
      name: rule.name ?? `Rule ${index + 1}`,
      enabled: rule.enabled !== false,
      condition: rule.condition ?? null,
      rewrites: rule.rewrites ?? (rule.rewrite ? [rule.rewrite] : []),
      fallback: rule.fallback,
      model: rule.model
    })),
    aliases: source.aliases ?? {},
    defaultFallback: source.defaultFallback ?? { mode: 'retry', models: [], retryCount: Number(source.retries ?? 2) },
    clientKeys: source.clientKeys ?? [],
    agentProfiles: source.agentProfiles ?? DEFAULT_CONFIG.agentProfiles,
    timeoutMs: Number(source.timeoutMs ?? 600000),
    retries: Number(source.retries ?? 2),
    baseDelayMs: Number(source.baseDelayMs ?? 200),
    modelDescriptions: source.modelDescriptions ?? {},
    logBodyCapture: ['all', 'errors', 'none'].includes(source.logBodyCapture) ? source.logBodyCapture : 'errors',
    allowUnauthenticatedRemote: source.allowUnauthenticatedRemote === true,
    exposeRoutingHeaders: source.exposeRoutingHeaders === true,
    bindHost: typeof source.bindHost === 'string' ? source.bindHost : undefined
  }
}

// ---------------------------------------------------------------------------
// Importing an existing gateway config (JSON backup or SQLite store).
// database row. API keys become Orca secret writes in the caller, never logs.
// ---------------------------------------------------------------------------
function legacyConditionToRuleCondition(condition) {
  if (!condition?.left || !condition.operator) return null
  const left = String(condition.left)
  const source = left.startsWith('request.header.') ? 'request.header'
    : left.startsWith('request.headers.') ? 'request.headers'
    : left.startsWith('request.body.') ? 'request.body' : 'request.body'
  const field = left.replace(/^request\.(header|headers)\./, '').replace(/^request\.body\./, '')
  const operator = String(condition.operator).replace(/_/g, '-')
  return { source, field, operator, value: condition.right }
}

export function decryptOmniRouteCredential(ciphertext, secret) {
  if (!ciphertext || typeof ciphertext !== 'string' || !ciphertext.startsWith('enc:v1:')) return ciphertext
  if (!secret || typeof secret !== 'string' || !secret.trim()) return ciphertext

  const body = ciphertext.slice(7)
  const parts = body.split(':')
  if (parts.length !== 3) return ciphertext
  const [ivHex, encHex, tagHex] = parts

  try {
    const iv = Buffer.from(ivHex, 'hex')
    const authTag = Buffer.from(tagHex, 'hex')

    const tryKey = (candKey) => {
      try {
        const decipher = createDecipheriv('aes-256-gcm', candKey, iv, { authTagLength: 16 })
        decipher.setAuthTag(authTag)
        let dec = decipher.update(encHex, 'hex', 'utf8')
        dec += decipher.final('utf8')
        return dec
      } catch {
        return null
      }
    }

    const staticKey = scryptSync(secret, 'omniroute-field-encryption-v1', 32)
    const res1 = tryKey(staticKey)
    if (res1 !== null) return res1

    const dynamicSalt = createHash('sha256').update(secret).digest().subarray(0, 16)
    const legacyKey = scryptSync(secret, dynamicSalt, 32)
    const res2 = tryKey(legacyKey)
    if (res2 !== null) return res2

    return ciphertext
  } catch {
    return ciphertext
  }
}

export function convertClaudeCodeRouterConfig(ccr) {
  const secrets = []
  const providers = (ccr?.Providers ?? ccr?.providers ?? []).map((provider) => {
    const name = slug(provider.name)
    const endpoints = Array.isArray(provider.capabilities) && provider.capabilities.length
      ? provider.capabilities.map((capability) => ({
          baseUrl: capability.baseUrl ?? provider.api_base_url ?? provider.baseUrl ?? provider.baseurl,
          protocols: [mapLegacyProtocol(capability.type ?? provider.type)].filter(Boolean)
        }))
      : [{ baseUrl: provider.api_base_url ?? provider.baseUrl ?? provider.baseurl ?? '', protocols: [mapLegacyProtocol(provider.type)].filter(Boolean) }]
    const keys = []
    const pushKey = (value, suffix) => {
      if (!value) return
      const secretKey = `imported.providers.${name}.${suffix}`
      secrets.push({ secretKey, value })
      keys.push({ id: `${name}-${suffix}`, secretKey, enabled: true, priority: 0, weight: 1 })
    }
    pushKey(provider.api_key ?? provider.apiKey ?? provider.apikey, 'key-1')
    for (const credential of provider.credentials ?? []) {
      pushKey(credential.api_key ?? credential.apiKey ?? credential.apikey, credential.id ?? `key-${keys.length + 1}`)
    }
    const models = (provider.models ?? []).map((m) => {
      const id = typeof m === 'object' && m !== null ? m.id ?? m.name : String(m)
      return {
        id: String(id),
        ...(provider.modelDescriptions?.[id] ? { description: provider.modelDescriptions[id] } : {}),
        ...(provider.modelMetadata?.[id]?.pricing ? { pricing: provider.modelMetadata[id].pricing } : {})
      }
    })
    const protocols = [...new Set(endpoints.flatMap((e) => e.protocols))]
    return {
      name,
      displayName: provider.name,
      baseUrl: endpoints[0]?.baseUrl ?? '',
      endpoints,
      protocols,
      models,
      keys,
      enabled: provider.enabled !== false,
      usageFetch: provider.account?.enabled === false
        ? undefined
        : (() => {
            const connectors = (provider.account?.connectors ?? []).filter((c) => c.type === 'http-json')
            return connectors.length ? { enabled: true, connectors } : undefined
          })()
    }
  })
  const router = ccr?.Router ?? ccr?.router ?? {}
  const routes = (router.rules ?? router.routes ?? []).map((rule, index) => ({
    id: rule.id ?? `imported-rule-${index + 1}`,
    name: rule.name ?? `imported rule ${index + 1}`,
    enabled: rule.enabled !== false,
    condition: legacyConditionToRuleCondition(rule.condition),
    rewrites: rule.rewrites ?? (rule.rewrite ? [rule.rewrite] : []),
    ...(rule.target ? { rewrites: [...(rule.rewrites ?? (rule.rewrite ? [rule.rewrite] : [])), { key: 'request.body.model', operation: 'set', value: rule.target }] } : {}),
    fallback: rule.fallback
  })).filter((rule) => rule.type !== 'script' && rule.type !== 'Script')
  const clientKeys = (ccr?.APIKEYS ?? ccr?.apiKeys ?? []).map((key) => {
    const secretKey = `imported.clientKeys.${key.id}`
    secrets.push({ secretKey, value: key.key })
    return { id: key.id, name: key.name ?? key.id, secretKey, expiresAt: key.expiresAt, limits: key.limits, enabled: true }
  })
  const profile = ccr?.profile ?? {}
  const agentProfiles = (profile.profiles ?? []).map((item) => ({
    agent: item.agent,
    name: item.name ?? item.agent,
    model: item.model ?? '',
    smallFastModel: item.smallFastModel ?? '',
    enabled: item.enabled !== false,
    scope: item.scope === 'ccr' ? 'router-only' : item.scope === 'global' ? 'system-default' : item.scope ?? 'router-only',
    env: item.env ?? {},
    providerId: item.providerId,
    providerName: item.providerName
  }))
  if (profile.claudeCode && !agentProfiles.some((p) => p.agent === 'claude-code')) {
    agentProfiles.push({ agent: 'claude-code', name: 'Claude Code', model: profile.claudeCode.model ?? '', smallFastModel: profile.claudeCode.smallFastModel ?? '', enabled: profile.claudeCode.enabled !== false, scope: 'system-default', env: {} })
  } else if (profile.claudeCode && profile.claudeCode.model && !agentProfiles.some((p) => p.agent === 'claude-code' && p.model)) {
    agentProfiles.push({ agent: 'claude-code', name: 'Claude Code', model: profile.claudeCode.model, smallFastModel: profile.claudeCode.smallFastModel ?? '', enabled: true, scope: 'router-only', env: {} })
  }
  if (profile.codex && profile.codex.model && !agentProfiles.some((p) => p.agent === 'codex' && p.model)) {
    agentProfiles.push({ agent: 'codex', name: 'Codex', model: profile.codex.model, enabled: profile.codex.enabled !== false, scope: 'system-default', env: {} })
  }

  const rawAliases = ccr?.aliases ?? ccr?.Aliases ?? ccr?.modelAliases ?? ccr?.customModelAliases ?? {}
  const aliases = {}
  for (const [k, v] of Object.entries(rawAliases)) {
    if (typeof v === 'string') aliases[k] = v
  }

  return {
    config: {
      version: 2,
      token: DEFAULT_CONFIG.token,
      providers,
      routes,
      aliases,
      defaultProvider: providers[0]?.name ?? '',
      defaultFallback: router.fallback ?? { mode: 'retry', models: [], retryCount: 2 },
      clientKeys,
      agentProfiles: agentProfiles.length ? agentProfiles : DEFAULT_CONFIG.agentProfiles,
      timeoutMs: ccr?.API_TIMEOUT_MS ?? 600000,
      baseDelayMs: 200,
      logBodyCapture: ccr?.observability?.requestLogBodyCapture ?? 'errors'
    },
    secrets
  }
}

export const convertLegacyConfig = convertClaudeCodeRouterConfig

export function convertOmniRouteConfig(omni, options = {}) {
  const secrets = []
  const encryptionKey = options.encryptionKey ?? process.env.STORAGE_ENCRYPTION_KEY

  const rawConnections = omni?.providerConnections ?? omni?.provider_connections ?? []
  const rawNodes = omni?.providerNodes ?? omni?.provider_nodes ?? []
  const rawCombos = omni?.combos ?? []
  const rawApiKeys = omni?.apiKeys ?? omni?.api_keys ?? []
  const rawAliases = omni?.modelAliases ?? omni?.model_aliases ?? {}
  const rawCustomModels = omni?.customModels ?? omni?.custom_models ?? {}

  const providerMap = new Map()
  const providers = []

  // 1. Provider nodes (custom endpoints)
  for (const node of rawNodes) {
    const slugName = slug(node.name || node.id)
    if (!slugName) continue
    const protocol = mapLegacyProtocol(node.apiType || node.api_type || node.type)
    const baseUrl = node.baseUrl || node.base_url || ''
    const provider = {
      name: slugName,
      displayName: node.name || node.id,
      baseUrl,
      endpoints: baseUrl ? [{ baseUrl, protocols: [protocol] }] : [],
      protocols: [protocol],
      models: [],
      keys: [],
      enabled: true
    }
    providers.push(provider)
    if (node.id) providerMap.set(slug(node.id), provider)
    if (node.name) providerMap.set(slug(node.name), provider)
  }

  // 2. Provider connections
  for (const conn of rawConnections) {
    const rawProvider = conn.provider || 'custom'
    const providerSlug = slug(rawProvider)
    let provider = providerMap.get(providerSlug)

    if (!provider) {
      const preset = PROVIDER_PRESETS.find(
        (p) => p.id === providerSlug || slug(p.name) === providerSlug
      )
      if (preset) {
        const protocols = [...new Set((preset.capabilities ?? []).map(mapLegacyProtocol))]
        provider = {
          name: preset.id,
          displayName: preset.name,
          baseUrl: preset.baseUrl,
          endpoints: [{ baseUrl: preset.baseUrl, protocols }],
          protocols,
          models: (preset.defaultModels ?? []).map((id) => ({ id })),
          keys: [],
          enabled: true
        }
        providers.push(provider)
        providerMap.set(slug(preset.id), provider)
        providerMap.set(slug(preset.name), provider)
      } else {
        provider = {
          name: providerSlug,
          displayName: conn.displayName || conn.display_name || conn.name || rawProvider,
          baseUrl: '',
          endpoints: [],
          protocols: ['openai'],
          models: [],
          keys: [],
          enabled: true
        }
        providers.push(provider)
        providerMap.set(providerSlug, provider)
      }
    }

    const rawKey = conn.apiKey || conn.api_key || conn.accessToken || conn.access_token
    let decryptedKey = rawKey
    if (typeof rawKey === 'string' && rawKey.startsWith('enc:v1:')) {
      decryptedKey = decryptOmniRouteCredential(rawKey, encryptionKey)
    }

    const keyIndex = provider.keys.length + 1
    const keyName = conn.name ? slug(conn.name) : `key-${keyIndex}`
    const keyId = `${provider.name}-${keyName}`
    const secretKey = `imported.providers.${provider.name}.${keyName}`

    if (decryptedKey) {
      secrets.push({ secretKey, value: decryptedKey })
    }

    let limits
    const rawLimits = conn.rateLimitOverrides || conn.rate_limit_overrides || conn.rate_limit_overrides_json
    if (rawLimits) {
      try {
        limits = typeof rawLimits === 'string' ? JSON.parse(rawLimits) : rawLimits
      } catch {}
    }

    provider.keys.push({
      id: keyId,
      secretKey,
      enabled: conn.isActive !== false && conn.is_active !== 0,
      priority: Number(conn.priority ?? 0),
      weight: 1,
      ...(limits ? { limits } : {})
    })

    const defaultModel = conn.defaultModel || conn.default_model
    if (defaultModel && !provider.models.some((m) => m.id === defaultModel)) {
      provider.models.push({ id: defaultModel })
    }
  }

  // 3. Custom models
  for (const [pId, models] of Object.entries(rawCustomModels)) {
    const provider = providerMap.get(slug(pId))
    if (provider && Array.isArray(models)) {
      for (const m of models) {
        const modelId = typeof m === 'string' ? m : m?.id
        if (modelId && !provider.models.some((x) => x.id === modelId)) {
          provider.models.push({ id: modelId, ...(m?.description ? { description: m.description } : {}) })
        }
      }
    }
  }

  // 4. Model aliases
  const aliases = {}
  for (const [alias, target] of Object.entries(rawAliases)) {
    if (typeof target === 'string') {
      try {
        aliases[alias] = target.startsWith('"') ? JSON.parse(target) : target
      } catch {
        aliases[alias] = target
      }
    }
  }

  // 5. Combos -> Routes + Aliases
  const routes = []
  for (const [index, combo] of rawCombos.entries()) {
    let comboData = combo.data
    if (typeof comboData === 'string') {
      try { comboData = JSON.parse(comboData) } catch { comboData = {} }
    } else if (!comboData && typeof combo === 'object') {
      comboData = combo
    }
    const comboName = combo.name || comboData?.name || `combo-${index + 1}`
    const steps = comboData?.steps || comboData?.models || []
    const models = steps.map((s) => typeof s === 'string' ? s : s?.model).filter(Boolean)
    if (models.length) {
      const primaryModel = models[0]
      const fallbackModels = models.slice(1)
      if (!aliases[comboName]) {
        aliases[comboName] = primaryModel
      }
      routes.push({
        id: `imported-combo-${slug(comboName)}`,
        name: `Combo: ${comboName}`,
        enabled: true,
        condition: { source: 'request.body', field: 'model', operator: '==', value: comboName },
        rewrites: [{ key: 'request.body.model', operation: 'set', value: primaryModel }],
        fallback: fallbackModels.length
          ? { mode: 'model-chain', models: fallbackModels, retryCount: 0 }
          : undefined
      })
    }
  }

  // 6. Client API keys
  const clientKeys = []
  for (const key of rawApiKeys) {
    let rawSecret = key.key
    let decryptedSecret = rawSecret
    if (typeof rawSecret === 'string' && rawSecret.startsWith('enc:v1:')) {
      decryptedSecret = decryptOmniRouteCredential(rawSecret, encryptionKey)
    }
    const secretKey = `imported.clientKeys.${key.id}`
    if (decryptedSecret) {
      secrets.push({ secretKey, value: decryptedSecret })
    }
    clientKeys.push({
      id: key.id,
      name: key.name || key.id,
      secretKey,
      enabled: !key.revoked_at && key.isActive !== false,
      limits: key.limits
    })
  }

  return {
    config: {
      version: 2,
      token: DEFAULT_CONFIG.token,
      providers,
      routes,
      aliases,
      defaultProvider: providers[0]?.name ?? '',
      defaultFallback: { mode: 'retry', models: [], retryCount: 2 },
      clientKeys,
      agentProfiles: DEFAULT_CONFIG.agentProfiles,
      timeoutMs: 600000,
      baseDelayMs: 200,
      logBodyCapture: 'errors'
    },
    secrets
  }
}

export function mergeRouterConfigs(baseConfig, incomingConfig, baseSecrets = [], incomingSecrets = []) {
  const mergedConfig = structuredClone(baseConfig)
  const secretsMap = new Map()
  for (const s of baseSecrets ?? []) secretsMap.set(s.secretKey, s.value)
  for (const s of incomingSecrets ?? []) secretsMap.set(s.secretKey, s.value)

  // Merge providers
  if (!Array.isArray(mergedConfig.providers)) mergedConfig.providers = []
  for (const incomingProv of incomingConfig.providers ?? []) {
    const existing = mergedConfig.providers.find((p) => p.name === incomingProv.name)
    if (!existing) {
      mergedConfig.providers.push(structuredClone(incomingProv))
    } else {
      const existingModelIds = new Set((existing.models ?? []).map((m) => m.id))
      for (const m of incomingProv.models ?? []) {
        if (!existingModelIds.has(m.id)) {
          existing.models = existing.models ?? []
          existing.models.push(structuredClone(m))
          existingModelIds.add(m.id)
        }
      }
      const existingKeyIds = new Set((existing.keys ?? []).map((k) => k.id))
      for (const k of incomingProv.keys ?? []) {
        if (!existingKeyIds.has(k.id)) {
          existing.keys = existing.keys ?? []
          existing.keys.push(structuredClone(k))
          existingKeyIds.add(k.id)
        }
      }
      if (!existing.baseUrl && incomingProv.baseUrl) existing.baseUrl = incomingProv.baseUrl
      if ((!existing.endpoints || !existing.endpoints.length) && incomingProv.endpoints?.length) {
        existing.endpoints = structuredClone(incomingProv.endpoints)
      }
      if ((!existing.protocols || !existing.protocols.length) && incomingProv.protocols?.length) {
        existing.protocols = [...incomingProv.protocols]
      }
    }
  }

  // Merge routes
  if (!Array.isArray(mergedConfig.routes)) mergedConfig.routes = []
  const existingRouteIds = new Set(mergedConfig.routes.map((r) => r.id))
  for (const r of incomingConfig.routes ?? []) {
    if (!existingRouteIds.has(r.id)) {
      mergedConfig.routes.push(structuredClone(r))
      existingRouteIds.add(r.id)
    }
  }

  // Merge aliases
  mergedConfig.aliases = {
    ...(mergedConfig.aliases ?? {}),
    ...(incomingConfig.aliases ?? {})
  }

  // Merge clientKeys
  if (!Array.isArray(mergedConfig.clientKeys)) mergedConfig.clientKeys = []
  const existingClientKeyIds = new Set(mergedConfig.clientKeys.map((k) => k.id))
  for (const k of incomingConfig.clientKeys ?? []) {
    if (!existingClientKeyIds.has(k.id)) {
      mergedConfig.clientKeys.push(structuredClone(k))
      existingClientKeyIds.add(k.id)
    }
  }

  // Merge agentProfiles
  if (!Array.isArray(mergedConfig.agentProfiles)) mergedConfig.agentProfiles = []
  const existingAgents = new Set(mergedConfig.agentProfiles.map((p) => p.agent))
  for (const p of incomingConfig.agentProfiles ?? []) {
    if (!existingAgents.has(p.agent)) {
      mergedConfig.agentProfiles.push(structuredClone(p))
      existingAgents.add(p.agent)
    } else {
      const existingProfile = mergedConfig.agentProfiles.find((x) => x.agent === p.agent)
      if (existingProfile && !existingProfile.model && p.model) {
        existingProfile.model = p.model
        if (p.smallFastModel) existingProfile.smallFastModel = p.smallFastModel
      }
    }
  }

  if (!mergedConfig.defaultProvider && incomingConfig.defaultProvider) {
    mergedConfig.defaultProvider = incomingConfig.defaultProvider
  }

  const mergedSecrets = Array.from(secretsMap.entries()).map(([secretKey, value]) => ({ secretKey, value }))
  return { config: mergedConfig, secrets: mergedSecrets }
}

export function readSqliteConfig(sqlitePath, options = {}) {
  const db = new DatabaseSync(sqlitePath, { readOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name)

    if (tables.includes('app_config')) {
      const row = db.prepare("SELECT value_json FROM app_config WHERE key = ?").get('default')
      if (!row) throw new Error('No default app_config row found in Claude Code Router database')
      const raw = JSON.parse(row.value_json)
      if (tables.includes('api_keys')) {
        const keyRows = db.prepare('SELECT id, name, encrypted_key, encryption, expires_at, limits_json FROM api_keys').all()
        raw.APIKEYS = keyRows
          .map((e) => ({
            id: e.id,
            name: e.name,
            key: e.encryption === 'plain' ? e.encrypted_key : '',
            ...(e.expires_at ? { expiresAt: e.expires_at } : {}),
            ...(e.limits_json ? { limits: JSON.parse(e.limits_json) } : {})
          }))
          .filter((k) => k.key)
      }
      return { type: 'ccr', ...convertClaudeCodeRouterConfig(raw) }
    }

    if (tables.includes('provider_connections') || tables.includes('provider_nodes') || tables.includes('key_value')) {
      const rawConnections = tables.includes('provider_connections')
        ? db.prepare('SELECT * FROM provider_connections').all()
        : []
      const rawNodes = tables.includes('provider_nodes')
        ? db.prepare('SELECT * FROM provider_nodes').all()
        : []
      const rawCombos = tables.includes('combos')
        ? db.prepare('SELECT * FROM combos').all()
        : []
      const rawApiKeys = tables.includes('api_keys')
        ? db.prepare('SELECT * FROM api_keys').all()
        : []

      const modelAliases = {}
      const customModels = {}
      if (tables.includes('key_value')) {
        const kvRows = db.prepare('SELECT namespace, key, value FROM key_value').all()
        for (const row of kvRows) {
          if (row.namespace === 'modelAliases') {
            try { modelAliases[row.key] = JSON.parse(row.value) } catch { modelAliases[row.key] = row.value }
          } else if (row.namespace === 'customModels') {
            try { customModels[row.key] = JSON.parse(row.value) } catch { customModels[row.key] = row.value }
          }
        }
      }

      let encryptionKey = options.encryptionKey
      if (!encryptionKey) {
        const envCandidates = [
          join(dirname(sqlitePath), '.env'),
          join(homedir(), '.omniroute', '.env')
        ]
        for (const envPath of envCandidates) {
          if (existsSync(envPath)) {
            try {
              const content = readFileSync(envPath, 'utf8')
              for (const line of content.split('\n')) {
                if (line.trim().startsWith('STORAGE_ENCRYPTION_KEY=')) {
                  encryptionKey = line.split('=', 2)[1]?.trim().replace(/^["'](.*)["']$/, '$1')
                  if (encryptionKey) break
                }
              }
            } catch {}
          }
          if (encryptionKey) break
        }
      }

      const raw = {
        providerConnections: rawConnections,
        providerNodes: rawNodes,
        combos: rawCombos,
        apiKeys: rawApiKeys,
        modelAliases,
        customModels
      }
      return { type: 'omniroute', ...convertOmniRouteConfig(raw, { encryptionKey }) }
    }

    throw new Error(`Unrecognized SQLite database format. Tables found: ${tables.join(', ')}`)
  } finally {
    db.close()
  }
}

export function detectAndConvertConfig(input, options = {}) {
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (trimmed.endsWith('.sqlite') || trimmed.endsWith('.db')) {
      return readSqliteConfig(trimmed, options)
    }
    if (trimmed.endsWith('.json')) {
      const content = readFileSync(trimmed, 'utf8')
      return detectAndConvertConfig(JSON.parse(content), options)
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return detectAndConvertConfig(JSON.parse(trimmed), options)
    }
  }

  if (typeof input !== 'object' || input === null) {
    throw new Error('Config input must be an object, JSON string, or file path')
  }

  if (
    Array.isArray(input.providerConnections) ||
    Array.isArray(input.provider_connections) ||
    Array.isArray(input.providerNodes) ||
    Array.isArray(input.provider_nodes) ||
    (input.combos && !input.Router && !input.router) ||
    (input.modelAliases && !input.Providers && !input.providers)
  ) {
    return { type: 'omniroute', ...convertOmniRouteConfig(input, options) }
  }

  if (
    input.Providers ||
    input.Router ||
    input.APIKEYS ||
    (Array.isArray(input.providers) && (input.router || input.profile || input.APIKEY || input.API_TIMEOUT_MS))
  ) {
    return { type: 'ccr', ...convertClaudeCodeRouterConfig(input) }
  }

  if (input.version === 2 || (Array.isArray(input.providers) && Array.isArray(input.routes))) {
    return { type: 'native', config: normalizeConfig(input), secrets: [] }
  }

  if (Array.isArray(input.providers) || Array.isArray(input.upstreams)) {
    return { type: 'ccr', ...convertClaudeCodeRouterConfig(input) }
  }

  throw new Error('Unrecognized config format. Expected Orca Router, Claude Code Router, or OmniRoute.')
}

export function detectLocalRouterConfigs() {
  const result = { ccr: null, omniroute: null }

  // 1. Claude Code Router
  const ccrCandidates = [
    join(homedir(), '.claude-code-router', 'config.sqlite'),
    join(homedir(), '.claude-code-router', 'config.json')
  ]
  const ccrPath = ccrCandidates.find((p) => existsSync(p))
  if (ccrPath) {
    try {
      if (ccrPath.endsWith('.sqlite')) {
        const db = new DatabaseSync(ccrPath, { readOnly: true })
        const row = db.prepare('SELECT value_json FROM app_config WHERE key = ?').get('default')
        const parsed = JSON.parse(row.value_json)
        const keysCount = db.prepare('SELECT count(*) as c FROM api_keys').get()?.c ?? 0
        db.close()
        result.ccr = {
          name: 'Claude Code Router',
          path: ccrPath,
          format: 'sqlite',
          providers: (parsed.Providers || parsed.providers || []).length,
          keys: keysCount,
          profiles: (parsed.profile?.profiles || []).length,
          rules: (parsed.Router?.rules || parsed.router?.rules || []).length
        }
      } else {
        const content = readFileSync(ccrPath, 'utf8')
        const parsed = JSON.parse(content)
        result.ccr = {
          name: 'Claude Code Router',
          path: ccrPath,
          format: 'json',
          providers: (parsed.Providers || parsed.providers || []).length,
          keys: (parsed.APIKEYS || parsed.apiKeys || []).length,
          profiles: (parsed.profile?.profiles || []).length,
          rules: (parsed.Router?.rules || parsed.router?.rules || []).length
        }
      }
    } catch (err) {
      result.ccr = { name: 'Claude Code Router', path: ccrPath, error: err.message }
    }
  }

  // 2. OmniRoute
  const omniCandidates = [
    join(homedir(), '.omniroute', 'storage.sqlite'),
    join(homedir(), '.omniroute', 'db.json')
  ]
  const omniPath = omniCandidates.find((p) => existsSync(p))
  if (omniPath) {
    try {
      if (omniPath.endsWith('.sqlite')) {
        const db = new DatabaseSync(omniPath, { readOnly: true })
        let connections = 0, nodes = 0, combos = 0, aliases = 0
        try { connections = db.prepare('SELECT count(*) as c FROM provider_connections').get()?.c ?? 0 } catch {}
        try { nodes = db.prepare('SELECT count(*) as c FROM provider_nodes').get()?.c ?? 0 } catch {}
        try { combos = db.prepare('SELECT count(*) as c FROM combos').get()?.c ?? 0 } catch {}
        try { aliases = db.prepare("SELECT count(*) as c FROM key_value WHERE namespace = 'modelAliases'").get()?.c ?? 0 } catch {}
        db.close()
        result.omniroute = {
          name: 'OmniRoute',
          path: omniPath,
          format: 'sqlite',
          connections,
          nodes,
          combos,
          aliases
        }
      } else {
        const content = readFileSync(omniPath, 'utf8')
        const parsed = JSON.parse(content)
        result.omniroute = {
          name: 'OmniRoute',
          path: omniPath,
          format: 'json',
          connections: (parsed.providerConnections || []).length,
          nodes: (parsed.providerNodes || []).length,
          combos: (parsed.combos || []).length,
          aliases: Object.keys(parsed.modelAliases || {}).length
        }
      }
    } catch (err) {
      result.omniroute = { name: 'OmniRoute', path: omniPath, error: err.message }
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Utilities: URLs, dot paths, conditions, rewrites.
// ---------------------------------------------------------------------------
export function joinUpstreamUrl(baseUrl, pathname) {
  const base = String(baseUrl).replace(/\/+$/, '')
  // Providers store base URLs including a trailing /v1 (OpenAI style).
  // Requests already carry /v1, so avoid a duplicated prefix.
  const withV1 = base.toLowerCase().endsWith('/v1')
  const pathStartsV1 = pathname.toLowerCase().startsWith('/v1')
  const bare = withV1 && pathStartsV1 ? base.slice(0, -3) : base
  return `${bare}${pathname}`
}

export function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
      .map((b) => b.text ?? '')
      .join('\n')
  }
  return ''
}

export function getPath(object, path) {
  if (path === '' || path == null) return object
  let current = object
  for (const segment of String(path).split('.')) {
    if (current == null) return undefined
    const key = /^\d+$/.test(segment) ? Number(segment) : segment
    current = current[key]
  }
  return current
}

function setPath(object, path, value) {
  const segments = String(path).split('.').filter(Boolean)
  if (segments.some((s) => ['__proto__', 'constructor', 'prototype'].includes(s))) return false
  let current = object
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]
    const key = /^\d+$/.test(segment) ? Number(segment) : segment
    if (current[key] == null || typeof current[key] !== 'object') {
      current[key] = /^\d+$/.test(segments[i + 1]) ? [] : {}
    }
    current = current[key]
  }
  const last = segments[segments.length - 1]
  if (last == null || ['__proto__', 'constructor', 'prototype'].includes(last)) return false
  current[/^\d+$/.test(last) ? Number(last) : last] = value
  return true
}

function deletePath(object, path) {
  const segments = String(path).split('.').filter(Boolean)
  let current = object
  for (let i = 0; i < segments.length - 1; i++) {
    current = current[/^\d+$/.test(segments[i]) ? Number(segments[i]) : segments[i]]
    if (current == null) return
  }
  const last = segments[segments.length - 1]
  const key = /^\d+$/.test(last) ? Number(last) : last
  if (Array.isArray(current) && typeof key === 'number') current.splice(key, 1)
  else if (current) delete current[key]
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export function parseLiteral(raw) {
  if (raw == null) return raw
  if (typeof raw !== 'string') return raw
  const trimmed = raw.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed)
  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null) return parsed
  } catch {
    // plain string
  }
  return raw
}

function containsDeep(value, needle) {
  if (deepEqual(value, needle)) return true
  if (Array.isArray(value)) return value.some((item) => containsDeep(item, needle))
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsDeep(item, needle))
  return String(value ?? '').includes(String(needle ?? ''))
}

function globMatch(pattern, value) {
  const regex = new RegExp(`^${String(pattern).replace(/[.*+?^${'{}'}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`)
  return regex.test(String(value ?? ''))
}

export function matchRoute(match, model) {
  // Backwards-compatible helper for the previous `routes` shape.
  if (!match || match === '*' || match === '') return true
  if (match.startsWith('prefix:')) return String(model ?? '').startsWith(match.slice(7))
  if (match.endsWith('/*')) return String(model ?? '').startsWith(match.slice(0, -1))
  if (match.includes('*')) return globMatch(match, model)
  return model === match
}

export function evaluateCondition(condition, { headers, body }) {
  if (!condition) return true
  const source = condition.source ?? 'request.body'
  const field = condition.field ?? ''
  const operator = String(condition.operator ?? '==').toLowerCase()
  const expected = parseLiteral(condition.value)
  let actual
  if (source === 'request.header' || source === 'request.headers') {
    actual = headers?.[String(field).toLowerCase()]
  } else {
    actual = getPath(body, field)
  }
  const textActual = actual == null ? '' : String(actual)
  switch (operator) {
    case '==': return typeof expected === 'number' || typeof actual === 'number' ? Number(actual) === Number(expected) : textActual === String(expected)
    case '!=': return typeof expected === 'number' || typeof actual === 'number' ? Number(actual) !== Number(expected) : textActual !== String(expected)
    case '>': return Number(actual) > Number(expected)
    case '>=': return Number(actual) >= Number(expected)
    case '<': return Number(actual) < Number(expected)
    case '<=': return Number(actual) <= Number(expected)
    case 'starts-with': return textActual.startsWith(String(expected))
    case 'contains': return Array.isArray(actual) ? actual.some((item) => deepEqual(item, expected)) : textActual.includes(String(expected))
    case 'contains-deep': return containsDeep(actual, expected)
    case 'not-contains': return !containsDeep(actual, expected)
    case 'matches': return globMatch(String(condition.value), textActual)
    case 'equals': return textActual === String(expected)
    default: return textActual === String(expected)
  }
}

export function applyRewrites(body, headers, rewrites) {
  for (const rewrite of rewrites ?? []) {
    const key = String(rewrite.key ?? '')
    const operation = rewrite.operation ?? 'set'
    const value = parseLiteral(rewrite.value)
    if (key.startsWith('request.body.')) {
      const path = key.slice('request.body.'.length)
      if (operation === 'set') {
        if (path === 'model' && typeof value === 'string' && value) {
          body.model = value
        } else if (path === 'model') {
          body.model = value
        } else setPath(body, path, value)
      } else if (operation === 'delete') deletePath(body, path)
      else if (operation === 'array-append') {
        let target = getPath(body, path)
        if (!Array.isArray(target)) { target = []; setPath(body, path, target) }
        target.push(value)
      } else if (operation === 'array-prepend') {
        let target = getPath(body, path)
        if (!Array.isArray(target)) { target = []; setPath(body, path, target) }
        target.unshift(value)
      } else if (operation === 'array-remove') {
        let target = getPath(body, path)
        if (Array.isArray(target)) target = target.filter((item) => !deepEqual(item, value)), setPath(body, path, target)
      } else if (operation === 'array-replace') {
        let target = getPath(body, path)
        const match = parseLiteral(rewrite.match)
        if (Array.isArray(target)) target = target.map((item) => deepEqual(item, match) ? value : item), setPath(body, path, target)
      }
    } else if (key.startsWith('request.header.') || key.startsWith('request.headers.')) {
      const path = key.replace(/^request\.headers?\./, '').toLowerCase()
      if (operation === 'delete') delete headers[path]
      else if (operation === 'set') headers[path] = String(value)
    }
  }
}

// ---------------------------------------------------------------------------
// Protocol translation (Anthropic <-> OpenAI <-> Responses, text + tools).
// ---------------------------------------------------------------------------
export function anthropicToOpenAI(body) {
  const messages = []
  const system = contentText(body.system)
  if (system) messages.push({ role: 'system', content: system })
  for (const msg of body.messages ?? []) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const text = contentText(msg.content)
      const toolCalls = msg.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }))
      messages.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) })
    } else if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: typeof block.content === 'string' ? block.content : contentText(block.content) })
        }
      }
      const parts = []
      for (const block of msg.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push({ type: 'text', text: block.text })
        } else if (block.type === 'image' && block.source?.data) {
          const mime = block.source.media_type || 'image/png'
          parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${block.source.data}` } })
        } else if (block.type === 'image_url' && block.image_url) {
          parts.push({ type: 'image_url', image_url: block.image_url })
        }
      }
      if (parts.length === 1 && parts[0].type === 'text') {
        messages.push({ role: 'user', content: parts[0].text })
      } else if (parts.length > 0) {
        messages.push({ role: 'user', content: parts })
      }
    } else {
      messages.push({ role: msg.role ?? 'user', content: contentText(msg.content) })
    }
  }
  const budget = Number(body.thinking?.budget_tokens ?? 0)
  const reasoningEffort = body.thinking?.type === 'enabled' || budget > 0
    ? (budget >= 16000 ? 'high' : budget >= 4000 ? 'medium' : 'low')
    : undefined
  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    ...(body.max_tokens ? { max_completion_tokens: body.max_tokens } : {}),
    temperature: body.temperature,
    stream: body.stream,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : body.reasoning_effort ? { reasoning_effort: body.reasoning_effort } : {}),
    ...(body.tools?.length ? { tools: body.tools.filter((t) => t.name).map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object' } } })) } : {})
  }
}

export function openAIToAnthropic(body) {
  const system = (body.messages ?? []).filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') || undefined
  const messages = (body.messages ?? []).filter((m) => m.role !== 'system').map((m) => {
    if (m.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' }] }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      const content = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const call of m.tool_calls) {
        let input = {}
        try { input = JSON.parse(call.function?.arguments ?? '{}') } catch { input = {} }
        content.push({ type: 'tool_use', id: call.id ?? `call_${Math.random().toString(36).slice(2, 10)}`, name: call.function?.name ?? 'unknown', input })
      }
      return { role: 'assistant', content }
    }
    if (Array.isArray(m.content)) {
      const content = []
      for (const part of m.content) {
        if (part.type === 'text' && typeof part.text === 'string') {
          content.push({ type: 'text', text: part.text })
        } else if (part.type === 'image_url') {
          const url = String(part.image_url?.url ?? '')
          const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url)
          if (match && match[2]) {
            content.push({ type: 'image', source: { type: 'base64', media_type: match[1] || 'image/png', data: match[3] } })
          } else if (url) {
            content.push({ type: 'image_url', image_url: part.image_url })
          }
        }
      }
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content: content.length ? content : contentText(m.content) }
    }
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content: typeof m.content === 'string' ? m.content : contentText(m.content) }
  })
  const thinking = body.thinking ?? (body.reasoning_effort
    ? { type: 'enabled', budget_tokens: body.reasoning_effort === 'high' ? 16000 : body.reasoning_effort === 'medium' ? 8000 : 2048 }
    : undefined)
  return {
    model: body.model,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 4096,
    ...(system ? { system } : {}),
    messages,
    temperature: body.temperature,
    stream: body.stream,
    ...(thinking ? { thinking } : {}),
    ...(body.tools?.length ? { tools: body.tools.filter((t) => t.function?.name).map((t) => ({ name: t.function.name, description: t.function.description ?? '', input_schema: t.function.parameters ?? { type: 'object' } })) } : {})
  }
}

export function openAIResponseToAnthropic(raw, model) {
  const choice = raw?.choices?.[0] ?? {}
  const message = choice.message ?? {}
  const content = []
  if (message.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content })
  }
  if (message.content) content.push({ type: 'text', text: message.content })
  for (const call of message.tool_calls ?? []) {
    let input = {}
    try { input = JSON.parse(call.function?.arguments ?? '{}') } catch { input = {} }
    content.push({ type: 'tool_use', id: call.id ?? `call_${Math.random().toString(36).slice(2, 10)}`, name: call.function?.name ?? 'unknown', input })
  }
  return {
    id: raw?.id ?? `msg_router_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: model ?? raw?.model,
    content,
    stop_reason: choice.finish_reason ?? 'end_turn',
    usage: { input_tokens: raw?.usage?.prompt_tokens ?? 0, output_tokens: raw?.usage?.completion_tokens ?? 0 }
  }
}

export function anthropicResponseToOpenAI(raw, model) {
  const content = []
  let text = ''
  const toolCalls = []
  for (const block of raw?.content ?? []) {
    if (block.type === 'text') text += block.text ?? ''
    else if (block.type === 'tool_use') toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } })
  }
  return {
    id: raw?.id ?? `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    model: model ?? raw?.model,
    choices: [{ index: 0, finish_reason: raw?.stop_reason ?? 'stop', message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }],
    usage: {
      prompt_tokens: raw?.usage?.input_tokens ?? 0,
      completion_tokens: raw?.usage?.output_tokens ?? 0,
      total_tokens: (raw?.usage?.input_tokens ?? 0) + (raw?.usage?.output_tokens ?? 0)
    }
  }
}

// Codex's apply_patch/code-mode tools are Responses `custom` tools constrained
// by a Lark grammar. OpenAI accepts that format; most third-party Responses
// endpoints reject it with "Grammar-constrained custom tools are not supported".
// Falling back to a text-format custom tool keeps the same tool shape and lets
// Codex parse the model's freeform input.
export function normalizeResponsesCustomTools(body, { supportsGrammar = false } = {}) {
  if (supportsGrammar || !Array.isArray(body?.tools)) return body
  let changed = false
  const tools = body.tools.map((tool) => {
    if (tool?.type === 'custom' && tool?.format?.type === 'grammar') {
      changed = true
      return { ...tool, format: { type: 'text' } }
    }
    return tool
  })
  return changed ? { ...body, tools } : body
}

export function responsesToOpenAI(body) {
  const messages = []
  if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) })
  const input = body.input
  if (typeof input === 'string') messages.push({ role: 'user', content: input })
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') { messages.push({ role: 'user', content: String(item ?? '') }); continue }
      if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '') })
        continue
      }
      if (item.type === 'function_call') {
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments ?? '{}' } }] })
        continue
      }
      if (item.type === 'custom_tool_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: item.call_id,
            type: 'function',
            function: { name: item.name, arguments: JSON.stringify({ input: item.input ?? '' }) }
          }]
        })
        continue
      }
      const role = item.role === 'developer' ? 'system' : item.role ?? 'user'
      const content = item.content
      if (typeof content === 'string') messages.push({ role, content })
      else if (Array.isArray(content)) {
        const text = content.filter((p) => p.type === 'input_text' || p.type === 'output_text' || typeof p.text === 'string').map((p) => p.text ?? '').join('')
        if (text) messages.push({ role, content: text })
      }
    }
  } else if (body.messages) {
    return { ...body }
  }
  const reasoningEffort = body.reasoning_effort ?? body.reasoning?.effort
  const tools = []
  for (const tool of body.tools ?? []) {
    if (!tool || typeof tool !== 'object') continue
    if (tool.type === 'custom' && tool.name) {
      tools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: `${tool.description ?? ''}${tool.description ? '\n\n' : ''}Return the raw input for this tool in the "input" field.`,
          parameters: {
            type: 'object',
            properties: { input: { type: 'string', description: 'Raw tool input' } },
            required: ['input'],
            additionalProperties: false
          }
        }
      })
      continue
    }
    if (tool.type === 'function' || tool.name) {
      tools.push({ type: 'function', function: { name: tool.name, description: tool.description ?? '', parameters: tool.parameters ?? { type: 'object' } } })
    }
  }
  return {
    model: body.model,
    messages,
    max_completion_tokens: body.max_output_tokens,
    temperature: body.temperature,
    stream: body.stream,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(tools.length ? { tools } : {})
  }
}

export function openAIResponseToResponses(raw, model) {
  const choice = raw?.choices?.[0] ?? {}
  const message = choice.message ?? {}
  const output = []
  if (message.content) {
    output.push({ type: 'message', id: `msg_${Date.now()}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: message.content }] })
  }
  for (const call of message.tool_calls ?? []) {
    const name = call.function?.name
    const rawArguments = call.function?.arguments ?? '{}'
    if (name === 'apply_patch') {
      let input = rawArguments
      try {
        const parsed = JSON.parse(rawArguments)
        if (typeof parsed?.input === 'string') input = parsed.input
      } catch { /* keep the raw arguments */ }
      output.push({ type: 'custom_tool_call', id: call.id, call_id: call.id, name, input })
      continue
    }
    output.push({ type: 'function_call', id: call.id, call_id: call.id, name, arguments: rawArguments })
  }
  return {
    id: raw?.id ?? `resp_${Date.now()}`,
    object: 'response',
    model: model ?? raw?.model,
    status: 'completed',
    output,
    usage: {
      input_tokens: raw?.usage?.prompt_tokens ?? 0,
      output_tokens: raw?.usage?.completion_tokens ?? 0,
      total_tokens: raw?.usage?.total_tokens ?? ((raw?.usage?.prompt_tokens ?? 0) + (raw?.usage?.completion_tokens ?? 0))
    }
  }
}

// Gemini's generateContent takes a `contents` array, so the OpenAI chat shape
// (which every other client protocol already converts to) is the source of
// truth here.
function geminiImagePart(value) {
  const url = String(value ?? '')
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url)
  if (match && match[2]) return { inlineData: { mimeType: match[1] || 'application/octet-stream', data: match[3] } }
  if (/^https?:\/\//.test(url)) return { fileData: { fileUri: url } }
  return null
}

export function openAIToGemini(body) {
  const contents = []
  let systemText = ''
  const toolNameById = new Map()
  for (const msg of body.messages ?? []) {
    if (msg.role === 'system') {
      const text = contentText(msg.content)
      if (text) systemText += (systemText ? '\n\n' : '') + text
      continue
    }
    if (msg.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: toolNameById.get(msg.tool_call_id) ?? 'unknown', response: { result: typeof msg.content === 'string' ? msg.content : contentText(msg.content) } } }]
      })
      continue
    }
    const role = msg.role === 'assistant' ? 'model' : 'user'
    const parts = []
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === 'text' && typeof block.text === 'string') parts.push({ text: block.text })
        else if (block?.type === 'image_url') {
          const part = geminiImagePart(block.image_url?.url)
          if (part) parts.push(part)
        }
      }
    } else if (typeof msg.content === 'string' && msg.content) {
      parts.push({ text: msg.content })
    }
    for (const call of msg.tool_calls ?? []) {
      let args = {}
      try { args = JSON.parse(call.function?.arguments ?? '{}') } catch { args = {} }
      const name = call.function?.name ?? 'unknown'
      toolNameById.set(call.id, name)
      parts.push({ functionCall: { name, args } })
    }
    if (parts.length) contents.push({ role, parts })
  }

  const generationConfig = {}
  const maxTokens = body.max_tokens ?? body.max_completion_tokens
  if (maxTokens != null) generationConfig.maxOutputTokens = maxTokens
  if (body.temperature != null) generationConfig.temperature = body.temperature
  if (body.top_p != null) generationConfig.topP = body.top_p
  if (body.stop != null) generationConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop]

  const tools = body.tools?.length
    ? [{ functionDeclarations: body.tools.filter((t) => t.type === 'function' || t.function?.name).map((t) => ({
        name: t.function?.name,
        description: t.function?.description ?? '',
        parameters: t.function?.parameters ?? { type: 'object' }
      })) }]
    : undefined

  return {
    contents,
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    ...(tools ? { tools } : {})
  }
}

export function geminiResponseToOpenAI(raw, model) {
  const candidate = raw?.candidates?.[0] ?? {}
  const parts = candidate.content?.parts ?? []
  let text = ''
  const toolCalls = []
  for (const part of parts) {
    if (typeof part.text === 'string') text += part.text
    else if (part.functionCall) {
      const name = part.functionCall.name ?? 'unknown'
      toolCalls.push({ id: `call_${name}_${toolCalls.length}`, type: 'function', function: { name, arguments: JSON.stringify(part.functionCall.args ?? {}) } })
    }
  }
  const finish = candidate.finishReason
  const finishReason = finish === 'MAX_TOKENS' ? 'length'
    : finish === 'SAFETY' || finish === 'RECITATION' || finish === 'BLOCKLIST' ? 'content_filter'
    : toolCalls.length ? 'tool_calls' : 'stop'
  const usage = raw?.usageMetadata ?? {}
  return {
    id: raw?.responseId ?? `chatcmpl_gemini_${Date.now()}`,
    object: 'chat.completion',
    model: model ?? raw?.modelVersion,
    choices: [{
      index: 0,
      finish_reason: finishReason,
      message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }
    }],
    usage: {
      prompt_tokens: usage.promptTokenCount ?? 0,
      completion_tokens: usage.candidatesTokenCount ?? 0,
      total_tokens: usage.totalTokenCount ?? ((usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0))
    }
  }
}

export function buildAnthropicSse(message) {
  const events = []
  events.push(['message_start', { type: 'message_start', message: { id: message.id, type: 'message', role: 'assistant', model: message.model, content: [], stop_reason: null, usage: { input_tokens: message.usage?.input_tokens ?? 0, output_tokens: 0 } } }])
  let index = 0
  for (const block of message.content ?? []) {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: block.type, ...(block.type === 'text' ? { text: '' } : { id: block.id, name: block.name, input: {} }) } }])
    if (block.type === 'text' && block.text) events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }])
    if (block.type === 'tool_use') events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
    index++
  }
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason ?? 'end_turn' }, usage: { output_tokens: message.usage?.output_tokens ?? 0 } }])
  events.push(['message_stop', { type: 'message_stop' }])
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

export function buildOpenAISse(completion) {
  const choice = completion.choices?.[0]
  const message = choice?.message ?? {}
  const chunks = []
  const base = { id: completion.id, object: 'chat.completion.chunk', model: completion.model }
  const emit = (delta, finishReason = null) => chunks.push(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
  let first = true
  if (message.content || !message.tool_calls?.length) emit({ role: 'assistant', content: message.content ?? '' })
  for (const call of message.tool_calls ?? []) {
    emit({ role: 'assistant', tool_calls: [{ index: chunks.length, id: call.id, type: 'function', function: { name: call.function?.name, arguments: call.function?.arguments ?? '{}' } }] })
  }
  emit({}, choice?.finish_reason ?? 'stop')
  chunks.push('data: [DONE]\n\n')
  return chunks.join('')
}

export function buildResponsesSse(response) {
  const seq = []
  seq.push(['response.created', { type: 'response.created', response: { ...response, status: 'in_progress' } }])
  for (const [index, item] of (response.output ?? []).entries()) {
    if (item.type === 'message') {
      seq.push(['response.output_item.added', { type: 'response.output_item.added', item }])
      const text = item.content?.[0]?.text ?? ''
      seq.push(['response.content_part.added', { type: 'response.content_part.added', item_id: item.id, part: { type: 'output_text', text: '' } }])
      if (text) seq.push(['response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, content_index: 0, delta: text }])
      seq.push(['response.output_text.done', { type: 'response.output_text.done', item_id: item.id, content_index: 0, text }])
      seq.push(['response.content_part.done', { type: 'response.content_part.done', item_id: item.id, part: item.content?.[0] }])
    } else if (item.type === 'function_call') {
      seq.push(['response.output_item.added', { type: 'response.output_item.added', item }])
      seq.push(['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: item.id, delta: item.arguments ?? '{}' }])
      seq.push(['response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: item.id, arguments: item.arguments ?? '{}' }])
    } else if (item.type === 'custom_tool_call') {
      seq.push(['response.output_item.added', { type: 'response.output_item.added', output_index: index, item: { ...item, input: '' } }])
      seq.push(['response.custom_tool_call_input.delta', { type: 'response.custom_tool_call_input.delta', item_id: item.id, output_index: index, delta: item.input ?? '' }])
      seq.push(['response.custom_tool_call_input.done', { type: 'response.custom_tool_call_input.done', item_id: item.id, output_index: index, input: item.input ?? '' }])
    }
    seq.push(['response.output_item.done', { type: 'response.output_item.done', item }])
  }
  seq.push(['response.completed', { type: 'response.completed', response }])
  return seq.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('') + 'data: [DONE]\n\n'
}

// ---------------------------------------------------------------------------
// Model resolution: aliases, provider/model selectors, rules, fallback.
// ---------------------------------------------------------------------------
function providersFor(normalized) {
  return normalized.providers.filter((provider) => provider.enabled !== false)
}

function providerByName(normalized, name) {
  return normalized.providers.find((provider) => provider.name === slug(name))
}

function findModelOwner(normalized, bareModel) {
  for (const provider of providersFor(normalized)) {
    if (provider.models.some((model) => model.id === bareModel)) return provider
  }
  return null
}

export function splitModelPrefix(model, config) {
  const normalized = normalizeConfig(config)
  const name = String(model ?? '')
  const alias = normalized.aliases[name]
  const source = alias ?? name
  const slash = source.indexOf('/')
  if (slash > 0) {
    const candidate = providerByName(normalized, source.slice(0, slash))
    if (candidate) return { provider: candidate, model: source.slice(slash + 1) }
  }
  const owner = findModelOwner(normalized, source)
  if (owner) return { provider: owner, model: source }
  const defaultProvider = providerByName(normalized, normalized.defaultProvider)
  return { provider: defaultProvider ?? providersFor(normalized)[0] ?? null, model: source }
}

export function resolveProviderTarget(config, selector, fallbackModel = '') {
  const normalized = normalizeConfig(config)
  if (!selector) return null
  const text = normalized.aliases[selector] ?? selector
  const slash = text.indexOf('/')
  if (slash > 0) {
    const provider = providerByName(normalized, text.slice(0, slash))
    if (provider) return { provider, model: text.slice(slash + 1) }
  }
  const owner = findModelOwner(normalized, text)
  if (owner) return { provider: owner, model: text }
  const named = providerByName(normalized, text)
  if (named) return { provider: named, model: fallbackModel }
  const provider = providerByName(normalized, normalized.defaultProvider) ?? providersFor(normalized)[0]
  return provider ? { provider, model: text } : null
}

export function agentProfileFor(normalized, agentId) {
  const wanted = slug(String(agentId ?? '').replace(/^.*[:/]/, ''))
  const synonyms = {
    claude: ['claude', 'claude-code', 'claude-design'],
    'claude-code': ['claude-code', 'claude', 'claude-design'],
    'claude-agent-teams': ['claude-agent-teams', 'claude'],
    codex: ['codex'],
    opencode: ['opencode'],
    opencode2: ['opencode2', 'opencode']
  }
  const candidates = [...(synonyms[wanted] ?? [wanted]), wanted]
  for (const candidate of candidates) {
    const profile = normalized.agentProfiles.find((item) => slug(item.agent) === candidate)
    if (profile) return profile
  }
  return normalized.agentProfiles.find((item) => slug(item.agent) === 'generic') ?? null
}

export function resolveAgentProfile(config, agentId) {
  return agentProfileFor(normalizeConfig(config), agentId)
}

// Environment Orca should hand an agent process so its requests reach the local
// gateway. Agents route by default; a profile that is explicitly disabled is
// the only thing that opts an agent out. The scope only decides how the model
// is chosen when a profile still carries one (imported CCR configs):
//   system-default -> use the profile model, else the router/agent default
//   router-only    -> keep the agent's own model unless the profile pins one
//   custom         -> same as router-only (kept for imported CCR configs)
// Profile `env` is merged last so an explicit override always wins.
export function buildAgentLaunchEnv(config, agentId, { base, token, eventEnv = {} } = {}) {
  const normalized = normalizeConfig(config)
  const profile = agentProfileFor(normalized, agentId)
  if (profile?.enabled === false) {
    return { env: eventEnv, model: '', profile, scope: 'router-only', routed: false }
  }
  const scope = profile?.scope === 'system-default' ? 'system-default' : 'router-only'
  const fallbackModel = scope === 'system-default'
    ? (normalized.defaultModel || eventEnv.ANTHROPIC_MODEL || eventEnv.OPENAI_MODEL || '')
    : ''
  const model = profile?.model || fallbackModel
  const small = profile?.smallFastModel || ''
  const noProxy = mergeNoProxy(eventEnv.NO_PROXY ?? eventEnv.no_proxy)
  const claudeAgent = /claude/i.test(String(agentId ?? ''))
  const env = {
    ...eventEnv,
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_BASE_URL: base,
    CLAUDE_AGENT_API_BASE_URL: base,
    ANTHROPIC_AUTH_TOKEN: token,
    // Claude Code raises a custom-key approval prompt when ANTHROPIC_API_KEY is
    // set; the auth token alone is enough for it. Other Anthropic clients still
    // read the key, so only Claude is blanked (a profile env can set it back).
    ANTHROPIC_API_KEY: claudeAgent ? '' : token,
    OPENAI_BASE_URL: `${base}/v1`,
    OPENAI_API_KEY: token,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    // Custom model ids are routed by the gateway, so let Claude Code accept them.
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
    ...(model ? { ANTHROPIC_MODEL: model, OPENAI_MODEL: model, MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model } : {}),
    ...(small ? { ANTHROPIC_SMALL_FAST_MODEL: small, ANTHROPIC_DEFAULT_HAIKU_MODEL: small } : {}),
    ...(profile?.env ?? {})
  }
  return { env, model, profile, scope, routed: true }
}

// The gateway's routable selectors: each enabled provider's models in order,
// followed by aliases. OpenCode and Codex publish this same list so their
// pickers stay in sync with the gateway's /v1/models response.
function routerModelEntries(normalized, agentId) {
  const profile = agentProfileFor(normalized, agentId)
  const entries = []
  const seen = new Set()
  const add = (selector, description = '') => {
    if (seen.has(selector)) return
    seen.add(selector)
    entries.push({ selector, description })
  }
  for (const provider of providersFor(normalized)) {
    for (const model of provider.models ?? []) add(`${provider.name}/${model.id}`, model.description ?? '')
  }
  for (const alias of Object.keys(normalized.aliases ?? {})) add(alias)
  // A profile/default model wins when it names a model we can actually route.
  // Otherwise start on the default provider's first model, mirroring the
  // gateway's own fallback, and fall back to the first published selector.
  const resolveSelector = (candidate) => {
    const text = String(candidate ?? '')
    if (!text) return ''
    if (seen.has(text)) return text
    const aliasTarget = normalized.aliases[text]
    if (aliasTarget && seen.has(aliasTarget)) return aliasTarget
    for (const provider of providersFor(normalized)) {
      if ((provider.models ?? []).some((model) => model.id === text)) {
        const selector = `${provider.name}/${text}`
        if (seen.has(selector)) return selector
      }
    }
    return ''
  }
  const defaultProvider = providerByName(normalized, normalized.defaultProvider) ?? providersFor(normalized)[0]
  const firstModel = defaultProvider?.models?.[0]
  const model = resolveSelector(profile?.model) || resolveSelector(normalized.defaultModel)
    || (firstModel ? `${defaultProvider.name}/${firstModel.id}` : entries[0]?.selector ?? '')
  return { entries, model }
}

// OpenCode reads providers from its own config file, not from OPENAI_BASE_URL,
// so pointing it at the gateway also means publishing the gateway's model list.
// The generated document defines one openai-compatible provider that sends
// every selector back through the router (`provider/model` ids are resolved by
// the gateway). A keyed provider's model map is authoritative: disabled
// providers are omitted, exactly like the gateway's /v1/models response.
export function buildOpenCodeConfig(config, { base, token, agentId = '' } = {}) {
  const normalized = normalizeConfig(config)
  const { entries, model } = routerModelEntries(normalized, agentId)
  const models = {}
  for (const { selector, description } of entries) {
    models[selector] = { name: description ? `${selector} — ${description}` : selector }
  }
  const provider = 'orca-router'
  const document = {
    $schema: 'https://opencode.ai/config.json',
    ...(model ? { model: `${provider}/${model}`, small_model: `${provider}/${model}` } : {}),
    // Stale router configs (for example CCR's provider) would otherwise stay
    // selectable and send traffic to a dead port. The plugin owns routing for
    // this launch, so hide that provider instead of editing the user's file.
    disabled_providers: ['claude-code-router'],
    provider: {
      [provider]: {
        name: 'Orca LLM Router',
        npm: '@ai-sdk/openai-compatible',
        options: { apiKey: token, baseURL: `${base}/v1` },
        models
      }
    }
  }
  return { document, model, provider }
}

// Codex builds its /model picker from a catalog file instead of querying the
// provider. The launch hook points `model_catalog_json` at this document and
// defines `model_providers.orca-router` for the selected slug. Standard function
// tools are used instead of code mode, so providers see ordinary function calls;
// the gateway adapts Codex's freeform apply_patch tool for chat-only providers.
// The remaining fields mirror the schema Codex's bundled catalog ships with.
const CODEX_CATALOG_TEMPLATE = {
  default_reasoning_level: 'medium',
  supported_reasoning_levels: [
    { effort: 'low', description: 'Fast responses with lighter reasoning' },
    { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
    { effort: 'high', description: 'Greater reasoning depth for complex problems' }
  ],
  shell_type: 'shell_command',
  visibility: 'list',
  supported_in_api: true,
  additional_speed_tiers: [],
  service_tiers: [],
  availability_nux: null,
  upgrade: null,
  model_messages: {},
  include_skills_usage_instructions: false,
  include_plugin_usage_instructions: false,
  include_apps_usage_instructions: false,
  default_reasoning_summary: 'none',
  support_verbosity: false,
  default_verbosity: null,
  apply_patch_tool_type: 'freeform',
  web_search_tool_type: 'text_and_image',
  truncation_policy: { mode: 'tokens', limit: 10000 },
  supports_image_detail_original: false,
  context_window: 128000,
  max_context_window: 128000,
  comp_hash: null,
  effective_context_window_percent: 95,
  experimental_supported_tools: [],
  input_modalities: ['text'],
  supports_search_tool: true,
  supports_experimental_context: false,
  use_responses_lite: false,
  supports_reasoning_effort_updates: false,
  node_repl_auto_review_required: false,
  node_repl_disabled: false,
  multi_agent_version: null,
  multi_agent_reasoning_effort: null,
  base_instructions: 'You are a coding agent.'
}

// Codex requires every catalog entry to carry the full ModelInfo shape, so the
// template above is spread into each entry rather than emitted as a bare list
// of ids. Aliases are included because the gateway resolves them too, and the
// default model uses the same profile/default fallback as OpenCode.
export function buildCodexModelCatalog(config, { agentId = '' } = {}) {
  const normalized = normalizeConfig(config)
  const { entries, model } = routerModelEntries(normalized, agentId)
  const models = entries.map(({ selector, description }, index) => ({
    ...CODEX_CATALOG_TEMPLATE,
    slug: selector,
    display_name: selector,
    description: description || `Orca LLM Router model ${selector}`,
    priority: index + 1
  }))
  return { document: { models }, model }
}

// Merge the generated OpenCode provider into a user's existing document without
// touching unrelated settings (MCP servers, agents, other providers). Legacy
// router providers are removed and their model ids repointed, so a stale CCR
// entry cannot keep receiving traffic after the switch.
export function mergeOpenCodeConfig(existing, generated, legacyProviders = ['claude-code-router']) {
  const document = structuredClone(existing && typeof existing === 'object' ? existing : {})
  const published = generated?.provider?.['orca-router']
  if (!published) return document
  const models = published.models ?? {}
  const defaultRef = generated.model ?? ''
  const defaultSelector = defaultRef.startsWith('orca-router/') ? defaultRef.slice('orca-router/'.length) : ''
  const selectorFor = (modelId) => (models[modelId] ? modelId : defaultSelector)
  const provider = { ...(document.provider ?? {}) }
  for (const legacy of legacyProviders) delete provider[legacy]
  provider['orca-router'] = published
  document.provider = provider
  const remapString = (value) => {
    if (typeof value !== 'string') return value
    for (const legacy of legacyProviders) {
      const prefix = `${legacy}/`
      if (value.startsWith(prefix)) return `orca-router/${selectorFor(value.slice(prefix.length))}`
    }
    return value
  }
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (!value || typeof value !== 'object') return
    for (const legacy of legacyProviders) {
      if (value.providerID === legacy && typeof value.model === 'string') {
        value.providerID = 'orca-router'
        value.model = selectorFor(value.model)
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') value[key] = remapString(entry)
      else walk(entry)
    }
  }
  walk(document)
  if (!document.model && defaultRef) document.model = defaultRef
  if (!document.small_model && defaultRef) document.small_model = defaultRef
  return document
}

// Undo mergeOpenCodeConfig's published provider: drop `orca-router` and the
// default model refs that point at it, leaving everything else as it is.
// Returns null when the document carries nothing of ours.
export function removeOpenCodeRouterProvider(existing) {
  if (!existing || typeof existing !== 'object' || !existing.provider?.['orca-router']) return null
  const document = structuredClone(existing)
  delete document.provider['orca-router']
  if (!Object.keys(document.provider).length) delete document.provider
  for (const key of ['model', 'small_model']) {
    if (typeof document[key] === 'string' && document[key].startsWith('orca-router/')) delete document[key]
  }
  return document
}

// Localhost should never be sent through a corporate proxy: add the loopback
// hosts to whatever NO_PROXY the launch already carries.
function mergeNoProxy(value) {
  const hosts = String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    if (!hosts.includes(host)) hosts.push(host)
  }
  return hosts.join(',')
}

function buildChainFromFallback(config, primarySelector, fallback) {
  const chain = []
  const seen = new Set()
  const addTarget = (target) => {
    if (!target?.provider) return
    const key = `${target.provider.name}/${target.model}`
    if (seen.has(key)) return
    seen.add(key)
    chain.push(target)
  }
  const primary = resolveProviderTarget(config, primarySelector)
  addTarget(primary)
  const bare = primary?.model ?? primarySelector
  for (const entry of fallback?.models ?? []) {
    if (typeof entry === 'string' && !entry.includes('/')) {
      const named = providerByName(config, entry)
      if (named) { addTarget({ provider: named, model: bare }); continue }
    }
    addTarget(resolveProviderTarget(config, entry, bare))
  }
  return chain
}

export function resolveChain(config, model) {
  const normalized = normalizeConfig(config)
  const chain = buildChainFromFallback(normalized, model, normalized.defaultFallback)
  return chain
}

function applyRulesForModel(config, body, headers) {
  let matchedRule = null
  for (const rule of config.routes) {
    if (rule.enabled === false) continue
    if (!evaluateCondition(rule.condition, { headers, body })) continue
    matchedRule = rule
    if (rule.model && body.model == null) body.model = rule.model
    applyRewrites(body, headers, rule.rewrites)
    break
  }
  return matchedRule
}

// ---------------------------------------------------------------------------
// Credential pools with limits.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Rate-limit window helpers (pruned to bound memory under sustained traffic).
// ---------------------------------------------------------------------------
function pruneTimestamps(timestamps, windowMs, now) {
  const cutoff = now - windowMs
  while (timestamps.length && timestamps[0] < cutoff) timestamps.shift()
  if (timestamps.length > MAX_WINDOW_ENTRIES) timestamps.splice(0, timestamps.length - MAX_WINDOW_ENTRIES)
  return timestamps
}

function pruneTokenEntries(entries, windowMs, now) {
  const cutoff = now - windowMs
  while (entries.length && entries[0].at < cutoff) entries.shift()
  if (entries.length > MAX_WINDOW_ENTRIES) entries.splice(0, entries.length - MAX_WINDOW_ENTRIES)
  return entries
}

function rateWindowCount(timestamps, windowMs, now) {
  const cutoff = now - windowMs
  let count = 0
  for (let i = timestamps.length - 1; i >= 0; i--) {
    if (timestamps[i] >= cutoff) count++
  }
  return count
}

function tokensInWindow(entries, windowMs, now) {
  const cutoff = now - windowMs
  let total = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].at >= cutoff) total += entries[i].tokens
  }
  return total
}

function recordInWindow(timestamps, at, maxWindowMs) {
  timestamps.push(at)
  pruneTimestamps(timestamps, maxWindowMs, at)
}

function recordTokensInWindow(entries, entry, maxWindowMs) {
  entries.push(entry)
  pruneTokenEntries(entries, maxWindowMs, entry.at)
}

function keyWithinLimits(key, state, now, estimatedTokens, imageCount) {
  const limits = key.limits ?? {}
  const windows = [
    ['rpm', 60_000, 'requests'], ['rph', 3_600_000, 'requests'], ['rpd', 86_400_000, 'requests'],
    ['tpm', 60_000, 'tokens'], ['tph', 3_600_000, 'tokens'], ['tpd', 86_400_000, 'tokens'],
    ['ipm', 60_000, 'images'], ['iph', 3_600_000, 'images'], ['ipd', 86_400_000, 'images']
  ]
  for (const [field, windowMs, kind] of windows) {
    const limit = limits[field]
    if (!limit) continue
    const used = kind === 'requests' ? rateWindowCount(state.requests, windowMs, now)
      : kind === 'tokens' ? tokensInWindow(state.tokens, windowMs, now)
      : rateWindowCount(state.images, windowMs, now)
    const needed = kind === 'tokens' ? estimatedTokens : kind === 'images' ? imageCount : 1
    if (used + needed > limit) return false
  }
  if (limits.maxRequests && rateWindowCount(state.requests, Number(limits.windowMs ?? 86_400_000), now) >= Number(limits.maxRequests)) return false
  if (limits.maxTokens && tokensInWindow(state.tokens, Number(limits.quotaWindowMs ?? 86_400_000), now) + estimatedTokens > Number(limits.maxTokens)) return false
  return true
}

function countImages(body) {
  let count = 0
  const walk = (value) => {
    if (!value || typeof value !== 'object') return
    if (value.type === 'image_url' || value.type === 'image' || value.type === 'input_image') count++
    for (const child of Object.values(value)) walk(child)
  }
  walk(body)
  return count
}

export function estimateTokens(body) {
  let text = ''
  if (body?.messages) text += JSON.stringify(body.messages)
  if (body?.input) text += typeof body.input === 'string' ? body.input : JSON.stringify(body.input)
  if (body?.instructions) text += String(body.instructions)
  if (body?.system) text += contentText(body.system)
  return Math.max(1, Math.ceil(text.length / 4))
}

// ---------------------------------------------------------------------------
// Server.
// ---------------------------------------------------------------------------
function isLoopbackHost(host) {
  const text = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  return text === '127.0.0.1' || text === 'localhost' || text === '::1' || text === '0:0:0:0:0:0:0:1'
}

const REDACTED = '[REDACTED]'
const SENSITIVE_KEYS = /^(authorization|proxy-authorization|x-api-key|x-goog-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|secret[-_]?key|password|passwd|cookie|set-cookie|client[-_]?secret|private[-_]?key)$/i

function redactValue(value, depth = 0) {
  if (depth > 6 || value == null) return value
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[key] = SENSITIVE_KEYS.test(key) ? REDACTED : redactValue(entry, depth + 1)
    return out
  }
  if (typeof value === 'string' && value.length > 256 && /^(sk-|rk-|AIza|Bearer\s)/.test(value)) return REDACTED
  return value
}

export function truncateText(text, limit = LOG_BODY_LIMIT) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit)}…[truncated]` : value
}

export function safeCaptureBody(raw, limit = LOG_BODY_LIMIT) {
  if (raw == null || raw === '') return undefined
  if (Buffer.isBuffer(raw)) return safeCaptureBody(raw.toString('utf8'), limit)
  if (typeof raw === 'string') {
    if (raw.includes('data:')) {
      const lines = raw.split(/\r?\n/)
      const redacted = []
      let total = 0
      for (const line of lines) {
        if (total > limit) break
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim()
          if (payload && payload !== '[DONE]') {
            try {
              const parsed = JSON.parse(payload)
              const cleaned = JSON.stringify(redactValue(parsed))
              redacted.push(`data: ${cleaned}`)
              total += cleaned.length + 7
              continue
            } catch { /* fall through to raw line */ }
          }
        }
        redacted.push(line)
        total += line.length + 1
      }
      return truncateText(redacted.join('\n'), limit)
    }
    if (raw.length > limit) return truncateText(raw, limit)
    try {
      const parsed = JSON.parse(raw)
      const redacted = redactValue(parsed)
      const serialized = JSON.stringify(redacted)
      if (serialized && serialized.length > limit) return truncateText(serialized, limit)
      return redacted
    } catch {
      return truncateText(raw, limit)
    }
  }
  try {
    const serialized = JSON.stringify(redactValue(raw))
    if (serialized && serialized.length > limit) return truncateText(serialized, limit)
    return JSON.parse(serialized)
  } catch {
    return undefined
  }
}

function shouldCollectLog(mode, status) {
  if (mode === 'none') return false
  if (mode === 'all') return true
  return status >= 400
}

function isChatPath(path) {
  return path === '/v1/chat/completions' || path === '/v1/messages' || path === '/v1/responses'
    || /^\/v1beta\/models\/[^/]+:(generateContent|streamGenerateContent)$/.test(path)
}

export function createSidecar({ getConfig, getSecret, fetchImpl, onLog, now = Date.now }) {
  const fetchFn = fetchImpl ?? globalThis.fetch
  const logs = []
  let server = null
  let bound = null
  const keyStates = new Map() // credential secretKey/id -> {requests:[], tokens:[], images:[]}
  const keyCooldowns = new Map() // credential identity -> timestamp it becomes usable again
  const keyCursors = new Map() // provider name -> next round-robin index
  const stats = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cost: 0, latencyMsTotal: 0, byProvider: {}, byModel: {} }

  const log = (entry, { config, status } = {}) => {
    const captureMode = config?.logBodyCapture ?? 'errors'
    const resolvedStatus = status ?? entry.status ?? 0
    const collectBodies = shouldCollectLog(captureMode, resolvedStatus)
    // "none" disables request logging entirely (no stored records, no onLog emission)
    // while core stats/usage are still maintained via aggregate counters and patched entries.
    const loggingEnabled = captureMode !== 'none'
    const record = { at: now(), ...entry }
    if (!collectBodies) {
      delete record.requestBody
      delete record.responseBody
      delete record.requestHeaders
      delete record.responseHeaders
    } else {
      if (record.requestBody != null) record.requestBody = safeCaptureBody(record.requestBody)
      if (record.responseBody != null) record.responseBody = safeCaptureBody(record.responseBody)
      if (record.requestHeaders != null) record.requestHeaders = redactValue(record.requestHeaders)
      if (record.responseHeaders != null) record.responseHeaders = redactValue(record.responseHeaders)
    }
    stats.requests++
    if (record.status >= 400) stats.errors++
    if (record.tokens) {
      stats.inputTokens += record.tokens.input ?? 0
      stats.outputTokens += record.tokens.output ?? 0
    }
    if (record.cost != null) stats.cost += record.cost
    if (record.latencyMs != null) stats.latencyMsTotal += record.latencyMs
    if (record.resolvedProvider) stats.byProvider[record.resolvedProvider] = (stats.byProvider[record.resolvedProvider] ?? 0) + 1
    if (record.resolvedModel) stats.byModel[record.resolvedModel] = (stats.byModel[record.resolvedModel] ?? 0) + 1
    if (loggingEnabled) {
      logs.push(record)
      if (logs.length > 300) logs.splice(0, logs.length - 300)
      try { onLog?.(record) } catch { /* logging must never break routing */ }
      return record
    }
    return record
  }

  // Usage is only known after the upstream body is read, so records are created
  // with tokens/cost null and patched here. Keep the aggregate stats in sync by
  // applying the delta. When logging is disabled the record may not be stored,
  // but its stats were counted at log() time.
  const applyUsage = (record, tokens, cost) => {
    if (!record) return
    const previousTokens = record.tokens
    const previousCost = record.cost
    record.tokens = tokens ?? null
    record.cost = cost ?? null
    if (previousTokens) {
      stats.inputTokens -= previousTokens.input ?? 0
      stats.outputTokens -= previousTokens.output ?? 0
    }
    if (previousCost != null) stats.cost -= previousCost
    if (tokens) {
      stats.inputTokens += tokens.input ?? 0
      stats.outputTokens += tokens.output ?? 0
    }
    if (cost != null) stats.cost += cost
  }

  const keyState = (id) => {
    if (keyStates.size > 4000) {
      const t = now()
      for (const [stateId, state] of keyStates) {
        const recent = (state.requests?.length ? state.requests[state.requests.length - 1] : 0)
          || (state.tokens?.length ? state.tokens[state.tokens.length - 1]?.at : 0)
          || (state.images?.length ? state.images[state.images.length - 1] : 0)
        if (!recent || t - recent > 86_400_000) keyStates.delete(stateId)
      }
    }
    if (!keyStates.has(id)) keyStates.set(id, { requests: [], tokens: [], images: [] })
    return keyStates.get(id)
  }

  const keyIdentity = (key) => key?.secretKey ?? key?.id ?? ''

  const pickKey = (provider, config, estimatedTokens, imageCount) => {
    const timestamp = now()
    const keys = (provider.keys ?? []).filter((key) => key.enabled !== false)
    if (!keys.length) return null
    // Keys that recently failed are skipped so later calls keep rotating. When
    // every key is cooling we fall back to the full pool rather than failing.
    const cooled = keys.filter((key) => (keyCooldowns.get(keyIdentity(key)) ?? 0) <= timestamp)
    const candidates = cooled.length ? cooled : keys
    const usable = candidates.filter((key) => keyWithinLimits(key, keyState(keyIdentity(key)), timestamp, estimatedTokens, imageCount))
    const pool = usable.length ? usable : candidates
    const sorted = [...pool].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || (b.weight ?? 1) - (a.weight ?? 1))
    // Round-robin across the whole usable pool; priority only orders the cycle.
    const cursor = keyCursors.get(provider.name) ?? 0
    const chosen = sorted[cursor % sorted.length]
    keyCursors.set(provider.name, (cursor + 1) % sorted.length)
    return chosen
  }

  const markKeyFailure = (key, status) => {
    if (!key) return
    const cooldown = KEY_COOLDOWN_MS[status]
    if (!cooldown) return
    if (keyCooldowns.size > 2000) {
      const t = now()
      for (const [id, until] of keyCooldowns) if (until <= t) keyCooldowns.delete(id)
    }
    keyCooldowns.set(keyIdentity(key), now() + cooldown)
  }

  const clearKeyFailure = (key) => {
    if (!key) return
    keyCooldowns.delete(keyIdentity(key))
  }

  const recordKeyUsage = (key, tokens, imageCount) => {
    if (!key) return
    const state = keyState(key.secretKey ?? key.id)
    const timestamp = now()
    recordInWindow(state.requests, timestamp, 86_400_000)
    if (tokens) recordTokensInWindow(state.tokens, { at: timestamp, tokens }, 86_400_000)
    for (let i = 0; i < imageCount; i++) recordInWindow(state.images, timestamp, 86_400_000)
  }

  const buildHeaders = (provider, key, incoming, protocol, extraHeaders = {}) => {
    const headers = { ...extraHeaders }
    // Provider auth is explicit: never forward the caller's gateway credentials
    // to an upstream provider. Opt in per key with `forwardClientAuth` only for
    // providers that intentionally trust the client's own credential.
    if (protocol === 'gemini') {
      const secret = key ? getSecret(key.secretKey) ?? null : null
      const value = secret ?? (key?.forwardClientAuth ? incoming.headers['x-goog-api-key'] : null) ?? null
      if (value) headers['x-goog-api-key'] = value
    } else {
      const secret = key ? getSecret(key.secretKey) ?? null : null
      const value = secret ?? (key?.forwardClientAuth ? incoming.headers.authorization?.replace(/^Bearer\s+/i, '') : null) ?? null
      if (value) {
        headers.authorization = `Bearer ${value}`
        headers['x-api-key'] = value
      }
      if (key?.forwardClientAuth) {
        if (!headers.authorization && incoming.headers.authorization) headers.authorization = incoming.headers.authorization
        if (!headers['x-api-key'] && incoming.headers['x-api-key']) headers['x-api-key'] = incoming.headers['x-api-key']
      }
      if (protocol === 'anthropic') {
        headers['anthropic-version'] = incoming.headers['anthropic-version'] ?? '2023-06-01'
        if (incoming.headers['anthropic-beta']) headers['anthropic-beta'] = incoming.headers['anthropic-beta']
      }
    }
    headers['content-type'] = incoming.headers['content-type'] ?? 'application/json'
    return headers
  }

  const endpointFor = (provider, protocol) => {
    if (Array.isArray(provider.endpoints) && provider.endpoints.length) {
      const match = provider.endpoints.find((endpoint) => (endpoint.protocols ?? []).includes(protocol))
      if (match) return match.baseUrl
      return provider.endpoints[0]?.baseUrl ?? provider.baseUrl
    }
    return provider.baseUrl
  }

  const targetProtocol = (provider, pathProtocol) => {
    const protocols = provider.protocols ?? []
    if (protocols.includes(pathProtocol)) return pathProtocol
    // Cross-protocol via OpenAI chat as the common denominator.
    if (protocols.includes('openai') || protocols.includes('passthrough')) return 'openai'
    if (protocols.includes('anthropic')) return 'anthropic'
    if (protocols.includes('responses')) return 'responses'
    // A provider that only speaks native Gemini gets the Gemini translation.
    if (protocols.includes('gemini')) return 'gemini'
    return 'openai'
  }

  const canonicalPath = (protocol, originalPath) => {
    if (protocol === 'anthropic') return '/v1/messages'
    if (protocol === 'responses') return '/v1/responses'
    if (protocol === 'openai') return '/v1/chat/completions'
    return originalPath
  }

  // Gemini carries the model in the URL and streams from a different method.
  const geminiPath = (model, wantsStream) =>
    `/v1beta/models/${encodeURIComponent(String(model ?? ''))}:${wantsStream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`

  const translateRequest = (body, from, to) => {
    if (from === to) return body
    if (to === 'gemini') {
      if (from === 'anthropic') return openAIToGemini(anthropicToOpenAI(body))
      if (from === 'responses') return openAIToGemini(responsesToOpenAI(body))
      return openAIToGemini(body)
    }
    if (from === 'anthropic' && to === 'openai') return anthropicToOpenAI(body)
    if (from === 'openai' && to === 'anthropic') return openAIToAnthropic(body)
    if (from === 'responses' && to === 'openai') return responsesToOpenAI(body)
    if (from === 'openai' && to === 'responses') return { ...body } // unsupported direct; handled via responses translator
    if (from === 'anthropic' && to === 'responses') return { ...anthropicToOpenAI(body) }
    if (from === 'responses' && to === 'anthropic') return openAIToAnthropic(responsesToOpenAI(body))
    return body
  }

  const translateResponse = (raw, from, to, model) => {
    if (from === to) return raw
    if (from === 'gemini') {
      const openai = geminiResponseToOpenAI(raw, model)
      if (to === 'openai') return openai
      if (to === 'anthropic') return openAIResponseToAnthropic(openai, model)
      if (to === 'responses') return openAIResponseToResponses(openai, model)
      return openai
    }
    if (from === 'openai' && to === 'anthropic') return openAIResponseToAnthropic(raw, model)
    if (from === 'anthropic' && to === 'openai') return anthropicResponseToOpenAI(raw, model)
    if (from === 'openai' && to === 'responses') return openAIResponseToResponses(raw, model)
    if (from === 'anthropic' && to === 'responses') return openAIResponseToResponses(anthropicResponseToOpenAI(raw, model), model)
    if (from === 'openai' && to === 'openai') return raw
    return raw
  }

  const extractUsage = (raw, protocol) => {
    if (protocol === 'gemini') {
      const usage = raw?.usageMetadata ?? {}
      return { input: usage.promptTokenCount ?? 0, output: usage.candidatesTokenCount ?? 0, cache: usage.cachedContentTokenCount ?? 0 }
    }
    const usage = raw?.usage ?? {}
    if (protocol === 'anthropic') return { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cache: (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) }
    if (protocol === 'responses') return { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 }
    return { input: usage.prompt_tokens ?? usage.input_tokens ?? 0, output: usage.completion_tokens ?? usage.output_tokens ?? 0, cache: usage.prompt_tokens_details?.cached_tokens ?? 0 }
  }

  // Streaming responses report usage across several events: Anthropic puts input
  // tokens on message_start and output tokens on message_delta, OpenAI puts a
  // final usage chunk (when requested), and Responses puts it on response.completed.
  const mergeStreamUsage = (acc, event, protocol) => {
    const mergeOne = (usage) => {
      if (!usage || typeof usage !== 'object') return
      const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount ?? 0
      const output = usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount ?? 0
      const cache = (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.prompt_tokens_details?.cached_tokens ?? 0) + (usage.cachedContentTokenCount ?? 0)
      if (!input && !output && !cache) return
      acc ??= { input: 0, output: 0, cache: 0 }
      if (input) acc.input = input
      if (output) acc.output = output
      if (cache) acc.cache = cache
    }
    if (protocol === 'anthropic') {
      mergeOne(event?.message?.usage)
      mergeOne(event?.usage)
    } else if (protocol === 'responses') {
      mergeOne(event?.response?.usage)
      mergeOne(event?.usage)
    } else if (protocol === 'gemini') {
      mergeOne(event?.usageMetadata)
      mergeOne(event?.usage)
    } else {
      mergeOne(event?.usage)
      mergeOne(event?.response?.usage)
    }
    return acc
  }

  const computeCost = (pricing, tokens) => {
    if (!pricing) return null
    const input = tokens.input ?? 0
    const output = tokens.output ?? 0
    const inputRate = pricing.inputUsdPerMillionTokens ?? 0
    const outputRate = pricing.outputUsdPerMillionTokens ?? 0
    if (!inputRate && !outputRate) return null
    return (input / 1e6) * inputRate + (output / 1e6) * outputRate
  }

  const clientLimitError = (state, limits, timestamp, imageCount = 0) => {
    const requests = (windowMs) => rateWindowCount(state.requests, windowMs, timestamp)
    const tokens = (windowMs) => tokensInWindow(state.tokens, windowMs, timestamp)
    const images = (windowMs) => rateWindowCount(state.images, windowMs, timestamp)
    if (limits.rpm && requests(60_000) >= limits.rpm) return 'client API key request rate limit reached'
    if (limits.rph && requests(3_600_000) >= limits.rph) return 'client API key request rate limit reached'
    if (limits.rpd && requests(86_400_000) >= limits.rpd) return 'client API key request rate limit reached'
    // Token totals can only be checked after the fact, so the pre-request gate
    // blocks once the window is already spent.
    if (limits.tpm && tokens(60_000) >= limits.tpm) return 'client API key token rate limit reached'
    if (limits.tph && tokens(3_600_000) >= limits.tph) return 'client API key token rate limit reached'
    if (limits.tpd && tokens(86_400_000) >= limits.tpd) return 'client API key token rate limit reached'
    if (limits.ipm && images(60_000) + imageCount > limits.ipm) return 'client API key image rate limit reached'
    if (limits.iph && images(3_600_000) + imageCount > limits.iph) return 'client API key image rate limit reached'
    if (limits.ipd && images(86_400_000) + imageCount > limits.ipd) return 'client API key image rate limit reached'
    if (limits.maxRequests && requests(Number(limits.windowMs ?? 86_400_000)) >= Number(limits.maxRequests)) return 'client API key request quota reached'
    if (limits.maxTokens && tokens(Number(limits.quotaWindowMs ?? 86_400_000)) >= Number(limits.maxTokens)) return 'client API key token quota reached'
    return null
  }

  const clientAuth = (config, headers, imageCount = 0) => {
    const clientKeys = config.clientKeys ?? []
    if (!clientKeys.length) {
      // Loopback-only by default; refuse unauthenticated access when the gateway
      // is exposed on a non-loopback host unless the operator explicitly opts in.
      if (!isLoopbackHost(config.bindHost ?? '127.0.0.1') && config.allowUnauthenticatedRemote !== true) {
        return { ok: false, status: 401, message: 'client API keys are required when the gateway binds to a non-loopback host' }
      }
      return { ok: true, state: null }
    }
    const provided = headers.authorization?.replace(/^Bearer\s+/i, '') ?? headers['x-api-key'] ?? headers['x-auth-api-key'] ?? ''
    if (!provided) return { ok: false, status: 401, message: 'missing client API key' }
    if (provided === config.token) return { ok: true, state: null } // internal launch token always accepted
    const timestamp = now()
    const match = clientKeys.find((key) => {
      if (key.enabled === false) return false
      if (key.expiresAt && new Date(key.expiresAt).getTime() < timestamp) return false
      return getSecret(key.secretKey) === provided
    })
    if (!match) return { ok: false, status: 401, message: 'invalid client API key' }
    const state = keyState(`client:${match.id}`)
    const limitError = clientLimitError(state, match.limits ?? {}, timestamp, imageCount)
    if (limitError) return { ok: false, status: 429, message: limitError }
    recordInWindow(state.requests, timestamp, 86_400_000)
    return { ok: true, state }
  }

  const recordClientUsage = (state, tokens, imageCount = 0) => {
    if (!state) return
    const timestamp = now()
    if (tokens) recordTokensInWindow(state.tokens, { at: timestamp, tokens: (tokens.input ?? 0) + (tokens.output ?? 0) }, 86_400_000)
    for (let i = 0; i < imageCount; i++) recordInWindow(state.images, timestamp, 86_400_000)
  }

  const imageGenerationCount = (path, body) => {
    if (!/\/images\/(generations|edits)$/.test(path)) return 0
    const n = Number(body?.n ?? 1)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1
  }

  async function forwardOnce(target, clientProtocol, path, body, incoming, { rawBody, wantsStreamHint } = {}) {
    const config = configRef()
    const provider = target.provider
    const responseProtocol = targetProtocol(provider, clientProtocol)
    const baseUrl = endpointFor(provider, responseProtocol)
    const chat = isChatPath(path)
    const wantsStream = wantsStreamHint ?? body?.stream === true
    const geminiStreamUpstream = responseProtocol === 'gemini' && clientProtocol === 'gemini' && wantsStream === true
    let targetPath = path
    if (responseProtocol === 'gemini' && chat) targetPath = geminiPath(target.model, geminiStreamUpstream)
    else if (responseProtocol !== clientProtocol && chat) targetPath = canonicalPath(responseProtocol, path)
    else if (responseProtocol !== clientProtocol && !chat) targetPath = path
    const url = joinUpstreamUrl(baseUrl, targetPath)
    let upstreamBody = body ? structuredClone(body) : null
    // Codex sends apply_patch/code-mode as grammar-constrained custom tools.
    // Keep the grammar only for endpoints known to accept it; everyone else
    // gets the text-format custom tool the Responses spec also allows.
    if (upstreamBody && clientProtocol === 'responses') {
      let supportsGrammar = provider.supportsCustomToolGrammar === true
      if (!supportsGrammar) {
        try {
          supportsGrammar = /(^|\.)openai\.com$/i.test(new URL(endpointFor(provider, 'responses')).hostname)
        } catch {
          /* non-URL base: assume no grammar support */
        }
      }
      upstreamBody = normalizeResponsesCustomTools(upstreamBody, { supportsGrammar })
    }
    // The chain has already resolved the client selector (provider/model or an
    // alias) to a provider + bare upstream model. Providers expect their own
    // model id, so never leak the routing prefix or alias upstream.
    if (upstreamBody && target.model) upstreamBody.model = target.model
    let bufferForStream = false
    let payload = null
    if (upstreamBody != null && chat) {
      if (responseProtocol !== clientProtocol) {
        const translated = translateRequest(upstreamBody, clientProtocol, responseProtocol)
        if (wantsStream && responseProtocol === 'gemini') delete translated.stream
        else if (wantsStream) translated.stream = false
        payload = JSON.stringify(translated)
        bufferForStream = wantsStream && clientProtocol !== 'gemini'
      } else {
        if (responseProtocol === 'gemini' && wantsStream) {
          const translated = structuredClone(upstreamBody)
          delete translated.stream
          payload = JSON.stringify(translated)
          bufferForStream = false
        } else {
          payload = JSON.stringify(upstreamBody)
        }
      }
    } else if (upstreamBody != null) {
      payload = JSON.stringify(upstreamBody)
    } else if (rawBody != null && rawBody.length) {
      payload = rawBody
    }
    const estimated = estimateTokens(upstreamBody)
    const imageCount = countImages(upstreamBody)
    const key = pickKey(provider, config, estimated, imageCount)
    const headers = buildHeaders(provider, key, incoming, responseProtocol)
    // Never leak the client's gateway auth to providers.
    delete headers['x-auth-api-key']
    const hasConfiguredSecrets = (provider.keys ?? []).some((k) => k.enabled !== false && getSecret(k.secretKey))
    if (key) {
      const secret = getSecret(key.secretKey)
      if (!secret && !key.forwardClientAuth) {
        return { error: { status: 502, message: `no usable credential for provider '${provider.name}' (missing secret for selected key)` } }
      }
    } else if (hasConfiguredSecrets) {
      return { error: { status: 429, message: `no usable credential for provider '${provider.name}' (keys limited or cooling down)` } }
    }
    // Providers with no configured keys are treated as keyless/pass-through at
    // the provider side; client gateway auth is still never forwarded upstream.
    const upstreamRes = await fetchFn(url, {
      method: incoming.method,
      headers,
      body: payload != null && (Buffer.isBuffer(payload) ? payload.length : String(payload).length) ? payload : undefined,
      signal: AbortSignal.timeout(config.timeoutMs ?? 600000)
    })
    return { upstreamRes, responseProtocol, forwardedModel: target.model, key, bufferForStream, wantsStream, targetPath }
  }

  async function pipe(req, res) {
    const config = configRef()
    const chunks = []
    for await (const chunk of req) {
      chunks.push(chunk)
      if (chunks.reduce((n, c) => n + c.length, 0) > SIDECAR_MAX_BODY_BYTES) {
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'request body too large' } }))
        return
      }
    }
    const rawBody = Buffer.concat(chunks)
    let body = null
    let bodyParseError = false
    if (rawBody.length && (req.headers['content-type'] ?? '').includes('json')) {
      try { body = JSON.parse(rawBody.toString('utf8')) } catch { bodyParseError = true }
    }
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname

    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, providers: config.providers.map((p) => p.name), upstreams: config.providers.map((p) => p.name), at: now() }))
      return
    }
    if (req.method === 'GET' && path === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(listModels(config)))
      return
    }
    if (bodyParseError) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'request body is not valid JSON', type: 'invalid_request_error', code: 'invalid_json' } }))
      return
    }

    const geminiClientMatch = path.match(/^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/)
    const clientProtocol = path.startsWith('/v1/messages') ? 'anthropic'
      : path.startsWith('/v1/responses') ? 'responses'
      : path.startsWith('/v1/chat/completions') ? 'openai'
      : geminiClientMatch ? 'gemini' : 'openai'
    const requestedModel = body?.model ?? (geminiClientMatch ? decodeURIComponent(geminiClientMatch[1]) : (req.headers['x-router-model'] ?? ''))
    const wantsStream = body?.stream === true || geminiClientMatch?.[2] === 'streamGenerateContent'
    const clientImageCount = imageGenerationCount(path, body)
    const chatRequest = isChatPath(path) || Boolean(body && (body.model || body.messages || body.input || body.contents || body.instructions || body.system))

    const auth = clientAuth(config, req.headers, clientImageCount)
    if (!auth.ok) {
      res.writeHead(auth.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: auth.message } }))
      return
    }

    // Apply routing rules (conditions + rewrites) to a mutable copy.
    const workingBody = body ? structuredClone(body) : null
    if (workingBody && !workingBody.model && requestedModel) workingBody.model = requestedModel
    const headers = {}
    for (const [name, value] of Object.entries(req.headers)) headers[String(name).toLowerCase()] = Array.isArray(value) ? value[0] : value
    const matchedRule = workingBody ? applyRulesForModel(config, workingBody, headers) : null
    const effectiveModel = workingBody?.model ?? requestedModel
    const fallback = matchedRule?.fallback ?? config.defaultFallback
    const chain = chatRequest ? buildChainFromFallback(config, effectiveModel, fallback) : []
    if (!chain.length) {
      if (!chatRequest) {
        // Passthrough for non-chat endpoints (embeddings, audio, unknown paths):
        // route via default provider when configured, preserving body/stream.
        const passthroughProvider = providerByName(config, config.defaultProvider) ?? providersFor(config)[0]
        if (passthroughProvider) chain.push({ provider: passthroughProvider, model: effectiveModel || requestedModel })
      }
    }
    if (!chain.length) {
      const missingModel = !effectiveModel && chatRequest
      const status = missingModel ? 400 : 404
      const entry = log({ upstream: null, resolvedProvider: null, resolvedModel: effectiveModel, protocol: clientProtocol, status, latencyMs: 0, attempts: [], error: missingModel ? 'no model specified' : 'no provider configured for model', requestBody: workingBody, requestHeaders: redactValue(req.headers) }, { config, status })
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: missingModel
          ? { message: 'no model was specified and no default model could be resolved', type: 'invalid_request_error', code: 'model_required' }
          : { message: `no provider could resolve model '${effectiveModel}'`, type: 'invalid_request_error', code: 'model_not_found' }
      }))
      return entry && undefined
    }

    const retryCount = fallback?.mode === 'retry' ? Number(fallback.retryCount ?? config.retries ?? 2) : fallback?.mode === 'model-chain' ? Number(fallback.retryCount ?? 0) : 0
    const attemptsPerTarget = retryCount + 1
    const attempts = []
    const failures = []
    const delaysMs = []
    let lastErrorBody = null
    let lastStatus = 502
    const startedTotal = now()

    for (let chainIndex = 0; chainIndex < chain.length; chainIndex++) {
      const target = chain[chainIndex]
      // Rotate through the pool even when fallback retries are off: each key
      // gets a try on key-level failures (auth errors, rate limits).
      const enabledKeyCount = (target.provider.keys ?? []).filter((key) => key.enabled !== false).length
      const targetAttempts = Math.max(attemptsPerTarget, Math.min(enabledKeyCount, MAX_KEY_ATTEMPTS))
      for (let attempt = 0; attempt < targetAttempts; attempt++) {
        const started = now()
        try {
          const forwarded = await forwardOnce(
            { provider: target.provider, model: target.model },
            clientProtocol, path, workingBody, req,
            { rawBody, wantsStreamHint: wantsStream }
          )
          if (forwarded?.error) {
            attempts.push(`${target.provider.name}#${forwarded.error.status ?? 502}`)
            failures.push({ provider: target.provider.name, status: forwarded.error.status ?? 502, error: forwarded.error.message })
            lastStatus = forwarded.error.status ?? 502
            lastErrorBody = JSON.stringify({ error: { message: forwarded.error.message } })
            if (attempt < targetAttempts - 1) {
              const delay = (config.baseDelayMs ?? 200) * 2 ** attempt
              delaysMs.push(delay)
              await sleep(delay)
              continue
            }
            break
          }
          const { upstreamRes, responseProtocol, forwardedModel, key, bufferForStream } = forwarded
          const status = upstreamRes.status
          const moreAttemptsHere = attempt < targetAttempts - 1
          const moreChain = chainIndex < chain.length - 1
          const retryable = RETRYABLE_STATUSES.has(status)
          const keyRotatable = KEY_ROTATE_STATUSES.has(status) && moreAttemptsHere
          const canFallback = fallback?.mode === 'model-chain' && DOWNSTREAM_FALLBACK_STATUSES(status)
          if ((retryable || keyRotatable || canFallback) && (moreAttemptsHere || moreChain) && status !== 200) {
            markKeyFailure(key, status)
            const failure = `${target.provider.name}#${status}`
            attempts.push(failure)
            failures.push({ provider: target.provider.name, status, credential: keyIdentity(key) || undefined })
            const bodyText = await upstreamRes.text().catch(() => '')
            lastErrorBody = bodyText
            lastStatus = status
            if (moreAttemptsHere) {
              const delay = retryDelayMs(upstreamRes.headers.get('retry-after'), config.baseDelayMs ?? 200, attempt)
              delaysMs.push(delay)
              await sleep(delay)
              continue
            }
            break
          }
          if (status < 400) clearKeyFailure(key)
          const entry = log({
            upstream: target.provider.name,
            resolvedProvider: target.provider.name,
            credential: key?.id ?? null,
            requestModel: requestedModel,
            resolvedModel: forwardedModel,
            model: forwardedModel,
            protocol: clientProtocol,
            status,
            latencyMs: now() - started,
            attempts: [...attempts, target.provider.name],
            failures,
            delaysMs,
            bytes: rawBody.length,
            tokens: null,
            cost: null,
            ruleId: matchedRule?.id ?? null,
            requestBody: workingBody,
            requestHeaders: redactValue(req.headers)
          }, { config, status })
          const routingHeaders = config.exposeRoutingHeaders ? {
            'x-router-provider': target.provider.name,
            'x-router-model': String(forwardedModel ?? ''),
            ...(matchedRule?.id ? { 'x-router-rule': matchedRule.id } : {}),
            'x-router-attempts': String(attempts.length + 1)
          } : null
          await streamResponse(upstreamRes, responseProtocol, clientProtocol, res, forwardedModel, bufferForStream, target.provider, key, entry, { config, routingHeaders, chatRequest, wantsStream: forwarded.wantsStream })
          if (auth.state) recordClientUsage(auth.state, entry.tokens, clientImageCount)
          return
        } catch (error) {
          attempts.push(`${target.provider.name}#${error?.name ?? 'error'}`)
          failures.push({ provider: target.provider.name, error: String(error?.message ?? error) })
          lastStatus = 502
          if (attempt < targetAttempts - 1) {
            const delay = (config.baseDelayMs ?? 200) * 2 ** attempt
            delaysMs.push(delay)
            await sleep(delay)
            continue
          }
        }
      }
    }

    log({ upstream: null, resolvedProvider: null, resolvedModel: effectiveModel, protocol: clientProtocol, status: lastStatus, latencyMs: now() - startedTotal, attempts, failures, error: lastErrorBody ? 'upstream failed' : 'all providers failed', requestBody: workingBody, requestHeaders: redactValue(req.headers), responseBody: lastErrorBody }, { config, status: lastStatus })
    res.writeHead(lastStatus, { 'content-type': 'application/json', 'x-router-fallback-attempts': String(attempts.length), 'x-router-fallback-failures': failures.length ? JSON.stringify(failures) : '', 'x-router-fallback-delays-ms': delaysMs.join(',') })
    res.end(JSON.stringify({ error: { message: lastErrorBody ? safeJsonPreview(lastErrorBody) : `all providers failed (${attempts.join(', ')})`, attempts } }))
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  function retryDelayMs(retryAfter, base, attempt) {
    if (retryAfter) {
      const seconds = Number(retryAfter)
      if (Number.isFinite(seconds) && seconds > 0) return Math.min(30_000, seconds * 1000)
      const dateMs = Date.parse(String(retryAfter))
      if (Number.isFinite(dateMs)) {
        const delta = dateMs - now()
        if (delta > 0) return Math.min(30_000, delta)
      }
    }
    return Math.min(30_000, (base ?? 200) * 2 ** attempt)
  }
  function safeJsonPreview(text) {
    try { JSON.parse(text); return text.slice(0, 2000) } catch { return text.slice(0, 2000) }
  }

  const configRef = () => normalizeConfig(getConfig())

  async function streamResponse(upstreamRes, responseProtocol, clientProtocol, res, model, bufferForStream, provider, key, entry, { config, routingHeaders, chatRequest = true, wantsStream = false } = {}) {
    const isStream = (upstreamRes.headers.get('content-type') ?? '').includes('text/event-stream')
    const pricing = provider?.pricing?.[model] ?? provider?.pricing?.default
    const tokensFor = (payload) => {
      const primary = extractUsage(payload, clientProtocol)
      if (primary.input || primary.output) return primary
      const secondary = extractUsage(payload, responseProtocol)
      return secondary.input || secondary.output ? secondary : null
    }
    const withRouting = (headers) => (routingHeaders ? { ...headers, ...routingHeaders } : headers)
    const captureMode = config?.logBodyCapture ?? 'errors'

    // Non-chat passthrough: stream bytes without translation/usage parsing.
    if (!chatRequest) {
      const headers = withRouting({
        'content-type': upstreamRes.headers.get('content-type') ?? 'application/octet-stream',
        ...(upstreamRes.headers.get('cache-control') ? { 'cache-control': upstreamRes.headers.get('cache-control') } : {}),
        ...(upstreamRes.headers.get('content-disposition') ? { 'content-disposition': upstreamRes.headers.get('content-disposition') } : {})
      })
      res.writeHead(upstreamRes.status, headers)
      if (!upstreamRes.body) {
        const text = await upstreamRes.text().catch(() => '')
        res.end(text)
        if (shouldCollectLog(captureMode, upstreamRes.status)) entry.responseBody = safeCaptureBody(text)
        return
      }
      if (shouldCollectLog(captureMode, upstreamRes.status) && !isStream) {
        const raw = await upstreamRes.text().catch(() => '')
        res.end(raw)
        entry.responseBody = safeCaptureBody(raw)
        return
      }
      for await (const chunk of upstreamRes.body) res.write(Buffer.from(chunk))
      res.end()
      return
    }

    if (bufferForStream && !isStream) {
      const raw = await upstreamRes.text().catch(() => '{}')
      if (shouldCollectLog(captureMode, upstreamRes.status)) entry.responseBody = safeCaptureBody(raw)
      if (upstreamRes.status >= 400) {
        res.writeHead(upstreamRes.status, withRouting({ 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' }))
        res.end(raw)
        return
      }
      let parsed = null
      try { parsed = JSON.parse(raw) } catch { parsed = null }
      const translated = parsed ? translateResponse(parsed, responseProtocol, clientProtocol, model) : null
      const tokens = parsed ? tokensFor(translated ?? parsed) : null
      applyUsage(entry, tokens, computeCost(pricing, tokens))
      recordKeyUsage(key, tokens ? tokens.input + tokens.output : null, 0)
      if (clientProtocol === 'anthropic' && responseProtocol !== 'anthropic') {
        res.writeHead(upstreamRes.status, withRouting({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }))
        res.end(buildAnthropicSse(translated ?? openAIResponseToAnthropic(parsed ?? {}, model)))
      } else if (clientProtocol === 'openai' && responseProtocol !== 'openai') {
        res.writeHead(upstreamRes.status, withRouting({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }))
        res.end(buildOpenAISse(translated ?? anthropicResponseToOpenAI(parsed ?? {}, model)))
      } else if (clientProtocol === 'responses' && responseProtocol !== 'responses') {
        res.writeHead(upstreamRes.status, withRouting({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }))
        res.end(buildResponsesSse(translated ?? openAIResponseToResponses(parsed ?? {}, model)))
      } else if (clientProtocol === 'gemini' && responseProtocol === 'openai' && wantsStream) {
        // Gemini clients expect SSE-ish JSON chunks; best-effort via OpenAI SSE is not native,
        // so return translated JSON. (Full Gemini stream translation is a larger change.)
        res.writeHead(upstreamRes.status, withRouting({ 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' }))
        res.end(translated ? JSON.stringify(translated) : raw)
      } else {
        res.writeHead(upstreamRes.status, withRouting({ 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' }))
        res.end(translated ? JSON.stringify(translated) : raw)
      }
      return
    }

    res.writeHead(upstreamRes.status, withRouting({ 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-cache', connection: 'keep-alive' }))
    if (!upstreamRes.body) {
      const text = await upstreamRes.text().catch(() => '')
      if (shouldCollectLog(captureMode, upstreamRes.status)) entry.responseBody = safeCaptureBody(text)
      res.end(text)
      if (text) {
        try {
          const parsed = JSON.parse(text)
          const tokens = tokensFor(parsed)
          applyUsage(entry, tokens, computeCost(pricing, tokens))
          recordKeyUsage(key, tokens ? tokens.input + tokens.output : null, 0)
        } catch { /* noop */ }
      }
      return
    }
    if (!isStream) {
      const raw = await upstreamRes.text().catch(() => '')
      if (shouldCollectLog(captureMode, upstreamRes.status)) entry.responseBody = safeCaptureBody(raw)
      if (upstreamRes.status < 400) {
        try {
          const parsed = JSON.parse(raw)
          const tokens = tokensFor(parsed)
          applyUsage(entry, tokens, computeCost(pricing, tokens))
          recordKeyUsage(key, tokens ? tokens.input + tokens.output : null, 0)
        } catch { /* non-JSON response */ }
      }
      if (responseProtocol !== clientProtocol && upstreamRes.status < 400) {
        try {
          const parsed = JSON.parse(raw)
          res.end(JSON.stringify(translateResponse(parsed, responseProtocol, clientProtocol, model)))
          return
        } catch { /* fall through to the raw body */ }
      }
      res.end(raw)
      return
    }
    // Same-protocol streaming: forward chunks as they arrive while watching for usage.
    const reader = upstreamRes.body.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    let streamTokens = null
    let captured = ''
    const observe = (text) => {
      if (shouldCollectLog(captureMode, upstreamRes.status) && captured.length < LOG_BODY_LIMIT) captured += text
      pending += text
      let index
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, '')
        pending = pending.slice(index + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let event = null
        try { event = JSON.parse(payload) } catch { continue }
        streamTokens = mergeStreamUsage(streamTokens, event, responseProtocol)
      }
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      observe(text)
      res.write(text)
    }
    const tail = decoder.decode()
    if (tail) observe(tail)
    res.end()
    if (captured) entry.responseBody = safeCaptureBody(captured)
    if (streamTokens) {
      applyUsage(entry, streamTokens, computeCost(pricing, streamTokens))
      recordKeyUsage(key, streamTokens.input + streamTokens.output || null, 0)
    }
  }

  function listModels(config) {
    const seen = new Set()
    const data = []
    for (const provider of providersFor(config)) {
      for (const model of provider.models ?? []) {
        const id = `${provider.name}/${model.id}`
        if (seen.has(id)) continue
        seen.add(id)
        data.push({ id, object: 'model', owned_by: provider.name, ...(model.description ? { description: model.description } : {}) })
      }
    }
    for (const [alias, target] of Object.entries(config.aliases ?? {})) {
      if (!target || seen.has(alias)) continue
      seen.add(alias)
      data.push({ id: alias, object: 'model', owned_by: 'alias', ...(config.modelDescriptions?.[alias] ? { description: config.modelDescriptions[alias] } : {}) })
    }
    return { object: 'list', data }
  }

  return {
    logs,
    stats,
    start(host = '127.0.0.1', port = 18080) {
      return new Promise((resolve, reject) => {
        if (server) return resolve(bound)
        server = createServer((req, res) => {
          pipe(req, res).catch((error) => {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }))
          })
        })
        server.once('error', reject)
        server.listen(port, host, () => {
          bound = { host, port: server.address().port }
          resolve(bound)
        })
      })
    },
    async stop() {
      if (!server) return
      const current = server
      server = null
      bound = null
      await new Promise((resolve) => current.close(() => resolve()))
    },
    status() {
      const config = configRef()
      return {
        running: Boolean(server && bound),
        host: bound?.host ?? config.bindHost ?? '127.0.0.1',
        port: bound?.port ?? config.port ?? 18080,
        providers: config.providers.map((p) => ({
          name: p.name,
          displayName: p.displayName,
          baseUrl: p.baseUrl,
          protocols: p.protocols ?? [],
          models: (p.models ?? []).map((m) => m.id),
          keyCount: (p.keys ?? []).length
        })),
        upstreams: config.providers.map((p) => ({
          name: p.name,
          baseUrl: p.baseUrl,
          protocols: p.protocols ?? [],
          keyCount: (p.keys ?? []).length
        })),
        routes: config.routes,
        rules: config.routes,
        defaultProvider: config.defaultProvider ?? '',
        defaultUpstream: config.defaultProvider ?? '',
        aliases: config.aliases ?? {},
        clientKeys: (config.clientKeys ?? []).map((key) => ({ id: key.id, name: key.name, expiresAt: key.expiresAt, limits: key.limits, enabled: key.enabled !== false })),
        agentProfiles: config.agentProfiles ?? []
      }
    },
    clearKeyCooldown(identity) {
      if (identity) keyCooldowns.delete(identity)
    },
    usage({ window = 'today', now: at = now() } = {}) {
      const since = window === '24h' ? at - 86_400_000 : window === '7d' ? at - 7 * 86_400_000 : window === '30d' ? at - 30 * 86_400_000 : new Date(at).setHours(0, 0, 0, 0)
      const recent = logs.filter((entry) => entry.at >= since)
      // When request logging is disabled the ring buffer is empty, but aggregate
      // stats are still maintained. Fall back to totals for "all-time" style views.
      if (!recent.length && logs.length === 0 && stats.requests) {
        return {
          window,
          since,
          requests: stats.requests,
          successRate: stats.requests ? (stats.requests - stats.errors) / stats.requests : 0,
          errors: stats.errors,
          inputTokens: stats.inputTokens,
          outputTokens: stats.outputTokens,
          totalTokens: stats.inputTokens + stats.outputTokens,
          cost: stats.cost,
          avgLatencyMs: stats.requests ? stats.latencyMsTotal / stats.requests : 0,
          byProvider: Object.entries(stats.byProvider).map(([provider, count]) => ({ provider, count })),
          byModel: Object.entries(stats.byModel).map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count),
          totals: { ...stats },
          loggingDisabled: true
        }
      }
      const sum = (key, field) => recent.filter((entry) => entry.status < 400).reduce((total, entry) => total + (entry[key]?.[field] ?? 0), 0)
      const successful = recent.filter((entry) => entry.status < 400).length
      const latencyTotal = recent.reduce((total, entry) => total + (entry.latencyMs ?? 0), 0)
      return {
        window,
        since,
        requests: recent.length,
        successRate: recent.length ? successful / recent.length : 0,
        errors: recent.length - successful,
        inputTokens: sum('tokens', 'input'),
        outputTokens: sum('tokens', 'output'),
        totalTokens: sum('tokens', 'input') + sum('tokens', 'output'),
        cost: recent.reduce((total, entry) => total + (entry.cost ?? 0), 0),
        avgLatencyMs: recent.length ? latencyTotal / recent.length : 0,
        byProvider: Object.entries(recent.reduce((acc, entry) => { if (entry.resolvedProvider) acc[entry.resolvedProvider] = (acc[entry.resolvedProvider] ?? 0) + 1; return acc }, {})).map(([provider, count]) => ({ provider, count })),
        byModel: Object.entries(recent.reduce((acc, entry) => { if (entry.resolvedModel) acc[entry.resolvedModel] = (acc[entry.resolvedModel] ?? 0) + 1; return acc }, {})).map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count),
        totals: { ...stats }
      }
    },
    clearLogs() {
      logs.length = 0
      return { ok: true }
    }
  }
}

// ---------------------------------------------------------------------------
// Discovery, connection checks & provider account usage.
// ---------------------------------------------------------------------------
export function jsonPathValue(path, payload) {
  const expression = String(path ?? '').trim()
  if (expression.startsWith('$.')) {
    let current = payload
    const segments = expression.slice(2).split('.')
    for (const segment of segments) {
      const bracket = segment.indexOf('[')
      const key = bracket >= 0 ? segment.slice(0, bracket) : segment
      if (key) current = current?.[key]
      if (bracket >= 0) {
        const indexes = [...segment.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]))
        for (const index of indexes) current = Array.isArray(current) ? current[index] : current?.[index]
      }
      if (current == null) return undefined
    }
    return current
  }
  return undefined
}

function evalMeterExpression(expression, payload) {
  if (typeof expression === 'number') return expression
  const text = String(expression ?? '').trim()
  const subtraction = text.match(/^(\d+(?:\.\d+)?)\s*-\s*(\$.+)$/)
  if (subtraction) {
    const value = Number(jsonPathValue(subtraction[2], payload))
    return Number.isFinite(value) ? Number(subtraction[1]) - value : undefined
  }
  const value = jsonPathValue(text, payload)
  const number = Number(value)
  return Number.isFinite(number) && value !== undefined ? number : undefined
}

export async function fetchProviderUsage(provider, { getSecret, fetchImpl } = {}) {
  const connectors = provider.usageFetch?.connectors ?? provider.usageFetch?.enabled === false ? [] : []
  if (provider.usageFetch?.enabled === false || !connectors.length) return { provider: provider.name, status: 'unsupported', meters: [], errors: [{ message: 'usage fetch not configured' }] }
  const fetchFn = fetchImpl ?? globalThis.fetch
  const meters = []
  const errors = []
  for (const connector of connectors) {
    try {
      const key = (provider.keys ?? []).map((entry) => getSecret?.(entry.secretKey)).find(Boolean)
      const headers = { ...(connector.headers ?? {}) }
      if (connector.auth !== 'none' && key) headers.authorization = `Bearer ${key}`
      const res = await fetchFn(connector.endpoint, {
        method: connector.method ?? 'GET',
        headers,
        body: connector.body ? JSON.stringify(connector.body) : undefined,
        signal: AbortSignal.timeout(10000)
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        errors.push({ message: `usage endpoint returned ${res.status}` })
        continue
      }
      for (const meter of connector.mapping?.meters ?? []) {
        const mapped = {
          id: meter.id,
          kind: meter.kind ?? 'balance',
          label: meter.label ?? meter.id,
          unit: meter.unit ?? '',
          window: meter.window,
          limit: evalMeterExpression(meter.limit, payload),
          used: evalMeterExpression(meter.used, payload),
          remaining: evalMeterExpression(meter.remaining, payload),
          resetAt: typeof meter.resetAt === 'string' ? String(jsonPathValue(meter.resetAt, payload) ?? '') : undefined
        }
        if (mapped.remaining == null && mapped.limit != null && mapped.used != null) mapped.remaining = mapped.limit - mapped.used
        meters.push(mapped)
      }
    } catch (error) {
      errors.push({ message: String(error?.message ?? error) })
    }
  }
  return { provider: provider.name, status: errors.length && !meters.length ? 'error' : 'ok', meters, errors }
}

export async function discoverProviderModels(provider, { getSecret, fetchImpl } = {}) {
  const fetchFn = fetchImpl ?? globalThis.fetch
  const key = (provider.keys ?? []).map((entry) => getSecret?.(entry.secretKey)).find(Boolean)
  const baseUrl = provider.baseUrl
  const attempts = []
  for (const candidate of [baseUrl, baseUrl?.replace(/\/v1$/, '')]) {
    if (!candidate) continue
    attempts.push(`${candidate}/v1/models`)
  }
  let last = null
  for (const url of attempts) {
    try {
      const res = await fetchFn(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(8000) })
      if (!res.ok) { last = new Error(`${url} returned ${res.status}`); continue }
      const json = await res.json().catch(() => ({}))
      const models = (json.data ?? json.models ?? []).map((model) => String(model.id ?? model.name ?? '')).filter(Boolean)
      return { provider: provider.name, models, status: res.status }
    } catch (error) {
      last = error
    }
  }
  throw last ?? new Error('model discovery failed')
}
