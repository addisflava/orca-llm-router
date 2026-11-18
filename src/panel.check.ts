// Panel states worth looking at: one scenario per tab, plus the empty
// first-run state. `orca plugin check .` renders each of these without Orca.
import { defineCheck } from 'orca/testing'
import type { AgentProfile, AgentRoute, LogEntry, ModelRoute, ProviderView, RequestPolicy, RouterConfig } from './protocol'

const providers: ProviderView[] = [
  {
    name: 'anthropic',
    displayName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    protocols: ['anthropic_messages'],
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    keyCount: 1,
    health: { state: 'healthy', latencyMs: 312, samples: 24, failures: 0, lastSuccessAt: Date.now() - 12_000 },
    keyUsage: [{
      id: 'k-anthropic-1',
      secretKey: 'ANTHROPIC_KEY',
      enabled: true,
      state: 'ready',
      requests: { minute: 2, hour: 35, day: 128 },
      tokens: { minute: 1_840, hour: 38_200, day: 246_460 },
      images: { minute: 0, hour: 0, day: 0 },
      meters: [
        { field: 'rpm', kind: 'requests', windowMs: 60_000, used: 2, limit: 60, remaining: 58, utilization: 2 / 60 },
        { field: 'rpd', kind: 'requests', windowMs: 86_400_000, used: 128, limit: 500, remaining: 372, utilization: 128 / 500 }
      ],
      utilization: 128 / 500
    }]
  },
  {
    name: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    protocols: ['openai_chat_completions', 'openai_responses'],
    models: ['gpt-5', 'gpt-5-mini', 'o4-mini'],
    keyCount: 2,
    health: { state: 'degraded', latencyMs: 940, samples: 11, failures: 2, lastSuccessAt: Date.now() - 90_000, lastFailureAt: Date.now() - 5_000 },
    keyUsage: [
      {
        id: 'k-openai-1',
        secretKey: 'OPENAI_KEY',
        enabled: true,
        state: 'limited',
        requests: { minute: 20, hour: 110, day: 640 },
        tokens: { minute: 32_000, hour: 180_000, day: 1_240_000 },
        images: { minute: 0, hour: 1, day: 4 },
        meters: [
          { field: 'rpm', kind: 'requests', windowMs: 60_000, used: 20, limit: 20, remaining: 0, utilization: 1 },
          { field: 'tpd', kind: 'tokens', windowMs: 86_400_000, used: 1_240_000, limit: 2_000_000, remaining: 760_000, utilization: 0.62 }
        ],
        utilization: 1
      },
      {
        id: 'k-openai-2',
        secretKey: 'OPENAI_KEY_BACKUP',
        enabled: true,
        state: 'ready',
        requests: { minute: 0, hour: 8, day: 22 },
        tokens: { minute: 0, hour: 12_400, day: 36_800 },
        images: { minute: 0, hour: 0, day: 0 },
        meters: [],
        utilization: 0
      }
    ]
  },
  {
    name: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocols: ['openai_chat_completions'],
    models: [],
    keyCount: 0
  }
]

const policies: RequestPolicy[] = [
  {
    id: 'policy-claude',
    name: 'Claude requests',
    enabled: true,
    condition: { source: 'request.body', field: 'model', operator: 'starts-with', value: 'claude-' },
    rewrites: [{ key: 'request.body.model', operation: 'set', value: 'anthropic/claude-sonnet-4-5' }],
    model: 'anthropic/claude-sonnet-4-5',
    fallback: { mode: 'provider-chain', models: ['smart'] }
  },
  {
    id: 'policy-fast',
    name: 'Fast tier',
    enabled: false,
    condition: { source: 'request.body', field: 'model', operator: 'equals', value: 'fast' },
    model: 'openai/gpt-5-mini',
    fallback: { mode: 'retry', retryCount: 2 }
  }
]

const modelRoutes: ModelRoute[] = [
  {
    name: 'fast',
    targets: [
      { provider: 'openai', model: 'gpt-5-mini' },
      { provider: 'anthropic', model: 'claude-haiku-4-5' }
    ],
    strategy: 'fastest',
    enabled: true
  },
  {
    name: 'smart',
    targets: [
      { provider: 'anthropic', model: 'claude-opus-4-1' },
      { provider: 'openai', model: 'gpt-5' }
    ],
    strategy: 'fastest',
    enabled: true
  },
  {
    name: 'sticky',
    targets: [{ provider: 'openrouter', model: '' }],
    strategy: 'ordered',
    enabled: true
  }
]

