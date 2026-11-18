// DeepSeek Web transport (chat.deepseek.com).
//
// Ported from FreeDeepseekAPI's lib/providers/deepseek.js, reimplemented as a
// self-contained ESM class with no account pool, no cooldown timers and no file
// I/O: the router's scheduler/cooldown supersedes those, so this transport
// holds a single normalized credential and one injected `fetch`. It keeps the
// PoW challenge flow, remote-session create/reuse/recreate, and the fragments /
// JSON-patch stream parser verbatim in behaviour.
//
// It mutates the passed-in session object (from WebChatSessionStore) and returns
// a raw completion result. Prompt construction, recovery history and OpenAI
// shaping live in index.mjs / prompt.mjs.

import { createUpstreamHttpError } from './errors.mjs'
import { deepseekModelConfig, listDeepseekModels } from './models.mjs'

const BASE = 'https://chat.deepseek.com'
export const DEEPSEEK_POW_WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm'

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'

// Normalize the plugin's auth JSON shape into the fields buildBaseHeaders needs.
export function normalizeCredential(raw) {
  let input = raw && typeof raw === 'object' ? raw : {}
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed
    } catch { /* not JSON — treat as missing */ }
  }
  const token = String(input.token || input.access_token || input.accessToken || '')
    .trim().replace(/^Bearer\s+/i, '')
  const cookie = Array.isArray(input.cookie)
    ? input.cookie.filter((c) => c && c.name && c.value).map((c) => `${c.name}=${c.value}`).join('; ')
    : String(input.cookie || '')
  return {
    token,
    cookie: cookie.trim(),
    hif_dliq: String(input.hif_dliq || ''),
    hif_leim: String(input.hif_leim || ''),
    wasmUrl: String(input.wasmUrl || DEEPSEEK_POW_WASM_URL),
  }
}

function isAssistantOutputFragment(fragment) {
  return fragment && (fragment.type === 'RESPONSE' || fragment.type === 'SEARCH') && typeof fragment.content === 'string'
}
function isReasoningFragment(fragment) {
  return fragment && (fragment.type === 'THINK' || fragment.type === 'REASONING') && typeof fragment.content === 'string'
}

function rebuildFragmentText(fragments) {
  const responseText = fragments.filter(isAssistantOutputFragment).map((f) => f.content).join('')
  const thinkText = fragments.filter(isReasoningFragment).map((f) => f.content).join('')
  return { responseText, thinkText }
}

function applyResponsePatchOperations(ops, appendFragments) {
  if (!Array.isArray(ops)) return false
  let applied = false
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue
    if (op.p === 'fragments' && op.o === 'APPEND' && op.v !== undefined) {
      appendFragments(op.v)
      applied = true
    }
  }
  return applied
}

export class DeepSeekWebTransport {
  /**
   * @param {object} opts
   * @param {object} opts.creds        normalized DeepSeek credential
   * @param {(url, init) => Promise<Response>} [opts.fetchFn]
   * @param {(challenge, wasmUrl, opts?) => Promise<number>} [opts.solvePOW]
   * @param {() => number} [opts.now]
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ creds = {}, fetchFn = globalThis.fetch, solvePOW, now = () => Date.now(), log = () => {} } = {}) {
    this.creds = normalizeCredential(creds)
    this.fetchFn = fetchFn
    this.solvePOW = solvePOW
    this.now = now
    this.log = log
    this.id = 'deepseek-web'
    this.displayName = 'DeepSeek Web'
  }

  isConfigured() {
    return Boolean(this.creds.token && this.creds.cookie)
  }

  /** Verify the credential with a lightweight authenticated upstream call. */
  async probe() {
    const challenge = await this._powChallenge(this._headers())
    return Boolean(challenge && challenge.challenge)
  }

  resolveModel(model) {
    return deepseekModelConfig(model)
  }

  listModels() {
    return listDeepseekModels(false)
  }

  _headers() {
    return {
      'User-Agent': USER_AGENT,
      'x-client-platform': 'web',
      'x-client-version': '2.0.0',
      'x-client-locale': 'ru',
      'x-client-timezone-offset': '14400',
      'x-app-version': '2.0.0',
      Authorization: `Bearer ${this.creds.token}`,
      'x-hif-dliq': this.creds.hif_dliq || '',
      'x-hif-leim': this.creds.hif_leim || '',
      Origin: BASE,
      Referer: `${BASE}/`,
      Cookie: this.creds.cookie || '',
      'Content-Type': 'application/json',
    }
  }

