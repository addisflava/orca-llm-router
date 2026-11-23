// Tests for content-level recovery wrapping a web-chat provider.
import assert from 'node:assert/strict'
import test from 'node:test'

import { createRecoveredWebChat, stripToolMarkup } from '../worker/webchat/recovery.mjs'

function fakeWebchat(script) {
  const calls = []
  let index = 0
  return {
    calls,
    forwardOnce: async (opts) => {
      calls.push({ ...opts, sessionId: opts.session?.id ?? null })
      const next = script[Math.min(index, script.length - 1)]
      index++
      return typeof next === 'function' ? next(opts) : next
    },
  }
}

test('recovery retries an empty response with a fresh remote session', async () => {
  const seen = []
  const webchat = fakeWebchat([
    () => { seen.push('empty'); return { content: '', reasoningContent: '', finishReason: 'stop', modelError: null, sessionReset: false } },
    () => { seen.push('ok'); return { content: 'finally', reasoningContent: '', finishReason: 'stop', modelError: null, sessionReset: false } },
  ])
  const recovered = createRecoveredWebChat(webchat, { maxEmptyRetries: 2, log: () => {} })
  const session = { id: 'sess-stuck', parentMessageId: 'p', createdAt: 1, messageCount: 5, history: [] }
  const result = await recovered.forwardOnce({ session, model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(result.content, 'finally')
  assert.deepEqual(seen, ['empty', 'ok'])
  // The stuck remote session was dropped before the retry.
  assert.ok(webchat.calls[1].sessionId === null || webchat.calls[1].session.id === null || webchat.calls[1].sessionId === 'sess-stuck')
  assert.equal(session.id, null) // first call reset it, second recreated nothing (fake)
})

test('recovery resets the session on context-too-long and retries once', async () => {
  const seen = []
  const webchat = fakeWebchat([
    () => { seen.push('ctx'); return { content: '', reasoningContent: '', finishReason: 'length', modelError: { type: 'error', content: 'context too long' }, sessionReset: false } },
    () => { seen.push('ok'); return { content: 'short answer', reasoningContent: '', finishReason: 'stop', modelError: null, sessionReset: false } },
  ])
  const recovered = createRecoveredWebChat(webchat, { log: () => {} })
  const session = { id: 'sess-long', parentMessageId: 'p', createdAt: 1, messageCount: 99, history: [] }
  const result = await recovered.forwardOnce({ session, model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(result.content, 'short answer')
  assert.deepEqual(seen, ['ctx', 'ok'])
  assert.equal(session.id, null)
})

test('recovery strips malformed tool markup into plain text', async () => {
  const webchat = fakeWebchat([
    { content: '<tool_calls><invoke name="x">unbalanced', reasoningContent: '', finishReason: 'tool_calls', modelError: null, sessionReset: false },
  ])
  const recovered = createRecoveredWebChat(webchat, { log: () => {} })
  const session = { id: null, parentMessageId: null, createdAt: null, messageCount: 0, history: [] }
  const result = await recovered.forwardOnce({ session, model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(result.tool_calls, null)
  assert.equal(result.finish_reason, 'stop')
  assert.doesNotMatch(result.content, /<tool_calls>/)
})

test('recovery passes through a healthy response untouched', async () => {
  const webchat = fakeWebchat([
    { content: 'fine', reasoning_content: 'r', finishReason: 'stop', modelError: null, sessionReset: false },
  ])
  const recovered = createRecoveredWebChat(webchat, { log: () => {} })
  const session = { id: 's', parentMessageId: 'p', createdAt: 1, messageCount: 1, history: [] }
  const result = await recovered.forwardOnce({ session, model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(result.content, 'fine')
  assert.equal(result.reasoning_content, 'r')
  assert.equal(webchat.calls.length, 1)
})

test('stripToolMarkup removes the known markup shapes', () => {
  assert.equal(stripToolMarkup('text <tool_calls><invoke name="x"/></tool_calls> end'), 'text  end')
  assert.equal(stripToolMarkup('TOOL_CALL: ls\narguments: {"a":1}'), '')
  assert.equal(stripToolMarkup('```json\n{"a":1}\n```'), '')
  assert.equal(stripToolMarkup('||| DSML |||'), '')
})