// Pure-Node tests for the web-chat foundation modules (no Orca, no network).
// Run: node --test tests/webchat.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deepseekModelConfig,
  deepseekCatalog,
  listDeepseekModels,
  qwenCatalog,
  qwenResolveModel,
} from '../worker/webchat/models.mjs'
import {
  buildToolCall,
  compactToolSchema,
  formatToolDefinitions,
  looksLikeToolCallMarkup,
  normalizeMessageContent,
  parseToolCall,
  parseDsmlToolCall,
  sanitizeContent,
} from '../worker/webchat/tools.mjs'
import {
  appendPromptInstruction,
  buildBoundedPrompt,
  buildRecoveryHistoryPrefix,
  buildRetryPrompt,
  formatMessages,
  hasExplicitConversationHistory,
  isContextTooLongError,
  truncatePromptMiddle,
} from '../worker/webchat/prompt.mjs'
import { WebChatSessionStore } from '../worker/webchat/session.mjs'
import { webchatConfigured } from '../worker/webchat/sidecar.mjs'

// ---------------------------------------------------------------------------
// models.mjs
// ---------------------------------------------------------------------------
test('deepseekModelConfig resolves aliases and strips the deepseek/ prefix', () => {
  assert.equal(deepseekModelConfig('deepseek-chat').model_type, 'default')
  assert.equal(deepseekModelConfig('deepseek-reasoner').thinking_enabled, true)
  assert.equal(deepseekModelConfig('deepseek-reasoner-search').search_enabled, true)
  assert.equal(deepseekModelConfig('deepseek-expert').model_type, 'expert')
  assert.equal(deepseekModelConfig('deepseek/deepseek-v4-pro').thinking_enabled, true)
  assert.equal(deepseekModelConfig('deepseek').model_type, 'default')
  assert.equal(deepseekModelConfig('nope'), null)
})

test('listDeepseekModels only exposes supported aliases by default', () => {
  const supported = listDeepseekModels()
  assert.ok(supported.includes('deepseek-chat'))
  assert.ok(supported.includes('deepseek-v4-pro'))
  assert.ok(!supported.includes('deepseek-vision'))      // unsupported
  assert.ok(!supported.includes('deepseek-expert-search')) // unsupported
  assert.ok(listDeepseekModels(true).includes('deepseek-vision'))
})

test('deepseekCatalog and qwenCatalog return static model lists', () => {
  const ds = deepseekCatalog()
  assert.ok(ds.some((m) => m.id === 'deepseek-reasoner' && m.description))
  const qw = qwenCatalog()
  // Canonical ids are bare; the qwen/... spellings are compatibility aliases.
  assert.ok(qw.some((m) => m.id === 'qwen3-max'))
  assert.ok(!qw.some((m) => m.id.startsWith('qwen/')))
})

test('qwenResolveModel maps aliases and passes through unknown ids', () => {
  assert.deepEqual(qwenResolveModel('qwen/qwen3-max'), { id: 'qwen3.7-max', thinking: false, requested: 'qwen/qwen3-max' })
  assert.equal(qwenResolveModel('qwen/qwen3-max-thinking').thinking, true)
  assert.equal(qwenResolveModel('qwen/qwen3-plus').id, 'qwen3.7-plus')
  // unknown qwen id passes through
  const pass = qwenResolveModel('qwen/qwen-future')
  assert.equal(pass.id, 'qwen-future')
  // default when empty
  assert.equal(qwenResolveModel('').id, 'qwen3.7-max')
})

// ---------------------------------------------------------------------------
// tools.mjs — schema compaction
// ---------------------------------------------------------------------------
test('compactToolSchema drops annotation keywords but keeps instance values', () => {
  const schema = {
    type: 'object',
    description: 'drop me',
    properties: {
      a: { type: 'string', description: 'drop', const: { description: 'keep-me' } },
      b: { type: 'array', items: { type: 'number', title: 'x' } },
    },
  }
  const compact = compactToolSchema(schema)
  assert.equal(compact.description, undefined)
  assert.equal(compact.properties.a.description, undefined)
  assert.deepEqual(compact.properties.a.const, { description: 'keep-me' })
  assert.equal(compact.properties.b.items.title, undefined)
})

