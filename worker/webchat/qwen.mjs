// Qwen Web transport (chat.qwen.ai, v2 chat API).
//
// Ported from FreeDeepseekAPI's lib/providers/qwen.js, reimplemented as a
// self-contained ESM class with a single normalized credential (the router's
// scheduler supersedes the account pool / cooldown). Keeps the v2 flow:
//   1. POST /api/v2/chats/new          -> { data: { id: chat_id } }
//   2. POST /api/v2/chat/completions?chat_id= -> phase-based SSE stream
//
// SSE deltas carry `choices[0].delta.phase`: think/thinking_summary ->
// reasoning_content; answer/null -> assistant content. Multi-turn chaining uses
// the assistant response id as the next turn's parent_id; when no response id
// can be captured the remote session is dropped so the caller re-injects local
// recovery history. An expired login returns HTTP 200 + {"success":false,...},
// which must surface as 401 (handled by the router's auth cooldown).

import crypto from 'node:crypto'
import { providerHttpError, looksLikeHtml } from './errors.mjs'
import { qwenResolveModel, qwenCatalog } from './models.mjs'

const BASE_URL = 'https://chat.qwen.ai'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const BX_VERSION = '2.5.36'
const BX_UMIDTOKEN_FALLBACK = 'T2gA0000000000000000000000000000000000000000'
const DEFAULT_SPA_VERSION = '0.2.66'

export function normalizeCredential(raw) {
  let input = raw && typeof raw === 'object' ? raw : {}
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed
    } catch { /* not JSON — treat as missing */ }
  }
  const token = String(input.token || input.access_token || input.accessToken || input.auth_token || '')
    .trim().replace(/^Bearer\s+/i, '')
  let cookie = input.cookie || input.cookies || ''
  if (Array.isArray(cookie)) {
    cookie = cookie.filter((c) => c && c.name && c.value).map((c) => `${c.name}=${c.value}`).join('; ')
  }
  return {
    token,
    cookie: String(cookie || '').trim(),
    bx_umidtoken: String(input.bx_umidtoken || input['bx-umidtoken'] || ''),
    bx_ua: String(input.bx_ua || input['bx-ua'] || ''),
    bx_v: String(input.bx_v || input['bx-v'] || BX_VERSION),
    spa_version: String(input.spa_version || input.version || DEFAULT_SPA_VERSION),
    baseUrl: String(input.baseUrl || BASE_URL),
  }
}

export function parseSseLine(line) {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  try { return JSON.parse(payload) } catch (e) { return null }
}

