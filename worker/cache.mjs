// Local response cache for the LLM Router.
//
// Two modes:
//   exact    - SHA-256 of the canonical request (post-rules, post-compression)
//              scoped by client protocol, stream mode and resolved target.
//   semantic - optional embeddings + cosine similarity on top of the exact
//              lookup. Embeddings come from a provider the operator picks, so
//              the gateway stays dependency-free.
//
// The cache stores the assembled response (JSON or raw SSE) so a hit can be
// replayed byte-for-byte without calling upstream. Entries are LRU + TTL and
// are scoped per target so one provider's answer never leaks into another's.

import { createHash } from 'node:crypto'

export const CACHE_MODES = ['exact', 'semantic']

const clamp = (value, min, max, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}

export function normalizeResponseCache(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  return {
    enabled: source.enabled === true,
    mode: CACHE_MODES.includes(source.mode) ? source.mode : 'exact',
    ttlMs: clamp(source.ttlMs, 10_000, 86_400_000, 300_000),
    maxEntries: Math.floor(clamp(source.maxEntries, 1, 2000, 200)),
    threshold: clamp(source.threshold, 0.5, 1, 0.95),
    embeddingProvider: typeof source.embeddingProvider === 'string' ? source.embeddingProvider : '',
    embeddingModel: typeof source.embeddingModel === 'string' ? source.embeddingModel : '',
    skipTools: source.skipTools !== false,
    maxTemperature: clamp(source.maxTemperature, 0, 2, 0)
  }
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function canonicalCacheKey({ scope, body }) {
  const canonical = { ...(body ?? {}) }
  delete canonical.stream
  return createHash('sha256').update(`${scope}\u0000${stableStringify(canonical)}`).digest('hex')
}

const PROMPT_FIELDS = {
  openai: ['messages'],
  anthropic: ['messages', 'system'],
  responses: ['input', 'instructions'],
  gemini: ['contents', 'systemInstruction']
}

function promptShape(value, key = '') {
  if (typeof value === 'string') {
    return key === 'content' || key === 'text' || key === 'output' ? '[text]' : value
  }
  if (Array.isArray(value)) return value.map((item) => promptShape(item, key))
  if (value && typeof value === 'object') {
    const shape = {}
    for (const [name, item] of Object.entries(value)) shape[name] = promptShape(item, name)
    return shape
  }
  return value
}

// Semantic mode is allowed to vary the prompt wording, but everything that
// shapes the answer (temperature, max tokens, stop, response format, tools,
// penalties, …) must still match. Hash the request with its prompt fields
// removed so a near-identical prompt cannot reuse an answer produced under
// different generation settings. The prompt's structure (roles, turn count,
// content part types) is kept so a one-turn prompt cannot match a different
// conversation shape.
export function semanticParamsKey(body, protocol = 'openai') {
  const clone = structuredClone(body ?? {})
  const shape = {}
  for (const field of PROMPT_FIELDS[protocol] ?? PROMPT_FIELDS.openai) {
    if (clone[field] !== undefined) shape[field] = promptShape(clone[field])
    delete clone[field]
  }
  clone.__promptShape = shape
  delete clone.model
  delete clone.stream
  return createHash('sha256').update(stableStringify(clone)).digest('hex')
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index++) {
    const a = Number(left[index])
    const b = Number(right[index])
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (!leftNorm || !rightNorm) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

function hasImagesDeep(body) {
  const stack = [body]
  while (stack.length) {
    const value = stack.pop()
    if (!value || typeof value !== 'object') continue
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item)
      continue
    }
    if (['image', 'image_url', 'input_image', 'input_audio', 'audio_url', 'file', 'input_file', 'document'].includes(value.type)) return true
    if (value.image_url || value.inlineData || value.fileData) return true
    for (const item of Object.values(value)) stack.push(item)
  }
  return false
}

