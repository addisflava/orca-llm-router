// Tool adapter for web-chat providers.
//
// Web chat (DeepSeek Web / Qwen Web) has no native OpenAI tool-calling, so the
// gateway instructs the model to emit a structured tool request and then parses
// the plain-text reply back into OpenAI tool_calls. This module is the
// reimplemented port of FreeDeepseekAPI's server.js tool parser (compactToolSchema,
// formatToolDefinitions, parseToolCall and its DSML / XML / legacy / JSON
// fallbacks). The only behavioral change: the injected instruction text no
// longer names a FreeDeepseekAPI server — it describes the local gateway.
//
// Everything here is pure and dependency-free; `log` is an optional sink.

const MAX_TOOL_MARKUP_CHARS = 256 * 1024
const MAX_TOOL_ARGUMENT_CHARS = 128 * 1024
const MAX_TOOL_JSON_CANDIDATES = 32
const MAX_DSML_PARAMETERS = 128
const MAX_DSML_STRUCTURAL_TAGS = MAX_DSML_PARAMETERS * 2 + 16
const MAX_DSML_TAG_CHARS = 2048

const noop = () => {}

// ---------------------------------------------------------------------------
// Tool schema compaction (drop annotation keywords that don't affect validity)
// ---------------------------------------------------------------------------
const TOOL_SCHEMA_ANNOTATION_KEYS = new Set(['description', 'examples', '$comment', 'title'])
const TOOL_SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
const TOOL_SCHEMA_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const TOOL_SCHEMA_SINGLE_KEYS = new Set([
  'additionalItems', 'additionalProperties', 'contains', 'contentSchema', 'else', 'if',
  'items', 'not', 'propertyNames', 'then', 'unevaluatedItems', 'unevaluatedProperties',
])

export function compactToolSchema(value) {
  if (Array.isArray(value)) return value.map(compactToolSchema)
  if (!value || typeof value !== 'object') return value
  const compact = {}
  for (const [key, child] of Object.entries(value)) {
    if (TOOL_SCHEMA_ANNOTATION_KEYS.has(key)) continue
    if (TOOL_SCHEMA_MAP_KEYS.has(key) && child && typeof child === 'object' && !Array.isArray(child)) {
      compact[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, compactToolSchema(schema)]))
    } else if (TOOL_SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
      compact[key] = child.map(compactToolSchema)
    } else if (TOOL_SCHEMA_SINGLE_KEYS.has(key)) {
      compact[key] = Array.isArray(child) ? child.map(compactToolSchema) : compactToolSchema(child)
    } else if (key === 'dependencies' && child && typeof child === 'object' && !Array.isArray(child)) {
      compact[key] = Object.fromEntries(Object.entries(child).map(([name, dependency]) => [
        name,
        Array.isArray(dependency) ? dependency : compactToolSchema(dependency),
      ]))
    } else {
      compact[key] = child
    }
  }
  return compact
}

/**
 * Build the system-prompt section that tells the model how to request a tool.
 * `serverLabel` names the local gateway (default is neutral, not tied to any
 * external proxy). `maxPromptChars` is the upstream prompt budget used to decide
 * whether to compact schemas.
 */
