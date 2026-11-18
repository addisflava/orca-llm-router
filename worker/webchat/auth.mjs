// Native Chrome/CDP auth capture for the web-chat transports.
//
// Ported from FreeDeepseekAPI's scripts/deepseek_chrome_auth.js, scripts/web_auth.js
// and lib/chrome_session.js, as a self-contained ESM module with no file outputs:
// captured credentials are returned to the caller (the worker saves them into
// `secrets:own` under the provider key's secretKey). Nothing here reads the
// FreeDeepseekAPI repo or writes auth files.
//
// Modes (mirroring upstream):
//   attach  — connect to an already-running Chrome with --remote-debugging-port
//             and use its current profile/login. No new window.
//   profile — copy the login from the normal Chrome profile into a private
//             throwaway profile and open that copy (Chrome 136+ refuses DevTools
//             on the real default profile dir).
//   launch  — start a clean managed profile.
//
// The worker drives the interactive loop (start -> user logs in -> capture ->
// cleanup) via the panel request handlers in main.mjs.

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { homedir, tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Provider profiles (auth shape each transport expects).
// ---------------------------------------------------------------------------
export const AUTH_PROVIDERS = {
  'deepseek-web': {
    id: 'deepseek-web',
    url: 'https://chat.deepseek.com/',
    domain: /deepseek\.com$/i,
    profileName: '.chrome-for-testing-profile-deepseek',
    port: 9222,
    tokenKeys: ['userToken', 'token', 'auth_token', 'access_token', 'accessToken'],
    testPrompt: 'ok',
  },
  'qwen-web': {
    id: 'qwen-web',
    url: 'https://chat.qwen.ai/',
    domain: /(^|\.)qwen\.ai$/i,
    profileName: '.chrome-for-testing-profile-qwen',
    port: 9335,
    tokenKeys: ['token', 'access_token', 'accessToken', 'auth_token', 'userToken'],
    testPrompt: 'ok',
  },
}

export function authProvider(id) {
  return AUTH_PROVIDERS[id] || null
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* noop */ }
}
const isTruthy = (value) => /^(1|true|yes|on|always|require|required)$/i.test(String(value || '').trim())

export function parsePorts(value, defaults = []) {
  const ports = []
  for (const raw of String(value || '').split(/[,\s]+/)) {
    const n = Number(raw)
    if (Number.isInteger(n) && n > 0 && n < 65536 && !ports.includes(n)) ports.push(n)
  }
  if (ports.length) return ports
  for (const d of defaults) {
    const n = Number(d)
    if (Number.isInteger(n) && n > 0 && !ports.includes(n)) ports.push(n)
  }
  return ports
}

async function fetchJson(url, opts = {}, timeoutMs = 2000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal })
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function devtoolsReady(port) {
  try {
    return await fetchJson(`http://127.0.0.1:${port}/json/version`)
  } catch {
    return null
  }
}

export { devtoolsReady }

export async function findDevtools(ports) {
  for (const port of ports) {
    if (await devtoolsReady(port)) return port
  }
  return null
}

// ---------------------------------------------------------------------------
// Chrome discovery.
// ---------------------------------------------------------------------------
export function resolveChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const home = homedir() || ''
  if (home) {
    const cacheRoot = path.join(home, '.cache', 'puppeteer', 'chrome')
    try {
      const candidates = fs.readdirSync(cacheRoot)
        .flatMap((dir) => {
          const baseDir = path.join(cacheRoot, dir)
          if (process.platform === 'darwin') {
            return [
              path.join(baseDir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
              path.join(baseDir, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
            ]
          }
          if (process.platform === 'win32') {
            return [path.join(baseDir, 'chrome-win64', 'chrome.exe'), path.join(baseDir, 'chrome-win64', 'chrome.exe')]
          }
          return [path.join(baseDir, 'chrome-linux64', 'chrome'), path.join(baseDir, 'chrome-linux64', 'chrome.exe')]
        })
        .filter((p) => p && fs.existsSync(p))
        .sort()
        .reverse()
      if (candidates[0]) return candidates[0]
    } catch { /* noop */ }
  }
  if (process.platform === 'win32') {
    for (const c of [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]) if (fs.existsSync(c)) return c
  } else if (process.platform === 'darwin') {
    for (const c of [
      '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]) if (fs.existsSync(c)) return c
  } else {
    for (const c of [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/opt/google/chrome/chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ]) if (fs.existsSync(c)) return c
  }
  return ''
}

// Profile cleanup is deliberately minimal: these directories are ours, live
// in the OS temp folder, and never hold the user's real Chrome profile.
export function removeProfileSafely(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 }) } catch { /* noop */ }
}