  _tag(session) {
    return `[deepseek-web/${session?.id || 'new'}]`
  }

  async _powChallenge(headers) {
    const cr = await this.fetchFn(`${BASE}/api/v0/chat/create_pow_challenge`, {
      method: 'POST', headers,
      body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
    })
    const chalText = await cr.text()
    if (!cr.ok) {
      throw createUpstreamHttpError(cr.status, `DeepSeek PoW challenge failed: ${chalText.substring(0, 120)}`)
    }
    let chalJson
    try { chalJson = JSON.parse(chalText) } catch { /* handled below */ }
    const challenge = chalJson && chalJson.data && chalJson.data.biz_data && chalJson.data.biz_data.challenge
    if (!challenge) {
      throw createUpstreamHttpError(401, 'DeepSeek PoW response has no data.biz_data.challenge. Auth may be expired or captcha required.')
    }
    return challenge
  }

  async _createSession(headers) {
    const sr = await this.fetchFn(`${BASE}/api/v0/chat_session/create`, {
      method: 'POST', headers, body: '{}',
    })
    const text = await sr.text()
    let json = null
    if (text) { try { json = JSON.parse(text) } catch { /* handled below */ } }
    const bizData = json && json.data && json.data.biz_data
    const createdSessionId = bizData && ((bizData.chat_session && bizData.chat_session.id) || bizData.id)
    if (!sr.ok || !createdSessionId) {
      throw createUpstreamHttpError(sr.status || 502, `Could not create DeepSeek chat session: ${text.substring(0, 120)}`)
    }
    return createdSessionId
  }

  _powHeader(challenge, answer) {
    return Buffer.from(JSON.stringify({
      algorithm: challenge.algorithm, challenge: challenge.challenge,
      salt: challenge.salt, answer,
      signature: challenge.signature, target_path: '/api/v0/chat/completion',
    })).toString('base64')
  }

  async _complete(session, cfg, prompt, headers, challenge, answer) {
    const powB64 = this._powHeader(challenge, answer)
    return this.fetchFn(`${BASE}/api/v0/chat/completion`, {
      method: 'POST',
      headers: Object.assign({}, headers, { 'X-DS-PoW-Response': powB64 }),
      body: JSON.stringify({
        chat_session_id: session.id,
        parent_message_id: session.parentMessageId,
        model_type: cfg.model_type,
        prompt, ref_file_ids: [],
        thinking_enabled: cfg.thinking_enabled, search_enabled: cfg.search_enabled,
        action: null, preempt: false,
      }),
    })
  }

  _readResponse(readable, session, tag) {
    const fragments = []
    let fullContent = ''
    let reasoningContent = ''
    let newMessageId = null
    let finishReason = null
    let modelError = null
    let lastPath = null
    let buffer = ''

    const rebuildFragmentState = () => {
      const rebuilt = rebuildFragmentText(fragments)
      if (rebuilt.responseText) fullContent = rebuilt.responseText
      reasoningContent = rebuilt.thinkText
    }
    const appendFragments = (value) => {
      const incoming = Array.isArray(value) ? value : [value]
      for (const fragment of incoming) {
        if (fragment && typeof fragment === 'object') fragments.push(Object.assign({}, fragment))
      }
      rebuildFragmentState()
    }

    const decoder = new TextDecoder()
    // processLine handles one complete "data: ..." line.
    const processLine = (line) => {
      if (!line.startsWith('data: ')) return
      let ev
      try { ev = JSON.parse(line.slice(6)) } catch (e) { return }
      if (ev.response_message_id !== undefined && !newMessageId) newMessageId = ev.response_message_id
      if (ev.type === 'error') {
        modelError = { type: ev.type, content: ev.content || '', finish_reason: ev.finish_reason || null }
      }
      if (ev.finish_reason) finishReason = ev.finish_reason
      if (ev.p !== undefined) lastPath = ev.p
      if (ev.v && typeof ev.v === 'object' && ev.v.response) {
        if (ev.v.response.message_id !== undefined) newMessageId = ev.v.response.message_id
        if (ev.v.response.content !== undefined) fullContent = ev.v.response.content
        if (Array.isArray(ev.v.response.fragments)) {
          fragments.length = 0
          appendFragments(ev.v.response.fragments)
        }
        if (ev.v.response.finish_reason !== undefined) finishReason = ev.v.response.finish_reason
      }
      if (lastPath === 'response/fragments' && ev.v !== undefined) appendFragments(ev.v)
      if (lastPath === 'response' && ev.v !== undefined) applyResponsePatchOperations(ev.v, appendFragments)
      if (lastPath === 'response/fragments/-1/content' && ev.v !== undefined && typeof ev.v !== 'object') {
        if (fragments.length > 0) {
          const lastFragment = fragments[fragments.length - 1]
          lastFragment.content = `${lastFragment.content || ''}${ev.v}`
          rebuildFragmentState()
        }
      }
      if (lastPath === 'response/content' && ev.v !== undefined && typeof ev.v !== 'object') fullContent += ev.v
      if (lastPath === 'response/finish_reason' && ev.v !== undefined) finishReason = ev.v
      if (lastPath === 'response/status' && ev.v !== undefined && ev.v !== 'FINISHED') finishReason = ev.v
    }

    // We must consume the async readable synchronously within a promise.
    return (async () => {
      for await (const chunk of readable) {
        buffer += decoder.decode(chunk, { stream: true })
        const split = buffer.split('\n')
        buffer = split.pop() || ''
        for (const line of split) processLine(line)
      }
      if (buffer.trim()) processLine(buffer)
      if (newMessageId) {
        session.parentMessageId = newMessageId
        session.messageCount++
      } else {
        this.log(`${tag} WARNING: could not extract message_id`)
      }
      return { content: fullContent, reasoningContent, messageId: newMessageId, finishReason, modelError }
    })()
  }