export function formatToolDefinitions(tools, { maxPromptChars = 80000, serverLabel = 'the local gateway' } = {}) {
  if (!tools || tools.length === 0) return ''
  let rawSchemaChars = 0
  for (const tool of tools) {
    try { rawSchemaChars += JSON.stringify(tool?.function?.parameters || {}).length } catch (e) { /* ignore */ }
  }
  const compactSchemas = rawSchemaChars > Math.floor(maxPromptChars * 0.4)
  let text = '\n\n--- TOOL REQUEST SYSTEM ---\n'
  text += 'You are an AI that ONLY REASONS and REQUESTS tool executions. You do NOT run any commands yourself.\n'
  text += 'When you need data from the local server, REQUEST exactly one tool call. Prefer strict JSON:\n'
  text += '{"tool_call":{"name":"<function_name>","arguments":{...}}}\n\n'
  text += 'Legacy format is also accepted: TOOL_CALL: <function_name>\narguments: <JSON arguments>\n\n'
  text += 'Your response will be sent to the local gateway, which executes the command and sends the output back in the next message.\n\n'
  text += 'RULES:\n'
  text += '1. You ONLY output the tool request — you never run anything yourself\n'
  text += '2. Do NOT simulate, guess, or fabricate command output — wait for the actual result\n'
  text += `3. The tool runs on ${serverLabel} — NOT on the web model\n`
  text += '4. After the tool executes, the result will be sent to you as a new user/tool message\n'
  text += '5. Never add explanation before or after the tool request when requesting a tool\n'
  text += '6. Keep arguments compact. Do not include large file contents unless the tool schema requires it.\n\n'
  text += 'Available functions:\n'
  for (const tool of tools) {
    if (tool.type === 'function' && tool.function) {
      const fn = tool.function
      text += `\n## ${fn.name}\n`
      const description = String(fn.description || '').replace(/\s+/g, ' ').trim()
      text += `${description.length > 500 ? description.substring(0, 497) + '...' : description}\n`
      if (fn.parameters) {
        text += `Parameters: ${JSON.stringify(compactSchemas ? compactToolSchema(fn.parameters) : fn.parameters)}\n`
      }
    }
  }
  text += '\n--- END TOOL REQUEST SYSTEM ---\n'
  text += '\nREMEMBER: Request tools only with strict JSON or TOOL_CALL legacy format. Never simulate results.'
  return text
}

// ---------------------------------------------------------------------------
// Balanced-JSON scanning helpers
// ---------------------------------------------------------------------------
export function extractBalancedJsonAt(text, startIndex) {
  if (text[startIndex] !== '{') return null
  let braceDepth = 0
  let inString = false
  let escape = false
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (!inString) {
      if (ch === '{') braceDepth++
      if (ch === '}') {
        braceDepth--
        if (braceDepth === 0) return text.substring(startIndex, i + 1)
      }
    }
  }
  return null
}

export function extractBalancedJsonObjects(text, maxObjects = MAX_TOOL_JSON_CANDIDATES) {
  const objects = []
  let start = -1
  let depth = 0
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (start === -1) {
      if (ch === '{') { start = i; depth = 1; inString = false; escape = false }
      continue
    }
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    if (ch === '}') {
      depth--
      if (depth === 0) {
        objects.push(text.substring(start, i + 1))
        if (objects.length >= maxObjects) return objects
        start = -1
      }
    }
  }
  return objects
}

export function buildToolCall(name, args = {}) {
  const toolName = typeof name === 'string' ? name.trim() : ''
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(toolName)) return null
  let parsedArgs = args
  if (typeof parsedArgs === 'string') {
    if (parsedArgs.length > MAX_TOOL_ARGUMENT_CHARS) return null
    try { parsedArgs = JSON.parse(parsedArgs) } catch (e) { return null }
  }
  if (parsedArgs === null || parsedArgs === undefined) parsedArgs = {}
  if (typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) return null
  let serialized
  try { serialized = JSON.stringify(parsedArgs) } catch (e) { return null }
  if (serialized.length > MAX_TOOL_ARGUMENT_CHARS) return null
  return { name: toolName, arguments: serialized }
}

function coerceToolCallObject(obj, { allowBare = false } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  let candidate = null
  if (Object.prototype.hasOwnProperty.call(obj, 'tool_call')) candidate = obj.tool_call
  else if (Object.prototype.hasOwnProperty.call(obj, 'function_call')) candidate = obj.function_call
  else if (Object.prototype.hasOwnProperty.call(obj, 'tool_calls')) {
    if (!Array.isArray(obj.tool_calls) || obj.tool_calls.length !== 1) return null
    candidate = obj.tool_calls[0]
  } else if (allowBare) candidate = obj
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const fn = candidate.function && typeof candidate.function === 'object' ? candidate.function : candidate
  return buildToolCall(fn.name ?? candidate.name, fn.arguments ?? candidate.arguments ?? candidate.input ?? {})
}

function parseJsonToolCandidate(raw, label = 'json', options = {}, log = noop) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    const tc = coerceToolCallObject(parsed, options)
    if (tc) { log(`[parseToolCall] SUCCESS ${label}: ${tc.name} (args=${tc.arguments.length} chars)`); return tc }
  } catch (e) {
    log(`[parseToolCall] ${label} JSON.parse failed: ${e.message?.substring?.(0, 100) || e.message}`)
  }
  return null
}

