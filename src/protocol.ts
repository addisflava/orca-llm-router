// The panel <-> worker contract, declared once: src/panel.tsx reads it and
// worker/main.mjs answers it. Keep request/event names in sync with both sides.
export {}

declare module 'orca' {
  interface PluginRequests {
    'router.status': {
      input: Record<string, never>
      output: {
        running: boolean
        host: string
        port: number
        providers: ProviderView[]
        upstreams: ProviderView[]
        routes: RouteRule[]
        rules: RouteRule[]
        defaultProvider: string
        defaultUpstream: string
        aliases: Record<string, string>
        clientKeys: { id: string; name: string; expiresAt?: string; limits?: Record<string, unknown>; enabled: boolean }[]
        agentProfiles: AgentProfile[]
        agents: AgentRoute[]
        logs: LogEntry[]
      }
    }
    'router.start': { input: Record<string, never>; output: { running: boolean; port: number } }
    'router.stop': { input: Record<string, never>; output: { running: boolean } }
    'router.restart': { input: Record<string, never>; output: { running: boolean; port: number } }
    'router.test': {
      input: Record<string, never>
      output: { results: { provider: string; upstream?: string; ok: boolean; status: number | null; latencyMs: number | null; message?: string }[] }
    }
    'router.testProvider': {
      input: { provider: string }
      output: { results: { provider: string; ok: boolean; status: number | null; latencyMs: number | null; message?: string }[] }
    }
    'router.clearLogs': { input: Record<string, never>; output: { ok: true } }
    'router.usage': {
      input: { window?: 'today' | '24h' | '7d' | '30d' }
      output: {
        window: string
        since: number
        requests: number
        successRate: number
        errors: number
        inputTokens: number
        outputTokens: number
        totalTokens: number
        cost: number
        avgLatencyMs: number
        byProvider: { provider: string; count: number }[]
        byModel: { model: string; count: number }[]
        totals: Record<string, unknown>
      }
    }
    'router.presets': { input: Record<string, never>; output: { presets: ProviderPreset[] } }
    'router.config.get': { input: Record<string, never>; output: { config: RouterConfig } }
    'router.config.save': { input: { config: RouterConfig }; output: { ok: true } }
    'router.config.export': { input: Record<string, never>; output: { config: RouterConfig; json: string; file: string } }
    'router.config.detectLocal': {
      input: Record<string, never>
      output: {
        ccr: DetectedRouterInfo | null
        omniroute: DetectedRouterInfo | null
      }
    }
    'router.config.importLocal': {
      input: { source: 'ccr' | 'omni' | 'both'; path?: string; merge?: boolean; encryptionKey?: string }
      output: { ok: true; importedFrom: string; providers: number; aliases: number; merged: boolean }
    }
    'router.config.import': {
      input: { json?: string; path?: string; merge?: boolean; encryptionKey?: string }
      output: { ok: true; importedFrom: string; providers: number; aliases: number; merged: boolean }
    }
    'router.provider.addPreset': {
      input: { presetId: string; name?: string; secretKey?: string; value?: string }
      output: { ok: true; provider: string }
    }
    'router.key.add': {
      input: {
        provider: string
        secretKey: string
        id?: string
        value: string
        priority?: number
        weight?: number
        limits?: Record<string, unknown>
      }
      output: { ok: true; id?: string; secretKey?: string }
    }
    'router.key.update': {
      input: {
        provider: string
        secretKey: string
        id?: string
        enabled?: boolean
        priority?: number
        weight?: number
        limits?: Record<string, unknown>
      }
      output: { ok: true }
    }
    'router.key.remove': { input: { provider: string; secretKey: string; id?: string }; output: { ok: true } }
    'router.clientKeys.create': {
      input: { name?: string; expiresAt?: string; limits?: Record<string, unknown> }
      output: { ok: true; id: string; key: string; secretKey: string }
    }
    'router.clientKeys.revoke': { input: { id: string }; output: { ok: true } }
    'router.discoverModels': {
      input: { provider?: string; baseUrl?: string; protocols?: string[]; secretKey?: string; value?: string }
      output: { ok: true; models: string[]; provider: string | null }
    }
    'router.testUsage': {
      input: { provider: string }
      output: { provider: string; status: string; meters: unknown[]; errors: { message: string }[] }
    }
  }
  interface PluginPanelEvents {
    'router.statusChanged': { running: boolean; port: number }
    'router.log': { entry: LogEntry }
  }
}