test('formatToolDefinitions builds a system section and never names a proxy host', () => {
  const tools = [
    { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  ]
  const text = formatToolDefinitions(tools, { serverLabel: 'the local gateway' })
  assert.match(text, /read_file/)
  assert.match(text, /TOOL_CALL: <function_name>/)
  assert.doesNotMatch(text, /9655|chat\.deepseek\.com|FreeDeepseekAPI/)
  assert.equal(formatToolDefinitions([]), '')
  assert.equal(formatToolDefinitions(), '')
})

// ---------------------------------------------------------------------------
// tools.mjs — parseToolCall
// ---------------------------------------------------------------------------
test('parseToolCall: strict JSON envelope', () => {
  const tc = parseToolCall('{"tool_call":{"name":"read_file","arguments":{"path":"/tmp/x"}}}')
  assert.equal(tc.name, 'read_file')
  assert.equal(tc.arguments, '{"path":"/tmp/x"}')
})

test('parseToolCall: tool_calls array envelope and function_call', () => {
  const arr = parseToolCall('{"tool_calls":[{"function":{"name":"ls","arguments":{"a":1}}}]}')
  assert.equal(arr.name, 'ls')
  const fn = parseToolCall('{"function_call":{"name":"grep","arguments":{"q":"x"}}}')
  assert.equal(fn.name, 'grep')
})

test('parseToolCall: XML-ish <tool_call> wrapper', () => {
  const tc = parseToolCall('Here is the call: <tool_call>{"name":"git","arguments":{"cmd":"status"}}</tool_call>')
  assert.equal(tc.name, 'git')
})

test('parseToolCall: fenced JSON block', () => {
  const tc = parseToolCall('```json\n{"tool_call":{"name":"curl","arguments":{"url":"http://x"}}}\n```')
  assert.equal(tc.name, 'curl')
})

test('parseToolCall: legacy TOOL_CALL: with balanced JSON', () => {
  const tc = parseToolCall('TOOL_CALL: exec\narguments: {"command":"ls"}')
  assert.equal(tc.name, 'exec')
  assert.equal(tc.arguments, '{"command":"ls"}')
})

test('parseToolCall: bare {name, arguments} object is not executable', () => {
  const tc = parseToolCall('Please use {"name":"foo","arguments":{}} to continue')
  assert.equal(tc, null)
})

test('parseToolCall: DSML invoke with parameters', () => {
  const text = '<tool_calls><invoke name="read_file"><parameter name="path">/etc/hostname</parameter></invoke></tool_calls>'
  const tc = parseToolCall(text)
  assert.equal(tc.name, 'read_file')
  assert.equal(tc.arguments, '{"path":"/etc/hostname"}')
})

test('parseToolCall: DSML direct with CDATA', () => {
  // `direct` has no matching closing tag; its body runs to the end of the
  // tool_calls wrapper (matches upstream behavior).
  const text = '<tool_calls><direct name="write"><parameter name="content"><![CDATA[a<b>c]]></parameter></tool_calls>'
  const tc = parseToolCall(text)
  assert.equal(tc.name, 'write')
  assert.equal(JSON.parse(tc.arguments).content, 'a<b>c')
})

test('parseDsmlToolCall is null on malformed markup', () => {
  assert.equal(parseDsmlToolCall('<tool_calls><invoke name="x"></tool_calls>'), null)
})

test('looksLikeToolCallMarkup and sanitizeContent', () => {
  assert.ok(looksLikeToolCallMarkup('TOOL_CALL: foo'))
  assert.ok(looksLikeToolCallMarkup('||| DSML |||'))
  assert.ok(looksLikeToolCallMarkup('<tool_call>'))
  assert.equal(looksLikeToolCallMarkup('just some text'), false)
  // strip lone surrogate characters
  assert.equal(sanitizeContent('a\ud800b'), 'ab')
  assert.equal(sanitizeContent('a\udc00b'), 'ab')
  // valid surrogate pairs (emoji, CJK extension) must survive
  assert.equal(sanitizeContent('hi 😀 ok'), 'hi 😀 ok')
  assert.equal(sanitizeContent('\ud83d\ude00'), '\ud83d\ude00')
})

test('normalizeMessageContent handles strings, arrays and images', () => {
  assert.equal(normalizeMessageContent('hi'), 'hi')
  assert.equal(normalizeMessageContent(['a', { type: 'text', text: 'b' }, { type: 'image_url', image_url: { url: 'http://i' } }]), 'a\nb\n[Image: http://i]')
  assert.equal(normalizeMessageContent(null), '')
  assert.equal(normalizeMessageContent([{ type: 'tool_result', tool_use_id: 't1', content: 'out' }]), '[Tool Result t1]\nout')
})

// ---------------------------------------------------------------------------
// prompt.mjs
// ---------------------------------------------------------------------------
test('formatMessages builds system prompt with tools and a transcript', () => {
  const messages = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'List files' },
    { role: 'assistant', tool_calls: [{ function: { name: 'ls', arguments: '{}' } }] },
    { role: 'tool', content: 'a.txt' },
    { role: 'user', content: 'thanks' },
  ]
  const { systemPrompt, prompt } = formatMessages(messages, [{ type: 'function', function: { name: 'ls', description: 'list', parameters: {} } }])
  assert.match(systemPrompt, /You are helpful/)
  assert.match(systemPrompt, /TOOL REQUEST SYSTEM/)
  assert.match(systemPrompt, /## ls/)
  assert.match(prompt, /User: List files/)
  assert.match(prompt, /Assistant: TOOL_CALL: ls/)
  assert.match(prompt, /\[Tool Result\]\na\.txt/)
})

