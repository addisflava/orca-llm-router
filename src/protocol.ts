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
        policies: RequestPolicy[]
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
        cacheHits?: number
        cacheSavedTokens?: number
        cacheSavedCost?: number
        compressionSavedChars?: number
        relayEvents?: number
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
        value?: string
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
    'router.discoverAllModels': {
      input: Record<string, never>
      output: { ok: true; providers: { provider: string; models: string[]; error?: string }[] }
    }
    'router.testUsage': {
      input: { provider: string; secretKey?: string }
      output: { provider: string; status: string; meters: unknown[]; errors: { message: string }[] }
    }
    'router.keyUsage': {
      input: { provider?: string; refresh?: boolean }
      output: { providers: ProviderKeyUsageReport[] }
    }
    'router.usageProbe': {
      input: { provider: string }
      output: {
        provider: string
        ok: boolean
        reason?: 'no-keys' | 'not-found' | 'probe-failed'
        endpoint?: string
        connector?: UsageConnector
        meters?: ProviderUsageMeter[]
        errors?: { message: string }[]
        secretKey?: string
        tried?: { url: string; status: number | string }[]
      }
    }
    'router.provider.usage': {
      input: { provider: string; usageFetch?: UsageFetchConfig | null }
      output: { ok: true }
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

export interface KeyUsageMeter {
  field: string
  kind: 'requests' | 'tokens' | 'images'
  windowMs: number
  used: number
  limit: number
  remaining: number
  utilization: number
}

export interface ProviderUsageMeter {
  id?: string
  kind?: string
  label?: string
  unit?: string
  window?: string
  limit?: number | null
  used?: number | null
  remaining?: number | null
  resetAt?: string
}

export interface KeyProviderUsage {
  id?: string
  secretKey: string
  enabled: boolean
  status: string
  meters: ProviderUsageMeter[]
  errors: { message: string }[]
  fetchedAt: number
}

export interface ProviderKeyUsageReport {
  provider: string
  keys: KeyProviderUsage[]
  /** Why a provider produced no per-key reports. */
  reason?: 'no-endpoint' | 'no-keys' | 'error'
}

export interface ProviderKeyUsage {
  id?: string
  secretKey: string
  enabled: boolean
  cooldownUntil?: number
  state: 'ready' | 'cooling' | 'limited' | 'disabled'
  requests: { minute: number; hour: number; day: number }
  tokens: { minute: number; hour: number; day: number }
  images: { minute: number; hour: number; day: number }
  meters: KeyUsageMeter[]
  utilization: number
}

export interface ProviderHealthView {
  state: 'healthy' | 'degraded' | 'stale' | 'open' | 'unknown'
  latencyMs: number | null
  samples: number
  failures: number
  lastSuccessAt?: number
  lastFailureAt?: number
}

export interface ProviderView {
  name: string
  displayName?: string
  baseUrl: string
  protocols: string[]
  models?: string[]
  keyCount: number
  keyUsage?: ProviderKeyUsage[]
  health?: ProviderHealthView
  /** True when a usage connector is configured (or matched from a preset). */
  usageSource?: boolean
}

export interface PolicyCondition {
  source: 'request.body' | 'request.header' | 'request.headers'
  field: string
  operator: string
  value: string
}

export interface PolicyRewrite {
  key: string
  operation?: 'set' | 'delete' | 'array-append' | 'array-prepend' | 'array-remove' | 'array-replace'
  value?: unknown
  match?: unknown
}

export interface FallbackPolicy {
  mode: 'off' | 'retry' | 'model-chain' | 'provider-chain'
  models?: string[]
  retryCount?: number
}

/**
 * One provider/model target in a route. An empty provider keeps the
 * legacy alias form (a bare model id or alias), resolved by the worker.
 */
export interface ModelTarget {
  provider: string
  model: string
}

/**
 * A route is a model name agents send, backed by one or more
 * provider/model targets. `fastest` orders the targets by measured health and
 * speed; `ordered` uses the listed order. This is the only failover unit.
 */
export interface ModelRoute {
  name: string
  targets: ModelTarget[]
  strategy?: 'ordered' | 'fastest'
  enabled?: boolean
  /** Attempts per target (plus the first). Defaults to the router retry count. */
  retries?: number
}

/** One legacy custom chain auto-migrated into a route. */
export interface MigrationEntry {
  at: number
  kind: 'rule-chain' | 'global-chain'
  from: string
  to: string
  targets: ModelTarget[]
  note?: string
}

/**
 * A global policy matches a request and rewrites it, points it at a model, or
 * attaches a fallback chain. Policies run top to bottom and the first match
 * wins.
 */
export interface RequestPolicy {
  id?: string
  name: string
  enabled?: boolean
  condition?: PolicyCondition | null
  rewrites?: PolicyRewrite[]
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

export interface SchedulerConfig {
  strategy?: 'priority-weighted' | 'round-robin'
  priorityTiers?: boolean
  utilizationAware?: boolean
  utilizationThreshold?: number
  allKeysExhausted?: 'error' | 'overflow'
  exhaustedStatus?: 420 | 429
  cacheAffinity?: boolean
  cacheAffinityTtlMs?: number
}

export interface CircuitBreakerConfig {
  enabled?: boolean
  failureThreshold?: number
  cooldownMs?: number
}

/**
 * Tuning for the per-route health ranking and its latency samples. A `fastest`
 * route ranks by measured health and speed; an `ordered` route does not.
 */
export interface ProviderHealthConfig {
  /** EWMA weight for a new latency sample, 0.1 (slow) to 0.9 (fast). */
  smoothing?: number
  /** A provider with no successful sample for this long is treated as stale. */
  staleMs?: number
}

export interface RouterConfig {
  version?: number
  token: string
  providers: ProviderConfig[]
  /** Routes (the failover unit). Model names agents send map to these. */
  routes: ModelRoute[]
  aliases: Record<string, string>
  /** Global policies. Legacy `routes` (v2) is accepted at runtime and normalized here. */
  policies: RequestPolicy[]
  defaultModel?: string
  /** Legacy global policy. Kept for import compatibility; no longer drives failover. */
  defaultFallback?: FallbackPolicy
  clientKeys: { id: string; name: string; secretKey?: string; expiresAt?: string; limits?: Record<string, unknown>; enabled?: boolean }[]
  agentProfiles: AgentProfile[]
  scheduler?: SchedulerConfig
  circuitBreaker?: CircuitBreakerConfig
  providerHealth?: ProviderHealthConfig
  /** Opt-in prompt compression. Off by default. */
  compression?: CompressionConfig
  /** Opt-in failover handoff digest. Off by default. */
  contextRelay?: ContextRelayConfig
  /** Opt-in local response cache, exact or embedding-backed semantic. */
  responseCache?: ResponseCacheConfig
  /** Legacy custom chains converted into routes. */
  migration?: MigrationEntry[]
  timeoutMs?: number
  retries?: number
  baseDelayMs?: number
  logBodyCapture?: 'all' | 'errors' | 'none'
  exposeRoutingHeaders?: boolean
  allowUnauthenticatedRemote?: boolean
}

export interface CompressionConfig {
  enabled?: boolean
  mode?: 'lite' | 'standard' | 'aggressive'
  minChars?: number
  keepRecentMessages?: number
  toolResults?: boolean
  systemPrompt?: boolean
  toolMaxChars?: number
  messageMaxChars?: number
}

export interface ContextRelayConfig {
  enabled?: boolean
  trigger?: 'failover' | 'always' | 'both'
  maxChars?: number
  keepRecentMessages?: number
  digestChars?: number
}

export interface ResponseCacheConfig {
  enabled?: boolean
  mode?: 'exact' | 'semantic'
  ttlMs?: number
  maxEntries?: number
  threshold?: number
  embeddingProvider?: string
  embeddingModel?: string
  skipTools?: boolean
  maxTemperature?: number
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
  usageFetch?: UsageFetchConfig
}

/** One meter read from a provider usage response. Expressions are JSON paths (`$.a.b`). */
export interface UsageMeterMapping {
  id?: string
  kind?: string
  label?: string
  limit?: number | string
  used?: number | string
  remaining?: number | string
  unit?: string
  window?: string
  resetAt?: string
}

/** An HTTP-JSON usage connector, the same shape imported from CCR and OmniRoute. */
export interface UsageConnector {
  id?: string
  type?: string
  endpoint: string
  auth?: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
  mapping?: { meters?: UsageMeterMapping[] }
}

export interface UsageFetchConfig {
  enabled?: boolean
  connectors?: UsageConnector[]
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
  failures?: { provider: string; status?: number; error?: string; code?: string }[]
  delaysMs?: number[]
  bytes?: number
  tokens?: { input: number; output: number; cache?: number } | null
  cost?: number | null
  error?: string
  compression?: { mode: string; before: number; after: number; saved: number } | null
  relay?: { before: number; after: number; relayed: number } | null
  cache?: 'hit' | 'semantic-hit' | 'miss' | 'bypass' | null
  cacheSavedTokens?: number
  cacheSavedCost?: number
}
