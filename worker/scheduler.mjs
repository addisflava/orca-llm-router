// Credential scheduling for one provider's key pool.
//
// The sidecar computes which keys are currently eligible (enabled, not
// cooling, within their limits); this module decides which eligible key gets
// the next request. Keeping the choice pure makes weighted rotation and
// priority spillover deterministic and testable without an HTTP server.

export const DEFAULT_SCHEDULER = Object.freeze({
  // "priority-weighted" uses smooth weighted round-robin within the active
  // priority tier. "round-robin" is kept as an explicit flat fallback.
  strategy: 'priority-weighted',
  // A lower priority number is preferred. Spill to the next tier only when
  // every key in the preferred tier is unavailable.
  priorityTiers: true,
  // Skip keys that are close to a configured limit while another key has
  // headroom. This is a preference, not a hard exclusion.
  utilizationAware: true,
  utilizationThreshold: 0.8,
  // What to do when every enabled key is cooling or over its configured
  // limit. "error" returns the configured exhausted status.
  allKeysExhausted: 'error',
  exhaustedStatus: 420,
  // Reuse the credential that served a session or prompt before, so prompt
  // caches stay warm. The sidecar supplies a stable affinity token.
  cacheAffinity: true,
  cacheAffinityTtlMs: 600_000
})

export const DEFAULT_CIRCUIT_BREAKER = Object.freeze({
  enabled: true,
  failureThreshold: 3,
  cooldownMs: 60_000
})

// Provider-level health ranking. Unlike the key scheduler this is not about
// distributing load: it orders a model's failover chain so the fastest healthy
// provider is tried first, and a session stays on it while its cache is warm.
export const DEFAULT_PROVIDER_HEALTH = Object.freeze({
  enabled: false,
  // Exponential moving average weight for a new latency sample.
  smoothing: 0.3,
  // A provider with no successful sample for this long loses its spot.
  staleMs: 300_000
})

const MAX_WEIGHT = 100

export function normalizeScheduler(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const threshold = Number(source.utilizationThreshold)
  const status = Number(source.exhaustedStatus)
  const affinityTtl = Number(source.cacheAffinityTtlMs)
  return {
    strategy: source.strategy === 'round-robin' ? 'round-robin' : 'priority-weighted',
    priorityTiers: source.priorityTiers !== false,
    utilizationAware: source.utilizationAware !== false,
    utilizationThreshold: Number.isFinite(threshold)
      ? Math.min(1, Math.max(0, threshold))
      : DEFAULT_SCHEDULER.utilizationThreshold,
    allKeysExhausted: source.allKeysExhausted === 'overflow' ? 'overflow' : 'error',
    exhaustedStatus: status === 429 ? 429 : 420,
    cacheAffinity: source.cacheAffinity !== false,
    cacheAffinityTtlMs: Number.isFinite(affinityTtl)
      ? Math.max(10_000, Math.min(86_400_000, affinityTtl))
      : DEFAULT_SCHEDULER.cacheAffinityTtlMs
  }
}

export function normalizeCircuitBreaker(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const failureThreshold = Number(source.failureThreshold)
  const cooldownMs = Number(source.cooldownMs)
  return {
    enabled: source.enabled !== false,
    failureThreshold: Number.isFinite(failureThreshold)
      ? Math.max(1, Math.min(100, Math.floor(failureThreshold)))
      : DEFAULT_CIRCUIT_BREAKER.failureThreshold,
    cooldownMs: Number.isFinite(cooldownMs)
      ? Math.max(1000, Math.min(3_600_000, Math.floor(cooldownMs)))
      : DEFAULT_CIRCUIT_BREAKER.cooldownMs
  }
}

export function normalizeProviderHealth(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const smoothing = Number(source.smoothing)
  const staleMs = Number(source.staleMs)
  return {
    enabled: source.enabled === true,
    smoothing: Number.isFinite(smoothing) ? Math.min(0.9, Math.max(0.1, smoothing)) : DEFAULT_PROVIDER_HEALTH.smoothing,
    staleMs: Number.isFinite(staleMs) ? Math.max(30_000, Math.min(3_600_000, staleMs)) : DEFAULT_PROVIDER_HEALTH.staleMs
  }
}

