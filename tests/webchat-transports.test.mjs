// Mocked end-to-end tests for the web-chat transports and orchestrator.
// No real network: fetch is injected; DeepSeek PoW is stubbed.
import assert from 'node:assert/strict'
import test from 'node:test'

import { DeepSeekWebTransport, normalizeCredential as dsNormalize } from '../worker/webchat/deepseek.mjs'
import { QwenWebTransport, parseSseLine, extractResponseId, normalizeCredential as qwNormalize } from '../worker/webchat/qwen.mjs'
import { createWebChatProvider, buildOpenAIChatMessage } from '../worker/webchat/index.mjs'
import { _clearPowCache } from '../worker/webchat/pow.mjs'

// --- tiny fetch mocks ------------------------------------------------------
function jsonResponse(obj, status = 200) {
  const text = JSON.stringify(obj)
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    text: async () => text,
    body: null,
  }
}
function sseResponse(...events) {
  const data = events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('')
  const text = data
  return {
    status: 200, ok: true,
    headers: { get: () => 'text/event-stream' },
    text: async () => text,
    body: new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(data)); c.close() },
    }),
  }
}

// ---------------------------------------------------------------------------
// normalizeCredential
// ---------------------------------------------------------------------------
test('deepseek normalizeCredential trims Bearer and joins cookie arrays', () => {
  const c = dsNormalize({ token: 'Bearer tok', cookie: [{ name: 'a', value: '1' }, { name: 'b', value: '2' }] })
  assert.equal(c.token, 'tok')
  assert.equal(c.cookie, 'a=1; b=2')
  assert.equal(c.wasmUrl.includes('sha3_wasm'), true)
})

test('qwen normalizeCredential defaults bx-v / spa-version / umid fallback', () => {
  const c = qwNormalize({ token: 't', cookie: 'cna=1' })
  assert.equal(c.token, 't')
  assert.equal(c.cookie, 'cna=1')
  assert.equal(c.bx_v, '2.5.36')
  assert.ok(c.spa_version)
})

// ---------------------------------------------------------------------------
// pow
// ---------------------------------------------------------------------------
test('solvePOW throws on missing wasmUrl and clears its cache', async () => {
  const { solvePOW } = await import('../worker/webchat/pow.mjs')
  await assert.rejects(() => solvePOW({}, undefined), /wasmUrl/)
  _clearPowCache()
})

// ---------------------------------------------------------------------------
// DeepSeek transport
// ---------------------------------------------------------------------------
test('DeepSeekWebTransport forwardOnce creates a session and reads fragments', async () => {
  const calls = []
  const fetchFn = async (url) => {
    calls.push(url)
    if (url.includes('create_pow_challenge')) {
      return jsonResponse({ data: { biz_data: { challenge: { algorithm: 'x', challenge: 'c', salt: 's', expire_at: 1, difficulty: 1, signature: 'sig' } } } })
    }
    if (url.includes('chat_session/create')) {
      return jsonResponse({ data: { biz_data: { chat_session: { id: 'sess-1' } } } })
    }
    if (url.includes('chat/completion')) {
      return sseResponse(
        { response_message_id: 'msg-1' },
        { p: 'response/fragments', v: [{ type: 'THINK', content: 'thinking...' }, { type: 'RESPONSE', content: 'Hello' }] },
        { finish_reason: 'stop' },
      )
    }
    throw new Error('unexpected URL ' + url)
  }
  const transport = new DeepSeekWebTransport({ creds: { token: 't', cookie: 'c' }, fetchFn, solvePOW: async () => 42 })
  const session = { id: null, parentMessageId: null, createdAt: null, messageCount: 0, history: [] }
  const result = await transport.forwardOnce(session, { model: 'deepseek-reasoner', prompt: 'cont', freshPrompt: 'fresh' })

  assert.equal(session.id, 'sess-1')
  assert.equal(session.parentMessageId, 'msg-1')
  assert.equal(session.messageCount, 1)
  assert.equal(result.content, 'Hello')
  assert.equal(result.reasoningContent, 'thinking...')
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.promptUsed, 'fresh') // new session => fresh prompt
  assert.equal(result.sessionReset, true)
  assert.ok(calls.some((u) => u.includes('create_pow_challenge')))
  assert.ok(calls.some((u) => u.includes('chat_session/create')))
})

test('DeepSeekWebTransport reuses an existing session and continues with prompt', async () => {
  const fetchFn = async (url) => {
    if (url.includes('create_pow_challenge')) {
      return jsonResponse({ data: { biz_data: { challenge: { algorithm: 'x', challenge: 'c', salt: 's', expire_at: 1, difficulty: 1, signature: 'sig' } } } })
    }
    if (url.includes('chat/completion')) {
      return sseResponse(
        { response_message_id: 'msg-9' },
        { p: 'response/fragments', v: [{ type: 'RESPONSE', content: 'Reuse ok' }] },
        { finish_reason: 'stop' },
      )
    }
    throw new Error('should not create a session on reuse: ' + url)
  }
  const transport = new DeepSeekWebTransport({ creds: { token: 't', cookie: 'c' }, fetchFn, solvePOW: async () => 42 })
  const session = { id: 'sess-9', parentMessageId: 'msg-8', createdAt: 1, messageCount: 5, history: [] }
  const result = await transport.forwardOnce(session, { model: 'deepseek-chat', prompt: 'continue', freshPrompt: 'fresh' })
  assert.equal(result.content, 'Reuse ok')
  assert.equal(session.parentMessageId, 'msg-9')
  assert.equal(session.messageCount, 6)
  assert.equal(result.promptUsed, 'continue') // reused session => continued prompt
  assert.equal(result.sessionReset, false)
})

