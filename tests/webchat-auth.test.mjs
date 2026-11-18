// Tests for the CDP auth capture logic (fake CDP client — no real browser).
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parsePorts,
  readDeepSeekAuth,
  readQwenAuth,
  captureAuth,
  authProvider,
  AUTH_PROVIDERS,
  resolveChromePath,
  desktopEnv,
} from '../worker/webchat/auth.mjs'

function fakeCdp({ pageState = {}, cookies = [], events = [] }) {
  return {
    events,
    close() { this.closed = true },
    send: async (method) => {
      if (method === 'Runtime.evaluate') return { result: { value: pageState } }
      if (method === 'Network.getAllCookies') return { cookies }
      throw new Error('unexpected CDP method ' + method)
    },
  }
}

test('parsePorts parses and de-duplicates port lists', () => {
  assert.deepEqual(parsePorts('9222, 9335'), [9222, 9335])
  assert.deepEqual(parsePorts('9222,9222'), [9222])
  assert.deepEqual(parsePorts('bogus'), [])
  assert.deepEqual(parsePorts('', [9222, 9335]), [9222, 9335])
})

test('authProvider exposes deepseek-web and qwen-web', () => {
  assert.equal(authProvider('deepseek-web').url, 'https://chat.deepseek.com/')
  assert.equal(authProvider('qwen-web').domain.test('.qwen.ai'), true)
  assert.equal(authProvider('nope'), null)
  assert.equal(resolveChromePath() === '' || typeof resolveChromePath() === 'string', true)
})

test('readDeepSeekAuth extracts token, deepseek cookies, hif headers and wasmUrl', async () => {
  const cdp = fakeCdp({
    pageState: {
      href: 'https://chat.deepseek.com/',
      localStorage: { userToken: JSON.stringify({ value: 'tok-123' }) },
      sessionStorage: {},
      resources: ['https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm'],
    },
    cookies: [
      { name: 'sessionid', value: 'abc', domain: '.deepseek.com' },
      { name: 'unrelated', value: 'x', domain: 'example.com' },
    ],
    events: [{ params: { headers: { 'x-hif-dliq': 'd1', 'x-hif-leim': 'l1' } } }],
  })
  const auth = await readDeepSeekAuth(cdp)
  assert.equal(auth.token, 'tok-123')
  assert.equal(auth.cookie, 'sessionid=abc')
  assert.equal(auth.hif_dliq, 'd1')
  assert.equal(auth.hif_leim, 'l1')
  assert.equal(auth.cookiesCount, 1)
  assert.match(auth.wasmUrl, /sha3.*\.wasm/)
  assert.equal(auth.baseUrl, 'https://chat.deepseek.com')
})

test('readDeepSeekAuth falls back to the default wasm URL and Authorization header', async () => {
  const cdp = fakeCdp({
    pageState: { href: 'https://chat.deepseek.com/', localStorage: {}, sessionStorage: {}, resources: [] },
    cookies: [{ name: 'a', value: '1', domain: 'chat.deepseek.com' }],
    events: [{ params: { request: { headers: { authorization: 'Bearer hdr-token' } } } }],
  })
  const auth = await readDeepSeekAuth(cdp)
  assert.equal(auth.token, 'hdr-token')
  assert.ok(auth.wasmUrl.includes('fe-static.deepseek.com'))
})

test('readQwenAuth extracts token, qwen cookies and bx headers', async () => {
  const cdp = fakeCdp({
    pageState: { href: 'https://chat.qwen.ai/', localStorage: { token: 'q-token' }, sessionStorage: {} },
    cookies: [
      { name: 'cna', value: 'c1', domain: '.qwen.ai' },
      { name: 'token', value: 'cookie-token', domain: '.qwen.ai' },
      { name: 'other', value: 'x', domain: 'baidu.com' },
    ],
    events: [{ params: { request: { headers: { 'bx-umidtoken': 'u1', 'bx-ua': 'ua1', 'bx-v': '2.5.36' } } } }],
  })
  const auth = await readQwenAuth(cdp)
  assert.equal(auth.token, 'q-token') // localStorage wins over the token cookie
  assert.equal(auth.cookie, 'cna=c1; token=cookie-token')
  assert.equal(auth.bx_umidtoken, 'u1')
  assert.equal(auth.bx_ua, 'ua1')
  assert.equal(auth.bx_v, '2.5.36')
  assert.equal(auth.cookiesCount, 2)
  assert.equal(auth.baseUrl, 'https://chat.qwen.ai')
})