export interface DetectedRouterInfo {
  name: string
  path: string
  format: string
  providers?: number
  keys?: number
  profiles?: number
  rules?: number
  connections?: number
  nodes?: number
  combos?: number
  aliases?: number
  error?: string
}

export interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  capabilities: string[]
  defaultModels: string[]
  websiteUrl?: string
  usage?: { endpoint: string; auth: string; mapping: { meters: unknown[] } }
}

export interface ProviderView {
  name: string
  displayName?: string
  baseUrl: string
  protocols: string[]
  models?: string[]
  keyCount: number
}

export interface RouteCondition {
  source: 'request.body' | 'request.header' | 'request.headers'
  field: string
  operator: string
  value: string
}

export interface RouteRewrite {
  key: string
  operation?: 'set' | 'delete' | 'array-append' | 'array-prepend' | 'array-remove' | 'array-replace'
  value?: unknown
  match?: unknown
}

export interface FallbackPolicy {
  mode: 'off' | 'retry' | 'model-chain'
  models?: string[]
  retryCount?: number
}

export interface RouteRule {
  id?: string
  name: string
  enabled?: boolean
  condition?: RouteCondition | null
  rewrites?: RouteRewrite[]
  model?: string
  fallback?: FallbackPolicy
  // Legacy fields accepted on import.
  match?: string
  upstream?: string
}

export interface AgentProfile {
  agent: string
  name: string
  model: string
  smallFastModel?: string
  /** Codex only: applied as `model_reasoning_effort` for that launch. */
  reasoningEffort?: 'low' | 'medium' | 'high' | string
  enabled?: boolean
  scope?: 'router-only' | 'system-default' | 'custom'
  env?: Record<string, string>
  providerId?: string
  providerName?: string
}

/** One row in the Agents tab: an Orca agent and whether it routes locally. */
export interface AgentRoute {
  agent: string
  name: string
  installed: boolean
  enabled: boolean
}

export interface RouterConfig {
  version?: number
  token: string
  providers: ProviderConfig[]
  routes: RouteRule[]
  aliases: Record<string, string>
  defaultProvider?: string
  defaultModel?: string
  defaultFallback: FallbackPolicy
  clientKeys: { id: string; name: string; secretKey?: string; expiresAt?: string; limits?: Record<string, unknown>; enabled?: boolean }[]
  agentProfiles: AgentProfile[]
  timeoutMs?: number
  retries?: number
  baseDelayMs?: number
  logBodyCapture?: 'all' | 'errors' | 'none'
  exposeRoutingHeaders?: boolean
  allowUnauthenticatedRemote?: boolean
}

export interface ProviderConfig {
  name: string
  displayName?: string
  baseUrl: string
  endpoints?: { baseUrl: string; protocols: string[] }[]
  protocols: string[]
  models: { id: string; description?: string; pricing?: unknown }[]
  keys: { id: string; secretKey: string; enabled?: boolean; priority?: number; weight?: number; limits?: Record<string, unknown> }[]
  enabled?: boolean
  pricing?: Record<string, unknown>
  usageFetch?: { enabled?: boolean; connectors?: unknown[] }
}

export interface LogEntry {
  at: number
  upstream: string | null
  resolvedProvider?: string | null
  credential?: string | null
  requestModel?: string
  resolvedModel?: string
  model: string
  protocol: string
  status: number
  latencyMs: number | null
  attempts: string[]
  failures?: { provider: string; status?: number; error?: string }[]
  delaysMs?: number[]
  bytes?: number
  tokens?: { input: number; output: number; cache?: number } | null
  cost?: number | null
  error?: string
}
