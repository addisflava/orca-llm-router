// Integration test: a web-chat provider routed through the real sidecar HTTP
// gateway with an injected (mocked) upstream fetch. Verifies the forwardOnce
// branch, OpenAI response synthesis, and the /reset-session endpoint.
import assert from 'node:assert/strict'
import test from 'node:test'

import { createSidecar } from '../worker/sidecar.mjs'

function jsonResponse(obj, status = 200) {
  const text = JSON.stringify(obj)
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    text: async () => text,
    json: async () => obj,
    body: null,
  }
}
function sseResponse(...events) {
  const data = events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('')
  return {
    status: 200, ok: true,
    headers: { get: () => 'text/event-stream' },
    text: async () => data,
    json: async () => null,
    body: new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(data)); c.close() },
    }),
  }
}

const WEBCHAT_CREDS = { token: 'ds-token', cookie: 'session=abc' }

async function withSidecar(config, fetchImpl, fn) {
  const sidecar = createSidecar({
    getConfig: () => config,
    getSecret: (k) => (k === 'ds-auth' ? WEBCHAT_CREDS : null),
    fetchImpl,
    onLog: () => {},
    solvePOW: async () => 42, // stub: tests use a fake challenge, not real WASM
  })
  const addr = await sidecar.start('127.0.0.1', 0)
  const base = `http://127.0.0.1:${addr.port}`
  try {
    await fn(base, sidecar)
  } finally {
    await sidecar.stop()
  }
}

function deepseekFetch(calls) {
  return async (url) => {
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
        { p: 'response/fragments', v: [{ type: 'THINK', content: 'thinking...' }, { type: 'RESPONSE', content: 'Hello from webchat' }] },
        { finish_reason: 'stop' },
      )
    }
    throw new Error('unexpected URL ' + url)
  }
}

test('sidecar routes a web-chat provider through the native transport', async () => {
  const config = {
    version: 3,
    token: 'orca-router',
    providers: [{
      name: 'deepseek-web',
      displayName: 'DeepSeek Web',
      transport: 'deepseek-web',
      protocols: ['openai'],
      models: [{ id: 'deepseek-chat' }],
      keys: [{ id: 'k1', secretKey: 'ds-auth', enabled: true, priority: 0, weight: 1 }],
    }],
    routes: [],
    aliases: {},
  }
  const calls = []
  await withSidecar(config, deepseekFetch(calls), async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.model, 'deepseek-chat')
    assert.equal(json.choices[0].message.content, 'Hello from webchat')
    assert.equal(json.choices[0].message.reasoning_content, 'thinking...')
    assert.equal(json.choices[0].finish_reason, 'stop')
    assert.ok(calls.some((u) => u.includes('create_pow_challenge')))
    assert.ok(calls.some((u) => u.includes('chat_session/create')))
    assert.ok(calls.some((u) => u.includes('chat/completion')))
  })
})

test('web-chat provider surfaces a typed 401 upstream failure', async () => {
  const config = {
    version: 3,
    token: 'orca-router',
    providers: [{
      name: 'deepseek-web',
      displayName: 'DeepSeek Web',
      transport: 'deepseek-web',
      protocols: ['openai'],
      models: [{ id: 'deepseek-chat' }],
      keys: [{ id: 'k1', secretKey: 'ds-auth', enabled: true, priority: 0, weight: 1 }],
    }],
    routes: [],
    aliases: {},
  }
  const badFetch = async (url) => {
    if (url.includes('create_pow_challenge')) return jsonResponse({}, 401)
    throw new Error('should not reach ' + url)
  }
  await withSidecar(config, badFetch, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
    })
    // The router retries once (default retries) then falls back to the error body.
    assert.ok(res.status === 401 || res.status === 502, `expected 401/502, got ${res.status}`)
  })
})

test('POST /reset-session drops a webchat session', async () => {
  const config = {
    version: 3,
    token: 'orca-router',
    providers: [],
    routes: [],
    aliases: {},
  }
  await withSidecar(config, async () => { throw new Error('no fetch expected') }, async (base) => {
    const res = await fetch(`${base}/reset-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transport: 'deepseek-web', affinityKey: 'abc', keyIdentity: 'k1' }),
    })
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.ok, true)
    assert.equal(json.removed, false) // no session yet
    assert.match(json.key, /^webchat:deepseek-web:abc:k1$/)
  })
})
test('qwen-web resolves its canonical model id to the correct upstream model', async () => {
  let completionBody = null
  const qwenFetch = async (url, init) => {
    if (url.includes('/api/v2/chats/new')) return jsonResponse({ data: { id: 'chat-1' } })
    if (url.includes('/api/v2/chat/completions')) {
      completionBody = JSON.parse(init.body)
      return sseResponse(
        { choices: [{ delta: { phase: 'answer', content: 'Qwen ok' } }] },
      )
    }
    throw new Error('unexpected ' + url)
  }
  const config = {
    version: 3,
    token: 'orca-router',
    providers: [{
      name: 'qwen-web',
      transport: 'qwen-web',
      protocols: ['openai'],
      models: [{ id: 'qwen3-max' }],
      keys: [{ id: 'k1', secretKey: 'qw-auth', enabled: true }],
    }],
    routes: [],
    aliases: {},
  }
  const sidecar = createSidecar({
    getConfig: () => config,
    getSecret: (k) => (k === 'qw-auth' ? { token: 't', cookie: 'c' } : null),
    fetchImpl: qwenFetch,
    onLog: () => {},
  })
  const addr = await sidecar.start('127.0.0.1', 0)
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-max', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.choices[0].message.content, 'Qwen ok')
    assert.equal(completionBody.model, 'qwen3.7-max', 'the bare alias maps to the current upstream model')
    assert.equal(completionBody.messages[0].feature_config.thinking_enabled, false)
  } finally {
    await sidecar.stop()
  }
})
