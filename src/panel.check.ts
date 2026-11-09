// Panel states worth looking at: one scenario per tab, plus the empty
// first-run state. `orca plugin check .` renders each of these without Orca.
import { defineCheck } from 'orca/testing'
import type { AgentProfile, AgentRoute, LogEntry, ProviderView, RouterConfig, RouteRule } from './protocol'

const providers: ProviderView[] = [
  {
    name: 'anthropic',
    displayName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    protocols: ['anthropic_messages'],
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    keyCount: 1
  },
  {
    name: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    protocols: ['openai_chat_completions', 'openai_responses'],
    models: ['gpt-5', 'gpt-5-mini', 'o4-mini'],
    keyCount: 2
  },
  {
    name: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocols: ['openai_chat_completions'],
    models: [],
    keyCount: 0
  }
]

const routes: RouteRule[] = [
  {
    id: 'rule-claude',
    name: 'Claude requests',
    enabled: true,
    condition: { source: 'request.body', field: 'model', operator: 'starts-with', value: 'claude-' },
    rewrites: [{ key: 'request.body.model', operation: 'set', value: 'anthropic/claude-sonnet-4-5' }],
    model: 'anthropic/claude-sonnet-4-5',
    fallback: { mode: 'model-chain', models: ['openai/gpt-5', 'openrouter/anthropic/claude-sonnet-4.5'] }
  },
  {
    id: 'rule-fast',
    name: 'Fast tier',
    enabled: false,
    condition: { source: 'request.body', field: 'model', operator: 'equals', value: 'fast' },
    model: 'openai/gpt-5-mini',
    fallback: { mode: 'retry', retryCount: 2 }
  }
]

const aliases = { fast: 'openai/gpt-5-mini', smart: 'anthropic/claude-opus-4-1' }

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
    cost: 0.0148
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
    cost: 0.0091
  },
  {
    at: Date.now() - 260_000,
    upstream: 'openrouter',
    resolvedProvider: 'openrouter',
    resolvedModel: 'anthropic/claude-sonnet-4.5',
    requestModel: 'fast',
    model: 'anthropic/claude-sonnet-4.5',
    protocol: 'openai_chat_completions',
    status: 429,
    latencyMs: 233,
    attempts: ['openrouter', 'openai'],
    failures: [{ provider: 'openrouter', status: 429, error: 'rate limited' }],
    error: 'rate limited',
    tokens: null
  }
]

const config: RouterConfig = {
  version: 2,
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
  routes,
  aliases,
  defaultProvider: 'anthropic',
  defaultFallback: { mode: 'model-chain', models: ['anthropic/claude-sonnet-4-5', 'openai/gpt-5'] },
  clientKeys: clientKeys.map((key) => ({ ...key })),
  agentProfiles
}

const status = {
  running: true,
  host: '127.0.0.1',
  port: 18080,
  providers,
  upstreams: providers,
  routes,
  rules: routes,
  defaultProvider: 'anthropic',
  defaultUpstream: 'anthropic',
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
    'router.presets': presets
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
    persisted: { plugin: { tab: 'routes' } }
  },
  profiles: {
    ...populated,
    persisted: { plugin: { tab: 'profiles' } }
  },
  keys: {
    ...populated,
    persisted: { plugin: { tab: 'keys' } }
  },
  logs: {
    ...populated,
    persisted: { plugin: { tab: 'logs' } }
  },
  import: {
    ...populated,
    persisted: { plugin: { tab: 'import' } }
  }
})