test('hasExplicitConversationHistory', () => {
  assert.equal(hasExplicitConversationHistory([{ role: 'user', content: 'x' }]), false)
  assert.equal(hasExplicitConversationHistory([{ role: 'user', content: 'x' }, { role: 'user', content: 'y' }]), true)
  assert.equal(hasExplicitConversationHistory([{ role: 'system', content: 's' }, { role: 'user', content: 'x' }]), false)
  assert.equal(hasExplicitConversationHistory([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'a' }]), true)
})

test('buildRecoveryHistoryPrefix renders exchanges', () => {
  const prefix = buildRecoveryHistoryPrefix([{ user: 'u', assistant: 'a' }])
  assert.match(prefix, /User: u/)
  assert.match(prefix, /Assistant: a/)
  assert.match(prefix, /\[Continue from here\]/)
  assert.equal(buildRecoveryHistoryPrefix([]), '')
})

test('truncatePromptMiddle keeps head and tail around a marker', () => {
  const text = 'A'.repeat(100)
  const out = truncatePromptMiddle(text, 50)
  assert.ok(out.length <= 50)
  assert.match(out, /compacted by the router/)
})

test('buildBoundedPrompt truncates only when needed', () => {
  const small = buildBoundedPrompt('sys', '', 'hi', 80000)
  assert.equal(small.compacted, false)
  const big = buildBoundedPrompt('S'.repeat(400), '', 'C'.repeat(400), 200)
  assert.equal(big.compacted, true)
  assert.ok(big.prompt.length <= 200)
  // history prefix is dropped before truncating conversation
  const withHistory = buildBoundedPrompt('', 'H'.repeat(300), 'C'.repeat(400), 200)
  assert.equal(withHistory.historyDropped, true)
})

test('buildRetryPrompt reports previous size', () => {
  const r = buildRetryPrompt('sys', '', 'conversation', 'previous-long-prompt', 200)
  assert.equal(r.previousPromptChars, 'previous-long-prompt'.length)
})