test('DeepSeekWebTransport recreates a session on 400 and throws typed error otherwise', async () => {
  const fetchFn = async (url) => {
    if (url.includes('create_pow_challenge')) {
      return jsonResponse({ data: { biz_data: { challenge: { algorithm: 'x', challenge: 'c', salt: 's', expire_at: 1, difficulty: 1, signature: 'sig' } } } })
    }
    if (url.includes('chat_session/create')) {
      return jsonResponse({ data: { biz_data: { chat_session: { id: 'sess-2' } } } })
    }
    if (url.includes('chat/completion')) {
      // First call -> 400 (expired session), second -> 200
      if (!fetchFn._failed) {
        fetchFn._failed = true
        const bad = jsonResponse({ error: 'expired' }, 400)
        bad.headers = { get: () => 'application/json' }
        return bad
      }
      return sseResponse(
        { response_message_id: 'msg-2' },
        { p: 'response/fragments', v: [{ type: 'RESPONSE', content: 'Recreated' }] },
        { finish_reason: 'stop' },
      )
    }
    throw new Error('unexpected ' + url)
  }
  const transport = new DeepSeekWebTransport({ creds: { token: 't', cookie: 'c' }, fetchFn, solvePOW: async () => 42 })
  const session = { id: 'sess-1', parentMessageId: 'msg-1', createdAt: 1, messageCount: 1, history: [] }
  const result = await transport.forwardOnce(session, { model: 'deepseek-chat', prompt: 'p', freshPrompt: 'fresh' })
  assert.equal(session.id, 'sess-2')
  assert.equal(result.content, 'Recreated')
  assert.equal(result.promptUsed, 'fresh')
  assert.equal(result.sessionReset, true)

  // A 401 on completion surfaces as a typed auth error.
  const badFetch = async (url) => {
    if (url.includes('create_pow_challenge')) {
      return jsonResponse({ data: { biz_data: { challenge: { algorithm: 'x', challenge: 'c', salt: 's', expire_at: 1, difficulty: 1, signature: 'sig' } } } })
    }
    if (url.includes('chat_session/create')) {
      return jsonResponse({ data: { biz_data: { chat_session: { id: 'sess-3' } } } })
    }
    const bad = jsonResponse({ error: 'nope' }, 401)
    bad.headers = { get: () => 'application/json' }
    return bad
  }
  const t2 = new DeepSeekWebTransport({ creds: { token: 't', cookie: 'c' }, fetchFn: badFetch, solvePOW: async () => 42 })
  const s2 = { id: 'sess-3', parentMessageId: null, createdAt: 1, messageCount: 0, history: [] }
  await assert.rejects(() => t2.forwardOnce(s2, { model: 'deepseek-chat', prompt: 'p', freshPrompt: 'f' }), (err) => {
    assert.equal(err.status, 401)
    assert.equal(err.type, 'authentication_error')
    return true
  })
})

// ---------------------------------------------------------------------------
// Qwen transport
// ---------------------------------------------------------------------------
test('QwenWebTransport creates a chat and reads phase-based SSE', async () => {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push(url)
    if (url.includes('/api/v2/chats/new')) {
      return jsonResponse({ data: { id: 'chat-1' } })
    }
    if (url.includes('/api/v2/chat/completions')) {
      return sseResponse(
        { type: 'response.created', response: { id: 'resp-1' } },
        { choices: [{ delta: { phase: 'think', content: 'reasoning' } }] },
        { choices: [{ delta: { phase: 'answer', content: 'Hello' } }] },
        { choices: [{ delta: { phase: null, content: ' world' } }] },
      )
    }
    throw new Error('unexpected ' + url)
  }
  const transport = new QwenWebTransport({ creds: { token: 't', cookie: 'c' }, fetchFn })
  const session = { id: null, parentMessageId: null, createdAt: null, messageCount: 0, history: [] }
  const result = await transport.forwardOnce(session, { model: 'qwen/qwen3-max-thinking', prompt: 'p', freshPrompt: 'f' })

  assert.equal(session.id, 'chat-1')
  assert.equal(session.parentMessageId, 'resp-1')
  assert.equal(session.messageCount, 1)
  assert.equal(result.content, 'Hello world')
  assert.equal(result.reasoningContent, 'reasoning')
  assert.equal(result.promptUsed, 'f')
  assert.equal(result.sessionReset, true)
})