const aliases = { fast: 'openai/gpt-5-mini', smart: 'anthropic/claude-opus-4-1', legacy: 'openai/gpt-5' }

const clientKeys = [
  { id: 'gw_live_7f2a', name: 'CI runner', expiresAt: '2027-01-01', limits: { rpm: 60 }, enabled: true },
  { id: 'gw_live_1b9c', name: 'Laptop', limits: {}, enabled: false }
]

const agentProfiles: AgentProfile[] = [
  { agent: 'claude', name: 'Claude Code', model: 'anthropic/claude-sonnet-4-5', smallFastModel: 'openai/gpt-5-mini', scope: 'router-only' },
  { agent: 'codex', name: 'Codex', model: 'openai/gpt-5', scope: 'custom', enabled: false }
]

const agents: AgentRoute[] = [
  { agent: 'claude', name: 'Claude', installed: true, enabled: true },
  { agent: 'codex', name: 'Codex', installed: true, enabled: false },
  { agent: 'opencode', name: 'OpenCode', installed: true, enabled: true },
  { agent: 'gemini', name: 'Gemini', installed: true, enabled: true },
  { agent: 'pi', name: 'Pi', installed: true, enabled: true },
  { agent: 'cursor', name: 'Cursor', installed: false, enabled: true },
  { agent: 'qwen-code', name: 'Qwen Code', installed: false, enabled: true }
]

const logs: LogEntry[] = [
  {
    at: Date.now() - 42_000,
    upstream: 'anthropic',
    resolvedProvider: 'anthropic',
    credential: 'ANTHROPIC_KEY',
    requestModel: 'claude-sonnet-4-5',
    resolvedModel: 'claude-sonnet-4-5',
    model: 'claude-sonnet-4-5',
    protocol: 'anthropic_messages',
    status: 200,
    latencyMs: 812,
    attempts: ['anthropic'],
    tokens: { input: 1840, output: 620 },
    cost: 0.0148,
    compression: { mode: 'standard', before: 5200, after: 4300, saved: 900 }
  },
  {
    at: Date.now() - 128_000,
    upstream: 'openai',
    resolvedProvider: 'openai',
    resolvedModel: 'gpt-5',
    requestModel: 'gpt-5',
    model: 'gpt-5',
    protocol: 'openai_chat_completions',
    status: 200,
    latencyMs: 1540,
    attempts: ['openai'],
    tokens: { input: 900, output: 410 },
    cost: 0.0091,
    cache: 'hit',
    cacheSavedTokens: 1310,
    cacheSavedCost: 0.0091
  },
  {
    at: Date.now() - 260_000,
    upstream: 'openrouter',
    resolvedProvider: 'openrouter',
    route: 'fast',
    resolvedModel: 'anthropic/claude-sonnet-4.5',
    requestModel: 'fast',
    model: 'anthropic/claude-sonnet-4.5',
    protocol: 'openai_chat_completions',
    stream: false,
    policyId: 'policy-fast',
    status: 429,
    latencyMs: 233,
    attempts: ['openrouter', 'openai'],
    failures: [{ provider: 'openrouter', status: 429, error: 'rate limited' }],
    error: 'rate limited',
    tokens: null
  }
]