// ---------------------------------------------------------------------------
// CDP client.
// ---------------------------------------------------------------------------
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.events = []
    this.closed = false
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        clearTimeout(timer)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      } else if (msg.method) {
        this.events.push(msg)
        if (this.events.length > 400) this.events.shift()
      }
    }
    const failPending = (reason) => {
      this.closed = true
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error(reason))
      }
      this.pending.clear()
    }
    this.ws.onclose = () => failPending('Chrome DevTools connection closed')
    this.ws.onerror = () => failPending('Chrome DevTools connection error')
  }
  ready() {
    if (this.ws.readyState === 1) return Promise.resolve()
    return new Promise((resolve, reject) => {
      // addEventListener keeps the constructor's onerror/onclose handlers intact.
      this.ws.addEventListener('open', () => resolve(), { once: true })
      this.ws.addEventListener('error', (err) => reject(err), { once: true })
    })
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('Chrome DevTools connection closed'))
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      // Never let a stalled page hang a panel request indefinitely.
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Chrome DevTools command timed out: ${method}`))
      }, 15000)
      this.pending.set(id, { resolve, reject, timer })
    })
  }
  close() {
    this.closed = true
    try { this.ws.close() } catch { /* noop */ }
  }
}

export class CDPClient extends CDP {}

// ---------------------------------------------------------------------------
// Page discovery + browser launch.
// ---------------------------------------------------------------------------
async function openOrFindPage(port, url) {
  const base = `http://127.0.0.1:${port}`
  const host = new URL(url).host
  let page = null
  let created = false
  try {
    const targets = await fetchJson(`${base}/json/list`)
    page = targets.find((t) => t.type === 'page' && String(t.url || '').includes(host)) || null
  } catch { /* noop */ }
  if (!page) {
    for (const method of ['PUT', 'GET']) {
      try {
        const res = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method })
        if (!res.ok) continue
        page = await res.json()
        created = true
        break
      } catch { /* noop */ }
    }
  }
  if (!page) {
    const targets = await fetchJson(`${base}/json/list`).catch(() => [])
    page = targets.find((t) => t.type === 'page' && t.url === 'about:blank') || targets.find((t) => t.type === 'page')
    created = Boolean(page && page.url === 'about:blank')
  }
  if (!page || !page.webSocketDebuggerUrl) throw new Error('No Chrome page target available to attach to.')
  try { await fetch(`${base}/json/activate/${page.id}`) } catch { /* noop */ }
  return {
    page,
    created,
    navigate: created || /^about:blank$|^chrome:|^devtools:/i.test(String(page.url || '')),
  }
}

export async function waitDevtools(port, { attempts = 48, child = null, context = '' } = {}) {
  for (let i = 0; i < attempts; i++) {
    const v = await devtoolsReady(port)
    if (v) return v
    // If the browser exited (no display, profile lock, bad binary) fail now
    // with the captured output instead of waiting out the full timeout.
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      // Let pending stderr/stdout 'data' events flush so the error carries the
      // actual reason (e.g. missing XDG_RUNTIME_DIR) instead of a bare code.
      await sleep(150)
      throw new Error(`Chrome exited before DevTools started (code ${child.exitCode ?? child.signalCode}).${context}`)
    }
    await sleep(250)
  }
  throw new Error(`Chrome DevTools endpoint did not start on port ${port}.${context}`)
}

