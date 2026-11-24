// Pure cost estimation for routed requests. No Node built-ins, no network, no
// Orca imports. Prices come from the generated models.dev snapshot; an explicit
// provider.pricing entry always wins. Unpriced models return null — we never
// invent a cost.

import { GENERATED_AT, PRICE_ENTRIES } from './price-data.mjs'
import { MODEL_PROVIDERS, ROUTER_TO_MODELS_DEV } from './price-providers.mjs'

export const catalogVersion = GENERATED_AT

const num = (value) => Number.isFinite(value) ? value : 0
const isRate = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0

// 'gpt-4o' stays as-is; 'anthropic/claude-sonnet-4-5-20250929' becomes
// 'claude-sonnet-4-5', matching the models.dev id.
export function normalizeModelId(model) {
  let id = String(model ?? '').trim().toLowerCase()
  if (!id) return ''
  const slash = id.lastIndexOf('/')
  if (slash >= 0) id = id.slice(slash + 1)
  id = id.replace(/@\d{8}$/, '').replace(/\[1m\]$/, '').replace(/-\d+:\d+$/, '')
  id = id.replace(/-\d{8}$/, '').replace(/-\d{4}$/, '')
  return id
}

function canonicalProviderFor(model) {
  const id = normalizeModelId(model)
  for (const [pattern, provider] of MODEL_PROVIDERS) if (pattern.test(id)) return provider
  return null
}

/** Build lookup indexes. Entries are the compact objects from price-data.mjs. */
export function createPriceCatalog(entries = PRICE_ENTRIES) {
  const byKey = new Map()
  const byId = new Map()
  const push = (map, key, entry) => {
    const list = map.get(key)
    if (list) list.push(entry)
    else map.set(key, [entry])
  }
  for (const entry of entries) {
    const id = String(entry.id ?? '').toLowerCase()
    const norm = normalizeModelId(entry.id)
    for (const key of [`${entry.provider}/${id}`, `${entry.provider}/${norm}`]) {
      if (!byKey.has(key)) byKey.set(key, entry)
    }
    for (const key of [id, norm]) {
      if (!key) continue
      const list = byId.get(key)
      if (!list?.some((candidate) => candidate.provider === entry.provider && candidate.id === id)) push(byId, key, entry)
    }
  }
  return { byKey, byId, version: GENERATED_AT }
}

export const DEFAULT_CATALOG = createPriceCatalog()

/** Find the price entry for a routed provider/model pair. Pure. */
export function resolvePriceEntry(provider, model, catalog = DEFAULT_CATALOG) {
  const id = String(model ?? '').trim().toLowerCase()
  const norm = normalizeModelId(model)
  if (!id && !norm) return null
  const providerId = ROUTER_TO_MODELS_DEV[provider] ?? provider
  const canonical = canonicalProviderFor(model)
  const keys = [
    providerId && `${providerId}/${id}`,
    providerId && `${providerId}/${norm}`,
    canonical && `${canonical}/${id}`,
    canonical && `${canonical}/${norm}`
  ].filter(Boolean)
  for (const key of keys) {
    const entry = catalog.byKey.get(key)
    if (entry) return entry
  }
  const candidates = [...new Set([...(catalog.byId.get(id) ?? []), ...(catalog.byId.get(norm) ?? [])])]
  if (!candidates.length) return null
  if (canonical) {
    const own = candidates.find((entry) => entry.provider === canonical)
    if (own) return own
  }
  return candidates[0]
}

function ratesFor(entry, promptTokens) {
  let rates = entry
  for (const tier of entry.tiers ?? []) {
    if (tier.size <= promptTokens && (!rates.size || tier.size > rates.size)) rates = tier
  }
  return rates
}

/** Cost one request from a resolved catalog entry. Returns null if unpriced. */
export function entryCostUsd(entry, tokens = {}) {
  if (!entry) return null
  const input = num(tokens.input)
  const output = num(tokens.output)
  const cacheRead = num(tokens.cacheRead)
  const cacheWrite = num(tokens.cacheWrite)
  const write1h = Math.min(cacheWrite, num(tokens.cacheWrite1h))
  const write5m = cacheWrite - write1h
  const reasoning = num(tokens.reasoning)
  const rates = ratesFor(entry, input + cacheRead + cacheWrite)
  let usd = 0
  const add = (count, rate) => {
    if (!count) return true
    if (!isRate(rate)) return false
    usd += (count * rate) / 1e6
    return true
  }
  if (!add(input, rates.input) || !add(output, rates.output) || !add(cacheRead, rates.cacheRead)) return null
  // Anthropic bills 5-minute and 1-hour writes apart: 5m uses the listed write
  // rate, 1h costs 2x the (tier's) base input rate. Every other provider has
  // one write rate and counts both kinds together.
  if (entry.provider === 'anthropic' && write1h > 0) {
    const oneHour = isRate(rates.input) ? rates.input * 2 : null
    if (!add(write5m, rates.cacheWrite) || !add(write1h, oneHour)) return null
  } else if (!add(write5m + write1h, rates.cacheWrite)) {
    return null
  }
  if (reasoning > 0 && !add(reasoning, rates.reasoning ?? rates.output)) return null
  return usd
}

/** Cost a request against the catalog. Returns null when the model is unknown. */
export function estimateCostUsd({ provider, model, ...tokens }, catalog = DEFAULT_CATALOG) {
  const entry = resolvePriceEntry(provider, model, catalog)
  return entry ? entryCostUsd(entry, tokens) : null
}

const OVERRIDE_RATES = {
  input: 'inputUsdPerMillionTokens',
  output: 'outputUsdPerMillionTokens',
  cacheRead: 'cacheReadUsdPerMillionTokens',
  cacheWrite: 'cacheWriteUsdPerMillionTokens',
  cacheWrite1h: 'cacheWrite1hUsdPerMillionTokens',
  reasoning: 'reasoningUsdPerMillionTokens'
}

function costFromOverride(pricing, tokens) {
  if (!pricing || typeof pricing !== 'object') return null
  // A rate the operator did not configure is treated as zero, matching the
  // previous input/output-only behaviour instead of hiding a formerly priced
  // request behind a missing cache rate.
  const entry = { provider: 'custom' }
  for (const field of Object.keys(OVERRIDE_RATES)) entry[field] = 0
  let found = false
  for (const [field, key] of Object.entries(OVERRIDE_RATES)) {
    if (!isRate(pricing[key])) continue
    entry[field] = pricing[key]
    found = true
  }
  if (!found) return null
  return entryCostUsd(entry, tokens)
}

/**
 * Quote one request. `pricing` is the provider's own pricing object and wins
 * over the catalog. Returns { usd, source: 'override' | 'catalog' | null }.
 */
export function quoteCost({ pricing, provider, model, tokens = {} }, catalog = DEFAULT_CATALOG) {
  // An explicit operator override keeps its historical input/output-only
  // behaviour, so we do not change what those users are charged.
  const override = costFromOverride(pricing, tokens)
  if (override !== null) return { usd: override, source: 'override' }
  // OpenAI, Responses and Gemini report prompt_tokens with cached tokens
  // included; Anthropic's input_tokens is already post-breakpoint. Normalize
  // to uncached input before catalog pricing, but keep the log counters intact.
  const effective = tokens.inputIncludesCache
    ? { ...tokens, input: Math.max(0, num(tokens.input) - num(tokens.cacheRead) - num(tokens.cacheWrite)) }
    : tokens
  const usd = estimateCostUsd({ provider, model, ...effective }, catalog)
  return usd === null ? { usd: null, source: null } : { usd, source: 'catalog' }
}
