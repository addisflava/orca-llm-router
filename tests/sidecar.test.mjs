// Pure-Node tests for the LLM Router gateway core (no Orca needed).
// Run: node --test tests/
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyCodexGlobal,
  buildCodexManagedConfig,
  injectCodexProvider,
  restoreCodexGlobal
} from '../worker/main.mjs'
import {
  DEFAULT_CONFIG,
  PROVIDER_PRESETS,
  anthropicToOpenAI,
  buildAgentLaunchEnv,
  buildOpenCodeConfig,
  buildCodexModelCatalog,
  mergeOpenCodeConfig,
  convertLegacyConfig,
  convertClaudeCodeRouterConfig,
  convertOmniRouteConfig,
  decryptOmniRouteCredential,
  mergeRouterConfigs,
  detectAndConvertConfig,
  readSqliteConfig,
  detectLocalRouterConfigs,
  createSidecar,
  deriveAffinityKey,
  fetchProviderUsage,
  safeCaptureBody,
  truncateText,
  geminiResponseToOpenAI,
  joinUpstreamUrl,
  matchRoute,
  normalizeConfig,
  normalizeResponsesCustomTools,
  openAIResponseToResponses,
  openAIResponseToAnthropic,
  openAIToAnthropic,
  openAIToGemini,
  buildResponsesSse,
  providerFromPreset,
  resolveAgentProfile,
  resolveChain,
  buildChainFromFallback,
  responsesToOpenAI
} from '../worker/sidecar.mjs'
import {
  createSchedulerState,
  normalizeCircuitBreaker,
  normalizeProviderHealth,
  normalizeScheduler,
  rankProviderTargets,
  retryAfterMs,
  selectScheduledKey
} from '../worker/scheduler.mjs'
import {
  compressChatBody,
  normalizeCompression,
  normalizeContextRelay,
  relayChatBody
} from '../worker/transforms.mjs'
import {
  canonicalCacheKey,
  cosineSimilarity,
  normalizeResponseCache,
  semanticParamsKey,
  shouldCacheRequest
} from '../worker/cache.mjs'

const anthropicProvider = {
  name: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  protocols: ['anthropic'],
  models: [{ id: 'claude-sonnet-4-20250514', description: 'Strong coding model' }],
  keys: []
}

const openaiProvider = {
  name: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  protocols: ['openai', 'responses'],
  models: [{ id: 'gpt-4o' }],
  keys: []
}

const deepseekProvider = {
  name: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  protocols: ['openai'],
  models: [{ id: 'deepseek-chat' }],
  keys: []
}

function testConfig(overrides = {}) {
  return normalizeConfig({
    version: 3,
    providers: [anthropicProvider, deepseekProvider, openaiProvider],
    defaultFallback: { mode: 'retry', models: [], retryCount: 0 },
    retries: 0,
    routes: [],
    aliases: {},
    clientKeys: [],
    agentProfiles: DEFAULT_CONFIG.agentProfiles,
    ...overrides
  })
}

test('joinUpstreamUrl strips a duplicate /v1', () => {
  assert.equal(joinUpstreamUrl('https://api.openai.com/v1/', '/v1/chat/completions'), 'https://api.openai.com/v1/chat/completions')
  assert.equal(joinUpstreamUrl('https://api.anthropic.com', '/v1/messages'), 'https://api.anthropic.com/v1/messages')
})

test('matchRoute: wildcard, prefix and exact (legacy helper)', () => {
  assert.equal(matchRoute('*', 'anything'), true)
  assert.equal(matchRoute('anthropic/*', 'anthropic/claude-x'), true)
  assert.equal(matchRoute('other/y', 'other/y'), true)
  assert.equal(matchRoute('prefix:claude', 'claude-3'), true)
  assert.equal(matchRoute('gpt-4o', 'gpt-4'), false)
})

test('resolveChain: provider prefix, aliases and default', () => {
  const config = testConfig({ aliases: { claude: 'anthropic/claude-sonnet-4-20250514' } })
  assert.deepEqual(resolveChain(config, 'deepseek/deepseek-chat').map((item) => item.provider.name), ['deepseek'])
  assert.deepEqual(resolveChain(config, 'claude').map((item) => item.provider.name), ['anthropic'])
  assert.deepEqual(resolveChain(config, 'gpt-4o').map((item) => item.provider.name), ['openai'])
})

test('routes expand to their ordered provider/model targets', () => {
  const config = testConfig({
    routes: [{
      name: 'fast',
      targets: [
        { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
        { provider: 'openai', model: 'gpt-4o' }
      ],
      strategy: 'fastest'
    }]
  })
  assert.deepEqual(
    resolveChain(config, 'fast').map((item) => `${item.provider.name}/${item.model}`),
    ['anthropic/claude-sonnet-4-20250514', 'openai/gpt-4o']
  )
})

test('a legacy modelGroups config still normalizes into routes', () => {
  const config = testConfig({
    version: 2,
    modelGroups: [{
      name: 'fast',
      targets: [{ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }],
      strategy: 'ordered'
    }]
  })
  assert.equal(config.routes.length, 1, 'the old field is read once')
  assert.equal(config.routes[0].name, 'fast')
  assert.equal('modelGroups' in config, false, 'saved configs use the routes field')
})

test('legacy aliases still resolve and become ordered one-target routes', () => {
  const config = testConfig({ aliases: { claude: 'anthropic/claude-sonnet-4-20250514' } })
  assert.deepEqual(resolveChain(config, 'claude').map((item) => item.provider.name), ['anthropic'])
  const route = normalizeConfig(config).routes.find((entry) => entry.name === 'claude')
  assert.equal(route.strategy, 'ordered', 'an upgraded alias keeps its single-target order')
  assert.deepEqual(route.targets, [{ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }])
})

test('a policy fallback route expands after the primary and a raw target also expands', () => {
  const config = testConfig({
    routes: [{
      name: 'backup',
      targets: [
        { provider: 'openai', model: 'gpt-4o' },
        { provider: 'deepseek', model: 'deepseek-chat' }
      ],
      strategy: 'ordered'
    }]
  })
  assert.deepEqual(
    buildChainFromFallback(config, 'anthropic/claude-sonnet-4-20250514', { mode: 'provider-chain', models: ['backup'] })
      .map((item) => `${item.provider.name}/${item.model}`),
    [
      'anthropic/claude-sonnet-4-20250514',
      'openai/gpt-4o',
      'deepseek/deepseek-chat'
    ]
  )
  // A policy fallback can name a route or a raw provider/model target. A raw
  // target is resolved directly and appended after the primary.
  assert.deepEqual(
    buildChainFromFallback(config, 'anthropic/claude-sonnet-4-20250514', { mode: 'provider-chain', models: ['openai/gpt-4o'] })
      .map((item) => `${item.provider.name}/${item.model}`),
    ['anthropic/claude-sonnet-4-20250514', 'openai/gpt-4o']
  )
})

test('a route target with no model reuses the primary model on that provider', () => {
  const config = testConfig({
    routes: [{ name: 'backup', targets: [{ provider: 'openai', model: '' }], strategy: 'ordered' }]
  })
  assert.deepEqual(
    buildChainFromFallback(config, 'anthropic/claude-sonnet-4-20250514', { mode: 'provider-chain', models: ['backup'] })
      .map((item) => `${item.provider.name}/${item.model}`),
    ['anthropic/claude-sonnet-4-20250514', 'openai/claude-sonnet-4-20250514'],
    'the same model name is tried on the other provider'
  )
})

test('a legacy global fallback chain is migrated to an opt-in route and stops applying', () => {
  const config = testConfig({ defaultFallback: { mode: 'provider-chain', models: ['deepseek/deepseek-chat'], retryCount: 0 } })
  assert.deepEqual(
    resolveChain(config, 'anthropic/claude-sonnet-4-20250514').map((item) => `${item.provider.name}/${item.model}`),
    ['anthropic/claude-sonnet-4-20250514'],
    'the global chain no longer adds a target to a raw provider/model request'
  )
  const route = config.routes.find((entry) => entry.name === 'default-failover')
  assert.ok(route, 'the chain is preserved as a route')
  assert.deepEqual(route.targets, [{ provider: 'deepseek', model: 'deepseek-chat' }])
  assert.equal(config.migration.at(-1).kind, 'global-chain')
  assert.equal(config.migration.at(-1).to, 'default-failover')
})

test('a legacy rule fallback chain is migrated into an ordered backup route', () => {
  const config = testConfig({
    version: 2,
    routes: [{
      name: 'claude default',
      condition: { source: 'request.body', field: 'model', operator: 'starts-with', value: 'claude-' },
      fallback: { mode: 'provider-chain', models: ['openai/gpt-4o', 'deepseek/deepseek-chat'], retryCount: 1 }
    }]
  })
  const policy = config.policies[0]
  assert.deepEqual(policy.fallback.models, ['claude-default-backups'], 'the policy now points at a route')
  const route = config.routes.find((entry) => entry.name === 'claude-default-backups')
  assert.ok(route)
  assert.deepEqual(route.targets, [
    { provider: 'openai', model: 'gpt-4o' },
    { provider: 'deepseek', model: 'deepseek-chat' }
  ])
  assert.equal(route.strategy, 'ordered')
  assert.equal(route.retries, 1)
  assert.equal(config.migration.at(-1).kind, 'rule-chain')
  // Re-normalizing the migrated config must not create a second route.
  const again = normalizeConfig(config)
  assert.equal(again.routes.filter((entry) => entry.name === 'claude-default-backups').length, 1)
  assert.equal(again.migration.filter((entry) => entry.kind === 'rule-chain').length, 1)
})

test('a provider/model request migrates and normalizes a lowercase provider prefix', () => {
  const config = testConfig({
    routes: [{ name: 'mixed', targets: [{ provider: 'Anthropic', model: '' }], strategy: 'ordered' }]
  })
  assert.deepEqual(config.routes[0].targets, [{ provider: 'anthropic', model: '' }])
})

test('responsesToOpenAI forwards reasoning effort and function tools', () => {
  const translated = responsesToOpenAI({
    model: 'm',
    input: 'read a file',
    reasoning: { effort: 'low' },
    tools: [{ type: 'function', name: 'shell', description: 'run', parameters: { type: 'object' } }]
  })
  assert.equal(translated.reasoning_effort, 'low')
  assert.equal(translated.messages[0].content, 'read a file')
  assert.deepEqual(translated.tools, [{
    type: 'function',
    function: { name: 'shell', description: 'run', parameters: { type: 'object' } }
  }])
})

test('responsesToOpenAI maps Codex custom tools and custom tool history', () => {
  const translated = responsesToOpenAI({
    model: 'm',
    input: [
      { type: 'custom_tool_call', call_id: 'call-1', name: 'apply_patch', input: '*** Begin Patch\n' },
      { type: 'custom_tool_call_output', call_id: 'call-1', output: 'done' }
    ],
    tools: [{ type: 'custom', name: 'apply_patch', description: 'edit files' }]
  })
  assert.equal(translated.tools[0].function.name, 'apply_patch')
  assert.deepEqual(translated.tools[0].function.parameters.required, ['input'])
  assert.deepEqual(translated.messages[0].tool_calls[0].function, {
    name: 'apply_patch',
    arguments: JSON.stringify({ input: '*** Begin Patch\n' })
  })
  assert.deepEqual(translated.messages[1], {
    role: 'tool',
    tool_call_id: 'call-1',
    content: 'done'
  })
})

test('openAIResponseToResponses restores a custom apply_patch call', () => {
  const response = openAIResponseToResponses({
    id: 'chatcmpl-1',
    choices: [{
      message: {
        tool_calls: [{
          id: 'call-2',
          type: 'function',
          function: {
            name: 'apply_patch',
            arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch\n' })
          }
        }]
      }
    }]
  }, 'pgs/deepseek-v4.1-flash')
  assert.equal(response.output[0].type, 'custom_tool_call')
  assert.equal(response.output[0].name, 'apply_patch')
  assert.equal(response.output[0].input, '*** Begin Patch\n*** End Patch\n')
  const sse = buildResponsesSse(response)
  assert.match(sse, /event: response\.custom_tool_call_input\.done/)
  assert.match(sse, /"type":"custom_tool_call"/)
})

test('anthropic <-> openai translation keeps text and tools', () => {
  const anthropic = {
    model: 'm',
    max_tokens: 8,
    system: 'be brief',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 't1', name: 'read', input: { file: 'a.ts' } }
        ]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }, { type: 'text', text: 'go' }] }
    ],
    tools: [{ name: 'read', description: 'r', input_schema: { type: 'object' } }]
  }
  const openai = anthropicToOpenAI(anthropic)
  assert.equal(openai.messages[0].role, 'system')
  assert.equal(openai.messages.find((m) => m.role === 'tool')?.tool_call_id, 't1')
  assert.equal(openai.tools[0].function.name, 'read')

  const back = openAIToAnthropic(openai)
  assert.equal(back.system, 'be brief')
  assert.ok(back.messages.length >= 3)
  assert.equal(back.tools?.[0]?.name, 'read')

  const reply = openAIResponseToAnthropic(
    { id: 'r1', model: 'm', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 't1', function: { name: 'read', arguments: '{"file":"a.ts"}' } }] } }], usage: { prompt_tokens: 2, completion_tokens: 1 } },
    'm'
  )
  assert.equal(reply.content[0].type, 'tool_use')
  assert.equal(reply.usage.input_tokens, 2)
})

test('normalizeConfig migrates legacy upstreams/routes', () => {
  const normalized = normalizeConfig({
    token: 'orca-router',
    upstreams: [{ name: 'acme', baseUrl: 'https://api.example.com/v1', protocols: ['openai'], keys: [{ id: 'k1', secretKey: 'acme-key' }] }],
    routes: [{ match: 'acme/*', upstream: 'acme', fallback: [] }],
    defaultUpstream: 'acme'
  })
  assert.equal(normalized.providers[0].name, 'acme')
  assert.equal(normalized.policies[0].condition.value, 'acme/')
})

test('provider enabled follows its key pool', () => {
  const normalized = normalizeConfig({
    providers: [
      {
        name: 'keyed',
        baseUrl: 'https://api.example.com/v1',
        enabled: false,
        keys: [
          { id: 'on', secretKey: 'keyed-on', enabled: true },
          { id: 'off', secretKey: 'keyed-off', enabled: false }
        ]
      },
      {
        name: 'all-off',
        baseUrl: 'https://api.example.com/v1',
        enabled: true,
        keys: [{ id: 'off', secretKey: 'all-off-key', enabled: false }]
      },
      { name: 'keyless', baseUrl: 'https://api.example.com/v1', enabled: false }
    ],
    routes: []
  })
  const byName = Object.fromEntries(normalized.providers.map((provider) => [provider.name, provider]))
  assert.equal(byName.keyed.enabled, true)
  assert.equal(byName['all-off'].enabled, false)
  assert.equal(byName.keyless.enabled, false)
})

test('full provider preset catalog is available', () => {
  assert.ok(PROVIDER_PRESETS.length >= 30)
  const IDs = new Set(PROVIDER_PRESETS.map((preset) => preset.id))
  for (const id of ['openai', 'anthropic', 'openrouter', 'deepseek', 'opencode-go', 'zhipu-cn-coding', 'moonshot', 'mistral', 'siliconflow']) {
    assert.ok(IDs.has(id), `missing preset ${id}`)
  }
  const provider = providerFromPreset('deepseek', { name: 'my-deepseek' })
  assert.equal(provider.name, 'my-deepseek')
  assert.ok(provider.protocols.includes('openai'))
})

