// Web-chat helpers for the router sidecar.
//
// Pure building blocks the sidecar's forwardOnce branch composes with the
// router's own closure (pickKey, getSecret, keyIdentity, cooldown state). It
// builds synthetic OpenAI Responses so the existing streamResponse /
// openAIResponseToAnthropic translation pipeline handles client-protocol
// conversion for free. Nothing here depends on a FreeDeepseekAPI server.

import { deepseekCatalog, qwenCatalog } from './models.mjs'

export const WEBCHAT_TRANSPORTS = new Set(['deepseek-web', 'qwen-web'])

export function isWebChatTransport(provider) {
  return Boolean(provider && WEBCHAT_TRANSPORTS.has(provider.transport))
}

export function webchatCatalog(provider) {
  if (provider?.transport === 'deepseek-web') return deepseekCatalog()
  if (provider?.transport === 'qwen-web') return qwenCatalog()
  return []
}

export function webchatConfigured(provider, creds) {
  if (!creds || !provider) return false
  // Credentials may arrive as the raw JSON string held by the vault before
  // it is parsed on load; accept either form.
  if (typeof creds === 'string') {
    try {
      const parsed = JSON.parse(creds)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) creds = parsed
      else return false
    } catch { return false }
  }
  if (provider.transport === 'deepseek-web') return Boolean(creds.token && creds.cookie)
  if (provider.transport === 'qwen-web') return Boolean(creds.token)
  return false
}

// A remote webchat session belongs to the auth account that created it. Scope
// the key by transport + affinity (the client conversation) + key identity
// (the account), so a different account never reuses a remote chat it does not
// own, and a new conversation never collides with an old one.
export function webchatSessionKey(transport, affinityKey, keyIdentity) {
  return `webchat:${transport}:${affinityKey || 'anon'}:${keyIdentity || ''}`
}

export function buildWebChatResponse(status, body, contentType, { retryAfter = null, stream = false } = {}) {
  const text = String(body ?? '')
  const headers = new Map([
    ['content-type', contentType],
    ...(retryAfter ? [['retry-after', String(retryAfter)]] : []),
  ])
  const encoder = new TextEncoder()
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    body: stream
      ? new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(text))
            controller.close()
          },
        })
      : null,
    text: async () => text,
    json: async () => { try { return JSON.parse(text) } catch (e) { return null } },
  }
}

export function buildWebChatErrorResponse(error, { retryAfter = null } = {}) {
  const status = Number(error?.status) || 502
  const body = JSON.stringify({
    error: {
      message: String(error?.message ?? 'upstream error'),
      type: error?.type ?? 'upstream_http_error',
      ...(error?.retryAfter ? { retry_after: error.retryAfter } : {}),
      ...(status === 401 ? { code: 'authentication_error' } : {}),
    },
  })
  const ra = retryAfter ?? (error?.retryAfter != null ? Number(error.retryAfter) : null)
  return buildWebChatResponse(status, body, 'application/json', { retryAfter: ra })
}

function chunkId() {
  return `chatcmpl-webchat-${Math.random().toString(36).slice(2, 10)}`
}

// Build a complete OpenAI chat.completion JSON body from a webchat result.
export function buildOpenAICompletion(result, model, now = Date.now) {
  const message = { role: 'assistant', content: result.content || null }
  if (result.reasoning_content) message.reasoning_content = result.reasoning_content
  if (result.tool_calls && result.tool_calls.length) message.tool_calls = result.tool_calls
  return {
    id: chunkId(),
    object: 'chat.completion',
    created: Math.floor(now() / 1000),
    model: String(model ?? ''),
    choices: [{
      index: 0,
      message,
      finish_reason: result.finish_reason || 'stop',
    }],
    usage: null,
  }
}

// Build an OpenAI chat.completion.chunk SSE body for streaming clients.
export function buildOpenAICompletionSse(result, model, now = Date.now) {
  const id = chunkId()
  const created = Math.floor(now() / 1000)
  const frame = (delta, finishReason = null) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: String(model ?? ''), choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
  let out = frame({ role: 'assistant', content: null, ...(result.reasoning_content ? { reasoning_content: result.reasoning_content } : {}) })
  if (result.content) out += frame({ content: result.content })
  out += frame({}, result.finish_reason || 'stop')
  out += 'data: [DONE]\n\n'
  return out
}

export function buildWebChatSuccessResponse(result, model, { wantsStream = false, clientProtocol = 'openai', now = Date.now } = {}) {
  // Streaming is only a real SSE passthrough for OpenAI clients; cross-protocol
  // (anthropic / responses) is handled by the router's buffered translation
  // path, so hand those a JSON body with bufferForStream=true.
  const stream = wantsStream && clientProtocol === 'openai'
  const body = stream ? buildOpenAICompletionSse(result, model, now) : JSON.stringify(buildOpenAICompletion(result, model, now))
  return {
    upstreamRes: buildWebChatResponse(200, body, stream ? 'text/event-stream' : 'application/json', { stream }),
    bufferForStream: wantsStream && clientProtocol !== 'openai',
  }
}