export async function getPageTarget(port, host) {
  for (let i = 0; i < 40; i++) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`)
    const page = targets.find((t) => t.type === 'page' && t.url.includes(host)) || targets.find((t) => t.type === 'page')
    if (page && page.webSocketDebuggerUrl) return page
    await sleep(250)
  }
  throw new Error('No Chrome page target found')
}

// Orca's plugin worker is launched without a desktop session (no DISPLAY,
// XDG_RUNTIME_DIR or DBUS address), so Chrome spawned from it exits with code 1.
// Restore those variables when they are missing but the sockets exist, using
// the same session the user is running Orca in.
export function desktopEnv() {
  const env = { ...process.env }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  const runtime = env.XDG_RUNTIME_DIR || (uid != null ? `/run/user/${uid}` : '')
  if (!env.XDG_RUNTIME_DIR && runtime && fs.existsSync(runtime)) env.XDG_RUNTIME_DIR = runtime
  if (!env.DBUS_SESSION_BUS_ADDRESS && runtime && fs.existsSync(path.join(runtime, 'bus'))) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtime}/bus`
  }
  if (!env.WAYLAND_DISPLAY && runtime && fs.existsSync(path.join(runtime, 'wayland-0'))) {
    env.WAYLAND_DISPLAY = 'wayland-0'
  }
  if (!env.DISPLAY && fs.existsSync('/tmp/.X11-unix/X0')) env.DISPLAY = ':0'
  return env
}

function killExistingTestingChrome(port, profileDir) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return
  const shellPatternSafe = (s) => String(s).replace(/[\\"']/g, '.')
  for (const pattern of [`--remote-debugging-port=${port}`, profileDir].map(shellPatternSafe)) {
    try {
      execFileSync('/usr/bin/pkill', ['-f', pattern], { stdio: 'ignore' })
    } catch { /* noop */ }
  }
  sleepSync(300)
}

/**
 * Launch (or reuse) a Chrome instance for the auth flow. Two lightweight paths
 * only: attach to an existing Chrome with a debug port, or launch a clean
 * temporary profile. There is deliberately no "copy the user's profile" mode —
 * it was slow, fragile, and unnecessary: login happens in the opened window.
 * @returns {Promise<{port: number, profileDir: string, mode: 'attach'|'launch', reused: boolean}>}
 */
export async function startAuthBrowser(providerId, { attachPorts, profileRoot } = {}) {
  const provider = authProvider(providerId)
  if (!provider) throw new Error(`unknown web-chat provider: ${providerId}`)
  const ports = parsePorts(String(process.env.WEB_CDP_PORTS || ''), attachPorts && attachPorts.length ? attachPorts : [9222, provider.port])

  // Cheapest path: an already-running Chrome with a DevTools port. No spawn,
  // no profile directory, nothing to clean up.
  const attachPort = await findDevtools(ports)
  if (attachPort) {
    return { mode: 'attach', port: attachPort, profileDir: '', reused: true }
  }

  const chromePath = resolveChromePath()
  if (!chromePath || !fs.existsSync(chromePath)) {
    throw new Error(`Chrome/Chrome for Testing not found. Set CHROME_PATH to a real browser binary, e.g. CHROME_PATH=$(which chromium)`)
  }

  const port = Number(process.env.WEB_CHROME_PORT || provider.port)
  const root = profileRoot || path.join(tmpdir(), 'orca-router-webchat')
  const profileDir = path.join(root, provider.profileName)
  killExistingTestingChrome(port, profileDir)
  removeProfileSafely(profileDir)
  fs.mkdirSync(profileDir, { recursive: true })

  const launchArgs = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    // Chrome 111+ rejects CDP WebSocket handshakes from unknown origins unless
    // this is set; harmless otherwise and avoids a silent connect failure.
    '--remote-allow-origins=*',
    '--use-mock-keychain',
    '--password-store=basic',
    '--disable-sync',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    provider.url,
  ]
  const launch = () => {
    const output = []
    const collect = (chunk) => {
      const line = String(chunk || '').trim()
      if (line && output.length < 20) output.push(line)
    }
    const child = spawn(chromePath, launchArgs, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: desktopEnv() })
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (err) => collect(err.message))
    child.unref()
    return { child, output }
  }
  const hint = ` Browser: ${chromePath}. Profile: ${profileDir}. If this is a headless machine, Chrome cannot open a visible window — start Chrome yourself with --remote-debugging-port=${port} and use Web login to attach, or use Paste auth JSON.`

  let { child, output } = launch()
  let context = `${hint}${output.length ? ` Chrome output: ${output.slice(-6).join(' | ').substring(0, 400)}` : ''}`
  try {
    await waitDevtools(port, { child, context })
  } catch (firstError) {
    // A previous Chrome may still have held the new profile lock while exiting;
    // clear it and try once more before giving up.
    killExistingTestingChrome(port, profileDir)
    removeProfileSafely(profileDir)
    fs.mkdirSync(profileDir, { recursive: true })
    ;({ child, output } = launch())
    context = `${hint} (retry) ${output.length ? `Chrome output: ${output.slice(-6).join(' | ').substring(0, 400)}` : ''}`
    try {
      await waitDevtools(port, { child, context })
    } catch (retryError) {
      void firstError
      throw new Error(`${retryError.message} (retried once after clearing the profile)`)
    }
  }
  return { mode: 'launch', port, profileDir, reused: false }
}