test('readQwenAuth falls back to the token cookie when localStorage is empty', async () => {
  const cdp = fakeCdp({
    pageState: { href: 'https://chat.qwen.ai/', localStorage: {}, sessionStorage: {} },
    cookies: [{ name: 'token', value: 'cookie-token', domain: '.qwen.ai' }],
    events: [],
  })
  const auth = await readQwenAuth(cdp)
  assert.equal(auth.token, 'cookie-token')
})

test('captureAuth polls until token+cookie and reports ok', async () => {
  const cdp = fakeCdp({
    pageState: { href: 'https://chat.qwen.ai/', localStorage: { token: 't' }, sessionStorage: {} },
    cookies: [{ name: 'cna', value: '1', domain: '.qwen.ai' }],
    events: [],
  })
  const { ok, auth } = await captureAuth('qwen-web', { port: 0, url: 'https://chat.qwen.ai/', cdp })
  assert.equal(ok, true)
  assert.equal(auth.token, 't')
  assert.equal(cdp.closed, true)
})

test('captureAuth reports not-ok when credentials are missing', async () => {
  const cdp = fakeCdp({
    pageState: { href: 'https://chat.qwen.ai/', localStorage: {}, sessionStorage: {} },
    cookies: [],
    events: [],
  })
  const { ok, auth } = await captureAuth('qwen-web', { port: 0, url: 'https://chat.qwen.ai/', cdp, attempts: 2 })
  assert.equal(ok, false)
  assert.equal(auth.token, '')
})
test('captureAuth with close:false keeps the connection open across polls', async () => {
  let ready = false
  const cdp = {
    events: [],
    closed: false,
    close() { this.closed = true },
    send: async (method) => {
      if (method === 'Runtime.evaluate') {
        return {
          result: {
            value: {
              href: 'https://chat.qwen.ai/',
              localStorage: ready ? { token: 'late-token' } : {},
              sessionStorage: {}
            }
          }
        }
      }
      if (method === 'Network.getAllCookies') {
        return { cookies: ready ? [{ name: 'cna', value: '1', domain: '.qwen.ai' }] : [] }
      }
      throw new Error('unexpected CDP method ' + method)
    }
  }
  const first = await captureAuth('qwen-web', { cdp, attempts: 1, close: false })
  assert.equal(first.ok, false)
  assert.equal(cdp.closed, false, 'the CDP connection is kept for the next poll')

  ready = true // simulate the user completing the browser login
  const second = await captureAuth('qwen-web', { cdp, attempts: 1, close: false })
  assert.equal(second.ok, true)
  assert.equal(second.auth.token, 'late-token')
  assert.equal(second.auth.cookie, 'cna=1')
})

test('desktopEnv restores the desktop session variables for a display-less worker', () => {
  const saved = {}
  const keys = ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
  for (const key of keys) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  try {
    const env = desktopEnv()
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (uid != null) {
      assert.equal(env.XDG_RUNTIME_DIR, `/run/user/${uid}`)
      assert.equal(env.DBUS_SESSION_BUS_ADDRESS, `unix:path=/run/user/${uid}/bus`)
      assert.equal(env.WAYLAND_DISPLAY, 'wayland-0')
    }
    assert.ok(env.PATH, 'the rest of the environment is preserved')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('captureAuth requireLiveSession rejects stale localStorage creds without an authenticated request', async () => {
  let bearerSeen = false
  const cdp = {
    events: [],
    close() {},
    send: async (method) => {
      if (method === 'Runtime.evaluate') {
        return {
          result: {
            value: {
              href: 'https://chat.deepseek.com/',
              // Stale token left over from a previous session.
              localStorage: { userToken: JSON.stringify({ value: 'stale-token' }) },
              sessionStorage: {},
              resources: []
            }
          }
        }
      }
      if (method === 'Network.getAllCookies') {
        // A tracking cookie, not proof of a login.
        return { cookies: [{ name: 'tracker', value: '1', domain: '.deepseek.com' }] }
      }
      throw new Error('unexpected CDP method ' + method)
    }
  }
  // Auto-capture must NOT accept stale creds with no observed Bearer header.
  const stale = await captureAuth('deepseek-web', { cdp, attempts: 1, close: false, requireLiveSession: true })
  assert.equal(stale.ok, false, 'stale credentials are not accepted as a login')

  // Once the app actually makes an authenticated request, capture succeeds.
  bearerSeen = true
  cdp.events.push({ params: { headers: { authorization: 'Bearer fresh-token', 'x-hif-dliq': 'dliq-value' } } })
  const live = await captureAuth('deepseek-web', { cdp, attempts: 1, close: false, requireLiveSession: true })
  assert.equal(live.ok, true, 'a real authenticated request is accepted')
  assert.equal(live.auth.authHeaderSeen, true)
  assert.equal(bearerSeen, true)
})