// ---------------------------------------------------------------------------
// DSML (DeepSeek structured markup language) parser
// ---------------------------------------------------------------------------
function canonicalizeToolMarkupTag(rawTag) {
  let token = String(rawTag || '').trim()
    .replace(/｜/g, '|')
    .replace(/[“”＂]/g, '"')
    .replace(/[‘’＇]/g, "'")
  let closing = false
  if (token.startsWith('/')) { closing = true; token = token.substring(1).trim() }
  token = token.replace(/^\|+\s*DSML\s*\|+\s*/i, '')
  if (token.startsWith('/')) { closing = true; token = token.substring(1).trim() }
  token = token.replace(/^DSML(?=(?:tool[\s_-]*calls|function[\s_-]*calls|invoke|parameter)\b)/i, '')

  if (!closing && /^name\s*=/i.test(token)) return `<direct ${token}>`

  const semantic = token.match(/^(?:(?:[A-Za-z_][\w.-]*):)?(tool[\s_-]*calls|function[\s_-]*calls|invoke|parameter)\b([\s\S]*)$/i)
  if (!semantic) return null
  const localName = semantic[1].replace(/[\s_-]/g, '').toLowerCase()
  const canonicalName = localName === 'toolcalls' || localName === 'functioncalls' ? 'tool_calls' : localName
  const attrs = closing ? '' : semantic[2]
  return `<${closing ? '/' : ''}${canonicalName}${attrs}>`
}

function normalizeToolMarkupTags(text) {
  const withAsciiAngles = String(text || '').replace(/＜/g, '<').replace(/＞/g, '>')
  return withAsciiAngles.replace(/<([^<>]{0,1024})>/g, (whole, rawTag) => {
    const canonical = canonicalizeToolMarkupTag(rawTag)
    return canonical || whole
  })
}

function decodeDsmlValue(value) {
  return String(value || '')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

function decodeDsmlParameterValue(value) {
  const raw = String(value || '')
  const cdata = raw.trim().match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i)
  return cdata ? cdata[1] : decodeDsmlValue(raw)
}