test('QwenWebTransport surfaces WAF HTML and unauthorized envelopes as 401', async () => {
  // WAF: create chat returns HTML
  const wafFetch = async (url) => {
    const resp = jsonResponse({}, 200)
    resp.headers = { get: () => 'text/html' }
    resp.text = async () => '<!DOCTYPE html><html><body>WAF</body></html>'
    return resp
  }
  const t = new QwenWebTransport({ creds: { token: 't', cookie: 'c' }, fetchFn: wafFetch })
  const s = { id: null, parentMessageId: null, createdAt: null, messageCount: 0, history: [] }
  await assert.rejects(() => t.forwardOnce(s, { model: 'qwen/qwen3-max', prompt: 'p', freshPrompt: 'f' }), (err) => {
    assert.equal(err.status, 401)
    return true
  })

  // Expired login: chat create 200 with success:false + code unauthorized
  const expiredFetch = async (url) => {
    if (url.includes('/api/v2/chats/new')) {
      return jsonResponse({ success: false, data: { code: 'unauthorized', details: 'token expired' } }, 200)
    }
    throw new Error('unexpected ' + url)
  }
  const t2 = new QwenWebTransport({ creds: { token: 't', cookie: 'c' }, fetchFn: expiredFetch })
  const s2 = { id: null, parentMessageId: null, createdAt: null, messageCount: 0, history: [] }
  await assert.rejects(() => t2.forwardOnce(s2, { model: 'qwen/qwen3-max', prompt: 'p', freshPrompt: 'f' }), (err) => {
    assert.equal(err.status, 401)
    assert.equal(err.type, 'authentication_error')
    return true
  })
})

test('parseSseLine and extractResponseId', () => {
  assert.equal(parseSseLine('data: [DONE]'), null)
  assert.equal(parseSseLine('event: x'), null)
  assert.deepEqual(parseSseLine('data: {"a":1}'), { a: 1 })
  assert.equal(extractResponseId({ response: { id: 'r1' } }), 'r1')
  assert.equal(extractResponseId({ data: { message: { id: 'm1' } } }), 'm1')
  assert.equal(extractResponseId({ nope: 1 }), '')
})

// ---------------------------------------------------------------------------
// index.mjs orchestrator
// ---------------------------------------------------------------------------
test('createWebChatProvider shapes tool_calls from plain-text markup', async () => {
  const fake = {
    id: 'deepseek-web', displayName: 'DeepSeek Web',
    isConfigured: () => true, resolveModel: () => ({}), listModels: () => ['x'],
    forwardOnce: async () => ({ content: 'TOOL_CALL: read_file\narguments: {"path":"/tmp/x"}', reasoningContent: '', finishReason: null, sessionReset: false }),
  }
  const p = createWebChatProvider(fake)
  const session = { id: 's', parentMessageId: null, createdAt: 1, messageCount: 0, history: [] }
  const result = await p.forwardOnce({ session, model: 'deepseek-chat', messages: [{ role: 'user', content: 'read a file' }] })
  assert.equal(result.finish_reason, 'tool_calls')
  assert.equal(result.tool_calls[0].function.name, 'read_file')
  assert.equal(result.tool_calls[0].function.arguments, '{"path":"/tmp/x"}')
})

test('createWebChatProvider prefixes recovery history for fresh sessions', async () => {
  let seen = null
  const fake = {
    id: 'qwen-web', displayName: 'Qwen Web',
    isConfigured: () => true, resolveModel: () => ({ id: 'q', thinking: false }), listModels: () => ['x'],
    forwardOnce: async (_session, { freshPrompt }) => { seen = freshPrompt; return { content: 'ok', reasoningContent: '', finishReason: 'stop', sessionReset: false } },
  }
  const p = createWebChatProvider(fake)
  const session = { id: 's', parentMessageId: 'p', createdAt: 1, messageCount: 0, history: [{ user: 'earlier', assistant: 'reply' }] }
  const result = await p.forwardOnce({ session, model: 'qwen/qwen3-max', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(result.content, 'ok')
  assert.match(seen, /\[Previous conversation\]/)
  assert.match(seen, /User: earlier/)
  assert.match(seen, /Assistant: reply/)
})

test('buildOpenAIChatMessage emits reasoning_content and finish_reason', () => {
  const m = buildOpenAIChatMessage({ content: 'a', reasoning_content: 'r', finish_reason: 'stop', tool_calls: null }, 'm')
  assert.equal(m.message.content, 'a')
  assert.equal(m.message.reasoning_content, 'r')
  assert.equal(m.finish_reason, 'stop')
})
test('normalizeCredential accepts the raw JSON string from the vault', () => {
  const ds = dsNormalize(JSON.stringify({ token: 'tok', cookie: 'c=1' }))
  assert.equal(ds.token, 'tok')
  assert.equal(ds.cookie, 'c=1')
  const qw = qwNormalize(JSON.stringify({ token: 'qt', cookie: 'cna=1', 'bx-v': '2.5.36' }))
  assert.equal(qw.token, 'qt')
  assert.equal(qw.bx_v, '2.5.36')
})