// ---------------------------------------------------------------------------
// Credential capture.
// ---------------------------------------------------------------------------
function parseMaybeJson(s) {
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

function normalizeToken(raw) {
  if (!raw) return ''
  const parsed = parseMaybeJson(raw)
  if (parsed && typeof parsed === 'object') {
    return parsed.value || parsed.token || parsed.access_token || parsed.accessToken || ''
  }
  return String(raw).trim()
}

async function readPageStores(cdp) {
  const evalRes = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const out = {href: location.href, localStorage:{}, sessionStorage:{}, resources: []};
      for (let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); out.localStorage[k]=localStorage.getItem(k); }
      for (let i=0;i<sessionStorage.length;i++){ const k=sessionStorage.key(i); out.sessionStorage[k]=sessionStorage.getItem(k); }
      out.resources = performance.getEntriesByType('resource').map(r => r.name).filter(n => /wasm|chat\\/completion|pow|chat_session/.test(n)).slice(-100);
      return out;
    })()`,
    returnByValue: true,
  })
  return (evalRes && evalRes.result && evalRes.result.value) || {}
}

function findTokenInStores(stores, tokenKeys) {
  for (const store of stores) {
    for (const key of tokenKeys) {
      const token = normalizeToken(store[key])
      if (token) return token
    }
  }
  for (const store of stores) {
    for (const [k, v] of Object.entries(store)) {
      if (/token/i.test(k)) {
        const token = normalizeToken(v)
        if (token) return token
      }
    }
  }
  return ''
}

function collectHeadersFromEvents(cdp, names) {
  const found = {}
  for (const ev of cdp.events) {
    const h = (ev.params && (ev.params.headers || (ev.params.request && ev.params.request.headers))) || null
    if (!h) continue
    for (const [k, v] of Object.entries(h)) {
      const lk = k.toLowerCase()
      if (names.includes(lk) && !found[lk]) found[lk] = String(v)
    }
  }
  return found
}

/**
 * Capture DeepSeek Web credentials from a page.
 * @returns {{token, cookie, hif_dliq, hif_leim, wasmUrl, baseUrl, href, cookiesCount}}
 */
export async function readDeepSeekAuth(cdp) {
  const pageState = await readPageStores(cdp)
  const stores = [pageState.localStorage || {}, pageState.sessionStorage || {}]
  let token = findTokenInStores(stores, AUTH_PROVIDERS['deepseek-web'].tokenKeys)

  const cookieRes = await cdp.send('Network.getAllCookies')
  const cookies = (cookieRes.cookies || []).filter((c) => /deepseek\.com$/.test(String(c.domain || '')))
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ')

  const headers = collectHeadersFromEvents(cdp, ['x-hif-dliq', 'x-hif-leim', 'authorization'])
  const hif_dliq = headers['x-hif-dliq'] || ''
  const hif_leim = headers['x-hif-leim'] || ''
  // A Bearer header in observed network traffic proves the app made an
  // authenticated request — unlike a stale token left in localStorage.
  const authHeaderSeen = /^Bearer\s+\S/i.test(headers.authorization || '')
  if (!token && authHeaderSeen) token = headers.authorization.replace(/^Bearer\s+/i, '')

  const wasmUrl = (pageState.resources || []).find((u) => /sha3.*\.wasm/.test(u))
    || 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm'

  return {
    token,
    cookie,
    hif_dliq,
    hif_leim,
    wasmUrl,
    authHeaderSeen,
    baseUrl: 'https://chat.deepseek.com',
    href: pageState.href,
    cookiesCount: cookies.length,
  }
}

/**
 * Capture Qwen Web credentials from a page.
 * @returns {{token, cookie, bx_umidtoken, bx_ua, bx_v, spa_version, baseUrl, href, cookiesCount}}
 */
export async function readQwenAuth(cdp) {
  const pageState = await readPageStores(cdp)
  const stores = [pageState.localStorage || {}, pageState.sessionStorage || {}]
  let token = findTokenInStores(stores, AUTH_PROVIDERS['qwen-web'].tokenKeys)

  const cookieRes = await cdp.send('Network.getAllCookies')
  const cookies = (cookieRes.cookies || []).filter((c) => /(^|\.)qwen\.ai$/i.test(String(c.domain || '')))
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ')

  const headers = collectHeadersFromEvents(cdp, ['bx-umidtoken', 'bx-ua', 'bx-v', 'authorization'])
  const tokenCookie = cookies.find((c) => c.name === 'token')
  const authHeaderSeen = /^Bearer\s+\S/i.test(headers.authorization || '')
  if (!token && authHeaderSeen) token = headers.authorization.replace(/^Bearer\s+/i, '')
  if (!token && tokenCookie) token = tokenCookie.value

  return {
    token,
    cookie,
    authHeaderSeen,
    bx_umidtoken: headers['bx-umidtoken'] || '',
    bx_ua: headers['bx-ua'] || '',
    bx_v: headers['bx-v'] || '',
    spa_version: '',
    baseUrl: 'https://chat.qwen.ai',
    href: pageState.href,
    cookiesCount: cookies.length,
  }
}

export const authReaders = {
  'deepseek-web': readDeepSeekAuth,
  'qwen-web': readQwenAuth,
}

/**
 * Connect to a page target and prepare Runtime/Network for capture.
 * @returns {Promise<{cdp: CDPClient, page}>}
 */
export async function connectPageTarget(port, url) {
  const found = await openOrFindPage(port, url)
  const cdp = new CDPClient(found.page.webSocketDebuggerUrl)
  await cdp.ready()
  if (found.navigate) {
    try { await cdp.send('Page.navigate', { url }) } catch { /* noop */ }
    await sleep(1200)
  }
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  return { cdp, page: found.page, created: found.created }
}

/**
 * Poll-capture credentials, waiting up to `attempts` for token+cookie.
 * Closes the CDP connection when done.
 * @returns {Promise<{ok: boolean, auth: object|null}>}
 */
export async function captureAuth(providerId, { port, url, cdp, attempts = 20, close = true, requireLiveSession = false } = {}) {
  const reader = authReaders[providerId]
  if (!reader) throw new Error(`unknown web-chat provider: ${providerId}`)
  let auth = null
  for (let i = 0; i < attempts; i++) {
    auth = await reader(cdp)
    // A token in localStorage + any site cookie is NOT proof of a login — it
    // can be a stale session. Automatic capture additionally requires that the
    // page actually made an authenticated request (observed Bearer header).
    const headersComplete = providerId !== 'deepseek-web' || Boolean(auth.hif_dliq || auth.hif_leim)
    const complete = auth.token && auth.cookie
      && (!requireLiveSession || (auth.authHeaderSeen && headersComplete))
    if (complete) break
    await sleep(500)
  }
  // `close: false` lets the panel poll repeatedly with the same CDP connection
  // (and keeps the accumulated header events between attempts).
  if (close) cdp.close()
  const ok = Boolean(auth && auth.token && auth.cookie
    && (!requireLiveSession || (auth.authHeaderSeen && (providerId !== 'deepseek-web' || auth.hif_dliq || auth.hif_leim))))
  return { ok, auth }
}
