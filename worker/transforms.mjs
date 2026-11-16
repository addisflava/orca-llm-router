// Deterministic, dependency-free request transforms for the LLM Router.
//
// Two opt-in features live here:
//   compression  - conservative prompt compression that never touches code,
//                  JSON payloads, tool-call structure or recent turns.
//   contextRelay - a failover handoff digest that shrinks older turns when a
//                  request has to move to another provider/model.
//
// Everything is pure: same input + same options -> same output. The sidecar
// calls these on a cloned body, so the caller's payload is never mutated.

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g
const FENCE_RE = /```[\s\S]*?```/g
const INLINE_RE = /`[^`\n]+`/g
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g
const PLACEHOLDER_RE = /\u0000(\d+)\u0000/g
const PROTECTED_PART_RE = /^\u0000\d+\u0000$/

export const COMPRESSION_MODES = ['lite', 'standard', 'aggressive']
export const RELAY_TRIGGERS = ['failover', 'always', 'both']

const clamp = (value, min, max, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback
}

export function normalizeCompression(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  return {
    enabled: source.enabled === true,
    mode: COMPRESSION_MODES.includes(source.mode) ? source.mode : 'lite',
    minChars: clamp(source.minChars, 0, 1_000_000, 2000),
    keepRecentMessages: clamp(source.keepRecentMessages, 0, 100, 4),
    toolResults: source.toolResults !== false,
    systemPrompt: source.systemPrompt === true,
    toolMaxChars: clamp(source.toolMaxChars, 200, 200_000, 4000),
    messageMaxChars: clamp(source.messageMaxChars, 200, 200_000, 2000)
  }
}

export function normalizeContextRelay(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  return {
    enabled: source.enabled === true,
    trigger: RELAY_TRIGGERS.includes(source.trigger) ? source.trigger : 'failover',
    maxChars: clamp(source.maxChars, 1000, 20_000_000, 24_000),
    keepRecentMessages: clamp(source.keepRecentMessages, 0, 100, 8),
    digestChars: clamp(source.digestChars, 40, 2000, 200)
  }
}

export function bodyCharLength(body) {
  try {
    return JSON.stringify(body ?? null)?.length ?? 0
  } catch {
    return 0
  }
}

// Pull code fences, inline code and URLs out of a string before prose
// compression so they come back byte-perfect.
function protectSegments(text) {
  const saved = []
  const stash = (match) => {
    const token = `\u0000${saved.length}\u0000`
    saved.push(match)
    return token
  }
  let out = String(text).replace(FENCE_RE, stash)
  out = out.replace(INLINE_RE, stash)
  out = out.replace(URL_RE, stash)
  return {
    text: out,
    restore: (value) => value.replace(PLACEHOLDER_RE, (_, index) => saved[Number(index)] ?? '')
  }
}

// Truncate unprotected prose while always keeping a whole protected segment.
// The returned length can exceed `limit` when a code block is long; that is
// deliberate - code is never cut.
function truncateProtected(text, limit) {
  if (text.length <= limit) return text
  const parts = text.split(/(\u0000\d+\u0000)/g)
  let out = ''
  for (const part of parts) {
    if (out.length + part.length > limit) {
      if (PROTECTED_PART_RE.test(part)) {
        out += part
        continue
      }
      break
    }
    out += part
  }
  const removed = Math.max(0, text.length - out.length)
  if (!removed) return text
  return `${out}\n[… ${removed} chars omitted by Orca LLM Router …]`
}

function looksLikeJson(text) {
  const trimmed = String(text ?? '').replace(ANSI_RE, '').trim()
  if (!trimmed) return false
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

function compressText(text, mode, limits, { tool = false } = {}) {
  if (typeof text !== 'string' || !text) return { text, before: 0, after: 0 }
  // Tool output is often machine-readable JSON. Whitespace changes there can
  // alter values, so leave a whole JSON payload untouched.
  if (looksLikeJson(text)) return { text, before: 0, after: 0 }
  const before = text.length
  const { text: protectedText, restore } = protectSegments(text)
  let out = protectedText.replace(ANSI_RE, '')
  out = out.replace(/\r\n/g, '\n')
  out = out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
  out = out.replace(/\n{3,}/g, '\n\n')

  const cap = tool
    ? (mode === 'aggressive' ? Math.min(limits.toolMaxChars, 1000) : mode === 'standard' ? limits.toolMaxChars : 0)
    : (mode === 'aggressive' ? limits.messageMaxChars : 0)
  if (cap > 0) out = truncateProtected(out, cap)

  out = restore(out)
  // Never make a string longer than it was; keep the original when the rules
  // did not actually save anything.
  return out.length < before ? { text: out, before, after: out.length } : { text, before, after: before }
}

function mapTextContent(content, fn) {
  if (typeof content === 'string') return fn(content)
  if (!Array.isArray(content)) return content
  return content.map((part) => {
    if (!part || typeof part !== 'object') return part
    if (part.type === 'image' || part.type === 'image_url' || part.type === 'input_image' || part.inlineData) return part
    if (typeof part.text === 'string') return { ...part, text: fn(part.text) }
    if (typeof part.content === 'string') return { ...part, content: fn(part.content) }
    if (Array.isArray(part.content)) return { ...part, content: mapTextContent(part.content, fn) }
    return part
  })
}

function mapAnthropicContent(content, fnText, fnTool) {
  if (typeof content === 'string') return fnText(content)
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    if (!block || typeof block !== 'object') return block
    if (block.type === 'text' && typeof block.text === 'string') return { ...block, text: fnText(block.text) }
    if (block.type === 'tool_result') {
      if (typeof block.content === 'string') return { ...block, content: fnTool(block.content) }
      if (Array.isArray(block.content)) {
        return {
          ...block,
          content: block.content.map((inner) =>
            inner && inner.type === 'text' && typeof inner.text === 'string'
              ? { ...inner, text: fnTool(inner.text) }
              : inner
          )
        }
      }
    }
    return block
  })
}

function oldEnough(index, length, keepRecent) {
  return index < length - keepRecent
}

function applyOpenAICompression(body, limits, makeFn) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!message || typeof message !== 'object') continue
    if (message.role === 'system' || message.role === 'developer') {
      if (limits.systemPrompt) message.content = mapTextContent(message.content, makeFn(false))
      continue
    }
    if (!oldEnough(index, messages.length, limits.keepRecentMessages)) continue
    if (message.role === 'tool') {
      if (limits.toolResults) message.content = mapTextContent(message.content, makeFn(true))
      continue
    }
    message.content = mapTextContent(message.content, makeFn(false))
  }
}

function applyAnthropicCompression(body, limits, makeFn) {
  if (limits.systemPrompt && (typeof body.system === 'string' || Array.isArray(body.system))) {
    body.system = mapTextContent(body.system, makeFn(false))
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!message || typeof message !== 'object') continue
    if (!oldEnough(index, messages.length, limits.keepRecentMessages)) continue
    message.content = mapAnthropicContent(
      message.content,
      makeFn(false),
      limits.toolResults ? makeFn(true) : (text) => text
    )
  }
}

function applyResponsesCompression(body, limits, makeFn) {
  if (limits.systemPrompt && typeof body.instructions === 'string') {
    body.instructions = makeFn(false)(body.instructions)
  }
  if (typeof body.input === 'string') {
    // A bare input string is the current turn, not old history. Leave it
    // untouched so aggressive mode cannot truncate the user's live prompt.
    return
  }
  if (!Array.isArray(body.input)) return
  const input = body.input
  for (let index = 0; index < input.length; index++) {
    const item = input[index]
    if (!item || typeof item !== 'object') continue
    if (!oldEnough(index, input.length, limits.keepRecentMessages)) continue
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      if (limits.toolResults && typeof item.output === 'string') item.output = makeFn(true)(item.output)
      continue
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') continue
    if (item.type === 'message') {
      item.content = mapTextContent(item.content, makeFn(false))
      continue
    }
    if (typeof item.content === 'string') item.content = makeFn(false)(item.content)
  }
}

function applyGeminiCompression(body, limits, makeFn) {
  if (limits.systemPrompt && Array.isArray(body.systemInstruction?.parts)) {
    body.systemInstruction.parts = body.systemInstruction.parts.map((part) =>
      part && typeof part.text === 'string' ? { ...part, text: makeFn(false)(part.text) } : part
    )
  }
  const contents = Array.isArray(body.contents) ? body.contents : []
  for (let index = 0; index < contents.length; index++) {
    const content = contents[index]
    if (!content || !Array.isArray(content.parts)) continue
    if (!oldEnough(index, contents.length, limits.keepRecentMessages)) continue
    content.parts = content.parts.map((part) => {
      if (!part || typeof part !== 'object') return part
      if (part.inlineData || part.functionCall || part.functionResponse) return part
      if (typeof part.text === 'string') return { ...part, text: makeFn(false)(part.text) }
      return part
    })
  }
}

export function compressChatBody(body, { protocol = 'openai', options = {} } = {}) {
  if (!body || typeof body !== 'object') return { body, before: 0, after: 0, changed: false }
  const limits = normalizeCompression(options)
  let before = 0
  let after = 0
  const makeFn = (tool) => (text) => {
    const result = compressText(text, limits.mode, limits, { tool })
    before += result.before
    after += result.after
    return result.text
  }
  const clone = structuredClone(body)
  if (protocol === 'anthropic') applyAnthropicCompression(clone, limits, makeFn)
  else if (protocol === 'responses') applyResponsesCompression(clone, limits, makeFn)
  else if (protocol === 'gemini') applyGeminiCompression(clone, limits, makeFn)
  else applyOpenAICompression(clone, limits, makeFn)
  const changed = after > 0 && after < before
  return { body: changed ? clone : body, before, after, changed }
}

// ---------------------------------------------------------------------------
// Context relay: shrink older turns into one-line digests so a failover target
// with a smaller context window can resume the conversation. No model call.
// ---------------------------------------------------------------------------

function digestText(text, limits) {
  const source = String(text ?? '')
  if (!source) return { text, changed: false }
  const firstLine = source.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  const clipped = firstLine.length > limits.digestChars ? `${firstLine.slice(0, limits.digestChars)}…` : firstLine
  const digest = `[handoff] ${clipped}${source.length > clipped.length ? ` …(+${source.length - clipped.length} chars)` : ''}`
  return { text: digest.length < source.length ? digest : source, changed: digest.length < source.length }
}

function digestTool(text, limits) {
  const source = String(text ?? '')
  if (!source) return { text, changed: false }
  const digest = `[handoff tool result: ${source.length} chars]`
  return { text: digest.length < source.length ? digest : source, changed: digest.length < source.length }
}

function applyRelayToMessages(body, protocol, limits, stats) {
  const makeText = (text) => {
    const result = digestText(text, limits)
    if (result.changed) stats.relayed++
    return result.text
  }
  const makeTool = (text) => {
    const result = digestTool(text, limits)
    if (result.changed) stats.relayed++
    return result.text
  }

  if (protocol === 'anthropic') {
    const messages = Array.isArray(body.messages) ? body.messages : []
    for (let index = 0; index < messages.length; index++) {
      if (!oldEnough(index, messages.length, limits.keepRecentMessages)) continue
      messages[index].content = mapAnthropicContent(messages[index].content, makeText, makeTool)
    }
    return
  }
  if (protocol === 'responses') {
    if (typeof body.input !== 'string' && Array.isArray(body.input)) {
      const input = body.input
      for (let index = 0; index < input.length; index++) {
        if (!oldEnough(index, input.length, limits.keepRecentMessages)) continue
        const item = input[index]
        if (!item || typeof item !== 'object') continue
        if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
          if (typeof item.output === 'string') item.output = makeTool(item.output)
          continue
        }
        if (item.type === 'function_call' || item.type === 'custom_tool_call') continue
        if (item.type === 'message') item.content = mapTextContent(item.content, makeText)
        else if (typeof item.content === 'string') item.content = makeText(item.content)
      }
    }
    return
  }
  if (protocol === 'gemini') {
    const contents = Array.isArray(body.contents) ? body.contents : []
    for (let index = 0; index < contents.length; index++) {
      if (!oldEnough(index, contents.length, limits.keepRecentMessages)) continue
      const parts = contents[index]?.parts
      if (!Array.isArray(parts)) continue
      contents[index].parts = parts.map((part) => {
        if (!part || part.inlineData || part.functionCall || part.functionResponse) return part
        if (typeof part.text === 'string') return { ...part, text: makeText(part.text) }
        return part
      })
    }
    return
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (let index = 0; index < messages.length; index++) {
    if (!oldEnough(index, messages.length, limits.keepRecentMessages)) continue
    const message = messages[index]
    if (!message || typeof message !== 'object') continue
    if (message.role === 'system' || message.role === 'developer') continue
    if (message.role === 'tool') message.content = mapTextContent(message.content, makeTool)
    else message.content = mapTextContent(message.content, makeText)
  }
}

export function relayChatBody(body, { protocol = 'openai', options = {} } = {}) {
  const limits = normalizeContextRelay(options)
  if (!body || typeof body !== 'object') return { body, before: 0, after: 0, changed: false, relayed: 0 }
  const before = bodyCharLength(body)
  const stats = { relayed: 0 }
  const clone = structuredClone(body)
  applyRelayToMessages(clone, protocol, limits, stats)
  const after = bodyCharLength(clone)
  return { body: after < before ? clone : body, before, after, changed: after < before, relayed: stats.relayed }
}