test('appendPromptInstruction appends a bounded instruction', () => {
  const out = appendPromptInstruction('X'.repeat(500), 'STRICT: do it', 200)
  assert.match(out, /STRICT: do it/)
  assert.ok(out.length <= 200)
})

test('isContextTooLongError matches several phrasings', () => {
  assert.ok(isContextTooLongError({ content: 'context too long' }))
  assert.ok(isContextTooLongError('maximum context length reached'))
  assert.ok(isContextTooLongError('prompt is too large'))
  assert.ok(isContextTooLongError('too many tokens'))
  assert.ok(isContextTooLongError({ type: 'error', message: 'normal message' }) === false)
})

// ---------------------------------------------------------------------------
// session.mjs
// ---------------------------------------------------------------------------
test('WebChatSessionStore getOrCreate and resetRemote', () => {
  const store = new WebChatSessionStore()
  const s = store.getOrCreate('k')
  assert.equal(s.id, null)
  s.id = 'chat-1'
  s.parentMessageId = 'msg-9'
  s.messageCount = 3
  const failed = store.resetRemote('k')
  assert.equal(failed.failedSessionId, 'chat-1')
  assert.equal(store.getOrCreate('k').id, null)
  assert.equal(store.resetRemote('missing'), null)
})

test('prepareForPrompt rolls over on depth and TTL', () => {
  let t = 0
  const store = new WebChatSessionStore({ sessionTtlMs: 1000, now: () => t })
  const s = store.getOrCreate('k')
  s.id = 'chat'
  s.createdAt = 0
  s.messageCount = 99
  assert.equal(store.prepareForPrompt('k'), null) // under depth (100)
  s.messageCount = 100
  assert.equal(store.prepareForPrompt('k').reason, 'max_message_depth')
  s.id = 'chat2'
  s.createdAt = 500 // must be truthy for the TTL branch
  s.messageCount = 1
  t = 2000 // now - createdAt = 1500 > ttl (1000)
  assert.equal(store.prepareForPrompt('k').reason, 'session_ttl')
})

test('storeHistory caps transcript length and entries', () => {
  const store = new WebChatSessionStore()
  for (let i = 0; i < 40; i++) store.storeHistory('k', `prompt ${i}`, 'answer', null)
  const s = store.get('k')
  assert.ok(s.history.length <= 15)
  // tool calls stored as TOOL_CALL:
  store.storeHistory('k', 'p', '', { name: 'exec', arguments: '{}' })
  assert.match(s.history[s.history.length - 1].assistant, /TOOL_CALL: exec/)
})

test('sweepIdle removes stale sessions', () => {
  let t = 0
  const store = new WebChatSessionStore({ now: () => t })
  store.getOrCreate('a')
  t = 10_000_000
  store.getOrCreate('b')
  assert.equal(store.sweepIdle(5_000_000), 1) // 'a' idle, 'b' fresh
  assert.equal(store.size, 1)
})

test('clear removes all sessions', () => {
  const store = new WebChatSessionStore()
  store.getOrCreate('a')
  store.getOrCreate('b')
  assert.equal(store.clear(), 2)
  assert.equal(store.size, 0)
})

test('buildToolCall validates names and argument size', () => {
  assert.equal(buildToolCall('ok_name', {}).name, 'ok_name')
  assert.equal(buildToolCall('', {}), null)
  assert.equal(buildToolCall('bad name!', {}), null)
  assert.equal(buildToolCall('x', [1, 2]), null) // array args rejected
  assert.equal(buildToolCall('x', '{"a":1}').arguments, '{"a":1}')
  assert.equal(buildToolCall('x', 'not json'), null)
})
test('webchatConfigured accepts credentials as a JSON string from the vault', () => {
  const provider = { transport: 'deepseek-web' }
  const creds = JSON.stringify({ token: 't', cookie: 'c' })
  assert.equal(webchatConfigured(provider, creds), true)
  assert.equal(webchatConfigured(provider, JSON.stringify({ token: '' })), false)
  assert.equal(webchatConfigured(provider, 'not json'), false)
})