function hasTools(body, protocol) {
  if (Array.isArray(body?.tools) && body.tools.length) return true
  if (Array.isArray(body?.functions) && body.functions.length) return true
  if (body?.tool_choice) return true
  if (protocol === 'responses' && Array.isArray(body?.input)) {
    if (body.input.some((item) =>
      item?.type === 'function_call' || item?.type === 'function_call_output'
      || item?.type === 'custom_tool_call' || item?.type === 'custom_tool_call_output'
    )) return true
  }
  if ((protocol === 'openai' || protocol === 'passthrough') && Array.isArray(body?.messages)) {
    if (body.messages.some((message) =>
      message?.role === 'tool'
      || (Array.isArray(message?.tool_calls) && message.tool_calls.length)
      || message?.function_call
    )) return true
  }
  if (protocol === 'anthropic' && Array.isArray(body?.messages)) {
    if (body.messages.some((message) => Array.isArray(message?.content)
      && message.content.some((block) => block?.type === 'tool_use' || block?.type === 'tool_result'))) return true
  }
  if (protocol === 'gemini' && Array.isArray(body?.contents)) {
    if (body.contents.some((content) => Array.isArray(content?.parts)
      && content.parts.some((part) => part?.functionCall || part?.functionResponse))) return true
  }
  return false
}

export function shouldCacheRequest({ protocol, body, headers, options } = {}) {
  const config = normalizeResponseCache(options)
  if (!config.enabled || !body || typeof body !== 'object') return false
  if (!['openai', 'anthropic', 'responses', 'gemini'].includes(protocol)) return false
  if (String(headers?.['x-router-cache'] ?? '').toLowerCase() === 'off') return false
  if (config.skipTools && hasTools(body, protocol)) return false
  if (hasImagesDeep(body)) return false
  const temperature = Number(body?.temperature ?? body?.generationConfig?.temperature ?? 0)
  if (Number.isFinite(temperature) && temperature > config.maxTemperature) return false
  return true
}

// Text used for embeddings / semantic matching. Capped so a huge prompt does
// not turn every cache miss into an expensive embedding request.
export function extractPromptText(body, protocol, limit = 8000) {
  const parts = []
  const push = (text) => {
    if (typeof text === 'string' && text) parts.push(text)
  }
  const walk = (value) => {
    if (typeof value === 'string') return push(value)
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value.image_url || value.inlineData || value.fileData || ['image', 'input_image', 'input_audio', 'file', 'input_file', 'document'].includes(value.type)) return
    if (typeof value.text === 'string') push(value.text)
    else if (typeof value.content === 'string') push(value.content)
    else if (Array.isArray(value.content)) walk(value.content)
    else if (typeof value.output === 'string') push(value.output)
  }

  if (protocol === 'anthropic') {
    walk(body?.system)
    walk(body?.messages)
  } else if (protocol === 'responses') {
    push(body?.instructions)
    walk(body?.input)
  } else if (protocol === 'gemini') {
    walk(body?.systemInstruction)
    walk(body?.contents)
  } else {
    walk(body?.messages)
  }
  return parts.join('\n').slice(0, limit)
}

export function createResponseCache({ now = Date.now } = {}) {
  const entries = new Map()
  const stats = { hits: 0, semanticHits: 0, misses: 0, stores: 0 }

  const prune = (limit) => {
    const timestamp = now()
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= timestamp) entries.delete(key)
    }
    while (entries.size > limit) {
      let oldestKey = null
      let oldestAt = Infinity
      for (const [key, entry] of entries) {
        if (entry.lastUsedAt < oldestAt) {
          oldestAt = entry.lastUsedAt
          oldestKey = key
        }
      }
      if (oldestKey == null) break
      entries.delete(oldestKey)
    }
  }

  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return null
      if (entry.expiresAt <= now()) {
        entries.delete(key)
        return null
      }
      entry.lastUsedAt = now()
      entry.hits = (entry.hits ?? 0) + 1
      return entry
    },
    findSemantic(scope, vector, threshold, limit = 200, paramsKey = null) {
      const timestamp = now()
      let best = null
      let bestScore = 0
      for (const entry of entries.values()) {
        if (entry.scope !== scope || !entry.vector || entry.expiresAt <= timestamp) continue
        if (paramsKey != null && entry.paramsKey !== paramsKey) continue
        const score = cosineSimilarity(entry.vector, vector)
        if (score >= threshold && score > bestScore) {
          best = entry
          bestScore = score
        }
      }
      if (best) {
        best.lastUsedAt = timestamp
        best.hits = (best.hits ?? 0) + 1
      }
      prune(limit)
      return best
    },
    set(entry, limit = 200) {
      if (!entry?.key) return
      entries.delete(entry.key)
      entries.set(entry.key, { ...entry, lastUsedAt: now(), hits: entry.hits ?? 0 })
      prune(limit)
      stats.stores++
    },
    clear() {
      entries.clear()
    },
    size() {
      return entries.size
    },
    stats() {
      return { ...stats, size: entries.size }
    }
  }
}