export function extractResponseId(obj) {
  if (!obj || typeof obj !== 'object') return ''
  const candidates = [
    obj.response_id, obj.message_id, obj.id,
    obj.response && obj.response.id,
    obj['response.created'] && obj['response.created'].response_id,
    obj.data && obj.data.response_id,
    obj.data && obj.data.message_id,
    obj.data && obj.data.response && obj.data.response.response_id,
    obj.data && obj.data.message && obj.data.message.id,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export class QwenWebTransport {
  /**
   * @param {object} opts
   * @param {object} opts.creds        normalized Qwen credential
   * @param {(url, init) => Promise<Response>} [opts.fetchFn]
   * @param {() => number} [opts.now]
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ creds = {}, fetchFn = globalThis.fetch, now = () => Date.now(), log = () => {}, timeoutMs = 120000 } = {}) {
    this.creds = normalizeCredential(creds)
    this.fetchFn = fetchFn
    this.now = now
    this.log = log
    this.timeoutMs = timeoutMs
    this.id = 'qwen-web'
    this.displayName = 'Qwen Web'
  }

  isConfigured() {
    return Boolean(this.creds.token)
  }

  /** Verify the credential with a lightweight authenticated upstream call. */
  async probe() {
    const { id } = this.resolveModel('qwen3-max')
    return Boolean(await this._createChat(id))
  }

  resolveModel(model) {
    return qwenResolveModel(model)
  }

  listModels() {
    return qwenCatalog().map((m) => m.id)
  }

  _headers(chatId) {
    const config = this.creds
    const headers = {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'User-Agent': USER_AGENT,
      Origin: config.baseUrl,
      Referer: chatId ? `${config.baseUrl}/c/${chatId}` : `${config.baseUrl}/`,
      source: 'web',
      version: config.spa_version,
      'x-request-id': crypto.randomUUID(),
      'bx-v': config.bx_v,
      'bx-umidtoken': config.bx_umidtoken || BX_UMIDTOKEN_FALLBACK,
    }
    if (config.bx_ua) headers['bx-ua'] = config.bx_ua
    if (config.token) headers.Authorization = `Bearer ${config.token}`
    if (config.cookie) headers.Cookie = config.cookie
    return headers
  }

  async _fetch(url, options, label) {
    try {
      return await this.fetchFn(url, Object.assign({ signal: AbortSignal.timeout(this.timeoutMs) }, options))
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw providerHttpError(504, `Qwen ${label} timed out`, 'request_timeout')
      }
      throw providerHttpError(502, `Qwen ${label} failed: ${e.message}`, 'upstream_network_error')
    }
  }

  _apiError(text, status) {
    let json = null
    try { json = JSON.parse(text) } catch (e) { /* not JSON */ }
    if (json && json.success === false) {
      const code = String((json.data && json.data.code) || 'unknown')
      const details = String((json.data && (json.data.details || json.data.message)) || '')
      const authFailure = /unauth|expired|invalid\s*(?:token|session|credential)|sign\s*in/i.test(`${code} ${details}`)
      if (authFailure) {
        const reason = details.replace(/[.\s]+$/, '')
        return providerHttpError(401, `Qwen session expired or invalid (${code})${reason ? `: ${reason}` : ''}. Re-login at https://chat.qwen.ai`, 'authentication_error')
      }
      return providerHttpError(status || 502, `Qwen API error (${code})${details ? `: ${details}` : ''}`, 'upstream_response_error')
    }
    return providerHttpError(status || 502, `Qwen error: ${String(text || '').substring(0, 300)}`, 'upstream_response_error')
  }

  async _createChat(upstreamModel) {
    const resp = await this._fetch(`${this.creds.baseUrl}/api/v2/chats/new`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        title: 'New Chat',
        models: [upstreamModel],
        chat_mode: 'normal',
        chat_type: 't2t',
        timestamp: this.now(),
      }),
    }, 'create chat')
    const contentType = resp.headers.get('content-type') || ''
    const text = await resp.text()
    if (contentType.includes('text/html') || looksLikeHtml(text)) {
      throw providerHttpError(401, 'Qwen rejected the session (Alibaba WAF / expired login). The full Cookie header (cna, ssxmod_itna, token) is required.', 'authentication_error')
    }
    if (!resp.ok) throw this._apiError(text, resp.status)
    let json = null
    try { json = JSON.parse(text) } catch (e) { /* handled below */ }
    const chatId = json && json.data && json.data.id
    if (!chatId) throw this._apiError(text, 502)
    return chatId
  }

  _messagePayload({ chatId, upstreamModel, thinking, prompt, parentId }) {
    const featureConfig = {
      thinking_enabled: thinking,
      output_schema: 'phase',
      auto_thinking: thinking,
      research_mode: 'normal',
      auto_search: false,
    }
    if (thinking) {
      featureConfig.thinking_mode = 'Thinking'
      featureConfig.thinking_format = 'summary'
    }
    const timestamp = Math.floor(this.now() / 1000)
    return {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model: upstreamModel,
      parent_id: parentId || null,
      timestamp: timestamp + 1,
      messages: [{
        fid: crypto.randomUUID(),
        parentId: parentId || null,
        childrenIds: [],
        role: 'user',
        content: prompt,
        user_action: 'chat',
        files: [],
        timestamp,
        models: [upstreamModel],
        chat_type: 't2t',
        feature_config: featureConfig,
        extra: { meta: { subChatType: 't2t' } },
        sub_chat_type: 't2t',
        parent_id: parentId || null,
      }],
    }
  }

  async _complete(chatId, payload) {
    return this._fetch(`${this.creds.baseUrl}/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`, {
      method: 'POST',
      headers: this._headers(chatId),
      body: JSON.stringify(payload),
    }, 'completion')
  }

  async _readStream(resp, session, tag) {
    let content = ''
    let reasoning = ''
    let responseId = ''
    let modelError = null
    let buffer = ''
    if (!resp.body) return { content, reasoning, responseId, modelError }
    const decoder = new TextDecoder()
    for await (const chunk of resp.body) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const ev = parseSseLine(line)
        if (!ev) continue
        if (!responseId) responseId = extractResponseId(ev)
        if (ev.type === 'response.created' || ev.type === 'response.completed') {
          if (!responseId) responseId = extractResponseId(ev.response || {})
        }
        if (ev.success === false) {
          const detail = ev.data && (ev.data.code || ev.data.message)
          modelError = { type: 'model_error', content: String(detail || JSON.stringify(ev).substring(0, 200)) }
          continue
        }
        if (ev.error) {
          modelError = { type: ev.error.type || 'model_error', content: String(ev.error.message || ev.error) }
          continue
        }
        const choices = ev.choices
        if (!Array.isArray(choices) || !choices.length) continue
        for (const choice of choices) {
          const delta = choice && choice.delta ? choice.delta : choice
          if (!delta) continue
          if (delta.status === 'error') {
            modelError = { type: 'model_error', content: 'Qwen stream reported an error status' }
            continue
          }
          const text = typeof delta.content === 'string' ? delta.content : ''
          if (!text) continue
          const phase = delta.phase
          if (phase === 'think' || phase === 'thinking_summary') reasoning += text
          else if (phase === 'answer' || phase === null || phase === undefined) content += text
        }
      }
    }
    return { content, reasoning, responseId, modelError }
  }

  _finish(session, result, promptUsed, sessionReset) {
    if (result.responseId) {
      session.parentMessageId = result.responseId
      session.messageCount++
    } else if (!result.modelError) {
      // No continuation anchor: never claim a remote session we cannot reuse.
      session.id = null
      session.parentMessageId = null
      session.createdAt = null
      session.messageCount = 0
    }
    session.lastActivityAt = this.now()
    return {
      content: result.content,
      reasoningContent: result.reasoning,
      finishReason: null,
      modelError: result.modelError,
      promptUsed,
      sessionReset: Boolean(sessionReset),
    }
  }

  async forwardOnce(session, { model, prompt, freshPrompt } = {}) {
    const { id: upstreamModel, thinking } = this.resolveModel(model)
    const tag = `[qwen-web/${session?.id || 'new'}]`
    const hadRemoteSession = Boolean(session.id)
    // A chat_id without a captured parent id cannot be continued reliably.
    if (session.id && !session.parentMessageId) {
      this.log(`${tag} Session ${session.id} has no continuation id; restarting chat.`)
      session.id = null
      session.parentMessageId = null
      session.createdAt = null
      session.messageCount = 0
    }
    const needsFresh = !session.id
    const effectivePrompt = needsFresh ? freshPrompt : prompt
    if (hadRemoteSession && needsFresh) this.log(`${tag} previous remote session dropped; using recovery prompt`)

    if (!session.id) {
      session.id = await this._createChat(upstreamModel)
      session.parentMessageId = null
      session.createdAt = this.now()
      session.messageCount = 0
      this.log(`${tag} Created chat ${session.id}`)
    } else {
      this.log(`${tag} Reusing chat ${session.id} (parent: ${session.parentMessageId}, msg#${session.messageCount})`)
    }

    let payload = this._messagePayload({ chatId: session.id, upstreamModel, thinking, prompt: effectivePrompt, parentId: session.parentMessageId })
    let resp = await this._complete(session.id, payload)
    let contentType = resp.headers.get('content-type') || ''

    // Expired/rejected chat: recreate once with the fresh recovery prompt.
    if (!resp.ok || contentType.includes('text/html')) {
      const bodyText = await resp.text()
      const waf = contentType.includes('text/html') || looksLikeHtml(bodyText)
      this.log(`${tag} Completion error (${resp.status}${waf ? ', WAF/HTML' : ''}): ${bodyText.substring(0, 120)}`)
      if (waf) throw providerHttpError(401, 'Qwen rejected the session (Alibaba WAF / expired login). The full Cookie header is required.', 'authentication_error')
      if ([400, 404, 500].includes(resp.status)) {
        session.id = null
        session.parentMessageId = null
        session.createdAt = null
        session.messageCount = 0
        session.id = await this._createChat(upstreamModel)
        session.createdAt = this.now()
        payload = this._messagePayload({ chatId: session.id, upstreamModel, thinking, prompt: freshPrompt, parentId: null })
        resp = await this._complete(session.id, payload)
        contentType = resp.headers.get('content-type') || ''
        if (!resp.ok || contentType.includes('text/html')) {
          const retryText = await resp.text()
          throw this._apiError(retryText, resp.status)
        }
        return this._finish(session, await this._readStream(resp, session, tag), freshPrompt, true)
      }
      throw this._apiError(bodyText, resp.status)
    }

    const result = await this._readStream(resp, session, tag)
    return this._finish(session, result, effectivePrompt, needsFresh)
  }
}