test('convertLegacyConfig imports providers, rules, keys and profiles', () => {
  const result = convertLegacyConfig({
    Providers: [{
      name: 'DeepSeek',
      api_base_url: 'https://api.deepseek.com',
      api_key: 'sk-deep',
      models: ['deepseek-chat'],
      modelDescriptions: { 'deepseek-chat': 'Cheap and fast' },
      capabilities: [{ baseUrl: 'https://api.deepseek.com', type: 'openai_chat_completions' }]
    }],
    Router: {
      fallback: { mode: 'model-chain', models: ['DeepSeek/deepseek-chat'], retryCount: 0 },
      rules: [{
        name: 'Claude default',
        enabled: true,
        condition: { left: 'request.body.model', operator: 'starts-with', right: 'claude-' },
        rewrites: [{ key: 'request.body.model', operation: 'set', value: 'DeepSeek/deepseek-chat' }]
      }]
    },
    APIKEYS: [{ id: 'laptop', name: 'Claude Code - laptop', key: 'llmr-client', createdAt: '2026-01-01T00:00:00Z' }],
    profile: { profiles: [{ agent: 'claude-code', name: 'Claude Code', model: 'DeepSeek/deepseek-chat', enabled: true, scope: 'ccr' }] }
  })
  assert.equal(result.config.providers[0].name, 'deepseek')
  assert.equal(result.config.policies[0].condition.value, 'claude-')
  assert.equal(result.config.clientKeys[0].id, 'laptop')
  assert.ok(result.secrets.some((entry) => entry.value === 'sk-deep'))
  assert.equal(result.config.agentProfiles[0].agent, 'claude-code')
})

test('resolveAgentProfile matches Orca agent names to client kinds', () => {
  const config = testConfig({
    agentProfiles: [
      { agent: 'generic', name: 'All agents', model: '', enabled: true },
      { agent: 'claude-code', name: 'Claude Code', model: 'anthropic/claude-sonnet-4-20250514', enabled: true }
    ]
  })
  assert.equal(resolveAgentProfile(config, 'claude').model, 'anthropic/claude-sonnet-4-20250514')
  assert.equal(resolveAgentProfile(config, 'unknown').agent, 'generic')
})

test('resolveAgentProfile returns a disabled profile so its toggle can be honored', () => {
  const config = testConfig({ agentProfiles: [{ agent: 'claude', name: 'Claude', model: '', enabled: false }] })
  assert.equal(resolveAgentProfile(config, 'claude')?.enabled, false)
})

test('the default config routes every agent with no explicit entries', () => {
  assert.deepEqual(DEFAULT_CONFIG.agentProfiles, [])
  const config = testConfig({ agentProfiles: [] })
  assert.equal(resolveAgentProfile(config, 'claude'), null)
})

test('buildAgentLaunchEnv routes an agent through the gateway with its profile', () => {
  const config = testConfig({
    agentProfiles: [
      {
        agent: 'claude-code',
        name: 'Claude Code',
        model: 'anthropic/claude-sonnet-4-20250514',
        smallFastModel: 'openai/gpt-4o-mini',
        enabled: true,
        scope: 'system-default',
        env: { ANTHROPIC_MODEL: 'override', CUSTOM_FLAG: 'on' }
      }
    ]
  })
  const { env, model, scope } = buildAgentLaunchEnv(config, 'claude', {
    base: 'http://127.0.0.1:18080',
    token: 'orca-router',
    eventEnv: { NO_PROXY: 'example.com' }
  })
  assert.equal(model, 'anthropic/claude-sonnet-4-20250514')
  assert.equal(scope, 'system-default')
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18080')
  assert.equal(env.ANTHROPIC_API_BASE_URL, 'http://127.0.0.1:18080')
  assert.equal(env.CLAUDE_AGENT_API_BASE_URL, 'http://127.0.0.1:18080')
  assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:18080/v1')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'orca-router')
  assert.equal(env.OPENAI_API_KEY, 'orca-router')
  // Claude Code gets the token as auth only, so it never raises the custom-key
  // approval prompt.
  assert.equal(env.ANTHROPIC_API_KEY, '')
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'openai/gpt-4o-mini')
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'openai/gpt-4o-mini')
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'anthropic/claude-sonnet-4-20250514')
  assert.equal(env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT, '1')
  // Profile env is merged last so it can override a generated value.
  assert.equal(env.ANTHROPIC_MODEL, 'override')
  assert.equal(env.CUSTOM_FLAG, 'on')
  // Loopback is added to an existing NO_PROXY without dropping it.
  assert.equal(env.NO_PROXY, 'example.com,127.0.0.1,localhost,::1')
  assert.equal(env.no_proxy, env.NO_PROXY)
})

test('buildAgentLaunchEnv keeps the agent model for router-only profiles', () => {
  const config = testConfig({
    agentProfiles: [
      { agent: 'codex', name: 'Codex', model: '', enabled: true, scope: 'router-only', env: {} }
    ]
  })
  const { env, model, scope } = buildAgentLaunchEnv(config, 'codex', {
    base: 'http://127.0.0.1:18080',
    token: 'orca-router'
  })
  assert.equal(model, '')
  assert.equal(scope, 'router-only')
  assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:18080/v1')
  assert.equal(env.OPENAI_MODEL, undefined)
  assert.equal(env.ANTHROPIC_MODEL, undefined)
})

test('buildAgentLaunchEnv skips agents whose toggle is off', () => {
  const config = testConfig({
    agentProfiles: [
      { agent: 'generic', name: 'All agents', model: 'openai/gpt-4o', enabled: true, scope: 'system-default', env: {} },
      { agent: 'claude-code', name: 'Claude Code', model: 'anthropic/claude-x', enabled: false, scope: 'system-default', env: {} }
    ]
  })
  const { profile, env, routed } = buildAgentLaunchEnv(config, 'claude', {
    base: 'http://127.0.0.1:18080',
    token: 'orca-router'
  })
  assert.equal(routed, false)
  assert.equal(profile.agent, 'claude-code')
  // A disabled agent is passed through untouched: no gateway env at all.
  assert.equal(env.ANTHROPIC_BASE_URL, undefined)
  assert.equal(env.OPENAI_MODEL, undefined)
})

test('buildAgentLaunchEnv routes an agent with no toggle entry by default', () => {
  const config = testConfig({ agentProfiles: [] })
  const { routed, env, model } = buildAgentLaunchEnv(config, 'gemini', {
    base: 'http://127.0.0.1:18080',
    token: 'orca-router'
  })
  assert.equal(routed, true)
  assert.equal(model, '')
  assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:18080/v1')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'orca-router')
})

test('buildOpenCodeConfig publishes the gateway providers and model list', () => {
  const config = testConfig()
  const { document, model, provider } = buildOpenCodeConfig(config, {
    base: 'http://127.0.0.1:18080',
    token: 'orca-router'
  })
  assert.equal(provider, 'orca-router')
  // The router never picks a startup model: with no explicit profile model
  // there is no pin, so OpenCode starts on its last-used model.
  assert.equal(model, '')
  assert.equal(document.model, undefined)
  assert.equal(document.small_model, undefined)
  // A stale CCR config would otherwise remain selectable.
  assert.deepEqual(document.disabled_providers, ['claude-code-router'])
  const published = document.provider['orca-router']
  assert.equal(published.name, 'Orca LLM Router')
  assert.equal(published.npm, '@ai-sdk/openai-compatible')
  assert.equal(published.options.baseURL, 'http://127.0.0.1:18080/v1')
  assert.equal(published.options.apiKey, 'orca-router')
  assert.deepEqual(Object.keys(published.models).sort(), [
    'anthropic/claude-sonnet-4-20250514',
    'deepseek/deepseek-chat',
    'openai/gpt-4o'
  ])
})

test('buildOpenCodeConfig honors aliases, profiles and disabled providers', () => {
  const config = testConfig({
    aliases: { fast: 'deepseek/deepseek-chat' },
    providers: [
      anthropicProvider,
      deepseekProvider,
      openaiProvider,
      {
        name: 'offline',
        baseUrl: 'https://offline.example.com/v1',
        models: [{ id: 'nope' }],
        keys: [{ id: 'off', secretKey: 'offline-key', enabled: false }]
      }
    ],
    agentProfiles: [
      { agent: 'opencode', name: 'OpenCode', model: 'fast', enabled: true, scope: 'router-only', env: {} }
    ]
  })
  const { document, model } = buildOpenCodeConfig(config, {
    base: 'http://127.0.0.1:18080',
    token: 'orca-router',
    agentId: 'opencode'
  })
  assert.equal(model, 'fast')
  assert.equal(document.model, 'orca-router/fast')
  const models = document.provider['orca-router'].models
  assert.deepEqual(Object.keys(models).sort(), [
    'anthropic/claude-sonnet-4-20250514',
    'deepseek/deepseek-chat',
    'fast',
    'openai/gpt-4o'
  ])
  assert.equal(models['offline/nope'], undefined)
})

test('buildCodexModelCatalog publishes the gateway models for the Codex picker', () => {
  const config = testConfig({ aliases: { fast: 'deepseek/deepseek-chat' } })
  const { document, model } = buildCodexModelCatalog(config, { agentId: 'codex' })
  assert.equal(model, '')
  assert.deepEqual(document.models.map((item) => item.slug), [
    'anthropic/claude-sonnet-4-20250514',
    'deepseek/deepseek-chat',
    'openai/gpt-4o',
    'fast'
  ])
  const first = document.models[0]
  assert.equal(first.display_name, 'anthropic/claude-sonnet-4-20250514')
  assert.equal(first.tool_mode, undefined)
  assert.equal(first.use_responses_lite, false)
  assert.equal(first.apply_patch_tool_type, 'freeform')
  assert.equal(first.shell_type, 'shell_command')
  assert.equal(first.base_instructions, 'You are a coding agent.')
  assert.ok(Array.isArray(first.supported_reasoning_levels))
})

test('buildCodexModelCatalog honors profiles and omits disabled providers', () => {
  const config = testConfig({
    aliases: { fast: 'deepseek/deepseek-chat' },
    providers: [
      anthropicProvider,
      deepseekProvider,
      openaiProvider,
      {
        name: 'offline',
        baseUrl: 'https://offline.example.com/v1',
        models: [{ id: 'nope' }],
        keys: [{ id: 'off', secretKey: 'offline-key', enabled: false }]
      }
    ],
    agentProfiles: [
      { agent: 'codex', name: 'Codex', model: 'fast', enabled: true, scope: 'router-only', env: {} }
    ]
  })
  const { document, model } = buildCodexModelCatalog(config, { agentId: 'codex' })
  assert.equal(model, 'fast')
  assert.ok(document.models.some((item) => item.slug === 'fast'))
  assert.ok(!document.models.some((item) => item.slug === 'offline/nope'))
})

test('injectCodexProvider adds the gateway, catalog, direct model and reasoning effort', () => {
  const command = injectCodexProvider('codex exec "hello"', {
    base: 'http://127.0.0.1:18080',
    catalogPath: '/tmp/orca-llm-router/codex-models.json',
    model: 'pgs/deepseek-v4.1-flash',
    reasoningEffort: 'low'
  })
  assert.match(command, /^codex /)
  assert.match(command, /model_provider="orca-router"/)
  assert.match(command, /model="pgs\/deepseek-v4\.1-flash"/)
  assert.match(command, /model_reasoning_effort="low"/)
  assert.match(command, /model_catalog_json="\/tmp\/orca-llm-router\/codex-models\.json"/)
  assert.match(command, /base_url="http:\/\/127\.0\.0\.1:18080\/v1"/)
  assert.match(command, /experimental_bearer_token="orca-router"/)
  assert.doesNotMatch(command, /env_key=/)
  assert.equal(injectCodexProvider(command, { base: 'http://127.0.0.1:18080' }), command)
})

