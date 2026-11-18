// LLM Router sidecar: a self-contained local gateway.
// It talks directly to providers with conditional routing rules, rewrites,
// model aliases, ordered fallback / retry policies, credential pools with
// limits, gateway client API keys, request logging and usage accounting.
//
// Config shape (persisted by worker/main.mjs in Orca storage 'router.config'):
//   token, providers[] (or legacy upstreams[]), routes[] (the failover unit),
//   policies[] (global request matchers), aliases{},
//   defaultFallback, clientKeys[], agentProfiles[], timeoutMs, retries,
//   baseDelayMs, logBodyCapture, exposeRoutingHeaders
//
// Provider shape:
//   { name, baseUrl?, endpoints?: [{baseUrl, protocols}], protocols: [...],
//     models: [{id, description?}], keys: [{id, secretKey, enabled?, priority?,
//     weight?, limits?, forwardClientAuth?}], enabled?, pricing?, usageFetch? }
// Route shape:
//   { name, targets: [{provider, model}], strategy?:'ordered'|'fastest',
//     enabled?, retries? }
// Policy shape:
//   { id?, name, enabled?, condition?: {source, field, operator, value},
//     rewrites?: [{key, operation?, value?, match?}], model?,
//     fallback?: {mode:'off'|'retry'|'model-chain'|'provider-chain', models?, retryCount?} }

import { createServer } from 'node:http'
import { createDecipheriv, scryptSync, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createSchedulerState, normalizeCircuitBreaker, normalizeProviderHealth, normalizeScheduler, rankProviderTargets, retryAfterMs, selectScheduledKey } from './scheduler.mjs'
import { COMPRESSION_MODES, bodyCharLength, compressChatBody, normalizeCompression, normalizeContextRelay, relayChatBody } from './transforms.mjs'
import { canonicalCacheKey, createResponseCache, extractPromptText, normalizeResponseCache, semanticParamsKey, shouldCacheRequest, stableStringify } from './cache.mjs'
import { SAMPLE_VPN_SERVER, createProxyFetch, findVpnServer, normalizeVpnServers } from './proxy.mjs'
import { WebChatSessionStore } from './webchat/session.mjs'
import { DeepSeekWebTransport } from './webchat/deepseek.mjs'
import { QwenWebTransport } from './webchat/qwen.mjs'
import { createWebChatProvider } from './webchat/index.mjs'
import { createRecoveredWebChat } from './webchat/recovery.mjs'
import { solvePOW as solvePOWFn } from './webchat/pow.mjs'
import {
  isWebChatTransport,
  webchatCatalog,
  webchatConfigured,
  webchatSessionKey,
  buildWebChatSuccessResponse,
  buildWebChatErrorResponse,
} from './webchat/sidecar.mjs'
export { isWebChatTransport, webchatCatalog, webchatConfigured } from './webchat/sidecar.mjs'

export const SIDECAR_MAX_BODY_BYTES = 64 * 1024 * 1024 // 64 MiB, the Orca cap
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504])
const PROVIDER_FAILURE_STATUSES = new Set([408, 409, 500, 502, 503, 504])
// A key-level failure: retry the same target with the next key in the pool.
const KEY_ROTATE_STATUSES = new Set([401, 403, 429])
// How long a key is skipped after it fails, so later requests keep rotating.
const KEY_COOLDOWN_MS = { 401: 300_000, 403: 300_000, 429: 60_000, 408: 30_000, 409: 30_000, 500: 30_000, 502: 30_000, 503: 30_000, 504: 30_000 }
const MAX_KEY_ATTEMPTS = 8
const MAX_KEY_COOLDOWN_MS = 60 * 60 * 1000
const KEY_LIMIT_WINDOWS = [
  ['rpm', 60_000, 'requests'], ['rph', 3_600_000, 'requests'], ['rpd', 86_400_000, 'requests'],
  ['tpm', 60_000, 'tokens'], ['tph', 3_600_000, 'tokens'], ['tpd', 86_400_000, 'tokens'],
  ['ipm', 60_000, 'images'], ['iph', 3_600_000, 'images'], ['ipd', 86_400_000, 'images']
]
const DOWNSTREAM_FALLBACK_STATUSES = (s) => s >= 400 && s < 600

// ---------------------------------------------------------------------------
// Provider presets. Endpoints, protocols and default models are ported from
// common gateway defaults and mapped to the sidecar's own protocol names when
// a provider is created.
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
  { id: 'y-api', name: 'Y-API', baseUrl: 'https://api.y-api.bestvirtualgoods.com/v1', capabilities: ['openai_chat_completions', 'anthropic_messages'], defaultModels: [], websiteUrl: 'https://y-api.bestvirtualgoods.com/' },
  // Native web-chat transports. These drive the free web subscriptions directly
  // (no HTTP gateway to reach); the router supplies the auth credential via a
  // `secrets:own` secret. baseUrl is unused and kept empty.
  { id: 'deepseek-web', name: 'DeepSeek Web', baseUrl: '', transport: 'deepseek-web', capabilities: ['openai_chat_completions'], defaultModels: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-reasoner-search', 'deepseek-v4-pro'], websiteUrl: 'https://chat.deepseek.com/' },
  { id: 'qwen-web', name: 'Qwen Web', baseUrl: '', transport: 'qwen-web', capabilities: ['openai_chat_completions'], defaultModels: ['qwen3-max', 'qwen3-max-thinking', 'qwen3-plus', 'qwen3-plus-thinking'], websiteUrl: 'https://chat.qwen.ai/' }
]

function mapLegacyProtocol(proto) {
  if (!proto) return 'openai'
  const normalized = String(proto).toLowerCase().replace(/[-_]/g, '_')
  if (normalized.includes('anthropic')) return 'anthropic'
  if (normalized.includes('responses')) return 'responses'
  if (normalized.includes('gemini') || normalized.includes('google')) return 'gemini'
  if (normalized.includes('openai') || normalized.includes('chat')) return 'openai'
  return proto
}

export function providerFromPreset(presetId, { name, apiKeySecretKey } = {}) {
  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId)
  if (!preset) return null
  const protocols = [...new Set((preset.capabilities ?? []).map(mapLegacyProtocol))]
  const endpoints = [{ baseUrl: preset.baseUrl, protocols }]
  const keys = apiKeySecretKey ? [{ id: 'key-1', secretKey: apiKeySecretKey, enabled: true, priority: 0, weight: 1 }] : []
  return {
    name: name || preset.id,
    displayName: preset.name,
    baseUrl: preset.baseUrl,
    endpoints,
    protocols: protocols.length ? protocols : ['openai'],
    models: (preset.defaultModels ?? []).map((id) => ({ id })),
    keys,
    transport: preset.transport,
    usageFetch: preset.usage
      ? { enabled: true, connectors: [{ id: preset.id, type: 'http-json', ...preset.usage }] }
      : undefined
  }
}

// Older provider entries predate usage scrapers in the preset catalog. Match
// those by base URL so existing installs get per-key quota without forcing the
// user to delete and re-add the provider. Never match on display name: a
// custom proxy could share a preset's label and must not receive its key.
export function resolveUsageFetch(provider) {
  if (provider?.usageFetch) return provider.usageFetch
  const baseUrl = String(provider?.baseUrl ?? provider?.endpoints?.[0]?.baseUrl ?? '').replace(/\/+$/, '')
  if (!baseUrl) return undefined
  const preset = PROVIDER_PRESETS.find((item) => item.usage && String(item.baseUrl ?? '').replace(/\/+$/, '') === baseUrl)
  if (!preset) return undefined
  return { enabled: true, connectors: [{ id: preset.id, type: 'http-json', ...preset.usage }] }
}

// ---------------------------------------------------------------------------
// Config defaults and normalization (including legacy upstreams -> providers).
// ---------------------------------------------------------------------------
export const DEFAULT_CONFIG = {
  version: 3,
  token: 'orca-router',
  providers: [],
  // A route is a model name agents send, backed by one or more
  // provider/model targets. It is the normal failover unit; `aliases` stays
  // for imported single-target aliases and older configs.
  routes: [],
  aliases: {},
  // Reusable VPN / proxy servers. Routes reference one by id; a route without
  // a reference stays on the direct connection. A working public US proxy is
  // seeded for a first-run trial; it is never attached to a route.
  vpnServers: [SAMPLE_VPN_SERVER],
  // Set once the sample has been offered, so clearing the list is respected.
  vpnSampleDismissed: false,
  // Global policies: ordered request matchers that rewrite or redirect.
  policies: [],
  defaultModel: '',
  defaultFallback: { mode: 'retry', models: [], retryCount: 2 },
  clientKeys: [],
  // Agents route by default: an entry only exists to turn one off. The panel
  // lists Orca's own agents and writes `{ agent, name, enabled }` here.
  agentProfiles: [],
  timeoutMs: 600000,
  retries: 2,
  baseDelayMs: 200,
  scheduler: {
    strategy: 'priority-weighted',
    priorityTiers: true,
    utilizationAware: true,
    utilizationThreshold: 0.8,
    allKeysExhausted: 'error',
    exhaustedStatus: 420,
    cacheAffinity: true,
    cacheAffinityTtlMs: 600_000
  },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 3,
    cooldownMs: 60_000
  },
  providerHealth: {
    enabled: false,
    smoothing: 0.3,
    staleMs: 300_000
  },
  // Opt-in request optimization. All three are off by default so existing
  // configs keep byte-identical routing and upstream payloads.
  compression: {
    enabled: false,
    mode: 'lite',
    minChars: 2000,
    keepRecentMessages: 4,
    toolResults: true,
    systemPrompt: false,
    toolMaxChars: 4000,
    messageMaxChars: 2000
  },
  contextRelay: {
    enabled: false,
    trigger: 'failover',
    maxChars: 24_000,
    keepRecentMessages: 8,
    digestChars: 200
  },
  responseCache: {
    enabled: false,
    mode: 'exact',
    ttlMs: 300_000,
    maxEntries: 200,
    threshold: 0.95,
    embeddingProvider: '',
    embeddingModel: '',
    skipTools: true,
    maxTemperature: 0
  },
  logBodyCapture: 'errors',
  persistLogs: false,
  exposeRoutingHeaders: false,
  allowUnauthenticatedRemote: false
}

const LOG_BODY_LIMIT = 4096
const MAX_WINDOW_ENTRIES = 5000
// Runtime usage/health snapshots are written at most this often. A trailing
// timer flushes the tail of a burst; main.mjs also flushes on a slower interval
// and on deactivate so an ungraceful exit loses no more than one window.
const RUNTIME_PERSIST_THROTTLE_MS = 5000
const RUNTIME_STATE_VERSION = 1

const slug = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-')

// Route names are selectors agents send verbatim, so they keep their
// case and punctuation. Only provider names are slugged.
function normalizeRoutes(input, vpnServers = []) {
  const routes = []
  const seen = new Set()
  const vpnIds = new Set(vpnServers.filter((server) => server.enabled !== false).map((server) => server.id))
  for (const raw of Array.isArray(input) ? input : []) {
    if (!raw || typeof raw !== 'object') continue
    const name = String(raw.name ?? '').trim()
    if (!name || seen.has(name)) continue
    const targets = []
    for (const target of Array.isArray(raw.targets) ? raw.targets : []) {
      if (!target || typeof target !== 'object') continue
      const provider = slug(target.provider ?? '')
      const model = String(target.model ?? '').trim()
      if (!provider && !model) continue
      targets.push({ provider, model })
    }
    if (!targets.length) continue
    seen.add(name)
    routes.push({
      name,
      targets,
      strategy: raw.strategy === 'ordered' ? 'ordered' : 'fastest',
      enabled: raw.enabled !== false,
      retries: normalizeRetries(raw.retries, 2),
      // A dangling or disabled reference degrades to a direct connection.
      ...(vpnIds.has(String(raw.vpn ?? '')) ? { vpn: String(raw.vpn) } : {})
    })
  }
  return routes
}

// Turn a legacy `aliases` entry into a one-target route. It is marked
// `ordered` so an upgraded config keeps its old single-target behavior even
// when health ranking is enabled.
function legacyAliasRoute(name, target, providers) {
  const text = String(target ?? '').trim()
  if (!text) return null
  const slash = text.indexOf('/')
  if (slash > 0) {
    const provider = providers.find((item) => item.name === slug(text.slice(0, slash)))
    if (provider) {
      return {
        name,
        targets: [{ provider: provider.name, model: text.slice(slash + 1) }],
        strategy: 'ordered',
        enabled: true,
        retries: 2
      }
    }
  }
  const named = providers.find((item) => item.name === slug(text))
  if (named) {
    return { name, targets: [{ provider: named.name, model: '' }], strategy: 'ordered', enabled: true, retries: 2 }
  }
  return { name, targets: [{ provider: '', model: text }], strategy: 'ordered', enabled: true, retries: 2 }
}

function mergeLegacyAliases(routes, aliases, providers) {
  const names = new Set(routes.map((route) => route.name))
  const merged = [...routes]
  for (const [name, target] of Object.entries(aliases ?? {})) {
    if (names.has(name)) continue
    const route = legacyAliasRoute(name, target, providers)
    if (!route) continue
    names.add(name)
    merged.push(route)
  }
  return merged
}