  /**
   * One upstream turn. `session` is the router's session object (mutated in
   * place). `prompt` is used when the remote session can be continued;
   * `freshPrompt` is used when a new session is created or after a rollover.
   */
  async forwardOnce(session, { model, prompt, freshPrompt } = {}) {
    const cfg = this.resolveModel(model) || deepseekModelConfig('deepseek-chat')
    const headers = this._headers()
    const tag = this._tag(session)
    const hadRemoteSession = Boolean(session.id)

    // Rollover already reset session.id to null when depth/TTL was hit (sidecar
    // calls WebChatSessionStore.prepareForPrompt before this). Use the recovery
    // prompt whenever the remote session is not reusable.
    const needsFresh = !session.id
    const effectivePrompt = needsFresh ? freshPrompt : prompt
    if (hadRemoteSession && needsFresh) this.log(`${tag} previous remote session dropped; using recovery prompt`)

    // 1. PoW challenge
    const challenge = await this._powChallenge(headers)
    const answer = await this.solvePOW(challenge, this.creds.wasmUrl)

    // 2. Ensure a remote session exists
    if (!session.id) {
      session.id = await this._createSession(headers)
      session.parentMessageId = null
      session.createdAt = this.now()
      session.messageCount = 0
      this.log(`${tag} Created new session: ${session.id}`)
    } else {
      this.log(`${tag} Reusing session: ${session.id} (parent: ${session.parentMessageId}, msg#${session.messageCount})`)
    }

    // 3. Completion
    let resp = await this._complete(session, cfg, effectivePrompt, headers, challenge, answer)
    if (resp.status !== 200) {
      const retryAfter = resp.headers?.get?.('retry-after')
      const errText = await resp.text()
      this.log(`${tag} Session error (${resp.status}): ${errText.substring(0, 100)}`)
      if (resp.status === 400 || resp.status === 404 || resp.status === 500) {
        // Remote session expired/invalid — recreate once with the recovery prompt.
        this.log(`${tag} Session ${session.id} expired. Creating new session...`)
        session.id = null
        session.parentMessageId = null
        session.id = await this._createSession(headers)
        session.parentMessageId = null
        session.createdAt = this.now()
        session.messageCount = 0
        this.log(`${tag} Created new session: ${session.id}`)
        const resp2 = await this._complete(session, cfg, freshPrompt, headers, challenge, answer)
        if (!resp2.ok) {
          const retryAfter2 = resp2.headers?.get?.('retry-after')
          const errText2 = await resp2.text()
          throw createUpstreamHttpError(resp2.status, errText2, retryAfter2)
        }
        const result = await this._readResponse(resp2.body, session, tag)
        return { ...result, promptUsed: freshPrompt, sessionReset: true }
      }
      throw createUpstreamHttpError(resp.status, errText, retryAfter)
    }

    const result = await this._readResponse(resp.body, session, tag)
    return { ...result, promptUsed: effectivePrompt, sessionReset: needsFresh }
  }
}