test('buildCodexManagedConfig installs and removes a marker-delimited block', () => {
  const original = [
    'model = "gpt-5.5"',
    'model_reasoning_effort = "xhigh"',
    '',
    '[subagents]',
    'model = "gpt-5.4-mini"',
    '',
    '[projects."/mnt/e/ecom"]',
    'trust_level = "trusted"',
    ''
  ].join('\n')
  const managed = buildCodexManagedConfig(original, {
    base: 'http://127.0.0.1:18080',
    token: 'orca-router',
    catalogPath: '/tmp/orca-llm-router/codex-models.json',
    model: 'tokenharbor/mimo-v2.5:free',
    reasoningEffort: 'xhigh'
  })
  assert.match(managed, /^# BEGIN Orca LLM Router managed profile/)
  assert.match(managed, /model_provider = "orca-router"/)
  assert.match(managed, /model_reasoning_effort = "high"/)
  assert.match(managed, /\[model_providers\.orca-router\]/)
  assert.match(managed, /experimental_bearer_token = "orca-router"/)
  assert.match(managed, /\[subagents\]/)
  assert.match(managed, /\[projects\."\/mnt\/e\/ecom"\]/)
  // The original top-level model/reasoning keys are replaced, not duplicated.
  assert.equal((managed.match(/^model = "tokenharbor\/mimo-v2\.5:free"$/gm) ?? []).length, 1)
  assert.equal((managed.match(/^model_reasoning_effort = /gm) ?? []).length, 1)
  // Re-applying is idempotent.
  assert.equal(buildCodexManagedConfig(managed, {
    base: 'http://127.0.0.1:18080',
    token: 'orca-router',
    catalogPath: '/tmp/orca-llm-router/codex-models.json',
    model: 'tokenharbor/mimo-v2.5:free',
    reasoningEffort: 'high'
  }), managed)
})

function codexGlobalHarness() {
  const home = mkdtempSync(join(tmpdir(), 'orca-codex-global-'))
  const path = join(home, 'config.toml')
  const store = new Map()
  const orca = {
    storage: {
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => { store.set(key, value) },
      delete: async (key) => { store.delete(key) }
    }
  }
  const previousHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = home
  return {
    path,
    store,
    orca,
    options: {
      base: 'http://127.0.0.1:18080',
      token: 'orca-router',
      catalogPath: '/tmp/orca-llm-router/codex-models.json',
      model: 'pgs/deepseek-v4.1-flash',
      reasoningEffort: 'low'
    },
    cleanup() {
      if (previousHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    }
  }
}

test('applyCodexGlobal keeps the original backup across a Codex rewrite', async () => {
  const harness = codexGlobalHarness()
  try {
    writeFileSync(harness.path, [
      'model = "gpt-5.5"',
      'model_reasoning_effort = "xhigh"',
      '',
      '[subagents]',
      'model = "gpt-5.4-mini"',
      ''
    ].join('\n'))
    assert.equal(await applyCodexGlobal(harness.orca, harness.options), harness.path)
    assert.match(readFileSync(harness.path, 'utf8'), /# BEGIN Orca LLM Router managed profile/)
    assert.equal(harness.store.get('router.codexConfigBackup').keys.model, 'model = "gpt-5.5"')

    // Codex rewrites config.toml to record a project trust entry. Its writer
    // drops our block, and it also drops the top-level keys we replaced.
    writeFileSync(harness.path, [
      '[subagents]',
      'model = "gpt-5.4-mini"',
      '',
      '[projects."/tmp/new-project"]',
      'trust_level = "trusted"',
      ''
    ].join('\n'))
    await applyCodexGlobal(harness.orca, harness.options)
    const backup = harness.store.get('router.codexConfigBackup')
    assert.equal(backup.keys.model, 'model = "gpt-5.5"')
    assert.equal(backup.keys.model_reasoning_effort, 'model_reasoning_effort = "xhigh"')
    assert.match(readFileSync(harness.path, 'utf8'), /# BEGIN Orca LLM Router managed profile/)

    await restoreCodexGlobal(harness.orca)
    const restored = readFileSync(harness.path, 'utf8')
    assert.match(restored, /^model = "gpt-5.5"/m)
    assert.match(restored, /^model_reasoning_effort = "xhigh"/m)
    assert.match(restored, /\[projects\."\/tmp\/new-project"\]/)
    assert.equal(harness.store.has('router.codexConfigBackup'), false)
  } finally {
    harness.cleanup()
  }
})

test('restoreCodexGlobal restores original keys even after Codex drops the block', async () => {
  const harness = codexGlobalHarness()
  try {
    writeFileSync(harness.path, [
      'model = "gpt-5.5"',
      'model_reasoning_effort = "xhigh"',
      '',
      '[projects."/mnt/e/ecom"]',
      'trust_level = "trusted"',
      ''
    ].join('\n'))
    await applyCodexGlobal(harness.orca, harness.options)

    // Simulate a crash after Codex rewrote the file, so the managed block is
    // gone but the backup still holds the person's original values.
    writeFileSync(harness.path, [
      '[projects."/mnt/e/ecom"]',
      'trust_level = "trusted"',
      ''
    ].join('\n'))
    await restoreCodexGlobal(harness.orca)
    const restored = readFileSync(harness.path, 'utf8')
    assert.match(restored, /^model = "gpt-5.5"/m)
    assert.match(restored, /^model_reasoning_effort = "xhigh"/m)
    assert.match(restored, /\[projects\."\/mnt\/e\/ecom"\]/)
    assert.equal(harness.store.has('router.codexConfigBackup'), false)
  } finally {
    harness.cleanup()
  }
})

test('applyCodexGlobal merges a partial Codex rewrite with the original keys', async () => {
  const harness = codexGlobalHarness()
  try {
    writeFileSync(harness.path, [
      'model = "gpt-5.5"',
      'model_reasoning_effort = "xhigh"',
      '',
      '[projects."/mnt/e/ecom"]',
      'trust_level = "trusted"',
      ''
    ].join('\n'))
    await applyCodexGlobal(harness.orca, harness.options)

    // Codex keeps the model key but drops the reasoning key while rewriting.
    writeFileSync(harness.path, [
      'model = "gpt-5.5"',
      '',
      '[projects."/tmp/new-project"]',
      'trust_level = "trusted"',
      ''
    ].join('\n'))
    await applyCodexGlobal(harness.orca, harness.options)
    const backup = harness.store.get('router.codexConfigBackup')
    assert.equal(backup.keys.model, 'model = "gpt-5.5"')
    assert.equal(backup.keys.model_reasoning_effort, 'model_reasoning_effort = "xhigh"')

    await restoreCodexGlobal(harness.orca)
    const restored = readFileSync(harness.path, 'utf8')
    assert.match(restored, /^model = "gpt-5.5"/m)
    assert.match(restored, /^model_reasoning_effort = "xhigh"/m)
    assert.match(restored, /\[projects\."\/tmp\/new-project"\]/)
  } finally {
    harness.cleanup()
  }
})

test('restoreCodexGlobal uses the in-memory backup when storage is unavailable', async () => {
  const harness = codexGlobalHarness()
  try {
    writeFileSync(harness.path, [
      'model = "gpt-5.5"',
      'model_reasoning_effort = "xhigh"',
      '',
      '[projects."/mnt/e/ecom"]',
      'trust_level = "trusted"',
      ''
    ].join('\n'))
    await applyCodexGlobal(harness.orca, harness.options)

    // Orca tears down the worker's storage before deactivate runs.
    harness.orca.storage.get = async () => { throw new Error('host gone') }
    harness.orca.storage.delete = async () => { throw new Error('host gone') }
    await restoreCodexGlobal(harness.orca)
    const restored = readFileSync(harness.path, 'utf8')
    assert.match(restored, /^model = "gpt-5.5"/m)
    assert.match(restored, /^model_reasoning_effort = "xhigh"/m)
    assert.match(restored, /\[projects\."\/mnt\/e\/ecom"\]/)
  } finally {
    harness.cleanup()
  }
})

test('normalizeResponsesCustomTools turns grammar tools into text for third-party providers', () => {
  const body = {
    model: 'm',
    tools: [
      { type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: x' } },
      { type: 'function', name: 'shell', parameters: { type: 'object' } }
    ]
  }
  const normalized = normalizeResponsesCustomTools(body)
  assert.deepEqual(normalized.tools[0].format, { type: 'text' })
  assert.deepEqual(normalized.tools[1], body.tools[1])
  // Grammar-capable providers keep the original tool definition.
  assert.equal(normalizeResponsesCustomTools(body, { supportsGrammar: true }), body)
  // Bodies without grammar tools are returned untouched.
  const plain = { tools: [{ type: 'function', name: 'shell' }] }
  assert.equal(normalizeResponsesCustomTools(plain), plain)
})

test('mergeOpenCodeConfig replaces CCR and repoints its model references', () => {
  const config = testConfig({ aliases: { fast: 'deepseek/deepseek-chat' } })
  const { document: generated } = buildOpenCodeConfig(config, {
    base: 'http://127.0.0.1:18080',
    token: 'orca-router'
  })
  const existing = {
    $schema: 'https://opencode.ai/config.json',
    model: 'claude-code-router/anthropic/claude-sonnet-4-20250514',
    small_model: 'claude-code-router/retired-model',
    agents: {
      title: { model: { providerID: 'claude-code-router', model: 'openai/gpt-4o' } },
      other: { model: { providerID: 'pgs', model: 'keep-me' } }
    },
    mcp: { servers: { docs: { type: 'remote', url: 'https://example.com/mcp' } } },
    provider: {
      'claude-code-router': { name: 'Claude Code Router', options: {} },
      keep: { name: 'Keep', options: { baseURL: 'https://keep.example.com/v1' } }
    }
  }
  const merged = mergeOpenCodeConfig(existing, generated)
  assert.equal(merged.provider['claude-code-router'], undefined)
  assert.deepEqual(merged.provider.keep, existing.provider.keep)
  assert.equal(merged.provider['orca-router'].options.baseURL, 'http://127.0.0.1:18080/v1')
  // Known targets keep their model; unknown ones fall back to the router default.
  assert.equal(merged.model, 'orca-router/anthropic/claude-sonnet-4-20250514')
  assert.equal(merged.small_model, 'orca-router/anthropic/claude-sonnet-4-20250514')
  assert.deepEqual(merged.agents.title.model, { providerID: 'orca-router', model: 'openai/gpt-4o' })
  assert.deepEqual(merged.agents.other.model, { providerID: 'pgs', model: 'keep-me' })
  assert.deepEqual(merged.mcp, existing.mcp)
  // The caller's document is untouched (the sync merges a clone).
  assert.ok(existing.provider['claude-code-router'])
})

test('mergeOpenCodeConfig does not invent a model for the user', () => {
  const config = testConfig()
  const { document: generated } = buildOpenCodeConfig(config, {
    base: 'http://127.0.0.1:18080',
    token: 'orca-router'
  })
  const existing = {
    $schema: 'https://opencode.ai/config.json',
    mcp: { servers: { docs: { type: 'remote', url: 'https://example.com/mcp' } } },
    provider: {}
  }
  const merged = mergeOpenCodeConfig(existing, generated)
  assert.equal(merged.model, undefined)
  assert.equal(merged.small_model, undefined)
})

test('buildAgentLaunchEnv does not fall back to a router default model', () => {
  const config = testConfig({
    defaultModel: 'anthropic/claude-sonnet-4-20250514',
    agentProfiles: [
      { agent: 'claude', name: 'Claude Code', model: '', enabled: true, scope: 'system-default', env: {} }
    ]
  })
  const { env, model } = buildAgentLaunchEnv(config, 'claude', {
    base: 'http://127.0.0.1:18080',
    token: 'orca-router'
  })
  assert.equal(model, '')
  assert.equal(env.ANTHROPIC_MODEL, undefined)
  assert.equal(env.OPENAI_MODEL, undefined)
  assert.equal(env.MODEL, undefined)
})

test('buildCodexManagedConfig leaves the user model untouched when no pin is given', () => {
  const base = 'http://127.0.0.1:18080'
  const original = [
    'model = "gpt-5.5"',
    'model_reasoning_effort = "xhigh"',
    '',
    '[projects."/tmp/new-project"]',
    'trust_level = "trusted"',
    ''
  ].join('\n')
  const options = { base, token: 'orca-router', catalogPath: '/tmp/orca-llm-router/codex-models.json' }
  const managed = buildCodexManagedConfig(original, options)
  // The user's own keys survive and the block adds routing only.
  assert.equal((managed.match(/^model = "gpt-5\.5"$/gm) ?? []).length, 1)
  assert.equal((managed.match(/^model_reasoning_effort = "xhigh"$/gm) ?? []).length, 1)
  assert.doesNotMatch(managed, /^model_reasoning_effort = "high"$/m)
  assert.match(managed, /model_provider = "orca-router"/)
  assert.match(managed, /model_catalog_json = "\/tmp\/orca-llm-router\/codex-models\.json"/)
  // Re-applying is idempotent.
  assert.equal(buildCodexManagedConfig(managed, options), managed)
})

async function withSidecar(config, fetchImpl, fn, secrets = {}) {
  const sidecar = createSidecar({
    getConfig: () => config,
    getSecret: (key) => secrets[key] ?? null,
    fetchImpl,
    onLog: () => {}
  })
  const addr = await sidecar.start('127.0.0.1', 0)
  const base = `http://127.0.0.1:${addr.port}`
  try {
    await fn(base, sidecar)
  } finally {
    await sidecar.stop()
  }
}

test('provider health normalization clamps its bounds', () => {
  assert.deepEqual(normalizeProviderHealth(), { enabled: false, smoothing: 0.3, staleMs: 300_000 })
  assert.deepEqual(normalizeProviderHealth({ enabled: true, smoothing: 5, staleMs: 1 }), { enabled: true, smoothing: 0.9, staleMs: 30_000 })
})

test('rankProviderTargets orders fastest healthy first and keeps failure last', () => {
  const target = (name) => ({ provider: { name }, model: 'm' })
  const targets = [target('slow'), target('fast'), target('broken')]
  const health = new Map([
    ['slow', { latencyMs: 900, samples: 5, failures: 0, lastSuccessAt: 1000 }],
    ['fast', { latencyMs: 120, samples: 5, failures: 0, lastSuccessAt: 1000 }],
    ['broken', { latencyMs: 100, samples: 5, failures: 3, lastSuccessAt: 1000, lastFailureAt: 2000 }]
  ])
  const ranked = rankProviderTargets({
    targets,
    health,
    config: { circuitBreaker: { failureThreshold: 3 } },
    enabled: true,
    timestamp: 2500
  })
  assert.deepEqual(ranked.map((item) => item.provider.name), ['fast', 'slow', 'broken'])
})

test('rankProviderTargets honors an open circuit and a live session pin', () => {
  const target = (name) => ({ provider: { name }, model: 'm' })
  const targets = [target('a'), target('b')]
  const health = new Map([
    ['a', { latencyMs: 100, samples: 4, failures: 0, lastSuccessAt: 1000 }],
    ['b', { latencyMs: 400, samples: 4, failures: 0, lastSuccessAt: 1000 }]
  ])
  const config = {
    circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 },
    scheduler: { cacheAffinity: true, cacheAffinityTtlMs: 600_000 }
  }
  const open = new Map([['a', { state: 'open', openUntil: 90_000 }]])
  assert.deepEqual(
    rankProviderTargets({ targets, health, circuits: open, config, enabled: true, timestamp: 10_000 }).map((item) => item.provider.name),
    ['b', 'a']
  )
  assert.deepEqual(
    rankProviderTargets({ targets, health, affinity: { provider: 'b', at: 9_000 }, config, enabled: true, timestamp: 10_000 }).map((item) => item.provider.name),
    ['b', 'a']
  )
})

test('rankProviderTargets only ranks when explicitly enabled', () => {
  const target = (name) => ({ provider: { name }, model: 'm' })
  const targets = [target('slow'), target('fast')]
  const health = new Map([
    ['slow', { latencyMs: 900, samples: 5, failures: 0, lastSuccessAt: 1000 }],
    ['fast', { latencyMs: 120, samples: 5, failures: 0, lastSuccessAt: 1000 }]
  ])
  assert.deepEqual(
    rankProviderTargets({ targets, health, config: {}, enabled: true, timestamp: 2000 }).map((item) => item.provider.name),
    ['fast', 'slow'],
    'a fastest route ranks its targets'
  )
  assert.deepEqual(
    rankProviderTargets({ targets, health, config: {}, enabled: false, timestamp: 2000 }).map((item) => item.provider.name),
    ['slow', 'fast'],
    'an ordered route keeps its listed order'
  )
  assert.deepEqual(
    rankProviderTargets({ targets, health, config: {}, timestamp: 2000 }).map((item) => item.provider.name),
    ['slow', 'fast'],
    'ranking is off unless a route opts in'
  )
})

test('a fastest route tries the healthiest provider first', async () => {
  const slow = { name: 'slow', baseUrl: 'https://slow.example.test/v1', protocols: ['openai'], models: [{ id: 'shared-model' }], keys: [] }
  const fast = { name: 'fast', baseUrl: 'https://fast.example.test/v1', protocols: ['openai'], models: [{ id: 'shared-model' }], keys: [] }
  const config = testConfig({
    providers: [slow, fast],
    routes: [{
      name: 'shared-model',
      targets: [
        { provider: 'slow', model: 'shared-model' },
        { provider: 'fast', model: 'shared-model' }
      ],
      strategy: 'fastest'
    }]
  })
  const calls = []
  await withSidecar(config, async (url) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ id: 'r1', model: 'shared-model', choices: [{ message: { content: 'hi' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }, async (base, sidecar) => {
    // Prime both providers the way a manual speed test does.
    sidecar.recordProbes([
      { provider: 'slow', ok: true, latencyMs: 900 },
      { provider: 'fast', ok: true, latencyMs: 100 }
    ])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'shared-model', messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.equal(res.status, 200)
    assert.match(calls[0], /fast\.example\.test/, 'the faster provider is tried first')
    assert.equal(sidecar.logs[0].resolvedProvider, 'fast')
    const health = sidecar.status().providers.find((provider) => provider.name === 'fast').health
    assert.equal(health.state, 'healthy')
    assert.ok(health.latencyMs != null)
  })
})

test('an ordered route keeps its listed order despite faster health', async () => {
  const slow = { name: 'slow', baseUrl: 'https://slow.example.test/v1', protocols: ['openai'], models: [{ id: 'shared-model' }], keys: [] }
  const fast = { name: 'fast', baseUrl: 'https://fast.example.test/v1', protocols: ['openai'], models: [{ id: 'shared-model' }], keys: [] }
  const config = testConfig({
    providers: [slow, fast],
    routes: [{
      name: 'shared-model',
      targets: [
        { provider: 'slow', model: 'shared-model' },
        { provider: 'fast', model: 'shared-model' }
      ],
      strategy: 'ordered'
    }]
  })
  const calls = []
  await withSidecar(config, async (url) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ id: 'r1', model: 'shared-model', choices: [{ message: { content: 'hi' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }, async (base, sidecar) => {
    sidecar.recordProbes([
      { provider: 'slow', ok: true, latencyMs: 900 },
      { provider: 'fast', ok: true, latencyMs: 100 }
    ])
    await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'shared-model', messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.match(calls[0], /slow\.example\.test/, 'the configured order is kept')
  })
})

test('normalizes Codex grammar custom tools for a third-party responses provider', async () => {
  const responsesConfig = (supportsCustomToolGrammar) => testConfig({
    providers: [{
      name: 'responses',
      baseUrl: 'https://responses.example.test/v1',
      protocols: ['responses'],
      models: [{ id: 'm' }],
      keys: [],
      ...(supportsCustomToolGrammar ? { supportsCustomToolGrammar: true } : {})
    }],
    defaultModel: 'responses/m'
  })
  const body = {
    model: 'responses/m',
    input: 'hi',
    tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: x' } }]
  }
  let seen
  await withSidecar(responsesConfig(false), async (url, init) => {
    seen = JSON.parse(init.body)
    return new Response(JSON.stringify({
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      output: [{ type: 'custom_tool_call', id: 'call_1', call_id: 'call_1', name: 'apply_patch', input: '*** Begin Patch\n' }],
      usage: { input_tokens: 1, output_tokens: 1 }
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    assert.equal(res.status, 200)
    assert.deepEqual(seen.tools[0].format, { type: 'text' })
    const payload = await res.json()
    assert.equal(payload.output[0].type, 'custom_tool_call')
  })

  await withSidecar(responsesConfig(true), async (url, init) => {
    seen = JSON.parse(init.body)
    return new Response(JSON.stringify({ id: 'resp_2', object: 'response', status: 'completed', output: [], usage: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    assert.equal(res.status, 200)
    assert.equal(seen.tools[0].format.type, 'grammar')
  })
})

test('proxies chat completions directly to the resolved provider and logs the route', async () => {
  const seen = []
  await withSidecar(testConfig(), async (url, init) => {
    seen.push({ url, init })
    return new Response(
      JSON.stringify({ id: 'r1', model: 'deepseek-chat', choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }, async (base, sidecar) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.equal(res.status, 200)
    assert.equal(seen.length, 1)
    assert.match(seen[0].url, /api\.deepseek\.com\/v1\/chat\/completions/)
    assert.equal(sidecar.logs.length, 1)
    assert.equal(sidecar.logs[0].resolvedProvider, 'deepseek')
    // The provider must receive its own bare model id, not the routing prefix.
    assert.equal(JSON.parse(seen[0].init.body).model, 'deepseek-chat')
    // Usage and the resolved model are recorded after the body is read.
    assert.equal(sidecar.logs[0].resolvedModel, 'deepseek-chat')
    assert.deepEqual(sidecar.logs[0].tokens, { input: 7, output: 3, cache: 0 })
    const usage = sidecar.usage()
    assert.equal(usage.totalTokens, 10)
    assert.deepEqual(usage.byModel, [{ model: 'deepseek-chat', count: 1 }])
  })
})

test('records usage from a same-protocol streaming response', async () => {
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ].join('')
  await withSidecar(testConfig(), async () => new Response(sse, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  }), async (base, sidecar) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'anthropic/claude-sonnet-4-20250514', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.equal(res.status, 200)
    assert.match(await res.text(), /message_start/)
    assert.deepEqual(sidecar.logs[0].tokens, { input: 11, output: 2, cache: 0 })
    assert.equal(sidecar.usage().totalTokens, 13)
  })
})

test('resolves an alias and forwards the provider bare model', async () => {
  const config = testConfig({ aliases: { fast: 'deepseek/deepseek-chat' } })
  let forwarded = null
  await withSidecar(config, async (url, init) => {
    forwarded = JSON.parse(init.body).model
    return new Response(JSON.stringify({ id: 'r1', choices: [{ message: { content: 'hi' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.equal(res.status, 200)
    assert.equal(forwarded, 'deepseek-chat')
  })
})

test('translates Anthropic messages to an OpenAI provider', async () => {
  await withSidecar(testConfig(), async (url, init) => {
    assert.match(url, /api\.deepseek\.com\/v1\/chat\/completions/)
    const payload = JSON.parse(init.body)
    assert.equal(payload.model, 'deepseek-chat')
    assert.equal(payload.messages[0].role, 'system')
    return new Response(
      JSON.stringify({ id: 'r1', model: 'deepseek-chat', choices: [{ message: { content: 'translated' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }, async (base) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', system: 'be brief', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.type, 'message')
    assert.equal(json.content[0].text, 'translated')
  })
})

test('streams an Anthropic-shaped response from an OpenAI provider', async () => {
  let forwarded = null
  await withSidecar(testConfig(), async (url, init) => {
    forwarded = JSON.parse(init.body)
    return new Response(JSON.stringify({
      id: 'r1',
      model: 'deepseek-chat',
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2 }
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }, async (base, sidecar) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    const body = await res.text()
    assert.match(body, /hello/)
    // Cross-protocol streaming is buffered upstream and re-emitted in the client shape.
    assert.equal(forwarded.stream, false)
    assert.equal(forwarded.model, 'deepseek-chat')
    assert.deepEqual(sidecar.logs[0].tokens, { input: 4, output: 2, cache: 0 })
  })
})

test('conditional rules rewrite the model before forwarding', async () => {
  const config = testConfig({
    policies: [{
      name: 'Claude -> DeepSeek',
      enabled: true,
      condition: { source: 'request.body', field: 'model', operator: 'starts-with', value: 'claude-' },
      rewrites: [{ key: 'request.body.model', operation: 'set', value: 'deepseek/deepseek-chat' }]
    }]
  })
  await withSidecar(config, async (url, init) => {
    assert.match(url, /api\.deepseek\.com/)
    assert.equal(JSON.parse(init.body).model, 'deepseek-chat')
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet', messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.equal(res.status, 200)
  })
})

test('a route fails over to the backup provider after a 502', async () => {
  const config = testConfig({
    routes: [{
      name: 'claude-backup',
      targets: [
        { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
        { provider: 'deepseek', model: 'deepseek-chat' }
      ],
      strategy: 'ordered'
    }]
  })
  const urls = []
  await withSidecar(config, async (url) => {
    urls.push(url)
    if (url.includes('anthropic.com')) {
      return new Response('bad gateway', { status: 502, headers: { 'content-type': 'text/plain' } })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }, async (base, sidecar) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-backup', messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.equal(res.status, 200)
    assert.ok(urls.length >= 2, `expected fallback, got ${urls.length}`)
    assert.equal(sidecar.logs.at(-1).resolvedProvider, 'deepseek')
  })
})

test('a raw provider/model request does not fail over to another provider', async () => {
  const config = testConfig()
  const urls = []
  await withSidecar(config, async (url) => {
    urls.push(url)
    return new Response('bad gateway', { status: 502, headers: { 'content-type': 'text/plain' } })
  }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'anthropic/claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.equal(res.status, 502)
    assert.ok(urls.every((url) => url.includes('anthropic.com')), 'only the requested provider is tried')
  })
})

test('an unknown chat model returns 404 instead of mapping to a default provider', async () => {
  const config = testConfig()
  let called = false
  await withSidecar(config, async () => {
    called = true
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }, async (base, sidecar) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'not-a-real-model', messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.equal(res.status, 404)
    assert.equal((await res.json()).error.code, 'model_not_found')
    const prefixed = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nope/model', messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.equal(prefixed.status, 404, 'an unknown provider prefix is not routed to the default provider')
    assert.equal(called, false, 'no provider is contacted for an unknown model')
    assert.equal(sidecar.logs.at(-1).status, 404)
  })
})

test('a route uses its own retry count per target', async () => {
  const config = testConfig({
    retries: 0,
    routes: [{ name: 'try-twice', targets: [{ provider: 'deepseek', model: 'deepseek-chat' }], strategy: 'ordered', retries: 1 }],
    baseDelayMs: 1
  })
  let calls = 0
  await withSidecar(config, async () => {
    calls++
    if (calls === 1) return new Response('temporary', { status: 502, headers: { 'content-type': 'text/plain' } })
    return new Response(JSON.stringify({ id: 'r', choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'try-twice', messages: [] })
    })
    assert.equal(res.status, 200)
    assert.equal(calls, 2, 'the route retried the same target once')
  })
})

test('fetchProviderUsage reads configured connectors instead of dropping them', async () => {
  const seen = []
  const provider = {
    name: 'metered',
    keys: [{ secretKey: 'metered-key' }],
    usageFetch: {
      connectors: [{
        endpoint: 'https://usage.example.test/balance',
        mapping: { meters: [{ id: 'usd', kind: 'balance', limit: 10, used: '$.spent', unit: '$.currency' }] }
      }]
    }
  }
  const result = await fetchProviderUsage(provider, {
    getSecret: () => 'sk-metered',
    fetchImpl: async (url, init) => {
      seen.push({ url, authorization: init.headers.authorization })
      return new Response(JSON.stringify({ spent: 3, currency: 'CNY' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  })
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.meters[0], {
    id: 'usd',
    kind: 'balance',
    label: 'usd',
    unit: 'CNY',
    window: undefined,
    limit: 10,
    used: 3,
    remaining: 7,
    resetAt: undefined
  })
  assert.deepEqual(seen, [{ url: 'https://usage.example.test/balance', authorization: 'Bearer sk-metered' }])
})

test('fetchProviderUsage targets a specific pool key', async () => {
  const provider = {
    name: 'metered',
    keys: [{ secretKey: 'first-key' }, { secretKey: 'second-key' }],
    usageFetch: {
      connectors: [{
        endpoint: 'https://usage.example.test/balance',
        mapping: { meters: [{ id: 'usd', kind: 'balance', limit: 10, used: '$.spent' }] }
      }]
    }
  }
  const asked = []
  let authorization = ''
  const result = await fetchProviderUsage(provider, {
    secretKey: 'second-key',
    getSecret: (key) => {
      asked.push(key)
      return key === 'second-key' ? 'sk-second' : 'sk-first'
    },
    fetchImpl: async (url, init) => {
      authorization = init.headers.authorization
      return new Response(JSON.stringify({ spent: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  })
  assert.deepEqual(asked, ['second-key'], 'only the requested key is resolved')
  assert.equal(authorization, 'Bearer sk-second')
  assert.equal(result.secretKey, 'second-key')
  assert.equal(result.meters[0].used, 2)
})

test('health endpoint reports providers', async () => {
  await withSidecar(testConfig(), async () => new Response('{}'), async (base) => {
    const res = await fetch(`${base}/health`)
    const json = await res.json()
    assert.equal(json.ok, true)
    assert.deepEqual(json.providers, ['anthropic', 'deepseek', 'openai'])
  })
})

test('client API keys are enforced when configured', async () => {
  const config = testConfig({
    clientKeys: [{ id: 'laptop', name: 'Laptop', secretKey: 'client-laptop', enabled: true }]
  })
  await withSidecar(config, async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }), async (base) => {
    const denied = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [] })
    })
    assert.equal(denied.status, 401)
    const allowed = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer orca-router' },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [] })
    })
    assert.equal(allowed.status, 200)
  })
})

test('rejects an expired client API key', async () => {
  const config = testConfig({
    clientKeys: [{ id: 'old', name: 'Old', secretKey: 'client-old', enabled: true, expiresAt: new Date(Date.now() - 60_000).toISOString() }]
  })
  await withSidecar(config, async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }), async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-old' },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [] })
    })
    assert.equal(res.status, 401)
  }, { 'client-old': 'sk-old' })
})

test('enforces a client API key request limit', async () => {
  const config = testConfig({
    clientKeys: [{ id: 'metered', name: 'Metered', secretKey: 'client-metered', enabled: true, limits: { rpm: 1 } }]
  })
  await withSidecar(config, async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }), async (base) => {
    const call = () => fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-metered' },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [] })
    })
    assert.equal((await call()).status, 200)
    assert.equal((await call()).status, 429)
  }, { 'client-metered': 'sk-metered' })
})

test('retries a retryable upstream failure and succeeds', async () => {
  let calls = 0
  const config = testConfig({ retries: 2, baseDelayMs: 1 })
  await withSidecar(config, async () => {
    calls++
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ id: 'r', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }, async (base, sidecar) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [] })
    })
    assert.equal(res.status, 200)
    assert.equal(calls, 2)
    assert.equal(sidecar.logs[0].attempts.length, 2)
  })
})

function pooledConfig(keys) {
  const provider = {
    name: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    protocols: ['openai'],
    models: [{ id: 'deepseek-chat' }],
    keys
  }
  return normalizeConfig({
    providers: [provider],
    defaultFallback: { mode: 'retry', models: [], retryCount: 0 },
    retries: 0,
    routes: [],
    aliases: {},
    clientKeys: [],
    agentProfiles: DEFAULT_CONFIG.agentProfiles
  })
}

async function proxy(base) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [{ role: 'user', content: 'hi' }] })
  })
}

test('credential pool rotates to the next key after an auth error', async () => {
  const config = pooledConfig([
    { id: 'first', secretKey: 'deepseek-key-1', enabled: true },
    { id: 'second', secretKey: 'deepseek-key-2', enabled: true }
  ])
  const used = []
  await withSidecar(
    config,
    async (url, init) => {
      used.push(init.headers.authorization)
      if (init.headers.authorization === 'Bearer sk-first') {
        return new Response('bad key', { status: 401, headers: { 'content-type': 'text/plain' } })
      }
      return new Response(JSON.stringify({ id: 'r1', choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    },
    async (base) => {
      const res = await proxy(base)
      assert.equal(res.status, 200)
      assert.deepEqual(used, ['Bearer sk-first', 'Bearer sk-second'])
    },
    { 'deepseek-key-1': 'sk-first', 'deepseek-key-2': 'sk-second' }
  )
})

test('credential pool round-robins between keys across requests', async () => {
  const config = pooledConfig([
    { id: 'first', secretKey: 'deepseek-key-1', enabled: true },
    { id: 'second', secretKey: 'deepseek-key-2', enabled: true }
  ])
  config.scheduler.cacheAffinity = false
  const used = []
  await withSidecar(
    config,
    async (url, init) => {
      used.push(init.headers.authorization)
      return new Response(JSON.stringify({ id: 'r1', choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    },
    async (base) => {
      for (let i = 0; i < 4; i++) assert.equal((await proxy(base)).status, 200)
      assert.deepEqual(used, ['Bearer sk-first', 'Bearer sk-second', 'Bearer sk-first', 'Bearer sk-second'])
    },
    { 'deepseek-key-1': 'sk-first', 'deepseek-key-2': 'sk-second' }
  )
})

test('credential pool keeps lower-priority keys idle until the preferred tier is unavailable', async () => {
  const config = pooledConfig([
    { id: 'preferred', secretKey: 'deepseek-key-1', enabled: true, priority: 0 },
    { id: 'spillover', secretKey: 'deepseek-key-2', enabled: true, priority: 1 }
  ])
  const used = []
  await withSidecar(
    config,
    async (url, init) => {
      used.push(init.headers.authorization)
      return new Response(JSON.stringify({ id: 'r1', choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    },
    async (base) => {
      for (let i = 0; i < 3; i++) assert.equal((await proxy(base)).status, 200)
      assert.deepEqual(used, ['Bearer sk-first', 'Bearer sk-first', 'Bearer sk-first'])
    },
    { 'deepseek-key-1': 'sk-first', 'deepseek-key-2': 'sk-second' }
  )

  const spilled = pooledConfig([
    { id: 'preferred', secretKey: 'deepseek-key-1', enabled: false, priority: 0 },
    { id: 'spillover', secretKey: 'deepseek-key-2', enabled: true, priority: 1 }
  ])
  used.length = 0
  await withSidecar(
    spilled,
    async (url, init) => {
      used.push(init.headers.authorization)
      return new Response(JSON.stringify({ id: 'r1', choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    },
    async (base) => {
      assert.equal((await proxy(base)).status, 200)
      assert.deepEqual(used, ['Bearer sk-second'])
    },
    { 'deepseek-key-1': 'sk-first', 'deepseek-key-2': 'sk-second' }
  )
})

test('normalizeConfig keeps scheduler settings', () => {
  const config = normalizeConfig(testConfig({
    scheduler: { priorityTiers: false, utilizationAware: false, allKeysExhausted: 'overflow', exhaustedStatus: 429 }
  }))
  assert.equal(config.scheduler.priorityTiers, false)
  assert.equal(config.scheduler.utilizationAware, false)
  assert.equal(config.scheduler.allKeysExhausted, 'overflow')
  assert.equal(config.scheduler.exhaustedStatus, 429)
})

test('scheduler distributes traffic by weight', () => {
  const state = createSchedulerState()
  const candidates = [
    { id: 'heavy', weight: 3 },
    { id: 'light', weight: 1 }
  ]
  const counts = { heavy: 0, light: 0 }
  for (let i = 0; i < 400; i++) {
    const chosen = selectScheduledKey({ providerName: 'weighted', candidates, scheduler: {}, state })
    counts[chosen.id]++
  }
  assert.deepEqual(counts, { heavy: 300, light: 100 })
})

test('scheduler prefers lower priority tiers and lower utilization', () => {
  const state = createSchedulerState()
  const tiers = [
    { id: 'preferred', priority: 0, weight: 1, utilization: 0.1 },
    { id: 'spillover', priority: 1, weight: 1, utilization: 0 }
  ]
  for (let i = 0; i < 5; i++) {
    assert.equal(selectScheduledKey({ providerName: 'tiers', candidates: tiers, scheduler: {}, state }).id, 'preferred')
  }
  assert.equal(
    selectScheduledKey({ providerName: 'tiers', candidates: [tiers[1]], scheduler: {}, state }).id,
    'spillover'
  )

  const spilled = createSchedulerState()
  const tiered = [
    { id: 'main', priority: 0, weight: 1, utilization: 0.95 },
    { id: 'backup', priority: 1, weight: 1, utilization: 0.1 }
  ]
  assert.equal(
    selectScheduledKey({ providerName: 'tier-spill', candidates: tiered, scheduler: {}, state: spilled }).id,
    'backup'
  )

  const headroom = createSchedulerState()
  const nearLimit = { id: 'near', weight: 10, utilization: 0.95 }
  const roomy = { id: 'roomy', weight: 1, utilization: 0.1 }
  for (let i = 0; i < 6; i++) {
    assert.equal(
      selectScheduledKey({ providerName: 'headroom', candidates: [nearLimit, roomy], scheduler: {}, state: headroom }).id,
      'roomy'
    )
  }
})

test('scheduler normalization and Retry-After parsing are bounded', () => {
  assert.equal(normalizeScheduler({ exhaustedStatus: 429 }).exhaustedStatus, 429)
  assert.equal(normalizeScheduler({ exhaustedStatus: 500 }).exhaustedStatus, 420)
  assert.equal(normalizeScheduler({ utilizationThreshold: 5 }).utilizationThreshold, 1)
  assert.equal(retryAfterMs('2'), 2000)
  const dateDelay = retryAfterMs(new Date(Date.now() + 5000).toUTCString())
  assert.ok(dateDelay > 3000 && dateDelay <= 5000, `expected a valid HTTP-date delay, got ${dateDelay}`)
  assert.equal(retryAfterMs('not-a-date'), 0)
})

test('deriveAffinityKey prefers explicit headers, then body ids, then a stable prompt hash', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(deriveAffinityKey({ 'x-orca-session-id': 'one', 'x-session-id': 'two' }, body), 'header:x-orca-session-id:one')
  assert.equal(deriveAffinityKey({ 'x-session-id': 'two' }, body), 'header:x-session-id:two')
  assert.equal(deriveAffinityKey({}, { ...body, metadata: { user_id: 'user-7' } }), 'body:user-7')
  const first = deriveAffinityKey({}, body)
  const reordered = deriveAffinityKey({}, { messages: [{ content: 'hi', role: 'user' }], model: 'm' })
  assert.equal(first, reordered)
  assert.notEqual(first, deriveAffinityKey({}, { ...body, messages: [{ role: 'user', content: 'bye' }] }))
  assert.equal(deriveAffinityKey({}, { model: 'm' }), '')
})

test('circuit breaker normalization is bounded', () => {
  assert.equal(normalizeCircuitBreaker({ failureThreshold: 0 }).failureThreshold, 1)
  assert.equal(normalizeCircuitBreaker({ cooldownMs: 10 }).cooldownMs, 1000)
  assert.equal(normalizeCircuitBreaker({ enabled: false }).enabled, false)
})

test('cache affinity keeps a session on the same key, then rebinds a new session', async () => {
  const config = pooledConfig([
    { id: 'first', secretKey: 'deepseek-key-1', enabled: true },
    { id: 'second', secretKey: 'deepseek-key-2', enabled: true }
  ])
  const used = []
  const call = (base, session) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(session ? { 'x-orca-session-id': session } : {}) },
    body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [{ role: 'user', content: 'hi' }] })
  })
  await withSidecar(
    config,
    async (url, init) => {
      used.push(init.headers.authorization)
      return new Response(JSON.stringify({ id: 'r1', choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    },
    async (base) => {
      assert.equal((await call(base, 'session-a')).status, 200)
      assert.equal((await call(base, 'session-a')).status, 200)
      assert.equal((await call(base, 'session-b')).status, 200)
      assert.deepEqual(used, ['Bearer sk-first', 'Bearer sk-first', 'Bearer sk-second'])
    },
    { 'deepseek-key-1': 'sk-first', 'deepseek-key-2': 'sk-second' }
  )
})

test('prompt hashing keeps identical prompts on one key without a session header', async () => {
  const config = pooledConfig([
    { id: 'first', secretKey: 'deepseek-key-1', enabled: true },
    { id: 'second', secretKey: 'deepseek-key-2', enabled: true }
  ])
  const used = []
  const call = (base, prompt) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [{ role: 'user', content: prompt }] })
  })
  await withSidecar(
    config,
    async (url, init) => {
      used.push(init.headers.authorization)
      return new Response(JSON.stringify({ id: 'r1', choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    },
    async (base) => {
      assert.equal((await call(base, 'same prompt')).status, 200)
      assert.equal((await call(base, 'same prompt')).status, 200)
      assert.equal((await call(base, 'different prompt')).status, 200)
      assert.deepEqual(used, ['Bearer sk-first', 'Bearer sk-first', 'Bearer sk-second'])
    },
    { 'deepseek-key-1': 'sk-first', 'deepseek-key-2': 'sk-second' }
  )
})

test('credential pool skips a key that reached its request limit', async () => {
  const config = pooledConfig([
    { id: 'metered', secretKey: 'deepseek-key-1', enabled: true, limits: { rpm: 1 } },
    { id: 'spare', secretKey: 'deepseek-key-2', enabled: true }
  ])
  const used = []
  await withSidecar(
    config,
    async (url, init) => {
      used.push(init.headers.authorization)
      return new Response(
        JSON.stringify({ id: 'r1', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    },
    async (base) => {
      assert.equal((await proxy(base)).status, 200)
      assert.equal((await proxy(base)).status, 200)
      assert.equal(used[0], 'Bearer sk-first')
      assert.equal(used[1], 'Bearer sk-second')
    },
    { 'deepseek-key-1': 'sk-first', 'deepseek-key-2': 'sk-second' }
  )
})

test('status reports rolling per-key usage and quota meters for the panel', async () => {
  const config = pooledConfig([
    { id: 'primary', secretKey: 'deepseek-key-1', enabled: true, limits: { rpm: 10, rpd: 100 } },
    { id: 'backup', secretKey: 'deepseek-key-2', enabled: false, limits: { rpm: 5 } }
  ])
  let currentTime = 1_000_000
  const sidecar = createSidecar({
    getConfig: () => config,
    getSecret: (key) => key === 'deepseek-key-1' ? 'sk-first' : 'sk-second',
    fetchImpl: async () => new Response(
      JSON.stringify({ id: 'r1', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ),
    onLog: () => {},
    now: () => currentTime
  })
  const addr = await sidecar.start('127.0.0.1', 0)
  try {
    assert.equal((await proxy(`http://127.0.0.1:${addr.port}`)).status, 200)

    const primary = sidecar.status().providers[0].keyUsage.find((key) => key.secretKey === 'deepseek-key-1')
    assert.ok(primary, 'primary key has a usage snapshot')
    assert.equal(primary.enabled, true)
    assert.equal(primary.state, 'ready')
    assert.equal(primary.requests.minute, 1)
    assert.equal(primary.requests.day, 1)
    assert.equal(primary.tokens.day, 10)
    assert.deepEqual(
      primary.meters.map((meter) => [meter.field, meter.used, meter.limit]),
      [['rpm', 1, 10], ['rpd', 1, 100]]
    )
    assert.equal(primary.utilization, 0.1)

    const backup = sidecar.status().providers[0].keyUsage.find((key) => key.secretKey === 'deepseek-key-2')
    assert.ok(backup, 'disabled key still has a usage snapshot')
    assert.equal(backup.enabled, false)
    assert.equal(backup.state, 'disabled')
    assert.equal(backup.requests.day, 0)

    currentTime += 61_000
    const later = sidecar.status().providers[0].keyUsage.find((key) => key.secretKey === 'deepseek-key-1')
    assert.equal(later.requests.minute, 0, 'the minute window rolls over')
    assert.equal(later.requests.hour, 1, 'the hourly window still includes the request')
    assert.equal(later.requests.day, 1, 'the daily window still includes the request')
  } finally {
    await sidecar.stop()
  }
})

test('a keyed provider retries a transient 5xx without cooling the key', async () => {
  const config = pooledConfig([{ id: 'only', secretKey: 'deepseek-key-1', enabled: true }])
  config.retries = 1
  let calls = 0
  await withSidecar(
    config,
    async () => {
      calls++
      if (calls === 1) return new Response('temporary', { status: 502, headers: { 'content-type': 'text/plain' } })
      return new Response(JSON.stringify({ id: 'r1', choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    },
    async (base) => {
      assert.equal((await proxy(base)).status, 200)
      assert.equal(calls, 2)
    },
    { 'deepseek-key-1': 'sk-first' }
  )
})

test('a single keyed provider honors Retry-After and retries within the same request', async () => {
  const config = pooledConfig([{ id: 'only', secretKey: 'deepseek-key-1', enabled: true }])
  config.retries = 1
  let calls = 0
  await withSidecar(
    config,
    async () => {
      calls++
      if (calls === 1) {
        return new Response('slow down', {
          status: 429,
          headers: { 'content-type': 'text/plain', 'retry-after': '0.001' }
        })
      }
      return new Response(JSON.stringify({ id: 'r1', choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    },
    async (base) => {
      assert.equal((await proxy(base)).status, 200)
      assert.equal(calls, 2)
    },
    { 'deepseek-key-1': 'sk-first' }
  )
})

test('returns 420 when every key is over its configured limit', async () => {
  const config = pooledConfig([
    { id: 'metered', secretKey: 'deepseek-key-1', enabled: true, limits: { rpm: 1 } }
  ])
  let calls = 0
  await withSidecar(
    config,
    async () => {
      calls++
      return new Response(
        JSON.stringify({ id: 'r1', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    },
    async (base, sidecar) => {
      assert.equal((await proxy(base)).status, 200)
      const exhausted = await proxy(base)
      assert.equal(exhausted.status, 420)
      assert.equal((await exhausted.json()).error.code, 'all_keys_exhausted')
      assert.equal(calls, 1, 'the exhausted request never reaches upstream')
      assert.equal(sidecar.logs.at(-1).status, 420)
    },
    { 'deepseek-key-1': 'sk-first' }
  )
})

test('provider circuit opens after repeated provider failures and allows a half-open probe', async () => {
  const config = pooledConfig([{ id: 'only', secretKey: 'deepseek-key-1', enabled: true }])
  config.circuitBreaker = { enabled: true, failureThreshold: 1, cooldownMs: 50 }
  let calls = 0
  await withSidecar(
    config,
    async () => {
      calls++
      if (calls === 1) return new Response('upstream down', { status: 500, headers: { 'content-type': 'text/plain' } })
      return new Response(JSON.stringify({ id: 'r1', choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    },
    async (base) => {
      assert.equal((await proxy(base)).status, 500)
      const open = await proxy(base)
      assert.equal(open.status, 503)
      assert.equal((await open.json()).error.code, 'provider_circuit_open')
      assert.equal(calls, 1, 'circuit-open request does not reach upstream')
      await new Promise((resolve) => setTimeout(resolve, 1100))
      assert.equal((await proxy(base)).status, 200)
      assert.equal(calls, 2, 'half-open probe reaches upstream once')
    },
    { 'deepseek-key-1': 'sk-first' }
  )
})

test('worker key pool handlers add, update and remove keys without resurrecting them', async () => {
  const store = new Map()
  const secrets = new Map()
  const handlers = new Map()
  const seed = normalizeConfig({
    providers: [{ ...deepseekProvider, keys: [{ id: 'seed', secretKey: 'deepseek-seed', enabled: true }] }],
    defaultFallback: { mode: 'retry', models: [], retryCount: 0 },
    retries: 0,
    routes: [],
    aliases: {},
    clientKeys: [],
    agentProfiles: DEFAULT_CONFIG.agentProfiles
  })
  const clone = (value) => JSON.parse(JSON.stringify(value))
  store.set('router.config', clone(seed))
  const orca = {
    storage: {
      get: async (key) => (store.has(key) ? clone(store.get(key)) : null),
      set: async (key, value) => {
        store.set(key, clone(value))
      }
    },
    settings: {
      get: async () => ({ enabled: false, port: 18080, bindHost: '127.0.0.1', timeoutMs: 600000, retries: 2, baseDelayMs: 0 })
    },
    secrets: {
      get: async (key) => (secrets.has(key) ? secrets.get(key) : null),
      set: async (key, value) => {
        secrets.set(key, value)
      },
      delete: async (key) => {
        secrets.delete(key)
      }
    },
    host: { call: async () => null },
    panels: {
      handle: (name, fn) => handlers.set(name, fn),
      post: () => {}
    },
    commands: { register: () => {} },
    hooks: { on: () => {} },
    events: { on: () => {} },
    log: () => {}
  }
  const { default: activate } = await import('../worker/main.mjs')
  await activate(orca)
  const call = (name, input) => handlers.get(name)(input)
  const keysOf = async () => {
    const { config } = await call('router.config.get', {})
    return config.providers.find((provider) => provider.name === 'deepseek').keys
  }

  await call('router.key.add', {
    provider: 'deepseek',
    secretKey: 'deepseek-a',
    value: 'sk-a',
    priority: 2,
    limits: { rpm: 10 }
  })
  await call('router.key.add', { provider: 'deepseek', secretKey: 'deepseek-b', value: 'sk-b' })
  let keys = await keysOf()
  assert.equal(keys.length, 3)
  assert.equal(secrets.get('deepseek-a'), 'sk-a')
  const added = keys.find((key) => key.secretKey === 'deepseek-a')
  assert.equal(added.priority, 2)
  assert.deepEqual(added.limits, { rpm: 10 })

  await call('router.key.update', {
    provider: 'deepseek',
    secretKey: 'deepseek-a',
    id: 'Primary key',
    value: 'sk-a-updated'
  })
  keys = await keysOf()
  assert.equal(keys.find((key) => key.secretKey === 'deepseek-a').id, 'Primary key')
  assert.equal(secrets.get('deepseek-a'), 'sk-a-updated')

  await call('router.key.update', { provider: 'deepseek', secretKey: 'deepseek-b', enabled: false, priority: 3 })
  keys = await keysOf()
  const updated = keys.find((key) => key.secretKey === 'deepseek-b')
  assert.equal(updated.enabled, false)
  assert.equal(updated.priority, 3)

  await call('router.key.remove', { provider: 'deepseek', secretKey: 'deepseek-a' })
  keys = await keysOf()
  assert.equal(keys.length, 2)
  assert.equal(secrets.has('deepseek-a'), false)
  // The persisted store must keep the removal too (merge must not resurrect it).
  assert.equal(store.get('router.config').providers.find((provider) => provider.name === 'deepseek').keys.length, 2)

  await call('router.key.remove', { provider: 'deepseek', secretKey: 'deepseek-b' })
  assert.equal((await keysOf()).length, 1)
  assert.equal(store.get('router.config').providers.find((provider) => provider.name === 'deepseek').keys.length, 1)
})

// ---------------------------------------------------------------------------
// Native Gemini protocol.
// ---------------------------------------------------------------------------

const geminiProvider = {
  name: 'google-gemini',
  baseUrl: 'https://generativelanguage.googleapis.com',
  protocols: ['gemini'],
  models: [{ id: 'gemini-2.5-flash' }],
  keys: [{ id: 'k1', secretKey: 'gemini-secret', enabled: true }]
}

const geminiConfig = (overrides = {}) => testConfig({
  providers: [geminiProvider],
  defaultFallback: { mode: 'retry', models: [], retryCount: 0 },
  ...overrides
})

const geminiReply = (text, usage = { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 }) => JSON.stringify({
  responseId: 'g1',
  modelVersion: 'gemini-2.5-flash',
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: usage
})

test('openAIToGemini maps system, messages and tools', () => {
  const body = openAIToGemini({
    model: 'gemini-2.5-flash',
    max_tokens: 32,
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', function: { name: 'read', arguments: '{"file":"a.ts"}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'done' }
    ],
    tools: [{ type: 'function', function: { name: 'read', description: 'r', parameters: { type: 'object' } } }]
  })
  assert.equal(body.model, undefined)
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'be brief' }] })
  assert.equal(body.generationConfig.maxOutputTokens, 32)
  assert.equal(body.generationConfig.temperature, 0.2)
  assert.equal(body.contents[0].role, 'user')
  assert.deepEqual(body.contents[0].parts, [{ text: 'hi' }])
  assert.equal(body.contents[1].parts[0].functionCall.name, 'read')
  assert.equal(body.contents[2].parts[0].functionResponse.name, 'read')
  assert.equal(body.tools[0].functionDeclarations[0].name, 'read')
})

test('geminiResponseToOpenAI maps text, tool calls and usage', () => {
  const reply = geminiResponseToOpenAI({
    responseId: 'g1',
    candidates: [{ content: { parts: [{ text: 'hello' }, { functionCall: { name: 'read', args: { file: 'a.ts' } } }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 }
  }, 'gemini-2.5-flash')
  assert.equal(reply.choices[0].message.content, 'hello')
  assert.equal(reply.choices[0].message.tool_calls[0].function.name, 'read')
  assert.equal(reply.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(reply.usage, { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 })
})

test('proxies an OpenAI request to native Gemini generateContent', async () => {
  const seen = []
  await withSidecar(geminiConfig(), async (url, init) => {
    seen.push({ url, init })
    return new Response(geminiReply('hi there'), { status: 200, headers: { 'content-type': 'application/json' } })
  }, async (base, sidecar) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'google-gemini/gemini-2.5-flash', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }] })
    })
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.choices[0].message.content, 'hi there')
    assert.equal(json.usage.prompt_tokens, 5)
    assert.match(seen[0].url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:generateContent$/)
    assert.equal(seen[0].init.headers['x-goog-api-key'], 'gm-key')
    assert.equal(seen[0].init.headers.authorization, undefined)
    assert.equal(seen[0].init.headers['x-api-key'], undefined)
    const upstreamBody = JSON.parse(seen[0].init.body)
    assert.equal(upstreamBody.model, undefined)
    assert.deepEqual(upstreamBody.systemInstruction, { parts: [{ text: 'be brief' }] })
    assert.equal(upstreamBody.contents[0].parts[0].text, 'hi')
    assert.equal(sidecar.logs[0].resolvedModel, 'gemini-2.5-flash')
    assert.deepEqual(sidecar.logs[0].tokens, { input: 5, output: 2, cache: 0 })
  }, { 'gemini-secret': 'gm-key' })
})

test('translates Anthropic messages to native Gemini and back', async () => {
  const seen = []
  await withSidecar(geminiConfig(), async (url, init) => {
    seen.push({ url, init })
    return new Response(geminiReply('hello'), { status: 200, headers: { 'content-type': 'application/json' } })
  }, async (base) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'google-gemini/gemini-2.5-flash', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.content[0].text, 'hello')
    assert.equal(json.usage.input_tokens, 5)
    const upstreamBody = JSON.parse(seen[0].init.body)
    assert.equal(upstreamBody.generationConfig.maxOutputTokens, 16)
  }, { 'gemini-secret': 'gm-key' })
})

test('streams a Gemini response to an OpenAI client without leaking a stream flag', async () => {
  const seen = []
  await withSidecar(geminiConfig(), async (url, init) => {
    seen.push({ url, init })
    return new Response(geminiReply('OK', { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 }), { status: 200, headers: { 'content-type': 'application/json' } })
  }, async (base, sidecar) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'google-gemini/gemini-2.5-flash', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'say OK' }] })
    })
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.match(text, /data: /)
    assert.match(text, /\[DONE\]/)
    assert.match(text, /OK/)
    const upstreamBody = JSON.parse(seen[0].init.body)
    assert.equal('stream' in upstreamBody, false)
    assert.deepEqual(sidecar.logs[0].tokens, { input: 3, output: 1, cache: 0 })
  }, { 'gemini-secret': 'gm-key' })
})

test('forwards a buffered upstream error instead of faking a stream', async () => {
  const config = testConfig({
    providers: [{ name: 'openai', baseUrl: 'https://api.openai.com/v1', protocols: ['openai'], models: [{ id: 'gpt-4o' }], keys: [] }]
  })
  await withSidecar(config, async () => new Response(
    JSON.stringify({ error: { message: 'upstream rejected the payload' } }),
    { status: 400, headers: { 'content-type': 'application/json' } }
  ), async (base) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-4o', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /upstream rejected the payload/)
  })
})

// ---------------------------------------------------------------------------
// Client key token/image limits and request hardening.
// ---------------------------------------------------------------------------

test('enforces a client API key token limit from recorded usage', async () => {
  const config = testConfig({
    clientKeys: [{ id: 'tokenmeter', name: 'Tokens', secretKey: 'client-token', enabled: true, limits: { tpd: 5 } }]
  })
  await withSidecar(config, async () => new Response(
    JSON.stringify({ id: 'r', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 4, completion_tokens: 4 } }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  ), async (base) => {
    const call = () => fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-token' },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [] })
    })
    assert.equal((await call()).status, 200) // records 8 tokens
    const limited = await call()
    assert.equal(limited.status, 429)
    assert.match((await limited.json()).error.message, /token rate limit/)
  }, { 'client-token': 'sk-token' })
})

test('enforces a client API key image limit on image generation', async () => {
  const config = testConfig({
    clientKeys: [{ id: 'imgmeter', name: 'Images', secretKey: 'client-img', enabled: true, limits: { ipd: 2 } }]
  })
  await withSidecar(config, async () => new Response(
    JSON.stringify({ created: 1, data: [] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  ), async (base) => {
    const call = (n) => fetch(`${base}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-img' },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', prompt: 'cat', n })
    })
    assert.equal((await call(2)).status, 200)
    assert.equal((await call(1)).status, 429)
  }, { 'client-img': 'sk-img' })
})

test('rejects a malformed JSON body with 400', async () => {
  let called = false
  await withSidecar(testConfig(), async () => {
    called = true
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json'
    })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error.code, 'invalid_json')
  })
  assert.equal(called, false)
})

test('reports a missing model as 400 model_required', async () => {
  await withSidecar(testConfig(), async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }), async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] })
    })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error.code, 'model_required')
  })
})

test('normalizeConfig keeps top-level model descriptions', () => {
  const normalized = normalizeConfig({
    providers: [],
    modelDescriptions: { 'fast-alias': 'Cheap and fast' }
  })
  assert.deepEqual(normalized.modelDescriptions, { 'fast-alias': 'Cheap and fast' })
})

test('normalizeConfig preserves the router default model', () => {
  const normalized = normalizeConfig({
    providers: [],
    defaultModel: 'pgs/deepseek-v4.1-flash'
  })
  assert.equal(normalized.defaultModel, 'pgs/deepseek-v4.1-flash')
})

test('convertClaudeCodeRouterConfig imports model aliases and profiles', () => {
  const result = convertClaudeCodeRouterConfig({
    Providers: [{
      name: 'OpenAI',
      api_base_url: 'https://api.openai.com/v1',
      api_key: 'sk-openai',
      models: [{ id: 'gpt-4o' }]
    }],
    aliases: {
      'fast-tier': 'openai/gpt-4o'
    },
    profile: {
      claudeCode: { model: 'openai/gpt-4o' }
    }
  })
  assert.equal(result.config.providers.length, 1)
  assert.equal(result.config.aliases['fast-tier'], 'openai/gpt-4o')
  assert.ok(result.config.agentProfiles.some((p) => p.agent === 'claude-code' && p.model === 'openai/gpt-4o'))
  assert.equal(result.secrets[0].value, 'sk-openai')
})

test('decryptOmniRouteCredential decrypts AES-256-GCM ciphertext', () => {
  const secret = 'dee38b1954c61fc6fee239e77177d40a108659b7fd3817705c742c16d565de65'
  const ciphertext = 'enc:v1:ce2861ccd4ca754c35d8624ce638a020:e78adb38b9ca2aa4804d1685256c4a482818aa2af859034a1d5d37b94eee5b2f238a9149793235838e00d5586007146788d04ff8c6d51c2d2ae643a38da204ef:46366d8395c5ad92c3d1b9109bf630f4'
  const decrypted = decryptOmniRouteCredential(ciphertext, secret)
  assert.equal(decrypted, 'NddEIsF3emsnsRCl14JJW5c0UAxh9BeBUp2oGJeE3e95dB3pQCGPcYW9pREffDFL')
  assert.equal(decryptOmniRouteCredential('plain-token', secret), 'plain-token')
})

test('convertOmniRouteConfig converts nodes, connections, combos, and aliases', () => {
  const omni = {
    providerNodes: [
      { id: 'ollama-node', name: 'Ollama Local', baseUrl: 'http://localhost:11434/v1', apiType: 'openai_chat' }
    ],
    providerConnections: [
      { id: 'conn-ollama', provider: 'ollama-node', name: 'Local Ollama', apiKey: 'ollama-secret', defaultModel: 'llama3' },
      { id: 'conn-ant', provider: 'anthropic', name: 'Anthropic Key', apiKey: 'sk-ant-test', priority: 1, rateLimitOverrides: { rpm: 60 } }
    ],
    combos: [
      {
        name: 'coding-combo',
        data: JSON.stringify({
          steps: [
            { kind: 'model', model: 'anthropic/claude-3-7-sonnet' },
            { kind: 'model', model: 'openai/gpt-4o' }
          ]
        })
      }
    ],
    modelAliases: {
      'dev-fast': 'ollama-node/llama3'
    },
    customModels: {
      'ollama-node': ['llama3:latest', 'qwen2.5-coder']
    },
    apiKeys: [
      { id: 'client-key-1', name: 'Dev Key', key: 'sk-omni-client', limits: { rpm: 30 } }
    ]
  }

  const result = convertOmniRouteConfig(omni)
  assert.equal(result.config.providers.length, 2)

  const ollama = result.config.providers.find((p) => p.name === 'ollama-local')
  assert.ok(ollama)
  assert.equal(ollama.baseUrl, 'http://localhost:11434/v1')
  assert.ok(ollama.models.some((m) => m.id === 'llama3'))
  assert.ok(ollama.models.some((m) => m.id === 'qwen2.5-coder'))

  const anthropic = result.config.providers.find((p) => p.name === 'anthropic')
  assert.ok(anthropic)
  assert.equal(anthropic.baseUrl, 'https://api.anthropic.com')
  assert.equal(anthropic.keys[0].priority, 1)
  assert.equal(anthropic.keys[0].limits.rpm, 60)

  assert.equal(result.config.policies.length, 1)
  assert.equal(result.config.policies[0].name, 'Combo: coding-combo')
  assert.equal(result.config.policies[0].rewrites[0].value, 'anthropic/claude-3-7-sonnet')
  assert.deepEqual(result.config.policies[0].fallback.models, ['openai/gpt-4o'])

  assert.equal(result.config.aliases['coding-combo'], 'anthropic/claude-3-7-sonnet')
  assert.equal(result.config.aliases['dev-fast'], 'ollama-node/llama3')

  assert.equal(result.config.clientKeys.length, 1)
  assert.equal(result.secrets.find((s) => s.secretKey === 'imported.clientKeys.client-key-1').value, 'sk-omni-client')
})

test('mergeRouterConfigs merges CCR and OmniRoute configs cleanly', () => {
  const ccr = convertClaudeCodeRouterConfig({
    Providers: [{ name: 'DeepSeek', api_base_url: 'https://api.deepseek.com', api_key: 'sk-deep', models: ['deepseek-chat'] }],
    aliases: { fast: 'deepseek/deepseek-chat' }
  })
  const omni = convertOmniRouteConfig({
    providerNodes: [{ id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', apiType: 'openai' }],
    providerConnections: [{ id: 'conn-1', provider: 'ollama', apiKey: 'ollama-key' }],
    modelAliases: { smart: 'anthropic/claude-sonnet-4-6' }
  })

  const merged = mergeRouterConfigs(ccr.config, omni.config, ccr.secrets, omni.secrets)
  assert.equal(merged.config.providers.length, 2)
  assert.ok(merged.config.providers.some((p) => p.name === 'deepseek'))
  assert.ok(merged.config.providers.some((p) => p.name === 'ollama'))
  assert.equal(merged.config.aliases.fast, 'deepseek/deepseek-chat')
  assert.equal(merged.config.aliases.smart, 'anthropic/claude-sonnet-4-6')
  assert.equal(merged.secrets.length, 2)
})

test('detectAndConvertConfig identifies formats automatically', () => {
  const ccrRaw = { Providers: [{ name: 'Test', api_base_url: 'http://test' }] }
  assert.equal(detectAndConvertConfig(ccrRaw).type, 'ccr')

  const omniRaw = { providerConnections: [{ provider: 'openai', apiKey: 'sk-123' }] }
  assert.equal(detectAndConvertConfig(omniRaw).type, 'omniroute')

  const nativeRaw = { version: 2, token: 'orca-router', providers: [], routes: [] }
  assert.equal(detectAndConvertConfig(nativeRaw).type, 'native')
})


// ---------------------------------------------------------------------------
// Concrete issue fixes
// ---------------------------------------------------------------------------

test('logBodyCapture=none disables request log collection but preserves usage stats', async () => {
  const config = testConfig({ logBodyCapture: 'none' })
  await withSidecar(config, async () => new Response(
    JSON.stringify({ id: 'r1', choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  ), async (base, sidecar) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.equal(res.status, 200)
    assert.equal(sidecar.logs.length, 0)
    const usage = sidecar.usage()
    assert.equal(usage.requests, 1)
    assert.equal(usage.totalTokens, 7)
  })
})

test('provider auth does not forward client gateway credentials upstream', async () => {
  let seenAuth = null
  await withSidecar(testConfig(), async (url, init) => {
    seenAuth = init.headers.authorization
    return new Response(JSON.stringify({ id: 'r1', choices: [{ message: { content: 'ok' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
  }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer client-gateway-token' },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [] })
    })
    assert.equal(res.status, 200)
    // no provider key configured and client auth must not be leaked
    assert.equal(seenAuth, undefined)
  })
})

test('parses HTTP-date Retry-After values', async () => {
  let calls = 0
  const config = testConfig({ retries: 1, baseDelayMs: 1 })
  const started = Date.now()
  await withSidecar(config, async () => {
    calls++
    if (calls === 1) {
      return new Response('rate limited', {
        status: 429,
        headers: { 'content-type': 'text/plain', 'retry-after': new Date(Date.now() - 1000).toUTCString() }
      })
    }
    return new Response(JSON.stringify({ id: 'r', choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [] })
    })
    assert.equal(res.status, 200)
    assert.equal(calls, 2)
    assert.ok(Date.now() - started < 5000)
  })
})

test('exposes routing headers when enabled', async () => {
  const config = testConfig({ exposeRoutingHeaders: true })
  await withSidecar(config, async () => new Response(
    JSON.stringify({ id: 'r1', choices: [{ message: { content: 'ok' } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  ), async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [] })
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-router-provider'), 'deepseek')
    assert.equal(res.headers.get('x-router-model'), 'deepseek-chat')
  })
})

test('requires client auth when binding non-loopback without client keys', async () => {
  const config = testConfig({ bindHost: '0.0.0.0', clientKeys: [] })
  const sidecar = createSidecar({
    getConfig: () => config,
    getSecret: () => null,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
    onLog: () => {}
  })
  const addr = await sidecar.start('127.0.0.1', 0)
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [] })
    })
    assert.equal(res.status, 401)
  } finally {
    await sidecar.stop()
  }
})

test('safeCaptureBody caps large JSON payloads to limit', () => {
  const hugePayload = JSON.stringify({
    messages: [
      { role: 'user', content: 'A'.repeat(50_000) }
    ]
  })
  const captured = safeCaptureBody(hugePayload, 1024)
  assert.ok(typeof captured === 'string')
  assert.ok(captured.length <= 1040)
  assert.ok(captured.includes('…[truncated]'))
})

test('panelLogEntry strips bulky request/response bodies and headers', async () => {
  const { panelLogEntry } = await import('../worker/main.mjs')
  const rawLog = {
    at: Date.now(),
    upstream: 'anthropic',
    resolvedProvider: 'anthropic',
    credential: 'key-1',
    model: 'claude-3-7-sonnet',
    protocol: 'anthropic_messages',
    status: 500,
    latencyMs: 120,
    attempts: ['anthropic'],
    tokens: { input: 1000, output: 500 },
    requestBody: { hugePrompt: 'X'.repeat(500_000) },
    responseBody: { rawError: 'Y'.repeat(500_000) },
    requestHeaders: { 'x-large-header': 'Z'.repeat(10_000) },
    responseHeaders: { 'x-trace': 'W'.repeat(10_000) }
  }
  const panelEntry = panelLogEntry(rawLog)
  assert.equal(panelEntry.requestBody, undefined)
  assert.equal(panelEntry.responseBody, undefined)
  assert.equal(panelEntry.requestHeaders, undefined)
  assert.equal(panelEntry.responseHeaders, undefined)
  assert.equal(panelEntry.upstream, 'anthropic')
  assert.equal(panelEntry.status, 500)
  assert.ok(JSON.stringify(panelEntry).length < 500)
})

test('50 logs stripped for panel status serialize to well under 1 MiB', async () => {
  const { panelLogEntry } = await import('../worker/main.mjs')
  const largeLogs = Array.from({ length: 50 }, (_, i) => ({
    at: Date.now() - i * 1000,
    upstream: 'anthropic',
    resolvedProvider: 'anthropic',
    credential: 'key-1',
    model: 'claude-sonnet-4-5',
    protocol: 'anthropic_messages',
    status: 200,
    latencyMs: 340,
    attempts: ['anthropic'],
    tokens: { input: 1500, output: 400 },
    cost: 0.015,
    requestBody: { conversation: 'Z'.repeat(100_000) },
    responseBody: { text: 'A'.repeat(100_000) }
  }))
  const panelLogs = largeLogs.map(panelLogEntry)
  const jsonSize = Buffer.byteLength(JSON.stringify(panelLogs))
  assert.ok(jsonSize < 50_000, `Expected < 50KB, got ${jsonSize} bytes`)
})

test('non-destructive rate window counting maintains hourly and daily limits', async () => {
  const config = testConfig({
    clientKeys: [{
      id: 'ck-multi',
      name: 'Multi-limit Key',
      secretKey: 'multi-secret',
      limits: { rpm: 2, rph: 3 }
    }]
  })
  let currentTime = 1000000
  const sidecar = createSidecar({
    getConfig: () => config,
    getSecret: (k) => k === 'multi-secret' ? 'key-abc' : null,
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    onLog: () => {},
    now: () => currentTime
  })
  const addr = await sidecar.start('127.0.0.1', 0)
  try {
    const callGateway = () => fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer key-abc' },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [{ role: 'user', content: 'hi' }] })
    })

    // Request 1 at T=1000000
    let res = await callGateway()
    assert.equal(res.status, 200)

    // Request 2 at T=1000000 + 10s
    currentTime += 10_000
    res = await callGateway()
    assert.equal(res.status, 200)

    // Advance 70s: outside 1-minute window, but still within 1-hour window
    currentTime += 70_000
    // Request 3 (rpm check runs first; must NOT delete previous requests from hourly window!)
    res = await callGateway()
    assert.equal(res.status, 200)

    // Request 4 at same time: within rpm (only 2 in last 60s), but hourly limit is 3, so must hit 429
    res = await callGateway()
    assert.equal(res.status, 429)
    const err = await res.json()
    assert.match(err.error.message, /rate limit reached/)
  } finally {
    await sidecar.stop()
  }
})

test('forwards anthropic-beta header to anthropic upstreams', async () => {
  let seenHeaders = null
  const config = testConfig({
    providers: [{
      name: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      protocols: ['anthropic'],
      models: [{ id: 'claude-3-7-sonnet' }],
      keys: [{ id: 'k1', secretKey: 'ant-key', enabled: true }]
    }]
  })
  await withSidecar(config, async (url, init) => {
    seenHeaders = init.headers
    return new Response(JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 5 }
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }, async (base) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31,thinking-2024-11-25'
      },
      body: JSON.stringify({ model: 'anthropic/claude-3-7-sonnet', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.equal(res.status, 200)
    assert.equal(seenHeaders['anthropic-beta'], 'prompt-caching-2024-07-31,thinking-2024-11-25')
  }, { 'ant-key': 'sk-ant-test' })
})

test('safeCaptureBody redacts sensitive values inside SSE data stream lines', () => {
  const sseChunk = 'data: {"secret_key": "sk-1234567890", "password": "pass", "text": "visible"}\n\ndata: [DONE]\n\n'
  const redacted = safeCaptureBody(sseChunk, 500)
  assert.ok(redacted.includes('data:'))
  assert.ok(redacted.includes('"secret_key":"[REDACTED]"'))
  assert.ok(redacted.includes('"password":"[REDACTED]"'))
  assert.ok(redacted.includes('"text":"visible"'))
})

test('translates multimodal images between Anthropic and OpenAI schemas', () => {
  const anthropicReq = {
    model: 'claude-3-sonnet',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'describe this image' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } }
      ]
    }]
  }
  const openAIReq = anthropicToOpenAI(anthropicReq)
  assert.equal(openAIReq.messages[0].content.length, 2)
  assert.equal(openAIReq.messages[0].content[0].type, 'text')
  assert.equal(openAIReq.messages[0].content[1].type, 'image_url')
  assert.match(openAIReq.messages[0].content[1].image_url.url, /^data:image\/png;base64,iVBORw0KGgo/)

  const backToAnthropic = openAIToAnthropic(openAIReq)
  assert.equal(backToAnthropic.messages[0].content[1].type, 'image')
  assert.equal(backToAnthropic.messages[0].content[1].source.type, 'base64')
  assert.equal(backToAnthropic.messages[0].content[1].source.media_type, 'image/png')
})

test('translates Anthropic thinking to OpenAI reasoning_effort and maps reasoning_content back', () => {
  const anthropicReq = {
    model: 'claude-3-7-sonnet',
    thinking: { type: 'enabled', budget_tokens: 16000 },
    messages: [{ role: 'user', content: 'solve puzzle' }]
  }
  const openAIReq = anthropicToOpenAI(anthropicReq)
  assert.equal(openAIReq.reasoning_effort, 'high')
  assert.equal(openAIReq.thinking, undefined)

  const openAIReply = {
    id: 'r1',
    model: 'deepseek-r1',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: 'answer is 42',
        reasoning_content: 'step 1: compute 6 * 7'
      }
    }]
  }
  const anthropicRes = openAIResponseToAnthropic(openAIReply, 'claude-3-7-sonnet')
  assert.equal(anthropicRes.content[0].type, 'thinking')
  assert.equal(anthropicRes.content[0].thinking, 'step 1: compute 6 * 7')
  assert.equal(anthropicRes.content[1].type, 'text')
  assert.equal(anthropicRes.content[1].text, 'answer is 42')
})

// ---------------------------------------------------------------------------
// Opt-in request optimization: compression, context relay, response cache.
// ---------------------------------------------------------------------------

function postJson(base, body, headers = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
}

test('compression normalization clamps modes and sizes', () => {
  assert.deepEqual(normalizeCompression(), {
    enabled: false,
    mode: 'lite',
    minChars: 2000,
    keepRecentMessages: 4,
    toolResults: true,
    systemPrompt: false,
    toolMaxChars: 4000,
    messageMaxChars: 2000
  })
  const normalized = normalizeCompression({ enabled: true, mode: 'nope', minChars: -1, keepRecentMessages: 500, toolMaxChars: 1 })
  assert.equal(normalized.mode, 'lite')
  assert.equal(normalized.minChars, 0)
  assert.equal(normalized.keepRecentMessages, 100)
  assert.equal(normalized.toolMaxChars, 200)
})

test('compression preserves code fences and recent turns while capping old tool output', () => {
  const code = '```js\nconst x = 1;\n\n\n\nconst y = 2;\n```'
  const body = {
    model: 'm',
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: `Please inspect:\n${code}\n${'a'.repeat(400)}` },
      { role: 'tool', content: 'tool line\n'.repeat(400) },
      { role: 'user', content: 'recent turn' }
    ]
  }
  const result = compressChatBody(body, {
    protocol: 'openai',
    options: { enabled: true, mode: 'standard', minChars: 0, keepRecentMessages: 1, toolMaxChars: 300 }
  })
  assert.equal(result.changed, true)
  assert.ok(result.body.messages[1].content.includes(code), 'code fence is byte-perfect')
  assert.ok(result.body.messages[2].content.includes('chars omitted by Orca LLM Router'))
  assert.equal(result.body.messages[3].content, 'recent turn')
  assert.equal(body.messages[2].content, 'tool line\n'.repeat(400), 'input body is not mutated')
})

test('aggressive compression shortens old prose but never tool structure', () => {
  const body = {
    model: 'm',
    messages: [
      { role: 'user', content: `old ${'word '.repeat(400)}` },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] },
      { role: 'tool', content: `result ${'z'.repeat(400)}` },
      { role: 'user', content: 'latest' }
    ]
  }
  const result = compressChatBody(body, {
    protocol: 'openai',
    options: { enabled: true, mode: 'aggressive', minChars: 0, keepRecentMessages: 1, messageMaxChars: 120, toolMaxChars: 200 }
  })
  assert.ok(result.body.messages[0].content.includes('chars omitted'))
  assert.equal(result.body.messages[1].tool_calls[0].id, 'call_1')
  assert.ok(result.body.messages[2].content.includes('chars omitted'))
  assert.equal(result.body.messages[3].content, 'latest')
})

test('anthropic compression leaves tool_use input and recent turns intact', () => {
  const body = {
    model: 'claude',
    system: 'sys',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `old ${'p'.repeat(500)}` },
          { type: 'tool_result', tool_use_id: 't1', content: `tool ${'q'.repeat(500)}` }
        ]
      },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'text', text: 'recent' }] }
    ]
  }
  const result = compressChatBody(body, {
    protocol: 'anthropic',
    options: { enabled: true, mode: 'aggressive', minChars: 0, keepRecentMessages: 1, messageMaxChars: 120, toolMaxChars: 150 }
  })
  const first = result.body.messages[0].content
  assert.ok(first[0].text.includes('chars omitted'))
  assert.ok(first[1].content.includes('chars omitted'))
  assert.deepEqual(result.body.messages[1].content[0].input, { path: 'a' })
  assert.equal(result.body.messages[2].content[0].text, 'recent')
})

test('context relay digests old turns and keeps the recent window', () => {
  assert.equal(normalizeContextRelay().trigger, 'failover')
  const body = {
    model: 'm',
    messages: [
      { role: 'system', content: `system stays ${'s'.repeat(300)}` },
      { role: 'user', content: 'first line\nsecond line that is long' },
      { role: 'tool', content: 'tool output '.repeat(100) },
      { role: 'user', content: 'recent question' }
    ]
  }
  const result = relayChatBody(body, {
    protocol: 'openai',
    options: { enabled: true, keepRecentMessages: 1, digestChars: 40 }
  })
  assert.equal(result.changed, true)
  assert.equal(result.body.messages[0].content, `system stays ${'s'.repeat(300)}`)
  assert.match(result.body.messages[1].content, /^\[handoff\] first line/)
  assert.match(result.body.messages[2].content, /^\[handoff tool result:/)
  assert.equal(result.body.messages[3].content, 'recent question')
})

test('cache keys ignore the stream flag but include scope, body, and stream options', () => {
  const scope = 'openai\u0000stream\u0000deepseek\u0000deepseek-chat'
  const base = { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], stream_options: { include_usage: true } }
  const streamed = canonicalCacheKey({ scope, body: { ...base, stream: true } })
  const buffered = canonicalCacheKey({ scope, body: { ...base, stream: false } })
  assert.equal(streamed, buffered)
  assert.notEqual(streamed, canonicalCacheKey({ scope, body: { ...base, stream: false, stream_options: { include_usage: false } } }))
  assert.notEqual(streamed, canonicalCacheKey({ scope: 'other', body: base }))
  assert.notEqual(streamed, canonicalCacheKey({ scope, body: { ...base, messages: [{ role: 'user', content: 'bye' }] } }))
})

test('cosine similarity and cache normalization behave predictably', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.equal(cosineSimilarity([1], [1, 0]), 0)
  const cache = normalizeResponseCache({ enabled: true, ttlMs: 1, maxEntries: 0, threshold: 2 })
  assert.equal(cache.ttlMs, 10_000)
  assert.equal(cache.maxEntries, 1)
  assert.equal(cache.threshold, 1)
})

test('semantic params keys ignore prompt wording but keep generation settings', () => {
  const base = {
    model: 'deepseek-chat',
    messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'explain this code' }],
    temperature: 0,
    max_tokens: 128,
    stop: ['\n\n']
  }
  const reworded = {
    ...base,
    messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'explain that code' }]
  }
  assert.equal(semanticParamsKey(base, 'openai'), semanticParamsKey(reworded, 'openai'))
  assert.notEqual(semanticParamsKey(base, 'openai'), semanticParamsKey({ ...base, max_tokens: 256 }, 'openai'))
  assert.notEqual(semanticParamsKey(base, 'openai'), semanticParamsKey({ ...base, temperature: 0.7 }, 'openai'))
  assert.notEqual(semanticParamsKey(base, 'openai'), semanticParamsKey({ ...base, stop: ['END'] }, 'openai'))
  assert.notEqual(
    semanticParamsKey(base, 'openai'),
    semanticParamsKey({ ...base, messages: [...base.messages, { role: 'assistant', content: 'prior answer' }] }, 'openai')
  )
  const withToolCall = {
    ...base,
    messages: [...base.messages, { role: 'assistant', tool_calls: [{ id: '1', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } }] }]
  }
  assert.notEqual(
    semanticParamsKey(withToolCall, 'openai'),
    semanticParamsKey({
      ...withToolCall,
      messages: [...base.messages, { role: 'assistant', tool_calls: [{ id: '1', type: 'function', function: { name: 'lookup', arguments: '{"id":2}' } }] }]
    }, 'openai')
  )
  // A model change is already part of the cache scope; it must not be the only
  // difference that creates a new params key.
  assert.equal(semanticParamsKey(base, 'openai'), semanticParamsKey({ ...base, model: 'other' }, 'openai'))
})

test('cache eligibility skips tools, images, hot requests, and per-request opt-out', () => {
  const options = normalizeResponseCache({ enabled: true, maxTemperature: 0 })
  const plain = { protocol: 'openai', headers: {}, options, body: { messages: [{ role: 'user', content: 'hello' }] } }
  assert.equal(shouldCacheRequest(plain), true)
  assert.equal(shouldCacheRequest({ ...plain, body: { messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function', function: { name: 'x' } }] } }), false)
  assert.equal(shouldCacheRequest({ ...plain, body: { messages: [{ role: 'tool', content: 'result' }] } }), false)
  assert.equal(shouldCacheRequest({ ...plain, body: { messages: [{ role: 'assistant', tool_calls: [{ id: '1' }] }] } }), false)
  assert.equal(shouldCacheRequest({ ...plain, body: { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] }] } }), false)
  assert.equal(shouldCacheRequest({ ...plain, body: { messages: [{ role: 'user', content: 'hello' }], temperature: 0.7 } }), false)
  assert.equal(shouldCacheRequest({ ...plain, headers: { 'x-router-cache': 'off' } }), false)
  assert.equal(shouldCacheRequest({
    ...plain,
    protocol: 'gemini',
    body: { contents: [{ parts: [{ functionCall: { name: 'x' } }] }] }
  }), false)
})

test('response cache replays an exact non-streaming response without calling upstream', async () => {
  const config = pooledConfig([{ id: 'k', secretKey: 'deepseek-key-1', enabled: true }])
  config.responseCache = normalizeResponseCache({ enabled: true, mode: 'exact', ttlMs: 60_000, maxEntries: 10 })
  let calls = 0
  await withSidecar(
    config,
    async () => {
      calls++
      return new Response(
        JSON.stringify({ id: 'r1', choices: [{ message: { content: 'cached answer' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    },
    async (base, sidecar) => {
      const body = { model: 'deepseek/deepseek-chat', messages: [{ role: 'user', content: 'same request' }] }
      const first = await postJson(base, body)
      const firstText = await first.text()
      const second = await postJson(base, body)
      const secondText = await second.text()
      assert.equal(first.status, 200)
      assert.equal(second.status, 200)
      assert.equal(second.headers.get('x-router-cache'), 'hit')
      assert.equal(secondText, firstText)
      assert.equal(calls, 1)
      assert.equal(sidecar.stats.cacheHits, 1)
      assert.equal(sidecar.stats.cacheSavedTokens, 6)
      const usage = sidecar.usage({ window: 'today' })
      assert.equal(usage.cacheHits, 1)
      assert.equal(usage.cacheSavedTokens, 6)
      const firstHeaders = await Promise.resolve(first.headers.get('x-router-cache'))
      assert.notEqual(firstHeaders, 'hit')
    },
    { 'deepseek-key-1': 'secret' }
  )
})

test('response cache stores and replays raw streaming SSE', async () => {
  const config = pooledConfig([{ id: 'k', secretKey: 'deepseek-key-1', enabled: true }])
  config.responseCache = normalizeResponseCache({ enabled: true, mode: 'exact', ttlMs: 60_000, maxEntries: 10 })
  const sse = [
    'data: {"id":"r1","choices":[{"delta":{"content":"hello"}}]}\n\n',
    'data: {"id":"r1","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
    'data: [DONE]\n\n'
  ].join('')
  let calls = 0
  await withSidecar(
    config,
    async () => {
      calls++
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
    async (base) => {
      const body = { model: 'deepseek/deepseek-chat', stream: true, messages: [{ role: 'user', content: 'stream me' }] }
      const first = await postJson(base, body)
      const firstText = await first.text()
      const second = await postJson(base, body)
      const secondText = await second.text()
      assert.equal(first.status, 200)
      assert.equal(second.status, 200)
      assert.equal(second.headers.get('x-router-cache'), 'hit')
      assert.equal(secondText, firstText)
      assert.match(secondText, /\[DONE\]/)
      assert.equal(calls, 1)
    },
    { 'deepseek-key-1': 'secret' }
  )
})

test('semantic cache mode matches near-identical prompts through an embedding provider', async () => {
  const config = pooledConfig([{ id: 'k', secretKey: 'deepseek-key-1', enabled: true }])
  config.responseCache = normalizeResponseCache({
    enabled: true,
    mode: 'semantic',
    ttlMs: 60_000,
    maxEntries: 10,
    threshold: 0.9,
    embeddingProvider: 'deepseek',
    embeddingModel: 'embed-small'
  })
  let chatCalls = 0
  let embeddingCalls = 0
  await withSidecar(
    config,
    async (url) => {
      if (String(url).includes('/embeddings')) {
        embeddingCalls++
        return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      chatCalls++
      return new Response(
        JSON.stringify({ id: 'r1', choices: [{ message: { content: 'semantic answer' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    },
    async (base) => {
      const firstBody = { model: 'deepseek/deepseek-chat', messages: [{ role: 'user', content: 'explain this code' }] }
      const first = await postJson(base, firstBody)
      const firstText = await first.text()
      const second = await postJson(base, { model: 'deepseek/deepseek-chat', messages: [{ role: 'user', content: 'explain that code' }] })
      const secondText = await second.text()
      assert.equal(second.headers.get('x-router-cache'), 'semantic-hit')
      assert.equal(secondText, firstText)
      assert.equal(chatCalls, 1)
      assert.equal(embeddingCalls, 2)
      // A near-identical prompt with different generation settings must not
      // reuse the stored answer.
      const different = await postJson(base, {
        model: 'deepseek/deepseek-chat',
        messages: [{ role: 'user', content: 'explain that code' }],
        max_tokens: 64
      })
      assert.notEqual(different.headers.get('x-router-cache'), 'semantic-hit')
      assert.equal(chatCalls, 2)
      assert.equal(embeddingCalls, 3)
      // An exact repeat of the original prompt is reported as an exact hit and
      // must not call the embedding provider again.
      const third = await postJson(base, firstBody)
      assert.equal(third.headers.get('x-router-cache'), 'hit')
      assert.equal(await third.text(), firstText)
      assert.equal(embeddingCalls, 3)
      assert.equal(chatCalls, 2)
    },
    { 'deepseek-key-1': 'secret' }
  )
})

test('x-router-cache: off bypasses the response cache', async () => {
  const config = pooledConfig([{ id: 'k', secretKey: 'deepseek-key-1', enabled: true }])
  config.responseCache = normalizeResponseCache({ enabled: true, mode: 'exact', ttlMs: 60_000, maxEntries: 10 })
  let calls = 0
  await withSidecar(
    config,
    async () => {
      calls++
      return new Response(
        JSON.stringify({ id: 'r1', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    },
    async (base) => {
      const body = { model: 'deepseek/deepseek-chat', messages: [{ role: 'user', content: 'bypass' }] }
      assert.equal((await postJson(base, body)).status, 200)
      const bypassed = await postJson(base, body, { 'x-router-cache': 'off' })
      assert.equal(bypassed.status, 200)
      assert.equal(bypassed.headers.get('x-router-cache'), 'bypass')
      assert.equal(calls, 2)
    },
    { 'deepseek-key-1': 'secret' }
  )
})

test('context relay compacts older turns on failover and keeps the recent window', async () => {
  const primary = {
    name: 'primary',
    baseUrl: 'https://primary.test/v1',
    protocols: ['openai'],
    models: [{ id: 'm' }],
    keys: [{ id: 'p', secretKey: 'primary-key' }]
  }
  const secondary = {
    name: 'secondary',
    baseUrl: 'https://secondary.test/v1',
    protocols: ['openai'],
    models: [{ id: 'm' }],
    keys: [{ id: 's', secretKey: 'secondary-key' }]
  }
  const config = testConfig({
    providers: [primary, secondary],
    routes: [{
      name: 'relay',
      targets: [{ provider: 'primary', model: 'm' }, { provider: 'secondary', model: 'm' }],
      strategy: 'ordered',
      retries: 0
    }],
    contextRelay: { enabled: true, trigger: 'failover', keepRecentMessages: 1, digestChars: 40 },
    retries: 0
  })
  const bodies = []
  await withSidecar(
    config,
    async (url, init) => {
      bodies.push(JSON.parse(init.body))
      if (String(url).includes('primary.test')) {
        return new Response(JSON.stringify({ error: { message: 'boom' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(
        JSON.stringify({ id: 'r1', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    },
    async (base) => {
      const response = await postJson(base, {
        model: 'relay',
        messages: [
          { role: 'system', content: 'system stays' },
          { role: 'user', content: 'first line\nsecond line that is long' },
          { role: 'tool', content: 'tool output '.repeat(80) },
          { role: 'user', content: 'recent question' }
        ]
      })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('x-router-context-relay')?.startsWith('compacted'), true)
      assert.equal(bodies.length, 2)
      assert.equal(bodies[0].messages[1].content, 'first line\nsecond line that is long')
      assert.match(bodies[1].messages[1].content, /^\[handoff\] first line/)
      assert.match(bodies[1].messages[2].content, /^\[handoff tool result:/)
      assert.equal(bodies[1].messages[0].content, 'system stays')
      assert.equal(bodies[1].messages[3].content, 'recent question')
    },
    { 'primary-key': 'p-secret', 'secondary-key': 's-secret' }
  )
})

test('compression runs before forwarding and honors the per-request off switch', async () => {
  const config = pooledConfig([{ id: 'k', secretKey: 'deepseek-key-1', enabled: true }])
  config.compression = normalizeCompression({ enabled: true, mode: 'standard', minChars: 0, keepRecentMessages: 1, toolMaxChars: 200 })
  const bodies = []
  await withSidecar(
    config,
    async (url, init) => {
      bodies.push(JSON.parse(init.body))
      return new Response(
        JSON.stringify({ id: 'r1', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    },
    async (base) => {
      const body = {
        model: 'deepseek/deepseek-chat',
        messages: [
          { role: 'tool', content: 'tool line\n'.repeat(100) },
          { role: 'user', content: 'recent' }
        ]
      }
      const compressed = await postJson(base, body)
      assert.equal(compressed.status, 200)
      assert.equal(compressed.headers.get('x-router-compression')?.startsWith('standard'), true)
      assert.match(bodies[0].messages[0].content, /chars omitted/)
      const skipped = await postJson(base, body, { 'x-router-compression': 'off' })
      assert.equal(skipped.status, 200)
      assert.equal(bodies[1].messages[0].content, 'tool line\n'.repeat(100))
    },
    { 'deepseek-key-1': 'secret' }
  )
})

test('compression leaves machine-readable JSON tool output untouched', () => {
  const payload = '{\n  "a": 1,  \n  "b": 2\n}'
  const body = {
    model: 'm',
    messages: [
      { role: 'tool', content: payload },
      { role: 'user', content: 'recent' }
    ]
  }
  const result = compressChatBody(body, {
    protocol: 'openai',
    options: { enabled: true, mode: 'aggressive', minChars: 0, keepRecentMessages: 1, toolMaxChars: 50 }
  })
  assert.equal(result.changed, false)
  assert.equal(result.body, body)
  assert.equal(body.messages[0].content, payload)
})

test('compression leaves a bare Responses input string and instructions alone by default', () => {
  const input = 'live prompt '.repeat(400)
  const body = { model: 'm', input, instructions: 'system instructions' }
  const result = compressChatBody(body, {
    protocol: 'responses',
    options: { enabled: true, mode: 'aggressive', minChars: 0, messageMaxChars: 100 }
  })
  assert.equal(result.changed, false)
  assert.equal(result.body, body)
  assert.equal(body.input, input)
  assert.equal(body.instructions, 'system instructions')
})