// Order a failover chain by health and speed. Targets stay failover-ordered;
// this never splits a single request across providers.
//
// Ranking rules, in order:
//   1. Healthy before unhealthy (open circuit, failed probe streak, or stale).
//   2. Lowest measured time-to-first-byte first. Unknown providers get the
//      mean of the known latencies so they are tried before a known-slow one.
//   3. Original chain order breaks ties, keeping behavior deterministic.
//
// A live session is pinned to its provider for the cache-affinity TTL, so a
// latency wobble does not move a warm prompt cache to another provider.
export function rankProviderTargets({
  targets = [],
  health = new Map(),
  circuits = new Map(),
  affinity = null,
  config = {},
  // Ranking is opt-in: a `fastest` route passes true, an `ordered` route
  // passes false. There is no global provider-health toggle.
  enabled,
  timestamp = Date.now()
} = {}) {
  if (targets.length < 2) return [...targets]
  // Ranking is opt-in per route; there is no global toggle.
  if (enabled !== true) return [...targets]
  const healthOptions = normalizeProviderHealth(config.providerHealth)
  const circuitRules = normalizeCircuitBreaker(config.circuitBreaker)
  const scheduler = normalizeScheduler(config.scheduler)

  const latencyOf = (name) => {
    const entry = health.get(name)
    return entry && entry.samples > 0 && Number.isFinite(entry.latencyMs) ? entry.latencyMs : null
  }
  const known = targets.map((target) => latencyOf(target.provider.name)).filter((value) => value != null)
  const prior = known.length ? known.reduce((total, value) => total + value, 0) / known.length : 1000

  const isHealthy = (name) => {
    const circuit = circuits.get(name)
    if (circuit?.state === 'open' && circuit.openUntil > timestamp) return false
    const entry = health.get(name)
    if (!entry) return true
    const failedSinceSuccess = entry.lastFailureAt && entry.lastFailureAt > (entry.lastSuccessAt ?? 0)
    if (failedSinceSuccess && entry.failures >= circuitRules.failureThreshold) return false
    if (entry.samples > 0 && entry.lastSuccessAt && timestamp - entry.lastSuccessAt > healthOptions.staleMs) return false
    return true
  }

  const ranked = targets.map((target, index) => {
    const latency = latencyOf(target.provider.name)
    return {
      target,
      index,
      healthy: isHealthy(target.provider.name),
      latency: latency ?? prior
    }
  })
  ranked.sort((a, b) => {
    if (a.healthy !== b.healthy) return a.healthy ? -1 : 1
    if (Math.abs(a.latency - b.latency) > 1e-6) return a.latency - b.latency
    return a.index - b.index
  })

  // Keep a session on the provider that already served it so prompt caches stay
  // warm, as long as that provider is still healthy and in this chain.
  if (affinity && scheduler.cacheAffinity && timestamp - affinity.at <= scheduler.cacheAffinityTtlMs) {
    const pinned = ranked.findIndex((item) => item.target.provider.name === affinity.provider && item.healthy)
    if (pinned > 0) ranked.unshift(ranked.splice(pinned, 1)[0])
  }
  return ranked.map((item) => item.target)
}

export function createSchedulerState() {
  return {
    cursors: new Map(), // provider name -> flat round-robin cursor
    weights: new Map() // provider name -> Map(credential identity -> smooth weight)
  }
}

// Parse Retry-After as either delta-seconds or an HTTP date. Used both for the
// retry sleep and for how long a credential stays cooling.
export function retryAfterMs(value, timestamp = Date.now()) {
  if (value == null || value === '') return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000)
  const at = Date.parse(String(value))
  return Number.isFinite(at) ? Math.max(0, at - timestamp) : 0
}

function clampWeight(value) {
  const weight = Math.floor(Number(value ?? 1))
  return Number.isFinite(weight) ? Math.min(MAX_WEIGHT, Math.max(1, weight)) : 1
}

function preferUtilization(pool, threshold) {
  if (!pool.length) return pool
  // If every key is already above the threshold there is no headroom to
  // prefer, so leave the full pool intact and let weighted rotation decide.
  const withHeadroom = pool.filter((item) => item.utilization < threshold)
  return withHeadroom.length ? withHeadroom : pool
}

export function selectScheduledKey({ providerName, candidates, scheduler, state }) {
  const options = normalizeScheduler(scheduler)
  if (!candidates?.length) return null
  const normalized = candidates.map((candidate, index) => ({
    candidate,
    index,
    id: String(candidate.id ?? candidate.key?.secretKey ?? candidate.key?.id ?? index),
    priority: Number(candidate.priority ?? 0),
    weight: clampWeight(candidate.weight),
    utilization: Number.isFinite(Number(candidate.utilization))
      ? Math.max(0, Number(candidate.utilization))
      : 0
  }))

  let pool = normalized
  if (options.priorityTiers) {
    const priorities = [...new Set(pool.map((item) => item.priority))].sort((a, b) => a - b)
    let priority = priorities[0]
    // Spill to a lower tier when the preferred tier has no headroom left but
    // another tier does. If every tier is near its limits, keep the preferred
    // tier: using exhausted higher-priority keys is still better than making
    // the fallback tier absorb traffic it was not meant to.
    if (options.utilizationAware) {
      const withHeadroom = priorities.find((tier) => pool.some(
        (item) => item.priority === tier && item.utilization < options.utilizationThreshold
      ))
      if (withHeadroom !== undefined) priority = withHeadroom
    }
    pool = pool.filter((item) => item.priority === priority)
  }
  if (options.utilizationAware) pool = preferUtilization(pool, options.utilizationThreshold)

  if (options.strategy === 'round-robin') {
    const cursor = state.cursors.get(providerName) ?? 0
    const chosen = pool[cursor % pool.length]
    state.cursors.set(providerName, (cursor + 1) % pool.length)
    return chosen.candidate
  }

  let weights = state.weights.get(providerName)
  if (!weights) {
    weights = new Map()
    state.weights.set(providerName, weights)
  }
  // A provider can accumulate entries after keys are removed. Keep the map
  // bounded without disturbing the smooth state of the current pool.
  if (weights.size > 512) {
    for (const id of weights.keys()) if (!pool.some((item) => item.id === id)) weights.delete(id)
  }

  const total = pool.reduce((sum, item) => sum + item.weight, 0)
  let chosen = null
  let bestScore = -Infinity
  for (const item of pool) {
    const score = (weights.get(item.id) ?? 0) + item.weight
    weights.set(item.id, score)
    const better = !chosen
      || score > bestScore + 1e-9
      || (Math.abs(score - bestScore) <= 1e-9 && (
        item.utilization < chosen.utilization - 1e-9
        || (Math.abs(item.utilization - chosen.utilization) <= 1e-9 && item.index < chosen.index)
      ))
    if (better) {
      chosen = item
      bestScore = score
    }
  }
  weights.set(chosen.id, (weights.get(chosen.id) ?? 0) - total)
  return chosen.candidate
}