function getMarkupAttribute(attrs, attribute) {
  const match = String(attrs || '').match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])([^"']+)\\1`, 'i'))
  return match ? match[2] : null
}

function readDsmlTagAt(text, start) {
  if (text[start] !== '<') return null
  const prefix = text.substring(start + 1, Math.min(text.length, start + 40)).trimStart()
  if (!/^\/?(?:tool_calls|invoke|parameter|direct)\b/i.test(prefix)) return null
  let quote = null
  let end = -1
  const scanEnd = Math.min(text.length, start + MAX_DSML_TAG_CHARS + 1)
  for (let i = start + 1; i < scanEnd; i++) {
    const ch = text[i]
    if (quote) { if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '>') { end = i; break }
  }
  if (end === -1) return { invalid: true }

  let token = text.substring(start + 1, end).trim()
  let closing = false
  if (token.startsWith('/')) { closing = true; token = token.substring(1).trim() }
  let selfClosing = false
  if (!closing && token.endsWith('/')) { selfClosing = true; token = token.substring(0, token.length - 1).trim() }
  const match = token.match(/^(tool_calls|invoke|parameter|direct)\b([\s\S]*)$/i)
  if (!match) return null
  return {
    name: match[1].toLowerCase(),
    attrs: closing ? '' : match[2],
    closing,
    selfClosing,
    start,
    end: end + 1,
  }
}

function scanDsmlStructuralTags(text) {
  const tags = []
  const value = String(text || '')
  for (let i = 0; i < value.length;) {
    if (value.substring(i, i + 9).toUpperCase() === '<![CDATA[') {
      const cdataEnd = value.indexOf(']]>', i + 9)
      if (cdataEnd === -1) return null
      i = cdataEnd + 3
      continue
    }
    if (value[i] !== '<') { i++; continue }
    const tag = readDsmlTagAt(value, i)
    if (!tag) { i++; continue }
    if (tag.invalid) return null
    tags.push(tag)
    if (tags.length > MAX_DSML_STRUCTURAL_TAGS) return null
    i = tag.end
  }
  return tags
}

function parseDsmlParameter(attrs, rawBody, args, seenNames) {
  const parameterName = getMarkupAttribute(attrs, 'name')
  if (!parameterName || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(parameterName) || seenNames.has(parameterName)) return false
  seenNames.add(parameterName)
  const stringMode = getMarkupAttribute(attrs, 'string')
  const rawValue = decodeDsmlParameterValue(rawBody)
  if (rawValue.length > MAX_TOOL_ARGUMENT_CHARS) return false
  let value = rawValue
  if (stringMode && stringMode.toLowerCase() === 'false') {
    try { value = JSON.parse(rawValue.trim()) } catch (e) { return false }
  }
  args[parameterName] = value
  return true
}

function parseDsmlInvoke(name, body) {
  const structuralTags = scanDsmlStructuralTags(body)
  if (!structuralTags) return null
  const parameterTags = structuralTags.filter((tag) => tag.name === 'parameter')
  if (structuralTags.some((tag) => tag.name !== 'parameter')) return null

  const args = {}
  let parameterCount = 0
  const seenNames = new Set()
  let cursor = 0
  for (let i = 0; i < parameterTags.length; i += 2) {
    const opening = parameterTags[i]
    const closing = parameterTags[i + 1]
    if (!opening || opening.closing || opening.selfClosing || !closing || !closing.closing) return null
    if (body.substring(cursor, opening.start).trim()) return null
    parameterCount++
    if (parameterCount > MAX_DSML_PARAMETERS) return null
    if (!parseDsmlParameter(opening.attrs, body.substring(opening.end, closing.start), args, seenNames)) return null
    cursor = closing.end
  }
  if (parameterCount > 0) {
    if (body.substring(cursor).trim()) return null
    return buildToolCall(name, args)
  }

  const decodedBody = decodeDsmlValue(body).trim()
  if (!decodedBody) return buildToolCall(name, {})
  const objects = extractBalancedJsonObjects(decodedBody, 2)
  if (objects.length !== 1 || decodedBody !== objects[0]) return null
  try { return buildToolCall(name, JSON.parse(objects[0])) } catch (e) { return null }
}

function extractToolCallScope(normalized) {
  const tags = scanDsmlStructuralTags(normalized)
  if (!tags) return null
  const wrappers = tags.filter((tag) => tag.name === 'tool_calls')
  const openings = wrappers.filter((tag) => !tag.closing)
  const closings = wrappers.filter((tag) => tag.closing)
  if (openings.length > 0) {
    if (openings.length !== 1 || openings[0].selfClosing || closings.length === 0) return null
    const opening = openings[0]
    const closing = closings[closings.length - 1]
    if (wrappers.some((tag) => tag.closing && tag.start < opening.end) || closing.start < opening.end) return null
    if (tags.some((tag) => tag.name !== 'tool_calls' && (tag.start < opening.end || tag.start >= closing.start))) return null
    return normalized.substring(opening.end, closing.start)
  }
  if (closings.length > 0) {
    const closing = closings[closings.length - 1]
    const invokeOpenings = tags.filter((tag) => tag.name === 'invoke' && !tag.closing && tag.start < closing.start)
    if (invokeOpenings.length === 1 && !invokeOpenings[0].selfClosing) {
      if (tags.some((tag) => tag.name !== 'tool_calls' && (tag.start < invokeOpenings[0].start || tag.start >= closing.start))) return null
      return normalized.substring(invokeOpenings[0].start, closing.start)
    }
  }
  return null
}

export function parseDsmlToolCall(text, log = noop) {
  if (String(text || '').length > MAX_TOOL_MARKUP_CHARS) return null
  const normalized = normalizeToolMarkupTags(text)
  const scope = extractToolCallScope(normalized)
  if (scope === null) return null
  const tags = scanDsmlStructuralTags(scope)
  if (!tags || tags.length === 0) return null
  const first = tags[0]
  if (scope.substring(0, first.start).trim()) return null

  if (first.name === 'invoke' && !first.closing && !first.selfClosing) {
    const invokeTags = tags.filter((tag) => tag.name === 'invoke')
    if (invokeTags.length !== 2 || invokeTags[0] !== first || invokeTags[1].closing !== true) return null
    const closing = invokeTags[1]
    if (scope.substring(closing.end).trim()) return null
    if (tags.some((tag) => tag.name === 'tool_calls' || tag.name === 'direct')) return null
    const parsed = parseDsmlInvoke(getMarkupAttribute(first.attrs, 'name'), scope.substring(first.end, closing.start))
    if (parsed) { log(`[parseToolCall] SUCCESS dsml: ${parsed.name} (args=${parsed.arguments.length} chars)`); return parsed }
  }

  if (first.name === 'direct' && !first.closing && !first.selfClosing) {
    if (tags.some((tag, index) => index > 0 && (tag.name === 'direct' || tag.name === 'invoke' || tag.name === 'tool_calls'))) return null
    const parsed = parseDsmlInvoke(getMarkupAttribute(first.attrs, 'name'), scope.substring(first.end))
    if (parsed) { log(`[parseToolCall] SUCCESS dsml-direct: ${parsed.name} (args=${parsed.arguments.length} chars)`); return parsed }
  }
  return null
}

export function looksLikeToolCallMarkup(text) {
  return /TOOL_CALL:\s*[\w-]+|<\s*tool_call\b|[|｜]+\s*DSML\s*[|｜]+|[<＜]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b|["'](?:tool_call|tool_calls|function_call)["']\s*:/i.test(String(text || ''))
}

export function parseToolCall(text, { log = noop } = {}) {
  if (!text || typeof text !== 'string') return null
  if (text.length > MAX_TOOL_MARKUP_CHARS) {
    log(`[parseToolCall] Refusing oversized tool markup candidate (${text.length} chars)`)
    return null
  }

  if (/[|｜]+\s*DSML\s*[|｜]+|[<＜]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b/i.test(text)) {
    const dsml = parseDsmlToolCall(text, log)
    if (dsml) return dsml
    log('[parseToolCall] Tool markup found but wrapper/invoke was incomplete or malformed')
    return null
  }

  const xmlMatch = text.match(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/i)
  if (xmlMatch) {
    const inner = xmlMatch[1].trim()
    const tc = parseJsonToolCandidate(inner, 'xml', { allowBare: true }, log)
    if (tc) return tc
  }

  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi
  let fence
  while ((fence = fenceRe.exec(text)) !== null) {
    const tc = parseJsonToolCandidate(fence[1].trim(), 'fenced', {}, log)
    if (tc) return tc
  }

  const match = text.match(/TOOL_CALL:\s*([\w-]+)\s*/i)
  if (match) {
    const name = match[1]
    const afterMatch = text.substring(match.index + match[0].length)
    const braceIdx = afterMatch.indexOf('{')
    if (braceIdx !== -1) {
      const rawJson = extractBalancedJsonAt(afterMatch, braceIdx)
      if (rawJson) {
        try {
          const args = JSON.parse(rawJson)
          const tc = buildToolCall(name, args)
          if (tc) { log(`[parseToolCall] SUCCESS legacy: ${name} (args=${rawJson.length} chars)`); return tc }
        } catch (e) {
          log(`[parseToolCall] legacy JSON.parse failed: ${e.message?.substring?.(0, 100) || e.message}`)
        }
      } else {
        log(`[parseToolCall] TOOL_CALL:${name} found but JSON braces are unbalanced`)
      }
    } else {
      log(`[parseToolCall] TOOL_CALL:${name} found but no { after it`)
    }
  }

  for (const rawJson of extractBalancedJsonObjects(text)) {
    const tc = parseJsonToolCandidate(rawJson, 'inline', {}, log)
    if (tc) return tc
  }

  log(`[parseToolCall] No tool call match in ${text.length} chars`)
  return null
}

/** Strip surrogate characters and other problematic Unicode from text. */
export function sanitizeContent(text) {
  return String(text ?? '').replace(/[\ud800-\udfff]/g, '')
}

/** Normalize OpenAI / Anthropic / Responses message content to plain text. */
export function normalizeMessageContent(content) {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || ''
      if (part.type === 'tool_result') return `[Tool Result ${part.tool_use_id || ''}]\n${normalizeMessageContent(part.content)}`
      if (part.type === 'image_url') return `[Image: ${part.image_url?.url || ''}]`
      return part.text || part.content || JSON.stringify(part)
    }).filter(Boolean).join('\n')
  }
  return String(content)
}