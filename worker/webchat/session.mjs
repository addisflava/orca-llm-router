// Web-chat session store.
//
// Web-chat providers keep a remote chat (a DeepSeek chat_session / Qwen chat_id)
// that must be reused across turns so the upstream keeps context. This store is
// the plugin-native replacement for FreeDeepseekAPI's `sessions` Map. It is
// intentionally generic — the router builds the composite key
// (`transport:affinityKey:keyIdentity`) so that:
//   - a different model never reuses another model's chat (affinityKey scoping),
//   - an account rotation (different keyIdentity) automatically drops the remote
//     chat instead of reusing it under a different account.
//
// It is instantiated once inside the sidecar and shares the sidecar's clock, so
// tests stay pure and there are no module-level globals.

import {
  MAX_HISTORY_LENGTH,
  MAX_HISTORY_CHARS,
  MAX_MESSAGE_DEPTH,
} from './prompt.mjs'

const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours, same as the proxy

export function createSession(now = Date.now()) {
  return {
    id: null,            // DeepSeek chat_session_id / Qwen chat_id
    parentMessageId: null, // continuation anchor (DeepSeek response id / Qwen response_id)
    createdAt: null,
    messageCount: 0,
    history: [],         // short local recovery transcript
    lastActivityAt: now,
  }
}

export class WebChatSessionStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.sessionTtlMs] remote-session TTL before rollover
   * @param {() => number} [opts.now] clock (defaults to Date.now)
   */
  constructor({ sessionTtlMs = DEFAULT_SESSION_TTL_MS, now = () => Date.now() } = {}) {
    this.sessionTtlMs = sessionTtlMs
    this.now = now
    this.sessions = new Map()
  }

  create() {
    return createSession(this.now())
  }

  /** Get or create the session for a composite key, touching its activity clock. */
  getOrCreate(key) {
    let session = this.sessions.get(key)
    if (!session) {
      session = createSession(this.now())
      this.sessions.set(key, session)
    }
    session.lastActivityAt = this.now()
    return session
  }

  get(key) {
    return this.sessions.get(key) ?? null
  }

  /**
   * Drop the remote chat for a key but keep local recovery history and the key
   * entry. Returns info about what was reset (for logging/errors).
   */
  resetRemote(key) {
    const session = this.sessions.get(key)
    if (!session) return null
    const failed = {
      failedSessionId: session.id,
      failedMessageCount: session.messageCount,
      key,
    }
    session.id = null
    session.parentMessageId = null
    session.createdAt = null
    session.messageCount = 0
    session.lastActivityAt = this.now()
    return failed
  }

  /**
   * Roll over a remote session that hit its depth or TTL limit. Returns
   * { reason, ...resetInfo } or null when the session is still healthy.
   */
  prepareForPrompt(key) {
    const session = this.sessions.get(key)
    if (!session || !session.id) return null
    const now = this.now()
    let reason = null
    if (session.messageCount >= MAX_MESSAGE_DEPTH) reason = 'max_message_depth'
    else if (session.createdAt && now - session.createdAt > this.sessionTtlMs) reason = 'session_ttl'
    if (!reason) return null
    return { reason, ...this.resetRemote(key) }
  }

  /** Remove an entire session entry (client asked to reset, or idle eviction). */
  delete(key) {
    return this.sessions.delete(key)
  }

  /** Forget every session. Returns the count removed. */
  clear() {
    const count = this.sessions.size
    this.sessions.clear()
    return count
  }

  /** Remove every session whose composite key starts with `prefix`. */
  deleteByPrefix(prefix) {
    let removed = 0
    for (const key of this.sessions.keys()) {
      if (key.startsWith(prefix)) { this.sessions.delete(key); removed++ }
    }
    return removed
  }

  /** Record a completed turn into the short local recovery transcript. */
  storeHistory(key, prompt, content, toolCall) {
    const session = this.getOrCreate(key)
    const assistantResponse = toolCall
      ? `TOOL_CALL: ${toolCall.name}\narguments: ${toolCall.arguments}`
      : content
    const shortPrompt = prompt.length > 500 ? '...' + prompt.substring(prompt.length - 500) : prompt
    session.history.push({ user: shortPrompt, assistant: assistantResponse })
    while (session.history.length > MAX_HISTORY_LENGTH) session.history.shift()
    let historyChars = session.history.reduce((sum, e) => sum + e.user.length + e.assistant.length, 0)
    while (historyChars > MAX_HISTORY_CHARS && session.history.length > 1) {
      const removed = session.history.shift()
      historyChars -= removed.user.length + removed.assistant.length
    }
  }

  /** Evict sessions idle longer than `maxIdleMs` (default 2× TTL). */
  sweepIdle(maxIdleMs = this.sessionTtlMs * 2) {
    const now = this.now()
    let removed = 0
    for (const [key, session] of this.sessions) {
      if (now - (session.lastActivityAt || 0) > maxIdleMs) { this.sessions.delete(key); removed++ }
    }
    return removed
  }

  /** Snapshot for status/UI, without leaking any credential material. */
  list() {
    const now = this.now()
    return [...this.sessions.entries()].map(([key, session]) => ({
      key,
      session_id: session.id,
      message_count: session.messageCount,
      history_size: session.history.length,
      age_ms: session.createdAt ? now - session.createdAt : null,
      idle_ms: now - (session.lastActivityAt || now),
    }))
  }

  get size() {
    return this.sessions.size
  }
}