const LEGACY_CHAIN_MODES = new Set(['model-chain', 'provider-chain'])

function migrationTarget(providers, aliases, entry) {
  const text = String(entry ?? '').trim()
  if (!text) return null
  const mapped = aliases[text] ?? text
  const slash = mapped.indexOf('/')
  if (slash > 0) {
    const provider = providers.find((item) => item.name === slug(mapped.slice(0, slash)))
    return provider ? { provider: provider.name, model: mapped.slice(slash + 1) } : null
  }
  const owner = providers.find((item) => (item.models ?? []).some((model) => model.id === mapped))
  if (owner) return { provider: owner.name, model: mapped }
  const named = providers.find((item) => item.name === slug(mapped))
  if (named) return { provider: named.name, model: '' }
  return { provider: '', model: mapped }
}

function dedupeTargets(targets) {
  const seen = new Set()
  const out = []
  for (const target of targets) {
    if (!target) continue
    const key = `${target.provider}/${target.model}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(target)
  }
  return out
}

function normalizeRetries(value, fallback = 2) {
  const count = Number(value)
  return Number.isFinite(count) ? Math.max(0, Math.min(20, Math.floor(count))) : fallback
}

// Turn a legacy custom chain (a raw provider/model list on a policy or the
// global default) into a route. Idempotent: a chain that already names a
// route, or a global policy reset to retry, is left alone.
function migrateLegacyChains({ policies, routes, aliases, providers, defaultFallback, retries, previous }) {
  const list = [...routes]
  const known = new Set(list.map((route) => route.name))
  const created = []
  const uniqueName = (base) => {
    let name = base
    let suffix = 2
    while (known.has(name)) name = `${base}-${suffix++}`
    known.add(name)
    return name
  }
  const backupsFor = (models) => dedupeTargets(
    models
      .filter((entry) => typeof entry === 'string')
      .map((entry) => migrationTarget(providers, aliases, entry))
  )
  const migratedPolicies = policies.map((policy) => {
    const fallback = policy.fallback
    if (!fallback || !LEGACY_CHAIN_MODES.has(fallback.mode)) return policy
    const models = Array.isArray(fallback.models) ? fallback.models : []
    if (!models.length) return policy
    const routeRefs = models.filter((entry) => known.has(entry))
    const rawEntries = models.filter((entry) => !known.has(entry))
    // Only routes: this is the simplified form, not a raw chain.
    if (!rawEntries.length) return policy
    const backups = backupsFor(rawEntries)
    if (!backups.length) {
      return routeRefs.length
        ? { ...policy, fallback: { mode: 'provider-chain', models: routeRefs, retryCount: fallback.retryCount } }
        : policy
    }
    const name = uniqueName(`${slug(policy.name || policy.id || 'policy')}-backups`)
    list.push({ name, targets: backups, strategy: 'ordered', enabled: true, retries: normalizeRetries(fallback.retryCount, retries) })
    created.push({ kind: 'rule-chain', from: policy.name || policy.id || 'policy', to: name, targets: backups })
    return { ...policy, fallback: { mode: 'provider-chain', models: [...routeRefs, name], retryCount: fallback.retryCount } }
  })

  let globalFallback = defaultFallback
  if (globalFallback && LEGACY_CHAIN_MODES.has(globalFallback.mode)) {
    const models = Array.isArray(globalFallback.models) ? globalFallback.models : []
    const routeRefs = models.filter((entry) => known.has(entry))
    const rawEntries = models.filter((entry) => !known.has(entry))
    let to = routeRefs[0] ?? ''
    let targets = []
    if (rawEntries.length) {
      const backups = backupsFor(rawEntries)
      if (backups.length) {
        to = uniqueName('default-failover')
        list.push({ name: to, targets: backups, strategy: 'ordered', enabled: true, retries: normalizeRetries(globalFallback.retryCount, retries) })
        targets = backups
      }
    }
    if (to) {
      created.push({
        kind: 'global-chain',
        from: 'Global default fallback',
        to,
        targets,
        note: 'No longer applies automatically; point a model name at this route to use it.'
      })
    }
    // A non-route request is now a single target with plain retries.
    globalFallback = { mode: 'retry', models: [], retryCount: Number(globalFallback.retryCount ?? retries ?? 2) }
  }

  const seen = new Set((previous ?? []).map((item) => `${item.kind}:${item.from}:${item.to}`))
  const additions = created
    .filter((item) => !seen.has(`${item.kind}:${item.from}:${item.to}`))
    .map((item) => ({ at: Date.now(), ...item }))
  return {
    policies: migratedPolicies,
    routes: list,
    defaultFallback: globalFallback,
    migration: [...(previous ?? []), ...additions].slice(-50)
  }
}

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
    id: key.id ?? `key-${index + 1}`,
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
    supportsCustomToolGrammar: provider.supportsCustomToolGrammar === true,
    // Web-chat native transports (deepseek-web | qwen-web) bypass the HTTP
    // endpoint and drive the web subscription directly. Absent for HTTP providers.
    transport: provider.transport
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
  // Version gate: v3 stores `routes` (the failover unit) and `policies`
  // (global request matchers). Legacy configs (version < 3) used `routes`
  // for the policies and `resolvers`/`modelGroups` for the routes.
  const isV3 = Number(source.version ?? 0) >= 3
  const rawPolicies = isV3
    ? (Array.isArray(source.policies) ? source.policies : [])
    : (source.routes ?? [])
  const rawRoutes = isV3
    ? (Array.isArray(source.routes) ? source.routes : [])
    : (Array.isArray(source.resolvers)
      ? source.resolvers
      : Array.isArray(source.modelGroups) ? source.modelGroups : [])
  const policies = rawPolicies
    .map((policy, index) => policy?.match && !policy.condition ? migrateOneLegacyRoute(policy, index) : policy)
    .filter((policy) => {
      const fallbackModels = policy?.fallback?.models ?? []
      const legacyReference = policy?.id?.startsWith('legacy-') && (policy?.name === 'omniroute/*' || policy?.name === '*' || fallbackModels.some((item) => item === 'ccr' || item === 'omniroute'))
      return !legacyReference
    })
  const aliases = source.aliases && typeof source.aliases === 'object' ? source.aliases : {}
  // Configs predating VPN support, and configs whose list was never populated,
  // get one working sample server so the feature can be tried immediately.
  // The flag records that the offer was made, so clearing the list is final.
  const vpnDismissed = source.vpnSampleDismissed === true
  const seedSampleVpn = !vpnDismissed && (!Array.isArray(source.vpnServers) || source.vpnServers.length === 0)
  const vpnServers = normalizeVpnServers(seedSampleVpn ? [SAMPLE_VPN_SERVER] : source.vpnServers)
  const routes = mergeLegacyAliases(normalizeRoutes(rawRoutes, vpnServers), aliases, providers ?? [])
  const normalizedPolicies = policies.map((policy, index) => ({
    id: policy.id ?? `policy-${index + 1}`,
    name: policy.name ?? `Policy ${index + 1}`,
    enabled: policy.enabled !== false,
    condition: policy.condition ?? null,
    rewrites: policy.rewrites ?? (policy.rewrite ? [policy.rewrite] : []),
    fallback: policy.fallback,
    model: policy.model
  }))
  const migrated = migrateLegacyChains({
    policies: normalizedPolicies,
    routes,
    aliases,
    providers: providers ?? [],
    defaultFallback: source.defaultFallback ?? { mode: 'retry', models: [], retryCount: Number(source.retries ?? 2) },
    retries: Number(source.retries ?? 2),
    previous: Array.isArray(source.migration) ? source.migration : []
  })
  return {
    ...structuredClone(DEFAULT_CONFIG),
    version: 3,
    token: source.token ?? DEFAULT_CONFIG.token,
    defaultModel: typeof source.defaultModel === 'string' ? source.defaultModel : DEFAULT_CONFIG.defaultModel,
    providers: providers ?? [],
    routes: migrated.routes,
    aliases,
    vpnServers,
    vpnSampleDismissed: vpnDismissed || seedSampleVpn,
    policies: migrated.policies,
    defaultFallback: migrated.defaultFallback,
    migration: migrated.migration,
    clientKeys: source.clientKeys ?? [],
    agentProfiles: source.agentProfiles ?? DEFAULT_CONFIG.agentProfiles,
    timeoutMs: Number(source.timeoutMs ?? 600000),
    retries: Number(source.retries ?? 2),
    baseDelayMs: Number(source.baseDelayMs ?? 200),
    scheduler: normalizeScheduler(source.scheduler ?? DEFAULT_CONFIG.scheduler),
    circuitBreaker: normalizeCircuitBreaker(source.circuitBreaker ?? DEFAULT_CONFIG.circuitBreaker),
    providerHealth: normalizeProviderHealth(source.providerHealth ?? DEFAULT_CONFIG.providerHealth),
    compression: normalizeCompression(source.compression ?? DEFAULT_CONFIG.compression),
    contextRelay: normalizeContextRelay(source.contextRelay ?? DEFAULT_CONFIG.contextRelay),
    responseCache: normalizeResponseCache(source.responseCache ?? DEFAULT_CONFIG.responseCache),
    modelDescriptions: source.modelDescriptions ?? {},
    logBodyCapture: ['all', 'errors', 'none'].includes(source.logBodyCapture) ? source.logBodyCapture : 'errors',
    persistLogs: source.persistLogs === true,
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
  const policies = (router.rules ?? router.routes ?? []).map((rule, index) => ({
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
      version: 3,
      token: DEFAULT_CONFIG.token,
      providers,
      routes: [],
      aliases,
      policies,
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

  // 5. Combos -> Policies + Aliases
  const policies = []
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
      policies.push({
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
      version: 3,
      token: DEFAULT_CONFIG.token,
      providers,
      routes: [],
      aliases,
      policies,
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

  // Merge policies (keyed by id)
  if (!Array.isArray(mergedConfig.policies)) mergedConfig.policies = []
  const existingPolicyIds = new Set(mergedConfig.policies.map((p) => p.id))
  const incomingPolicies = incomingConfig.policies ?? incomingConfig.routes ?? []
  for (const p of incomingPolicies) {
    if (!existingPolicyIds.has(p.id)) {
      mergedConfig.policies.push(structuredClone(p))
      existingPolicyIds.add(p.id)
    }
  }

  // Merge aliases
  mergedConfig.aliases = {
    ...(mergedConfig.aliases ?? {}),
    ...(incomingConfig.aliases ?? {})
  }

  // Merge routes by name; an existing route wins.
  if (!Array.isArray(mergedConfig.routes)) mergedConfig.routes = []
  const incomingRoutes = incomingConfig.routes ?? incomingConfig.resolvers ?? incomingConfig.modelGroups ?? []
  const existingRouteNames = new Set(mergedConfig.routes.map((route) => route.name))
  for (const route of incomingRoutes) {
    if (!route?.name || existingRouteNames.has(route.name)) continue
    mergedConfig.routes.push(structuredClone(route))
    existingRouteNames.add(route.name)
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

  if (Number(input.version ?? 0) >= 2 || (Array.isArray(input.providers) && (Array.isArray(input.routes) || Array.isArray(input.policies)))) {
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

const globRegexCache = new Map()
function globMatch(pattern, value) {
  let regex = globRegexCache.get(pattern)
  if (!regex) {
    regex = new RegExp(`^${String(pattern).replace(/[.*+?^${'{}'}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`)
    if (globRegexCache.size > 500) globRegexCache.clear()
    globRegexCache.set(pattern, regex)
  }
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

// Translate an OpenAI chat request into the Responses API shape. Needed when a
// provider declares only `responses` but an agent speaks chat completions or
// messages. OpenAI chat remains the common denominator, so this mirrors
// responsesToOpenAI above.
export function openAIToResponses(body) {
  if (!body || typeof body !== 'object') return { ...(body ?? {}) }
  if (!Array.isArray(body.messages)) return { ...body }
  const instructions = []
  const input = []
  let sawConversation = false
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') continue
    const text = contentText(message.content)
    if ((message.role === 'system' || message.role === 'developer') && !sawConversation) {
      if (text) instructions.push(text)
      continue
    }
    sawConversation = true
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: String(message.tool_call_id ?? ''), output: text })
      continue
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!call?.function?.name) continue
        input.push({ type: 'function_call', call_id: String(call.id ?? ''), name: call.function.name, arguments: call.function.arguments ?? '{}' })
      }
    }
    if (text) {
      const role = message.role === 'assistant' ? 'assistant'
        : message.role === 'system' || message.role === 'developer' ? 'developer' : 'user'
      input.push({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] })
    }
  }
  const tools = (body.tools ?? []).map((tool) => {
    if (tool?.type === 'function' && tool.function?.name) {
      return {
        type: 'function',
        name: tool.function.name,
        description: tool.function.description ?? '',
        parameters: tool.function.parameters ?? { type: 'object' }
      }
    }
    return tool
  })
  const choice = body.tool_choice
  const toolChoice = !choice ? undefined
    : typeof choice === 'string' ? choice
      : choice?.type === 'function' && choice.function?.name ? { type: 'function', name: choice.function.name }
        : choice
  const effort = body.reasoning_effort ?? body.reasoning?.effort
  const maxOutput = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens
  return {
    model: body.model,
    ...(instructions.length ? { instructions: instructions.join('\n\n') } : {}),
    input,
    ...(maxOutput ? { max_output_tokens: maxOutput } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { top_p: body.top_p } : {}),
    ...(body.stream != null ? { stream: body.stream } : {}),
    ...(effort ? { reasoning: { effort } } : {}),
    ...(tools.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(body.parallel_tool_calls != null ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
    ...(body.metadata ? { metadata: body.metadata } : {})
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

// Reverse of openAIResponseToResponses: lets a Responses-only provider serve a
// chat-completions or messages client instead of leaking a Responses body.
export function responsesResponseToOpenAI(raw, model) {
  const output = Array.isArray(raw?.output) ? raw.output : []
  let text = ''
  const toolCalls = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part?.type === 'output_text' || typeof part?.text === 'string') text += part.text ?? ''
      }
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const args = item.type === 'custom_tool_call'
        ? JSON.stringify({ input: item.input ?? '' })
        : (item.arguments ?? '{}')
      toolCalls.push({
        id: item.call_id ?? item.id ?? '',
        type: 'function',
        function: { name: item.name ?? '', arguments: args }
      })
    }
  }
  const status = raw?.status
  const finishReason = status === 'incomplete' ? 'length'
    : status === 'failed' ? 'stop'
      : toolCalls.length ? 'tool_calls' : 'stop'
  const input = raw?.usage?.input_tokens ?? 0
  const outputTokens = raw?.usage?.output_tokens ?? 0
  return {
    id: raw?.id ?? `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    model: model ?? raw?.model,
    choices: [{
      index: 0,
      finish_reason: finishReason,
      message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }
    }],
    usage: { prompt_tokens: input, completion_tokens: outputTokens, total_tokens: input + outputTokens }
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

function findRoute(normalized, name) {
  const text = String(name ?? '').trim()
  if (!text) return null
  return (normalized.routes ?? []).find((route) => route.name === text && route.enabled !== false) ?? null
}

function resolveSelector(normalized, selector, fallbackModel = '') {
  if (!selector) return null
  const text = normalized.aliases[selector] ?? selector
  const slash = text.indexOf('/')
  if (slash > 0) {
    const provider = providerByName(normalized, text.slice(0, slash))
    if (provider) return { provider, model: text.slice(slash + 1) }
    // A model id may itself contain a slash (e.g. `qwen/qwen3-max`). When the
    // prefix is not a provider name, fall through to an exact model-id match
    // instead of dropping the selector — otherwise such catalogs are unusable.
  }
  const owner = findModelOwner(normalized, text)
  if (owner) return { provider: owner, model: text }
  const named = providerByName(normalized, text)
  if (named) return { provider: named, model: fallbackModel }
  return null
}

function resolveRouteTarget(normalized, target, fallbackModel = '', vpn = '') {
  if (!target) return null
  const withVpn = (resolved) => (resolved && vpn ? { ...resolved, vpn } : resolved)
  const provider = target.provider ? providerByName(normalized, target.provider) : null
  if (provider) return withVpn({ provider, model: target.model || fallbackModel })
  if (target.model) return withVpn(resolveSelector(normalized, target.model, fallbackModel))
  return null
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
// the only thing that opts an agent out. The router never chooses a model on
// the agent's behalf: the only pin it emits is an explicit profile model
// (carried by imported CCR configs). Without one, the agent keeps its own
// default or last-used model and the gateway routes (or 404s) that name.
// Profile `env` is merged last so an explicit override always wins.
export function buildAgentLaunchEnv(config, agentId, { base, token, eventEnv = {} } = {}) {
  const normalized = normalizeConfig(config)
  const profile = agentProfileFor(normalized, agentId)
  if (profile?.enabled === false) {
    return { env: eventEnv, model: '', profile, scope: 'router-only', routed: false }
  }
  const scope = profile?.scope === 'system-default' ? 'system-default' : 'router-only'
  const model = profile?.model || ''
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
  for (const route of normalized.routes ?? []) {
    if (route.enabled !== false) add(route.name, 'Route')
  }
  for (const alias of Object.keys(normalized.aliases ?? {})) add(alias)
  // The router never picks a startup model on the agent's behalf. The only
  // pin it emits is an explicit profile model (normalized to a routable
  // selector); otherwise agents keep their own default/last-used model.
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
  const model = resolveSelector(profile?.model)
  return { entries, model }
}

// OpenCode reads providers from its own config file, not from OPENAI_BASE_URL,
// so pointing it at the gateway also means publishing the gateway's model list.
// The generated document defines one openai-compatible provider that sends
// every selector back through the router (`provider/model` ids are resolved by
// the gateway). A keyed provider's model map is authoritative: disabled
// providers are omitted, exactly like the gateway's /v1/models response.
// The document pins `model`/`small_model` only when an agent profile explicitly
// carries one; otherwise OpenCode starts on its last-used model.
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
  const pinnedSelector = String(generated.model ?? '').startsWith('orca-router/')
    ? String(generated.model).slice('orca-router/'.length)
    : ''
  // Unknown legacy ids are repointed at the explicit profile pin, or the
  // first published selector, so they still resolve after the CCR switch.
  // This is migration cleanup, not a pin: the document's own model keys are
  // only rewritten when they referenced the legacy provider.
  const fallbackSelector = pinnedSelector || Object.keys(models)[0] || ''
  const selectorFor = (modelId) => (models[modelId] ? modelId : fallbackSelector)
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
  // Never invent a model for the user. An existing model key is kept (after
  // legacy repo pointing); an absent one is left absent so OpenCode starts on
  // the last-used model.
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

export function buildChainFromFallback(normalized, primarySelector, fallback) {
  const chain = []
  const seen = new Set()
  const addTarget = (target) => {
    if (!target?.provider || !target.model) return
    // Two identical provider/model pairs reached through different VPNs are
    // distinct attempts: keep both in the chain.
    const key = `${target.provider.name}/${target.model}\u0000${target.vpn ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    chain.push(target)
  }
  const primaryRoute = findRoute(normalized, primarySelector)
  const primary = primaryRoute ? null : resolveSelector(normalized, primarySelector)
  addTarget(primary)
  let bare = primary?.model
  if (!bare && primaryRoute) {
    bare = primaryRoute.targets
      .map((target) => resolveRouteTarget(normalized, target, '', primaryRoute.vpn))
      .find((target) => target?.model)?.model
  }
  if (primaryRoute) {
    for (const target of primaryRoute.targets) addTarget(resolveRouteTarget(normalized, target, bare ?? '', primaryRoute.vpn))
  }
  // A fallback entry is either a route name or a raw `provider/model` target.
  // A route contributes all of its targets; a raw entry resolves to one.
  const reuse = bare ?? (primaryRoute ? '' : primarySelector)
  for (const entry of fallback?.models ?? []) {
    if (typeof entry !== 'string') continue
    const route = findRoute(normalized, entry)
    if (route) {
      for (const target of route.targets) addTarget(resolveRouteTarget(normalized, target, reuse, route.vpn))
      continue
    }
    addTarget(resolveSelector(normalized, entry, reuse))
  }
  return chain
}

function fallbackRouteFor(normalized, fallback) {
  for (const entry of fallback?.models ?? []) {
    if (typeof entry !== 'string') continue
    const route = findRoute(normalized, entry)
    if (route) return route
  }
  return null
}

export function resolveChain(config, model) {
  const normalized = normalizeConfig(config)
  return buildChainFromFallback(normalized, model, normalized.defaultFallback)
}

function applyPolicies(config, body, headers) {
  let matchedPolicy = null
  for (const policy of config.policies) {
    if (policy.enabled === false) continue
    if (!evaluateCondition(policy.condition, { headers, body })) continue
    matchedPolicy = policy
    if (policy.model && body.model == null) body.model = policy.model
    applyRewrites(body, headers, policy.rewrites)
    break
  }
  return matchedPolicy
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

// Windows are append-ordered and pruned from the front, so the first stale
// entry marks the end of the useful range. Stop there instead of scanning the
// whole array on every scheduling decision.
function rateWindowCount(timestamps, windowMs, now) {
  const cutoff = now - windowMs
  let count = 0
  for (let i = timestamps.length - 1; i >= 0; i--) {
    if (timestamps[i] < cutoff) break
    count++
  }
  return count
}

function tokensInWindow(entries, windowMs, now) {
  const cutoff = now - windowMs
  let total = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].at < cutoff) break
    total += entries[i].tokens
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
  for (const [field, windowMs, kind] of KEY_LIMIT_WINDOWS) {
    const limit = Number(limits[field])
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

// Fraction of the tightest configured limit a key has consumed. Utilisation is
// used only as a scheduling preference; keyWithinLimits remains the hard gate.
function keyUtilization(key, state, now, estimatedTokens, imageCount) {
  const limits = key.limits ?? {}
  let utilization = 0
  for (const [field, windowMs, kind] of KEY_LIMIT_WINDOWS) {
    const limit = Number(limits[field])
    if (!limit || limit <= 0) continue
    const used = kind === 'requests' ? rateWindowCount(state.requests, windowMs, now)
      : kind === 'tokens' ? tokensInWindow(state.tokens, windowMs, now)
      : rateWindowCount(state.images, windowMs, now)
    const needed = kind === 'tokens' ? estimatedTokens : kind === 'images' ? imageCount : 0
    utilization = Math.max(utilization, (used + needed) / limit)
  }
  if (limits.maxRequests) {
    const limit = Number(limits.maxRequests)
    if (limit > 0) utilization = Math.max(utilization, rateWindowCount(state.requests, Number(limits.windowMs ?? 86_400_000), now) / limit)
  }
  if (limits.maxTokens) {
    const limit = Number(limits.maxTokens)
    if (limit > 0) utilization = Math.max(utilization, (tokensInWindow(state.tokens, Number(limits.quotaWindowMs ?? 86_400_000), now) + estimatedTokens) / limit)
  }
  return utilization
}

// A read-only snapshot for the panel: rolling request/token/image totals plus
// one meter per configured limit. Meters stay in the declared window order so
// a bar does not jump between windows while utilization is tied.
export function keyUsageSnapshot(key, state, now = Date.now()) {
  const source = state ?? {}
  const requests = source.requests ?? []
  const tokens = source.tokens ?? []
  const images = source.images ?? []
  const summary = (kind) => ({
    minute: kind === 'tokens' ? tokensInWindow(tokens, 60_000, now)
      : rateWindowCount(kind === 'requests' ? requests : images, 60_000, now),
    hour: kind === 'tokens' ? tokensInWindow(tokens, 3_600_000, now)
      : rateWindowCount(kind === 'requests' ? requests : images, 3_600_000, now),
    day: kind === 'tokens' ? tokensInWindow(tokens, 86_400_000, now)
      : rateWindowCount(kind === 'requests' ? requests : images, 86_400_000, now)
  })
  const limits = key?.limits ?? {}
  const meters = []
  const addMeter = (field, kind, windowMs) => {
    const limit = Number(limits[field])
    if (!Number.isFinite(limit) || limit <= 0) return
    const used = kind === 'tokens' ? tokensInWindow(tokens, windowMs, now)
      : rateWindowCount(kind === 'requests' ? requests : images, windowMs, now)
    meters.push({
      field,
      kind,
      windowMs,
      used,
      limit,
      remaining: Math.max(0, limit - used),
      utilization: used / limit
    })
  }
  for (const [field, windowMs, kind] of KEY_LIMIT_WINDOWS) addMeter(field, kind, windowMs)
  addMeter('maxRequests', 'requests', Number(limits.windowMs ?? 86_400_000))
  addMeter('maxTokens', 'tokens', Number(limits.quotaWindowMs ?? 86_400_000))
  return {
    requests: summary('requests'),
    tokens: summary('tokens'),
    images: summary('images'),
    meters,
    utilization: meters.reduce((max, meter) => Math.max(max, meter.utilization), 0)
  }
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

// Session headers are checked in priority order. `x-orca-session-id` is the
// explicit contract; the others let common agents keep cache affinity without
// any client changes.
const AFFINITY_HEADERS = [
  'x-orca-session-id',
  'x-session-id',
  'x-claude-session-id',
  'x-claude-code-session-id',
  'x-opencode-session-id',
  'x-codex-session-id',
  'x-agent-session-id'
]

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()]
  return Array.isArray(value) ? value[0] : value
}

// Resolve the stable cache-affinity token for a request. Explicit session
// headers win, then body identifiers, then a hash of the stable prompt prefix.
// The caller combines this with provider/model so a different model never
// reuses the old binding.
export function deriveAffinityKey(headers = {}, body = null) {
  for (const name of AFFINITY_HEADERS) {
    const value = headerValue(headers, name)
    if (value != null && String(value).trim()) return `header:${name}:${String(value).trim()}`
  }
  const identifiers = [
    body?.metadata?.user_id,
    body?.metadata?.userId,
    body?.metadata?.session_id,
    body?.user,
    body?.user_id,
    body?.conversation_id
  ]
  for (const value of identifiers) {
    if (typeof value === 'string' && value.trim()) return `body:${value.trim()}`
  }
  if (!body || typeof body !== 'object') return ''
  const prompt = {
    model: body.model,
    system: body.system ?? body.instructions ?? body.systemInstruction,
    messages: body.messages ?? body.input ?? body.contents,
    tools: body.tools
  }
  if (prompt.messages == null && prompt.system == null) return ''
  return `prompt:${createHash('sha256').update(stableStringify(prompt)).digest('hex')}`
}

export function createSidecar({ getConfig, getSecret, fetchImpl, onLog, now = Date.now, solvePOW = solvePOWFn, initialState = null, persistState = null }) {
  const baseFetch = fetchImpl ?? globalThis.fetch
  const proxyFetch = createProxyFetch({ getSecret, baseFetch })
  // Routes opt in to a VPN server by id. Every upstream call made while that
  // route serves a request uses this scoped fetch; everything else stays direct.
  const scopedFetch = (vpnId, config = configRef()) => {
    const server = findVpnServer(config, vpnId)
    return server ? (url, init) => proxyFetch(url, init, server) : baseFetch
  }
  const vpnLabel = (config, vpnId) => findVpnServer(config, vpnId)?.name ?? null
  const webchatSessions = new WebChatSessionStore({ now })
  let webchatRequestCount = 0
  const logs = []
  let server = null
  let bound = null
  const keyStates = new Map() // credential secretKey/id -> {requests:[], tokens:[], images:[]}
  const keyCooldowns = new Map() // credential identity -> timestamp it becomes usable again
  const schedulerState = createSchedulerState()
  const providerCircuits = new Map() // provider name -> { failures, state, openUntil, probeInFlight }
  const providerHealth = new Map() // provider name -> { latencyMs, samples, failures, successes, lastSuccessAt, lastFailureAt }
  const providerAffinity = new Map() // affinity token -> { provider, at }
  // A route keeps serving the same target until that target fails. Keyed by
  // route name + affinity token, so separate sessions can pin different targets.
  const routeAffinity = new Map()
  const affinityBindings = new Map() // provider\0model\0affinity -> { keyId, expiresAt }
  const responseCache = createResponseCache({ now })
  const pruneProviderAffinity = (ttl) => {
    if (providerAffinity.size <= 2000) return
    const cutoff = now() - ttl
    for (const [token, value] of providerAffinity) if (value.at < cutoff) providerAffinity.delete(token)
  }
  const pruneRouteAffinity = (ttl) => {
    if (routeAffinity.size <= 500) return
    const cutoff = now() - ttl
    for (const [token, value] of routeAffinity) if (value.at < cutoff) routeAffinity.delete(token)
  }
  const stats = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cost: 0, latencyMsTotal: 0, byProvider: {}, byModel: {}, routeRequests: {}, routeFailovers: {}, cacheHits: 0, cacheSavedTokens: 0, cacheSavedCost: 0, compressionSavedChars: 0, relayEvents: 0 }

  // --- Runtime state persistence -------------------------------------------
  // Usage counters and provider health are process-local, but they are
  // snapshotted to Orca storage so a plugin/worker restart does not reset the
  // 24-hour windows or the health badges. Nothing here contains a secret value:
  // key identities are secret *names*, matching what config already stores.
  const runtimeSnapshot = () => {
    const copyState = (state) => ({
      requests: [...(state.requests ?? [])],
      // `tokens` is a numeric total per entry (see recordKeyUsage); keep it as
      // a primitive so tokensInWindow still sums correctly after a restore.
      tokens: (state.tokens ?? []).map((entry) => ({ at: entry.at, tokens: entry.tokens })),
      images: [...(state.images ?? [])]
    })
    return {
      version: RUNTIME_STATE_VERSION,
      savedAt: now(),
      keyStates: [...keyStates].map(([id, state]) => [id, copyState(state)]),
      keyCooldowns: [...keyCooldowns].map(([id, until]) => [id, until]),
      providerHealth: [...providerHealth].map(([name, health]) => [name, { ...health }]),
      providerCircuits: [...providerCircuits].map(([name, circuit]) => [name, {
        failures: circuit.failures,
        state: circuit.state,
        openUntil: circuit.openUntil,
        probeInFlight: false
      }]),
      stats: {
        ...stats,
        byProvider: { ...stats.byProvider },
        byModel: { ...stats.byModel }
      }
    }
  }

  const restoreRuntimeState = (state) => {
    if (!state || typeof state !== 'object' || state.version !== RUNTIME_STATE_VERSION) return
    const timestamp = now()
    const DAY = 86_400_000
    if (Array.isArray(state.keyStates)) {
      for (const [id, raw] of state.keyStates) {
        if (typeof id !== 'string' || !id || !raw || typeof raw !== 'object') continue
        const entry = {
          requests: Array.isArray(raw.requests) ? raw.requests.filter((value) => Number.isFinite(value)) : [],
          tokens: Array.isArray(raw.tokens)
            ? raw.tokens.filter((value) => value && Number.isFinite(value.at) && Number.isFinite(value.tokens))
              .map((value) => ({ at: value.at, tokens: value.tokens }))
            : [],
          images: Array.isArray(raw.images) ? raw.images.filter((value) => Number.isFinite(value)) : []
        }
        pruneTimestamps(entry.requests, DAY, timestamp)
        pruneTokenEntries(entry.tokens, DAY, timestamp)
        pruneTimestamps(entry.images, DAY, timestamp)
        if (entry.requests.length || entry.tokens.length || entry.images.length) keyStates.set(id, entry)
      }
    }
    if (Array.isArray(state.keyCooldowns)) {
      for (const [id, until] of state.keyCooldowns) {
        if (typeof id === 'string' && Number.isFinite(until) && until > timestamp) keyCooldowns.set(id, until)
      }
    }
    if (Array.isArray(state.providerHealth)) {
      for (const [name, health] of state.providerHealth) {
        if (typeof name !== 'string' || !health || typeof health !== 'object') continue
        providerHealth.set(name, {
          latencyMs: Number.isFinite(health.latencyMs) ? health.latencyMs : null,
          samples: Number.isFinite(health.samples) ? health.samples : 0,
          failures: Number.isFinite(health.failures) ? health.failures : 0,
          successes: Number.isFinite(health.successes) ? health.successes : 0,
          lastSuccessAt: Number.isFinite(health.lastSuccessAt) ? health.lastSuccessAt : 0,
          lastFailureAt: Number.isFinite(health.lastFailureAt) ? health.lastFailureAt : 0
        })
      }
    }
    if (Array.isArray(state.providerCircuits)) {
      for (const [name, raw] of state.providerCircuits) {
        if (typeof name !== 'string' || !raw || typeof raw !== 'object') continue
        const expired = raw.state === 'open' && Number.isFinite(raw.openUntil) && raw.openUntil <= timestamp
        providerCircuits.set(name, {
          failures: expired ? 0 : Number.isFinite(raw.failures) ? raw.failures : 0,
          state: expired ? 'closed' : (raw.state === 'open' || raw.state === 'half-open' ? raw.state : 'closed'),
          openUntil: expired ? 0 : Number.isFinite(raw.openUntil) ? raw.openUntil : 0,
          probeInFlight: false
        })
      }
    }
    if (state.stats && typeof state.stats === 'object') {
      const source = state.stats
      const num = (value) => Number.isFinite(value) ? value : 0
      stats.requests = num(source.requests)
      stats.errors = num(source.errors)
      stats.inputTokens = num(source.inputTokens)
      stats.outputTokens = num(source.outputTokens)
      stats.cost = num(source.cost)
      stats.latencyMsTotal = num(source.latencyMsTotal)
      stats.cacheHits = num(source.cacheHits)
      stats.cacheSavedTokens = num(source.cacheSavedTokens)
      stats.cacheSavedCost = num(source.cacheSavedCost)
      stats.compressionSavedChars = num(source.compressionSavedChars)
      stats.relayEvents = num(source.relayEvents)
      stats.byProvider = source.byProvider && typeof source.byProvider === 'object' ? { ...source.byProvider } : {}
      stats.byModel = source.byModel && typeof source.byModel === 'object' ? { ...source.byModel } : {}
      stats.routeFailovers = source.routeFailovers && typeof source.routeFailovers === 'object' ? { ...source.routeFailovers } : {}
      stats.routeRequests = source.routeRequests && typeof source.routeRequests === 'object' ? { ...source.routeRequests } : {}
    }
  }
  restoreRuntimeState(initialState)

  // `persistState` is injected by main.mjs and is best-effort: a storage failure
  // must never break a request. Writes are throttled by injected time so the
  // pure tests stay deterministic, with a trailing timer for the tail of a burst.
  let runtimeDirty = false
  let lastRuntimePersistAt = 0
  let runtimeFlushTimer = null
  const persistRuntimeNow = () => {
    if (!persistState) return
    if (runtimeFlushTimer != null) {
      clearTimeout(runtimeFlushTimer)
      runtimeFlushTimer = null
    }
    runtimeDirty = false
    lastRuntimePersistAt = now()
    try {
      const result = persistState(runtimeSnapshot())
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch { /* best effort */ }
  }
  const markRuntimeDirty = () => {
    if (!persistState) return
    runtimeDirty = true
    if (now() - lastRuntimePersistAt >= RUNTIME_PERSIST_THROTTLE_MS) {
      persistRuntimeNow()
      return
    }
    if (runtimeFlushTimer == null && typeof setTimeout === 'function') {
      runtimeFlushTimer = setTimeout(() => {
        runtimeFlushTimer = null
        if (runtimeDirty) persistRuntimeNow()
      }, RUNTIME_PERSIST_THROTTLE_MS)
      runtimeFlushTimer.unref?.()
    }
  }

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
    markRuntimeDirty()
    if (record.resolvedProvider) stats.byProvider[record.resolvedProvider] = (stats.byProvider[record.resolvedProvider] ?? 0) + 1
    if (record.resolvedModel) stats.byModel[record.resolvedModel] = (stats.byModel[record.resolvedModel] ?? 0) + 1
    if (record.route) stats.routeRequests[record.route] = (stats.routeRequests[record.route] ?? 0) + 1
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
    markRuntimeDirty()
  }

  const circuitFor = (providerName) => {
    let circuit = providerCircuits.get(providerName)
    if (!circuit) {
      circuit = { failures: 0, state: 'closed', openUntil: 0, probeInFlight: false }
      providerCircuits.set(providerName, circuit)
    }
    return circuit
  }

  const providerCircuitAllows = (provider, config) => {
    const rules = normalizeCircuitBreaker(config.circuitBreaker)
    if (!rules.enabled) return { allowed: true }
    const circuit = circuitFor(provider.name)
    const timestamp = now()
    if (circuit.state === 'open') {
      if (timestamp < circuit.openUntil) {
        return { allowed: false, retryAfterMs: circuit.openUntil - timestamp }
      }
      circuit.state = 'half-open'
      circuit.probeInFlight = false
    }
    if (circuit.state === 'half-open') {
      if (circuit.probeInFlight) return { allowed: false, retryAfterMs: 1000 }
      circuit.probeInFlight = true
      return { allowed: true, probe: true }
    }
    return { allowed: true }
  }

  const healthFor = (providerName) => {
    let entry = providerHealth.get(providerName)
    if (!entry) {
      entry = { latencyMs: null, samples: 0, failures: 0, successes: 0, lastSuccessAt: 0, lastFailureAt: 0 }
      providerHealth.set(providerName, entry)
    }
    return entry
  }

  // Time-to-first-byte samples feed the provider ranking. The EWMA reacts to a
  // provider slowing down without letting one slow request reorder the chain.
  const recordHealthSample = (provider, outcome, config, latencyMs) => {
    if (outcome !== 'success' && outcome !== 'failure') return
    markRuntimeDirty()
    const entry = healthFor(provider.name)
    if (outcome === 'success') {
      const sample = Number(latencyMs)
      if (Number.isFinite(sample) && sample >= 0) {
        const smoothing = normalizeProviderHealth(config?.providerHealth).smoothing
        entry.latencyMs = entry.samples === 0 ? sample : entry.latencyMs * (1 - smoothing) + sample * smoothing
        entry.samples += 1
      }
      entry.successes += 1
      entry.failures = 0
      entry.lastSuccessAt = now()
      return
    }
    entry.failures += 1
    entry.lastFailureAt = now()
  }

  // Provider-level failures open the circuit. A successful HTTP response from
  // the provider - including a 4xx caused by the request or a key - proves the
  // endpoint is reachable, so it closes the circuit without resetting key state.
  const recordProviderOutcome = (provider, outcome, config, latencyMs) => {
    recordHealthSample(provider, outcome, config, latencyMs)
    markRuntimeDirty()
    const rules = normalizeCircuitBreaker(config.circuitBreaker)
    if (!rules.enabled) return
    const circuit = circuitFor(provider.name)
    if (outcome === 'success') {
      circuit.failures = 0
      circuit.state = 'closed'
      circuit.openUntil = 0
      circuit.probeInFlight = false
      return
    }
    if (outcome === 'neutral') {
      circuit.probeInFlight = false
      return
    }
    if (outcome !== 'failure') return
    circuit.probeInFlight = false
    circuit.failures += 1
    if (circuit.state === 'half-open' || circuit.failures >= rules.failureThreshold) {
      circuit.state = 'open'
      circuit.openUntil = now() + rules.cooldownMs
      circuit.probeInFlight = false
    }
  }

  // What the panel shows for a provider: measured speed plus the same health
  // signals the ranking uses, so the displayed state explains the order.
  const providerHealthView = (providerName, timestamp, config) => {
    const entry = providerHealth.get(providerName)
    const circuit = providerCircuits.get(providerName)
    const rules = normalizeCircuitBreaker(config.circuitBreaker)
    const options = normalizeProviderHealth(config.providerHealth)
    const open = circuit?.state === 'open' && circuit.openUntil > timestamp
    const failedSinceSuccess = Boolean(entry && entry.lastFailureAt > (entry.lastSuccessAt ?? 0))
    const degraded = Boolean(entry && failedSinceSuccess && entry.failures >= rules.failureThreshold)
    const stale = Boolean(entry && entry.samples > 0 && entry.lastSuccessAt && timestamp - entry.lastSuccessAt > options.staleMs)
    const state = open ? 'open' : degraded ? 'degraded' : stale ? 'stale' : entry && entry.samples > 0 ? 'healthy' : 'unknown'
    return {
      state,
      latencyMs: entry && entry.samples > 0 ? Math.round(entry.latencyMs) : null,
      samples: entry?.samples ?? 0,
      failures: entry?.failures ?? 0,
      lastSuccessAt: entry?.lastSuccessAt || undefined,
      lastFailureAt: entry?.lastFailureAt || undefined
    }
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

  const pickKey = (provider, config, estimatedTokens, imageCount, { allowCooling = false, model = '', affinity = '' } = {}) => {
    const timestamp = now()
    const scheduler = normalizeScheduler(config.scheduler)
    const bindingKey = scheduler.cacheAffinity && affinity
      ? `${provider.name}\u0000${model}\u0000${affinity}`
      : ''
    const rememberAffinity = (key) => {
      if (!bindingKey || !key) return
      if (affinityBindings.size > 5000) {
        for (const [id, binding] of affinityBindings) if (binding.expiresAt <= timestamp) affinityBindings.delete(id)
      }
      affinityBindings.set(bindingKey, {
        keyId: keyIdentity(key),
        expiresAt: timestamp + scheduler.cacheAffinityTtlMs
      })
    }
    const keys = (provider.keys ?? []).filter((key) => key.enabled !== false)
    // A provider with no configured keys is keyless/pass-through, not exhausted.
    if (!keys.length) return { key: null, keyless: true }
    const cooling = keys.filter((key) => (keyCooldowns.get(keyIdentity(key)) ?? 0) <= timestamp)
    // A retry inside the same request may reuse a key that was just cooled by a
    // 429, after the retry delay. A fresh request still starts from the healthy
    // pool and gets the explicit exhausted response if there is none.
    const available = allowCooling && !cooling.length ? keys : cooling
    // Compute the hard limit gate and the scheduling utilization once per key;
    // both read the same rolling state and used to rescan every window twice.
    const availability = available.map((key) => {
      const id = keyIdentity(key)
      const state = keyState(id)
      return {
        key,
        id,
        priority: key.priority ?? 0,
        weight: key.weight ?? 1,
        withinLimits: keyWithinLimits(key, state, timestamp, estimatedTokens, imageCount),
        utilization: keyUtilization(key, state, timestamp, estimatedTokens, imageCount)
      }
    })
    const usable = availability.filter((item) => item.withinLimits)
    if (!usable.length) {
      // Legacy "overflow" mode keeps the previous behaviour of using a key
      // anyway when every key is cooling or over limit. The default is a hard
      // stop so an explicit exhausted response is visible to the client.
      if (scheduler.allKeysExhausted === 'overflow') {
        const candidates = available.length ? available : keys
        const within = candidates.filter((key) => keyWithinLimits(key, keyState(keyIdentity(key)), timestamp, estimatedTokens, imageCount))
        const pool = within.length ? within : candidates
        const chosen = selectScheduledKey({
          providerName: provider.name,
          candidates: pool.map((key) => ({
            key,
            id: keyIdentity(key),
            priority: key.priority ?? 0,
            weight: key.weight ?? 1,
            utilization: keyUtilization(key, keyState(keyIdentity(key)), timestamp, estimatedTokens, imageCount)
          })),
          scheduler: { ...scheduler, priorityTiers: false, utilizationAware: false },
          state: schedulerState
        })
        rememberAffinity(chosen?.key)
        return { key: chosen?.key ?? null, overflow: true }
      }
      const limited = availability.length > 0 && availability.every((item) => !item.withinLimits)
      return { key: null, exhausted: true, reason: limited ? 'limited' : 'cooling' }
    }
    if (bindingKey) {
      const binding = affinityBindings.get(bindingKey)
      if (binding) {
        const bound = binding.expiresAt > timestamp
          ? usable.find((item) => item.id === binding.keyId)
          : null
        if (bound) {
          binding.expiresAt = timestamp + scheduler.cacheAffinityTtlMs
          return { key: bound.key, affinity: true }
        }
        affinityBindings.delete(bindingKey)
      }
    }
    const chosen = selectScheduledKey({
      providerName: provider.name,
      candidates: usable.map(({ key, id, priority, weight, utilization }) => ({ key, id, priority, weight, utilization })),
      scheduler,
      state: schedulerState
    })
    rememberAffinity(chosen?.key)
    return { key: chosen?.key ?? null, exhausted: !chosen, reason: chosen ? '' : 'unavailable' }
  }

  const markKeyFailure = (key, status, retryAfter) => {
    if (!key) return
    const headerCooldown = retryAfterMs(retryAfter, now())
    const cooldown = headerCooldown > 0
      ? Math.min(MAX_KEY_COOLDOWN_MS, Math.max(1000, headerCooldown))
      : KEY_COOLDOWN_MS[status]
    if (!cooldown) return
    if (keyCooldowns.size > 2000) {
      const t = now()
      for (const [id, until] of keyCooldowns) if (until <= t) keyCooldowns.delete(id)
    }
    keyCooldowns.set(keyIdentity(key), now() + cooldown)
    markRuntimeDirty()
  }

  const clearKeyFailure = (key) => {
    if (!key) return
    keyCooldowns.delete(keyIdentity(key))
    markRuntimeDirty()
  }

  const recordKeyUsage = (key, tokens, imageCount) => {
    if (!key) return
    const state = keyState(key.secretKey ?? key.id)
    const timestamp = now()
    recordInWindow(state.requests, timestamp, 86_400_000)
    if (tokens) recordTokensInWindow(state.tokens, { at: timestamp, tokens }, 86_400_000)
    for (let i = 0; i < imageCount; i++) recordInWindow(state.images, timestamp, 86_400_000)
    markRuntimeDirty()
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

  // Semantic cache embeddings: one explicit provider/model chosen in the panel,
  // called through the same key pool and header rules as chat traffic. Any
  // failure simply bypasses the semantic layer; exact caching still works.
  async function embedCacheText(text, options, config, vpn = '') {
    if (!text || !options.embeddingProvider || !options.embeddingModel) return null
    const provider = providersFor(config).find((item) => item.name === options.embeddingProvider)
    if (!provider) return null
    const protocols = provider.protocols ?? []
    if (!protocols.includes('openai') && !protocols.includes('passthrough')) return null
    const selection = pickKey(provider, config, 0, 0, { model: options.embeddingModel })
    if (selection.exhausted) return null
    const incoming = { headers: {} }
    const headers = buildHeaders(provider, selection.key, incoming, 'openai')
    headers['content-type'] = 'application/json'
    try {
      const response = await scopedFetch(vpn, config)(joinUpstreamUrl(endpointFor(provider, 'openai'), '/embeddings'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: options.embeddingModel, input: text }),
        signal: AbortSignal.timeout(20_000)
      })
      if (!response.ok) return null
      const payload = await response.json()
      const vector = payload?.data?.[0]?.embedding ?? payload?.embedding
      return Array.isArray(vector) && vector.length ? vector : null
    } catch {
      return null
    }
  }

  // Capture what the gateway sends back so a successful response can be
  // replayed later. Oversized bodies are simply not cached.
  function createResponseCapture(res, limit) {
    let body = ''
    let contentType = 'application/json'
    let overflow = false
    const append = (chunk) => {
      if (chunk == null || overflow) return
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      if (body.length + text.length > limit) {
        overflow = true
        body = ''
        return
      }
      body += text
    }
    return {
      res: {
        writeHead(status, headers) {
          if (headers && typeof headers === 'object') {
            contentType = headers['content-type'] ?? headers['Content-Type'] ?? contentType
          }
          return res.writeHead(status, headers)
        },
        write(chunk, ...rest) {
          append(chunk)
          return res.write(chunk, ...rest)
        },
        end(chunk, ...rest) {
          append(chunk)
          return res.end(chunk, ...rest)
        }
      },
      result: () => (overflow || !body ? null : { body, contentType })
    }
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
    if (from === 'openai' && to === 'responses') return openAIToResponses(body)
    if (from === 'anthropic' && to === 'responses') return openAIToResponses(anthropicToOpenAI(body))
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
    if (from === 'responses') {
      const openai = responsesResponseToOpenAI(raw, model)
      return to === 'anthropic' ? openAIResponseToAnthropic(openai, model) : openai
    }
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

  // Native web-chat transport path. Drives DeepSeek Web / Qwen Web directly and
  // returns a synthetic OpenAI Response so the standard translation pipeline
  // converts it to the client's protocol. Failures are returned as synthetic
  // error Responses (with .status / retry-after) so the router's existing
  // key-rotation and cooldown logic handles them like any other upstream.
  async function webchatForwardOnce({ target, provider, clientProtocol, body, path, wantsStream, affinityKey, config }) {
    // Bound memory over a long-running gateway: evict idle web-chat sessions
    // periodically (cheap relative to an upstream call).
    if (++webchatRequestCount % 50 === 0) webchatSessions.sweepIdle()
    const upstreamBody = body ? structuredClone(body) : null
    if (upstreamBody && target.model) upstreamBody.model = target.model
    let openaiBody = upstreamBody
    if (clientProtocol !== 'openai' || !isChatPath(path)) {
      openaiBody = translateRequest(upstreamBody ?? {}, clientProtocol, 'openai')
    }
    const messages = openaiBody?.messages ?? []
    const tools = openaiBody?.tools ?? []
    const model = target.model || openaiBody?.model || ''
    if (!Array.isArray(messages) || !messages.length) {
      const error = new Error('web-chat transport requires a chat request with messages')
      error.status = 400
      error.type = 'invalid_request_error'
      return buildWebChatErrorResponse(error)
    }
    const selection = pickKey(provider, config, 0, 0, { model, affinity: affinityKey })
    const key = selection?.key
    if (!key) {
      // Web-chat has no upstream HTTP call to produce an exhaustion signal, so
      // surface the same structured scheduler result the normal path uses. The
      // retry loop then emits the documented 420 / router_exhausted response
      // (including Retry-After) instead of a generic upstream failure.
      if (selection?.exhausted) {
        const scheduler = normalizeScheduler(config.scheduler)
        return {
          error: {
            status: scheduler.exhaustedStatus,
            code: 'all_keys_exhausted',
            message: `no usable credential for provider '${provider.name}' (${selection.reason === 'cooling' ? 'all keys are cooling down' : 'all keys are over their limits'})`
          }
        }
      }
      const error = new Error(`no usable credential for provider '${provider.name}' (web-chat needs an auth secret)`)
      error.status = 502
      error.type = 'upstream_http_error'
      return buildWebChatErrorResponse(error)
    }
    const creds = getSecret(key.secretKey)
    if (!creds) {
      const error = new Error(`missing auth secret for provider '${provider.name}'`)
      error.status = 502
      error.type = 'upstream_http_error'
      return buildWebChatErrorResponse(error)
    }
    const sessionKey = webchatSessionKey(provider.transport, affinityKey, keyIdentity(key))
    const session = webchatSessions.getOrCreate(sessionKey)
    webchatSessions.prepareForPrompt(sessionKey) // roll over depth/TTL (resets id when stale)

    const webFetch = scopedFetch(target.vpn, config)
    const transport = provider.transport === 'deepseek-web'
      ? new DeepSeekWebTransport({ creds, fetchFn: webFetch, solvePOW, now, log: onLog ?? (() => {}) })
      : new QwenWebTransport({ creds, fetchFn: webFetch, now, log: onLog ?? (() => {}) })
    const webchat = createRecoveredWebChat(createWebChatProvider(transport, { now }), { log: onLog ?? (() => {}) })

    try {
      const result = await webchat.forwardOnce({ session, model, messages, tools })
      if (result.modelError) {
        // Content-level model error (e.g. Qwen success:false mid-stream).
        const error = new Error(`web-chat model error: ${result.modelError.content || 'unknown'}`)
        error.status = 502
        error.type = 'upstream_http_error'
        return buildWebChatErrorResponse(error)
      }
      const toolCall = result.tool_calls?.[0]?.function
        ? { name: result.tool_calls[0].function.name, arguments: result.tool_calls[0].function.arguments }
        : null
      webchatSessions.storeHistory(sessionKey, result.promptUsed, result.content, toolCall)
      const built = buildWebChatSuccessResponse(result, model, { wantsStream, clientProtocol, now })
      return {
        upstreamRes: built.upstreamRes,
        responseProtocol: 'openai',
        forwardedModel: model,
        key,
        bufferForStream: built.bufferForStream,
        wantsStream,
        targetPath: path,
      }
    } catch (error) {
      return {
        upstreamRes: buildWebChatErrorResponse(error),
        responseProtocol: 'openai',
        forwardedModel: model,
        key,
        bufferForStream: false,
        wantsStream,
        targetPath: path,
      }
    }
  }

  async function forwardOnce(target, clientProtocol, path, body, incoming, { rawBody, wantsStreamHint, allowCooling = false, affinityKey = '', config: passedConfig } = {}) {
    const config = passedConfig ?? configRef()
    const provider = target.provider
    const responseProtocol = targetProtocol(provider, clientProtocol)
    const baseUrl = endpointFor(provider, responseProtocol)
    const chat = isChatPath(path)
    const wantsStream = wantsStreamHint ?? body?.stream === true
    if (isWebChatTransport(provider)) {
      return webchatForwardOnce({ target, provider, clientProtocol, body, path, wantsStream, affinityKey, config })
    }
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
    const selection = pickKey(provider, config, estimated, imageCount, { allowCooling, model: target.model, affinity: affinityKey })
    const key = selection.key
    const headers = buildHeaders(provider, key, incoming, responseProtocol)
    // Never leak the client's gateway auth to providers.
    delete headers['x-auth-api-key']
    const hasConfiguredSecrets = (provider.keys ?? []).some((k) => k.enabled !== false && getSecret(k.secretKey))
    if (key) {
      const secret = getSecret(key.secretKey)
      if (!secret && !key.forwardClientAuth) {
        return { error: { status: 502, message: `no usable credential for provider '${provider.name}' (missing secret for selected key)` } }
      }
    } else if (hasConfiguredSecrets && selection.exhausted) {
      const scheduler = normalizeScheduler(config.scheduler)
      return {
        error: {
          status: scheduler.exhaustedStatus,
          code: 'all_keys_exhausted',
          message: `no usable credential for provider '${provider.name}' (${selection.reason === 'cooling' ? 'all keys are cooling down' : 'all keys are over their limits'})`
        }
      }
    }
    // Providers with no configured keys are treated as keyless/pass-through at
    // the provider side; client gateway auth is still never forwarded upstream.
    // A route's VPN applies to the whole upstream exchange, including streams.
    const upstreamFetch = scopedFetch(target.vpn, config)
    const upstreamRes = await upstreamFetch(url, {
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
    let bodyBytes = 0
    for await (const chunk of req) {
      chunks.push(chunk)
      bodyBytes += chunk.length
      if (bodyBytes > SIDECAR_MAX_BODY_BYTES) {
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
    // Reset a web-chat remote session (POST /reset-session with
    // { provider, affinityKey, keyIdentity }), so a stale conversation can be
    // dropped and restarted. Auth via the same gateway token as other requests.
    if (req.method === 'POST' && path === '/reset-session') {
      const auth = clientAuth(config, req.headers, 0)
      if (!auth.ok) {
        res.writeHead(auth.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: auth.message } }))
        return
      }
      const payload = body && typeof body === 'object' ? body : {}
      const key = webchatSessionKey(payload.transport || 'deepseek-web', payload.affinityKey || 'anon', payload.keyIdentity || '')
      const removed = webchatSessions.delete(key)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, removed, key }))
      return
    }
    if (req.method === 'GET' && path === '/webchat-sessions') {
      const auth = clientAuth(config, req.headers, 0)
      if (!auth.ok) {
        res.writeHead(auth.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: auth.message } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ sessions: webchatSessions.list() }))
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
    // Optimization applies only to actual generation endpoints, never to
    // auxiliary chat-shaped calls such as /v1/messages/count_tokens.
    const optimizableChat = isChatPath(path)

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
    const affinityKey = deriveAffinityKey(headers, workingBody)
    const matchedPolicy = workingBody ? applyPolicies(config, workingBody, headers) : null
    const effectiveModel = workingBody?.model ?? requestedModel
    // A route is the failover unit: when the request names one, its targets
    // form the chain and the route's strategy decides health ranking. A policy
    // can still add retries or extra targets after the route.
    const matchedRoute = chatRequest ? findRoute(config, effectiveModel) : null
    // The matched route name is recorded on every log entry so the request log
    // shows which route a request came through and which model it selected.
    const routeName = matchedRoute?.name ?? null
    // A policy may point at a route or a raw provider/model target. A raw
    // provider/model primary is never given extra failover targets: it is a
    // single target with retries.
    const policyFallback = matchedPolicy?.fallback ?? null
    const chain = chatRequest ? buildChainFromFallback(config, effectiveModel, policyFallback) : []
    if (!chain.length) {
      if (!chatRequest) {
        // Passthrough for non-chat endpoints (embeddings, audio, unknown paths):
        // route via the first enabled provider, preserving body/stream.
        const passthroughProvider = providersFor(config)[0]
        if (passthroughProvider) chain.push({ provider: passthroughProvider, model: effectiveModel || requestedModel })
      }
    }
    if (!chain.length) {
      const missingModel = !effectiveModel && chatRequest
      const status = missingModel ? 400 : 404
      const entry = log({ upstream: null, resolvedProvider: null, route: routeName, vpn: vpnLabel(config, matchedRoute?.vpn), requestModel: requestedModel, resolvedModel: effectiveModel, protocol: clientProtocol, stream: wantsStream, errorCode: missingModel ? 'model_required' : 'model_not_found', status, latencyMs: 0, attempts: [], error: missingModel ? 'no model specified' : 'no provider configured for model', requestBody: workingBody, requestHeaders: redactValue(req.headers) }, { config, status })
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: missingModel
          ? { message: 'no model was specified and no default model could be resolved', type: 'invalid_request_error', code: 'model_required' }
          : { message: `no provider could resolve model '${effectiveModel}'`, type: 'invalid_request_error', code: 'model_not_found' }
      }))
      return entry && undefined
    }

    // Health ranking only reorders a route's targets. A raw
    // provider/model request has one target, so there is nothing to rank.
    const chainRoute = matchedRoute ?? fallbackRouteFor(config, policyFallback)
    const rankByHealth = chainRoute ? chainRoute.strategy !== 'ordered' : false
    const orderedChain = rankProviderTargets({
      targets: chain,
      health: providerHealth,
      circuits: providerCircuits,
      affinity: providerAffinity.get(affinityKey),
      config,
      enabled: rankByHealth,
      timestamp: now()
    })
    if (orderedChain.length && affinityKey && rankByHealth) {
      const scheduler = normalizeScheduler(config.scheduler)
      if (scheduler.cacheAffinity) {
        providerAffinity.set(affinityKey, { provider: orderedChain[0].provider.name, at: now() })
        pruneProviderAffinity(scheduler.cacheAffinityTtlMs)
      }
    }
    // A route stays on the target that last served it until that target fails.
    // The pin is applied after health ranking so it wins over a latency wobble,
    // but a failed target is demoted by health/circuit state on the next request.
    const schedulerOptions = normalizeScheduler(config.scheduler)
    const routePinKey = matchedRoute ? `${matchedRoute.name}\0${affinityKey || 'anon'}` : null
    if (routePinKey && orderedChain.length > 1) {
      const pin = routeAffinity.get(routePinKey)
      if (pin && now() - pin.at <= schedulerOptions.cacheAffinityTtlMs) {
        const index = orderedChain.findIndex((target) => (
          target.provider.name === pin.provider && target.model === pin.model
        ))
        if (index > 0) orderedChain.unshift(orderedChain.splice(index, 1)[0])
      }
      pruneRouteAffinity(schedulerOptions.cacheAffinityTtlMs)
    }

    // --- Opt-in request optimization -------------------------------------
    // Compression runs on the post-rule body. Context relay is applied per
    // attempt when the chain moves to another target. The response cache is
    // keyed by the exact transformed request and the first resolved target.
    const compressionOptions = normalizeCompression(config.compression)
    const relayOptions = normalizeContextRelay(config.contextRelay)
    const cacheOptions = normalizeResponseCache(config.responseCache)
    let routedBody = workingBody
    let compressionInfo = null
    if (optimizableChat && workingBody && compressionOptions.enabled) {
      const requestedMode = String(headers['x-router-compression'] ?? '').toLowerCase()
      const mode = requestedMode === 'off'
        ? null
        : COMPRESSION_MODES.includes(requestedMode) ? requestedMode : compressionOptions.mode
      if (mode && bodyCharLength(workingBody) >= compressionOptions.minChars) {
        const result = compressChatBody(workingBody, {
          protocol: clientProtocol,
          options: { ...compressionOptions, mode }
        })
        if (result.changed) {
          routedBody = result.body
          compressionInfo = { mode, before: result.before, after: result.after, saved: result.before - result.after }
          stats.compressionSavedChars += compressionInfo.saved
        }
      }
    }

    let cachePlan = null
    let cacheVector = null
    if (optimizableChat && req.method === 'POST' && routedBody && orderedChain.length
      && shouldCacheRequest({ protocol: clientProtocol, body: routedBody, headers, options: cacheOptions })) {
      const cacheTarget = orderedChain[0]
      const scopeParts = [clientProtocol, wantsStream ? 'stream' : 'json', cacheTarget.provider.name, cacheTarget.model]
      if (cacheOptions.mode === 'semantic') scopeParts.push(`embed:${cacheOptions.embeddingProvider}/${cacheOptions.embeddingModel}`)
      const scope = scopeParts.join('\u0000')
      cachePlan = {
        scope,
        key: canonicalCacheKey({ scope, body: routedBody }),
        target: cacheTarget,
        paramsKey: cacheOptions.mode === 'semantic' ? semanticParamsKey(routedBody, clientProtocol) : null,
        promptText: cacheOptions.mode === 'semantic' ? extractPromptText(routedBody, clientProtocol) : ''
      }
    }
    let cached = cachePlan ? responseCache.get(cachePlan.key) : null
    let cacheHitKind = cached ? 'hit' : null
    const cacheBypassed = !cachePlan && cacheOptions.enabled
      && String(headers['x-router-cache'] ?? '').toLowerCase() === 'off'
    if (cachePlan && !cached && cacheOptions.mode === 'semantic' && cachePlan.promptText) {
      cacheVector = await embedCacheText(cachePlan.promptText, cacheOptions, config, cachePlan.target?.vpn)
      if (cacheVector) {
        cached = responseCache.findSemantic(cachePlan.scope, cacheVector, cacheOptions.threshold, cacheOptions.maxEntries, cachePlan.paramsKey)
        if (cached) cacheHitKind = 'semantic-hit'
      }
    }
    if (cached) {
      const responseHeaders = {
        'content-type': cached.response.contentType || 'application/json',
        'x-router-cache': cacheHitKind
      }
      if (compressionInfo) responseHeaders['x-router-compression'] = `${compressionInfo.mode}; saved=${compressionInfo.saved}`
      if (config.exposeRoutingHeaders) {
        responseHeaders['x-router-provider'] = cachePlan.target.provider.name
        responseHeaders['x-router-model'] = String(cachePlan.target.model ?? '')
        responseHeaders['x-router-attempts'] = '0'
      }
      res.writeHead(cached.response.status, responseHeaders)
      res.end(cached.response.body)
      log({
        upstream: cachePlan.target.provider.name,
        resolvedProvider: cachePlan.target.provider.name,
        route: routeName,
        resolvedModel: cachePlan.target.model,
        model: cachePlan.target.model,
        requestModel: requestedModel,
        protocol: clientProtocol,
        stream: wantsStream,
        policyId: matchedPolicy?.id ?? null,
        status: cached.response.status,
        latencyMs: 0,
        attempts: [],
        failures: [],
        cache: cacheHitKind,
        cacheSavedTokens: (cached.tokens?.input ?? 0) + (cached.tokens?.output ?? 0),
        cacheSavedCost: Number(cached.cost ?? 0),
        tokens: cached.tokens ?? null,
        cost: 0,
        requestBody: routedBody,
        requestHeaders: redactValue(req.headers)
      }, { config, status: cached.response.status })
      if (auth.state) recordClientUsage(auth.state, cached.tokens ?? null, clientImageCount)
      stats.cacheHits++
      if (cached.tokens) stats.cacheSavedTokens += (cached.tokens.input ?? 0) + (cached.tokens.output ?? 0)
      stats.cacheSavedCost += Number(cached.cost ?? 0)
      return
    }

    let relayBody = null
    let relayInfo = null
    let relayUsed = false
    const relayOverBudget = Boolean(optimizableChat && relayOptions.enabled && routedBody && bodyCharLength(routedBody) > relayOptions.maxChars)

    const retryCount = matchedRoute
      ? Number(matchedRoute.retries ?? config.retries ?? 2)
      : Number(config.retries ?? 2)
    const attemptsPerTarget = retryCount + 1
    const attempts = []
    const failures = []
    const delaysMs = []
    let lastErrorBody = null
    let lastStatus = 502
    let sawExhausted = false
    let sawCircuitOpen = false
    let circuitRetryAfterMs = 0
    let madeAttempt = false
    let exhaustedReason = ''
    const startedTotal = now()

    for (let chainIndex = 0; chainIndex < orderedChain.length; chainIndex++) {
      const target = orderedChain[chainIndex]
      // Each trail entry names the full target, so the log shows exactly which
      // model was tried at every hop without creating a separate log per try.
      const attemptKey = `${target.provider.name}/${target.model}`
      // A handoff digest is only needed when the request actually moves to
      // another target (or when explicitly configured to always compact).
      const relayNow = Boolean(optimizableChat && relayOptions.enabled && routedBody && (
        relayOptions.trigger === 'always'
        || (chainIndex > 0 && (relayOptions.trigger === 'failover' || relayOptions.trigger === 'both'))
        || (relayOptions.trigger === 'both' && relayOverBudget)
      ))
      let attemptBody = routedBody
      if (relayNow) {
        if (!relayBody) {
          const result = relayChatBody(routedBody, { protocol: clientProtocol, options: relayOptions })
          relayBody = result.changed ? result.body : routedBody
          if (result.changed) {
            relayInfo = { before: result.before, after: result.after, relayed: result.relayed }
            stats.relayEvents++
          }
        }
        if (relayBody !== routedBody) {
          attemptBody = relayBody
          relayUsed = true
        }
      }
      // Rotate through the pool even when fallback retries are off: each key
      // gets a try on key-level failures (auth errors, rate limits).
      const enabledKeyCount = (target.provider.keys ?? []).filter((key) => key.enabled !== false).length
      const targetAttempts = Math.max(attemptsPerTarget, Math.min(enabledKeyCount, MAX_KEY_ATTEMPTS))
      for (let attempt = 0; attempt < targetAttempts; attempt++) {
        const circuit = providerCircuitAllows(target.provider, config)
        if (!circuit.allowed) {
          sawCircuitOpen = true
          if (circuit.retryAfterMs) {
            circuitRetryAfterMs = circuitRetryAfterMs
              ? Math.min(circuitRetryAfterMs, circuit.retryAfterMs)
              : circuit.retryAfterMs
          }
          attempts.push(`${attemptKey}#circuit_open`)
          failures.push({
            provider: target.provider.name,
            model: target.model,
            status: 503,
            error: 'provider circuit is open',
            code: 'provider_circuit_open'
          })
          lastStatus = 503
          break
        }
        const started = now()
        try {
          const forwarded = await forwardOnce(
            { provider: target.provider, model: target.model, vpn: target.vpn },
            clientProtocol, path, attemptBody, req,
            { rawBody, wantsStreamHint: wantsStream, allowCooling: attempt > 0 && lastStatus === 429, affinityKey, config }
          )
          if (forwarded?.error) {
            const errorStatus = forwarded.error.status ?? 502
            attempts.push(`${attemptKey}#${errorStatus}`)
            if (forwarded.error.code === 'all_keys_exhausted') {
              recordProviderOutcome(target.provider, 'neutral', config)
              sawExhausted = true
              exhaustedReason = forwarded.error.message
              failures.push({ provider: target.provider.name, model: target.model, status: errorStatus, error: forwarded.error.message, code: forwarded.error.code })
              // No credential can be tried for this target. A model/provider
              // chain may still have a target, but retrying this one is useless.
              break
            }
            recordProviderOutcome(target.provider, 'neutral', config)
            failures.push({ provider: target.provider.name, model: target.model, status: errorStatus, error: forwarded.error.message })
            madeAttempt = true
            lastStatus = errorStatus
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
          madeAttempt = true
          const status = upstreamRes.status
          // Time to response headers is the speed sample; consuming the body is
          // deliberately excluded so large responses do not look slow.
          recordProviderOutcome(target.provider, PROVIDER_FAILURE_STATUSES.has(status) ? 'failure' : 'success', config, now() - started)
          const moreAttemptsHere = attempt < targetAttempts - 1
          const moreChain = chainIndex < orderedChain.length - 1
          const retryable = RETRYABLE_STATUSES.has(status)
          const keyRotatable = KEY_ROTATE_STATUSES.has(status) && moreAttemptsHere
          const canFallback = !!chainRoute && DOWNSTREAM_FALLBACK_STATUSES(status)
          // A 429 Retry-After is useful even when this was the final attempt:
          // the credential should stay cooling for the interval the provider
          // asked for so the next request does not hit it again. Provider-level
          // 5xx responses are retried without cooling the key itself.
          if (KEY_ROTATE_STATUSES.has(status)) {
            markKeyFailure(key, status, upstreamRes.headers.get('retry-after'))
          }
          if ((retryable || keyRotatable || canFallback) && (moreAttemptsHere || moreChain) && status !== 200) {
            const failure = `${attemptKey}#${status}`
            attempts.push(failure)
            failures.push({ provider: target.provider.name, model: target.model, status, credential: keyIdentity(key) || undefined })
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
          // Any prior failure before this response means a retry or failover
          // happened. Flag it so a 200 can still carry a visible warning.
          const failedOver = attempts.length > 0
          if (routePinKey) {
            routeAffinity.set(routePinKey, { provider: target.provider.name, model: target.model, at: now() })
          }
          if (failedOver && routeName) {
            stats.routeFailovers[routeName] = (stats.routeFailovers[routeName] ?? 0) + 1
          }
          // Only the first resolved target owns the cache scope. A response
          // that needed failover or relay is served, never stored.
          const servedFirstTarget = cachePlan
            && target.provider.name === cachePlan.target.provider.name
            && String(target.model ?? '') === String(cachePlan.target.model ?? '')
          const cacheStatus = cachePlan
            ? (!relayUsed && servedFirstTarget ? 'miss' : 'bypass')
            : cacheBypassed ? 'bypass' : null
          const entry = log({
            upstream: target.provider.name,
            resolvedProvider: target.provider.name,
            credential: key?.id ?? null,
            route: routeName,
            vpn: vpnLabel(config, target.vpn),
            requestModel: requestedModel,
            resolvedModel: forwardedModel,
            model: forwardedModel,
            protocol: clientProtocol,
            stream: Boolean(forwarded.wantsStream),
            failedOver,
            status,
            latencyMs: now() - started,
            attempts: [...attempts, attemptKey],
            failures,
            delaysMs,
            bytes: rawBody.length,
            tokens: null,
            cost: null,
            policyId: matchedPolicy?.id ?? null,
            compression: compressionInfo,
            relay: relayUsed ? relayInfo : null,
            cache: cacheStatus,
            requestBody: attemptBody,
            requestHeaders: redactValue(req.headers)
          }, { config, status })
          const routingHeaders = {
            ...(config.exposeRoutingHeaders ? {
              'x-router-provider': target.provider.name,
              'x-router-model': String(forwardedModel ?? ''),
              ...(matchedPolicy?.id ? { 'x-router-policy': matchedPolicy.id } : {}),
              'x-router-attempts': String(attempts.length + 1)
            } : {}),
            ...(compressionInfo ? { 'x-router-compression': `${compressionInfo.mode}; saved=${compressionInfo.saved}` } : {}),
            ...(relayUsed && relayInfo ? { 'x-router-context-relay': `compacted; saved=${relayInfo.before - relayInfo.after}` } : {}),
            ...(cacheStatus ? { 'x-router-cache': cacheStatus } : {})
          }
          const capture = cachePlan && cacheStatus === 'miss' ? createResponseCapture(res, 1_048_576) : null
          await streamResponse(upstreamRes, responseProtocol, clientProtocol, capture ? capture.res : res, forwardedModel, bufferForStream, target.provider, key, entry, { config, routingHeaders, chatRequest, wantsStream: forwarded.wantsStream })
          if (capture && status < 400) {
            const captured = capture.result()
            if (captured) {
              responseCache.set({
                key: cachePlan.key,
                scope: cachePlan.scope,
                paramsKey: cachePlan.paramsKey,
                promptText: cachePlan.promptText,
                vector: cacheVector,
                response: { status, contentType: captured.contentType, body: captured.body },
                tokens: entry.tokens ?? null,
                cost: Number(entry.cost ?? 0),
                createdAt: now(),
                expiresAt: now() + cacheOptions.ttlMs
              }, cacheOptions.maxEntries)
            }
          }
          if (auth.state) recordClientUsage(auth.state, entry.tokens, clientImageCount)
          return
        } catch (error) {
          madeAttempt = true
          recordProviderOutcome(target.provider, 'failure', config)
          attempts.push(`${attemptKey}#${error?.name ?? 'error'}`)
          failures.push({ provider: target.provider.name, model: target.model, error: String(error?.message ?? error) })
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

    const scheduler = normalizeScheduler(config.scheduler)
    const allCircuitOpen = sawCircuitOpen && !madeAttempt
    const allExhausted = sawExhausted && !madeAttempt && !allCircuitOpen
    const finalStatus = allExhausted ? scheduler.exhaustedStatus : allCircuitOpen ? 503 : lastStatus
    const finalError = allExhausted
      ? JSON.stringify({
          error: {
            type: 'router_exhausted',
            code: 'all_keys_exhausted',
            message: exhaustedReason || 'all configured credentials are cooling down or over their limits'
          }
        })
      : allCircuitOpen
        ? JSON.stringify({
            error: {
              type: 'router_unavailable',
              code: 'provider_circuit_open',
              message: 'every candidate provider is temporarily circuit-open'
            }
          })
        : lastErrorBody
    if (routePinKey) routeAffinity.delete(routePinKey)
    if (attempts.length > 0 && routeName) {
      stats.routeFailovers[routeName] = (stats.routeFailovers[routeName] ?? 0) + 1
    }
    log({ upstream: null, resolvedProvider: null, route: routeName, vpn: vpnLabel(config, chain[0]?.vpn), requestModel: requestedModel, resolvedModel: effectiveModel, protocol: clientProtocol, stream: wantsStream, failedOver: attempts.length > 0, errorCode: allExhausted ? 'all_keys_exhausted' : allCircuitOpen ? 'provider_circuit_open' : 'upstream_failed', status: finalStatus, latencyMs: now() - startedTotal, attempts, failures, error: allExhausted ? 'all keys exhausted' : allCircuitOpen ? 'all providers circuit-open' : lastErrorBody ? 'upstream failed' : 'all providers failed', compression: compressionInfo, relay: relayUsed ? relayInfo : null, cache: cachePlan ? (relayUsed ? 'bypass' : 'miss') : null, requestBody: routedBody, requestHeaders: redactValue(req.headers), responseBody: finalError }, { config, status: finalStatus })
    const responseHeaders = {
      'content-type': 'application/json',
      'x-router-fallback-attempts': String(attempts.length),
      'x-router-fallback-failures': failures.length ? JSON.stringify(failures) : '',
      'x-router-fallback-delays-ms': delaysMs.join(',')
    }
    if (allExhausted) {
      const retryAfter = retryAfterForChain(orderedChain)
      if (retryAfter) responseHeaders['retry-after'] = String(retryAfter)
    } else if (allCircuitOpen && circuitRetryAfterMs > 0) {
      responseHeaders['retry-after'] = String(Math.max(1, Math.ceil(circuitRetryAfterMs / 1000)))
    }
    res.writeHead(finalStatus, responseHeaders)
    if (allCircuitOpen) {
      res.end(JSON.stringify({
        error: {
          type: 'router_unavailable',
          code: 'provider_circuit_open',
          message: 'every candidate provider is temporarily circuit-open',
          attempts
        }
      }))
      return
    }
    if (allExhausted) {
      res.end(JSON.stringify({
        error: {
          type: 'router_exhausted',
          code: 'all_keys_exhausted',
          message: exhaustedReason || 'all configured credentials are cooling down or over their limits',
          attempts
        }
      }))
      return
    }
    res.end(JSON.stringify({ error: { message: finalError ? String(finalError).slice(0, 2000) : `all providers failed (${attempts.join(', ')})`, attempts } }))
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  function retryAfterForChain(chain) {
    const timestamp = now()
    let earliest = Infinity
    for (const target of chain) {
      for (const key of target.provider?.keys ?? []) {
        if (key.enabled === false) continue
        const until = keyCooldowns.get(keyIdentity(key)) ?? 0
        if (until > timestamp) earliest = Math.min(earliest, until)
      }
    }
    return Number.isFinite(earliest) ? Math.max(1, Math.ceil((earliest - timestamp) / 1000)) : undefined
  }
  function retryDelayMs(retryAfter, base, attempt) {
    const headerDelay = retryAfterMs(retryAfter, now())
    if (headerDelay > 0) return Math.min(30_000, headerDelay)
    return Math.min(30_000, (base ?? 200) * 2 ** attempt)
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
    if (upstreamRes.status < 400) {
      if (streamTokens) applyUsage(entry, streamTokens, computeCost(pricing, streamTokens))
      // Count the request even when the stream carried no usage block: many
      // OpenAI-compatible providers only send usage when the client opts in.
      recordKeyUsage(key, streamTokens ? streamTokens.input + streamTokens.output || null : null, 0)
    }
  }

  function listModels(config) {
    const seen = new Set()
    const data = []
    for (const provider of providersFor(config)) {
      const catalogModels = isWebChatTransport(provider) && !(provider.models ?? []).length
        ? webchatCatalog(provider)
        : (provider.models ?? [])
      for (const model of catalogModels) {
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
    webchatSessions,
    resetWebChatSession: (key) => webchatSessions.delete(key),
    resetWebChatSessionsByTransport: (transport) => webchatSessions.deleteByPrefix(`webchat:${transport}:`),
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
      const timestamp = now()
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
          keyCount: (p.keys ?? []).length,
          // The Add-provider dialog's Web chat mode finds its provider by this
          // field; without it the UI looks unchanged after setup().
          transport: p.transport,
          health: providerHealthView(p.name, timestamp, config),
          usageSource: Boolean((resolveUsageFetch(p)?.connectors ?? []).length),
          keyUsage: (p.keys ?? []).map((key) => {
            const until = keyCooldowns.get(keyIdentity(key)) ?? 0
            const usage = keyUsageSnapshot(key, keyStates.get(keyIdentity(key)), timestamp)
            const enabled = key.enabled !== false
            const limited = usage.meters.some((meter) => meter.used >= meter.limit)
            return {
              id: key.id,
              secretKey: key.secretKey,
              enabled,
              cooldownUntil: until > timestamp ? until : undefined,
              state: !enabled ? 'disabled' : until > timestamp ? 'cooling' : limited ? 'limited' : 'ready',
              ...usage
            }
          })
        })),
        upstreams: config.providers.map((p) => ({
          name: p.name,
          baseUrl: p.baseUrl,
          protocols: p.protocols ?? [],
          keyCount: (p.keys ?? []).length
        })),
        policies: config.policies,
        aliases: config.aliases ?? {},
        clientKeys: (config.clientKeys ?? []).map((key) => ({ id: key.id, name: key.name, expiresAt: key.expiresAt, limits: key.limits, enabled: key.enabled !== false })),
        agentProfiles: config.agentProfiles ?? [],
        routeFailovers: { ...stats.routeFailovers },
        routeRequests: { ...stats.routeRequests }
      }
    },
    clearKeyCooldown(identity) {
      if (identity) keyCooldowns.delete(identity)
      markRuntimeDirty()
    },
    // Best-effort persistence hooks. main.mjs calls flushRuntime on a timer and
    // on deactivate; tests can inspect the payload with runtimeSnapshot().
    runtimeSnapshot() {
      return runtimeSnapshot()
    },
    flushRuntime() {
      if (runtimeDirty) persistRuntimeNow()
    },
    // The panel's speed test feeds the same samples real traffic produces, so a
    // manual test can prime the ranking for a provider that has been idle.
    recordProbes(results = []) {
      const config = configRef()
      for (const result of results) {
        const provider = config.providers.find((item) => item.name === result?.provider)
        if (!provider) continue
        // A 401/403 still proves the endpoint is up; only a real transport or
        // 5xx failure counts against health, matching live traffic.
        const reachable = result.ok || result.status === 401 || result.status === 403
        recordHealthSample(provider, reachable ? 'success' : 'failure', config, result.latencyMs)
      }
      return { ok: true }
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
          cacheHits: stats.cacheHits,
          cacheSavedTokens: stats.cacheSavedTokens,
          cacheSavedCost: stats.cacheSavedCost,
          compressionSavedChars: stats.compressionSavedChars,
          relayEvents: stats.relayEvents,
          byProvider: Object.entries(stats.byProvider).map(([provider, count]) => ({ provider, count })),
          byModel: Object.entries(stats.byModel).map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count),
          totals: { ...stats },
          loggingDisabled: true
        }
      }
      const sum = (key, field) => recent.filter((entry) => entry.status < 400).reduce((total, entry) => total + (entry[key]?.[field] ?? 0), 0)
      const successful = recent.filter((entry) => entry.status < 400).length
      const latencyTotal = recent.reduce((total, entry) => total + (entry.latencyMs ?? 0), 0)
      const cacheHits = recent.filter((entry) => entry.cache === 'hit' || entry.cache === 'semantic-hit').length
      const cacheSavedTokens = recent.reduce((total, entry) => total + (entry.cacheSavedTokens ?? 0), 0)
      const cacheSavedCost = recent.reduce((total, entry) => total + (entry.cacheSavedCost ?? 0), 0)
      const compressionSavedChars = recent.reduce((total, entry) => total + (entry.compression?.saved ?? 0), 0)
      const relayEvents = recent.filter((entry) => entry.relay).length
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
        cacheHits,
        cacheSavedTokens,
        cacheSavedCost,
        compressionSavedChars,
        relayEvents,
        byProvider: Object.entries(recent.reduce((acc, entry) => { if (entry.resolvedProvider) acc[entry.resolvedProvider] = (acc[entry.resolvedProvider] ?? 0) + 1; return acc }, {})).map(([provider, count]) => ({ provider, count })),
        byModel: Object.entries(recent.reduce((acc, entry) => { if (entry.resolvedModel) acc[entry.resolvedModel] = (acc[entry.resolvedModel] ?? 0) + 1; return acc }, {})).map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count),
        totals: { ...stats }
      }
    },
    clearLogs() {
      logs.length = 0
      stats.routeFailovers = {}
      stats.routeRequests = {}
      routeAffinity.clear()
      markRuntimeDirty()
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

export async function fetchProviderUsage(provider, { getSecret, fetchImpl, secretKey } = {}) {
  const connectors = provider.usageFetch?.enabled === false ? [] : (provider.usageFetch?.connectors ?? [])
  if (provider.usageFetch?.enabled === false || !connectors.length) return { provider: provider.name, secretKey, status: 'unsupported', meters: [], errors: [{ message: 'usage fetch not configured' }] }
  const fetchFn = fetchImpl ?? globalThis.fetch
  const meters = []
  const errors = []
  for (const connector of connectors) {
    try {
      const key = secretKey
        ? getSecret?.(secretKey)
        : (provider.keys ?? []).map((entry) => getSecret?.(entry.secretKey)).find(Boolean)
      if (connector.auth !== 'none' && !key) {
        errors.push({ message: 'no credential available' })
        continue
      }
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
        const rawUnit = typeof meter.unit === 'string' && meter.unit.startsWith('$.')
          ? jsonPathValue(meter.unit, payload)
          : meter.unit
        const mapped = {
          id: meter.id,
          kind: meter.kind ?? 'balance',
          label: meter.label ?? meter.id,
          unit: typeof rawUnit === 'string' ? rawUnit : '',
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
  return { provider: provider.name, secretKey, status: errors.length && !meters.length ? 'error' : 'ok', meters, errors }
}

// Optional usage discovery: when a provider has no configured connector, try a
// short list of well-known balance endpoints with the provider key. Only an
// exact response-shape match is accepted, so an unrelated JSON body never turns
// into a fabricated quota. Runs only on an explicit panel click.
const USAGE_PROBE_SPECS = [
  {
    id: 'openrouter',
    path: '/credits',
    detect: (payload) => typeof payload?.data?.total_credits === 'number' || typeof payload?.data?.total_usage === 'number',
    meters: [{ id: 'balance', kind: 'balance', label: 'Balance', limit: '$.data.total_credits', used: '$.data.total_usage', unit: 'USD' }]
  },
  {
    id: 'deepseek',
    path: '/user/balance',
    detect: (payload) => Array.isArray(payload?.balance_infos) && payload.balance_infos.some((entry) => entry && entry.total_balance != null),
    meters: [{ id: 'balance', kind: 'balance', label: 'Balance', remaining: '$.balance_infos[0].total_balance', unit: '$.balance_infos[0].currency' }]
  },
  {
    id: 'opencode',
    path: '/usage',
    detect: (payload) => typeof payload?.usage?.rolling?.percent === 'number',
    meters: [
      { id: 'rolling_5h', kind: 'quota', label: '5h limit', limit: 100, used: '$.usage.rolling.percent', remaining: '100 - $.usage.rolling.percent', unit: '%', window: '5h' },
      { id: 'rolling_weekly', kind: 'quota', label: 'Weekly limit', limit: 100, used: '$.usage.weekly.percent', remaining: '100 - $.usage.weekly.percent', unit: '%', window: 'weekly' },
      { id: 'rolling_monthly', kind: 'quota', label: 'Monthly limit', limit: 100, used: '$.usage.monthly.percent', remaining: '100 - $.usage.monthly.percent', unit: '%', window: 'monthly' }
    ]
  },
  {
    id: 'moonshot',
    path: '/users/me/balance',
    detect: (payload) => typeof payload?.data?.available_balance === 'number',
    meters: [{ id: 'balance', kind: 'balance', label: 'Balance', remaining: '$.data.available_balance', unit: 'CNY' }]
  },
  {
    id: 'siliconflow',
    path: '/user/info',
    detect: (payload) => typeof payload?.data?.totalBalance === 'number',
    meters: [{ id: 'balance', kind: 'balance', label: 'Balance', remaining: '$.data.totalBalance', unit: 'CNY' }]
  },
  {
    id: 'mistral',
    path: '/billing/subscription',
    detect: (payload) => typeof payload?.credit_balance === 'number' || typeof payload?.monthly_budget === 'number',
    meters: [
      { id: 'credit_balance', kind: 'balance', label: 'Credit balance', remaining: '$.credit_balance', unit: 'EUR' },
      { id: 'monthly_budget', kind: 'quota', label: 'Monthly budget', limit: '$.monthly_budget', unit: 'EUR', window: 'monthly' }
    ]
  },
  {
    id: 'openai-billing',
    path: '/dashboard/billing/credit_grants',
    detect: (payload) => typeof payload?.total_available === 'number' || typeof payload?.total_granted === 'number',
    meters: [{ id: 'balance', kind: 'balance', label: 'Credits', limit: '$.total_granted', used: '$.total_used', remaining: '$.total_available', unit: 'USD' }]
  },
  {
    id: 'oneapi',
    origin: true,
    path: '/api/user/self',
    detect: (payload) => typeof payload?.data?.quota === 'number',
    meters: [{ id: 'quota', kind: 'balance', label: 'Quota', used: '$.data.used_quota', remaining: '$.data.quota', unit: 'credits' }]
  }
]

const USAGE_PROBE_BUDGET_MS = 15_000

export async function probeProviderUsage(provider, { getSecret, fetchImpl, secretKey } = {}) {
  const poolEntry = secretKey
    ? { secretKey }
    : (provider?.keys ?? []).find((entry) => entry?.secretKey && getSecret?.(entry.secretKey))
  const resolvedKey = poolEntry?.secretKey
  const key = resolvedKey ? getSecret?.(resolvedKey) : null
  if (!key) return { ok: false, reason: 'no-keys', meters: [], errors: [], tried: [] }
  const base = String(provider?.baseUrl ?? provider?.endpoints?.[0]?.baseUrl ?? '').replace(/\/+$/, '')
  const bases = [...new Set([base, base.replace(/\/v1$/, '')])].filter(Boolean)
  let origin = ''
  try { origin = new URL(base).origin } catch { origin = '' }
  const fetchFn = fetchImpl ?? globalThis.fetch
  const startedAt = Date.now()
  const tried = []
  for (const spec of USAGE_PROBE_SPECS) {
    if (Date.now() - startedAt > USAGE_PROBE_BUDGET_MS) break
    for (const candidate of spec.origin ? [origin] : bases) {
      if (!candidate) continue
      const url = `${candidate}${spec.path}`
      if (tried.some((entry) => entry.url === url)) continue
      let payload = null
      try {
        const res = await fetchFn(url, {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(5000)
        })
        tried.push({ url, status: res.status })
        if (!res.ok) continue
        payload = await res.json().catch(() => null)
      } catch (error) {
        tried.push({ url, status: String(error?.message ?? error) })
        continue
      }
      if (!payload || !spec.detect(payload)) continue
      const connector = {
        id: `probe-${spec.id}`,
        type: 'http-json',
        endpoint: url,
        auth: 'provider-api-key',
        mapping: { meters: spec.meters }
      }
      const applied = await fetchProviderUsage(
        { ...provider, usageFetch: { enabled: true, connectors: [connector] } },
        { getSecret: () => key, fetchImpl, secretKey: resolvedKey }
      )
      return {
        ok: applied.meters.length > 0,
        reason: applied.meters.length > 0 ? undefined : 'probe-failed',
        endpoint: url,
        connector,
        meters: applied.meters,
        errors: applied.errors,
        secretKey: resolvedKey,
        tried
      }
    }
  }
  return { ok: false, reason: 'not-found', meters: [], errors: [], secretKey: resolvedKey, tried }
}