const config: RouterConfig = {
  version: 3,
  token: 'orca-router',
  providers: [
    {
      name: 'anthropic',
      displayName: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      protocols: ['anthropic_messages'],
      models: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-opus-4-1' }, { id: 'claude-haiku-4-5' }],
      keys: [{ id: 'k-anthropic-1', secretKey: 'ANTHROPIC_KEY' }]
    },
    {
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      protocols: ['openai_chat_completions', 'openai_responses'],
      models: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }, { id: 'o4-mini' }],
      keys: [
        { id: 'k-openai-1', secretKey: 'OPENAI_KEY' },
        { id: 'k-openai-2', secretKey: 'OPENAI_KEY_BACKUP' }
      ]
    },
    {
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      protocols: ['openai_chat_completions'],
      models: [],
      keys: []
    }
  ],
  routes: modelRoutes,
  aliases,
  policies,
  defaultFallback: { mode: 'retry', models: [], retryCount: 2 },
  compression: {
    enabled: true,
    mode: 'standard',
    minChars: 2000,
    keepRecentMessages: 4,
    toolResults: true,
    systemPrompt: false
  },
  contextRelay: {
    enabled: true,
    trigger: 'failover',
    maxChars: 24_000,
    keepRecentMessages: 8,
    digestChars: 200
  },
  responseCache: {
    enabled: true,
    mode: 'semantic',
    ttlMs: 300_000,
    maxEntries: 200,
    threshold: 0.95,
    embeddingProvider: 'openai',
    embeddingModel: 'text-embedding-3-small',
    skipTools: true,
    maxTemperature: 0
  },
  migration: [{
    at: Date.now() - 60_000,
    kind: 'global-chain',
    from: 'Global default fallback',
    to: 'default-failover',
    targets: [{ provider: 'openai', model: 'gpt-5' }],
    note: 'No longer applies automatically; point a model name at this route to use it.'
  }],
  clientKeys: clientKeys.map((key) => ({ ...key })),
  agentProfiles
}

const status = {
  running: true,
  host: '127.0.0.1',
  port: 18080,
  providers,
  upstreams: providers,
  policies,
  aliases,
  clientKeys,
  agentProfiles,
  agents,
  logs
}

const usage = {
  window: 'today',
  since: Date.now() - 3_600_000,
  requests: 128,
  successRate: 0.977,
  errors: 3,
  inputTokens: 184_320,
  outputTokens: 62_140,
  totalTokens: 246_460,
  cost: 1.87,
  avgLatencyMs: 940,
  cacheHits: 9,
  cacheSavedTokens: 12_400,
  cacheSavedCost: 0.11,
  compressionSavedChars: 48_200,
  relayEvents: 3,
  byProvider: [
    { provider: 'anthropic', count: 71 },
    { provider: 'openai', count: 52 },
    { provider: 'openrouter', count: 5 }
  ],
  byModel: [
    { model: 'claude-sonnet-4-5', count: 71 },
    { model: 'gpt-5', count: 44 },
    { model: 'gpt-5-mini', count: 8 }
  ],
  totals: {}
}

const keyQuotas = {
  providers: [
    {
      provider: 'openai',
      keys: [
        {
          id: 'k-openai-1',
          secretKey: 'OPENAI_KEY',
          enabled: true,
          status: 'ok',
          fetchedAt: Date.now(),
          errors: [],
          meters: [
            { id: 'rolling-5h', kind: 'quota', label: '5h limit', unit: '%', limit: 100, used: 72, remaining: 28 },
            { id: 'weekly', kind: 'quota', label: 'Weekly limit', unit: '%', limit: 100, used: 31, remaining: 69 }
          ]
        },
        {
          id: 'k-openai-2',
          secretKey: 'OPENAI_KEY_BACKUP',
          enabled: true,
          status: 'ok',
          fetchedAt: Date.now(),
          errors: [],
          meters: [
            { id: 'balance', kind: 'balance', label: 'Balance', unit: 'USD', remaining: 12.5 }
          ]
        }
      ]
    }
  ]
}

const presets = {
  presets: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      capabilities: ['anthropic_messages'],
      defaultModels: ['claude-sonnet-4-5', 'claude-haiku-4-5']
    },
    {
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      capabilities: ['openai_chat_completions', 'openai_responses'],
      defaultModels: ['gpt-5', 'gpt-5-mini']
    }
  ]
}

const populated = {
  settings: { enabled: false },
  requests: {
    'router.status': status,
    'router.config.get': { config },
    'router.usage': usage,
    'router.presets': presets,
    'router.keyUsage': keyQuotas
  }
}

export default defineCheck({
  empty: {
    settings: { enabled: false },
    persisted: { plugin: { tab: 'overview' } }
  },
  overview: {
    ...populated,
    persisted: { plugin: { tab: 'overview' } }
  },
  providers: {
    ...populated,
    persisted: { plugin: { tab: 'providers' } }
  },
  routing: {
    ...populated,
    persisted: { plugin: { tab: 'routing' } }
  },
  'settings': {
    ...populated,
    persisted: { plugin: { tab: 'settings' } }
  },
  profiles: {
    ...populated,
    persisted: { plugin: { tab: 'profiles' } }
  },
  logs: {
    ...populated,
    persisted: { plugin: { tab: 'logs' } }
  }
})
