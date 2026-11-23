// Dependency-free outbound tunneling for the gateway. Routes can attach a
// reusable HTTP CONNECT or SOCKS5 server; the sidecar calls fetchViaVpn for
// that route's upstream requests. Plain (no server) requests use native fetch.
//
// Credentials are never read from the URL or config: the config stores only a
// secret name, and getSecret() resolves it at request time.

import { request as httpRequest } from 'node:http'
import { connect as netConnect, isIP } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { Duplex } from 'node:stream'

const CONNECT_TIMEOUT_MS = 15_000
const HEADER_TIMEOUT_MS = 30_000
const MAX_LINE_CHARS = 64 * 1024
const HOP_BY_HOP = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding',
  'upgrade', 'te', 'trailer', 'proxy-authenticate', 'proxy-authorization'
])

const slug = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '')

/**
 * One working public US HTTP proxy, offered as a starter entry in Settings so
 * the VPN feature can be tried immediately. It is never attached to a route
 * automatically, and the panel warns that public proxies are untrusted.
 */
export const SAMPLE_VPN_SERVER = {
  id: 'sample-us-proxy',
  name: 'Free US proxy (sample)',
  type: 'http',
  host: '47.85.161.37',
  port: 3128,
  enabled: true
}

export function normalizeVpnServer(raw, used = new Set()) {
  if (!raw || typeof raw !== 'object') return null
  let type = String(raw.type ?? '').toLowerCase()
  let host = String(raw.host ?? '').trim()
  let port = Number(raw.port)
  const url = String(raw.url ?? '').trim()
  if (!host && url) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') type = 'http'
      else if (['socks:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) type = 'socks5'
      host = parsed.hostname
      port = parsed.port ? Number(parsed.port) : NaN
      // Any user:pass in the URL is intentionally discarded. Credentials live
      // in Orca's secret store, never in config, logs or exported JSON.
    } catch {
      /* invalid URL; fall through to explicit fields */
    }
  }
  if (type !== 'http' && type !== 'socks5') return null
  host = host.replace(/^\[|\]$/g, '')
  if (!host || /[\s/@]/.test(host)) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) port = type === 'socks5' ? 1080 : 8080
  const name = String(raw.name ?? '').trim() || `${type.toUpperCase()} ${host}:${port}`
  let id = String(raw.id ?? '').trim() || slug(name) || `vpn-${slug(host)}-${port}`
  if (used.has(id)) {
    let suffix = 2
    while (used.has(`${id}-${suffix}`)) suffix++
    id = `${id}-${suffix}`
  }
  used.add(id)
  const secretKey = String(raw.secretKey ?? '').trim()
  return {
    id,
    name,
    type,
    host,
    port,
    enabled: raw.enabled !== false,
    ...(secretKey ? { secretKey } : {})
  }
}

export function normalizeVpnServers(input) {
  const used = new Set()
  const out = []
  for (const raw of Array.isArray(input) ? input : []) {
    const server = normalizeVpnServer(raw, used)
    if (server) out.push(server)
  }
  return out
}

/** Resolve a route's vpn id against the current config. Disabled servers are direct. */
export function findVpnServer(config, id) {
  if (!id) return null
  return (config?.vpnServers ?? []).find((server) => server?.id === id && server.enabled !== false) ?? null
}

function vpnCredentials(server, getSecret) {
  if (!server.secretKey) return null
  let raw = null
  try { raw = getSecret(server.secretKey) } catch { /* unavailable secret */ }
  if (raw == null) return null
  const text = typeof raw === 'string' ? raw : String(raw)
  if (!text.trim()) return null
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { username: String(parsed.username ?? ''), password: String(parsed.password ?? '') }
    }
  } catch {
    /* a bare string is treated as a password with no username */
  }
  return { username: '', password: text }
}

// A small byte queue that lets the handshake and header parser read exact byte
// counts off a socket while leaving any already-received bytes for the caller.
class ByteQueue {
  constructor(stream) {
    this.stream = stream
    this.chunks = []
    this.length = 0
    this.ended = false
    this.error = null
    this.waiters = []
    this._onData = (chunk) => {
      const buffer = Buffer.from(chunk)
      if (!buffer.length) return
      this.chunks.push(buffer)
      this.length += buffer.length
      this._wake()
    }
    this._onEnd = () => { this.ended = true; this._wake() }
    this._onError = (error) => { this.error = error; this.ended = true; this._wake() }
    stream.on('data', this._onData)
    stream.on('end', this._onEnd)
    stream.on('error', this._onError)
    stream.on('close', this._onEnd)
  }

  _wake() {
    while (this.waiters.length && (this.length > 0 || this.ended)) this.waiters.shift().resolve()
  }

  _wait() {
    return new Promise((resolve) => this.waiters.push({ resolve }))
  }

  take(count) {
    if (count <= 0) return Buffer.alloc(0)
    const parts = []
    let remaining = count
    while (remaining > 0 && this.chunks.length) {
      const chunk = this.chunks[0]
      if (chunk.length <= remaining) {
        parts.push(this.chunks.shift())
        remaining -= chunk.length
      } else {
        parts.push(chunk.subarray(0, remaining))
        this.chunks[0] = chunk.subarray(remaining)
        remaining = 0
      }
    }
    this.length -= count - remaining
    return parts.length === 1 ? parts[0] : Buffer.concat(parts)
  }

  async readExactly(count) {
    while (this.length < count) {
      if (this.ended) throw this.error ?? new Error('connection closed before the response completed')
      await this._wait()
    }
    return this.take(count)
  }

  async readLine() {
    const bytes = []
    for (;;) {
      const byte = await this.readExactly(1)
      bytes.push(byte[0])
      if (byte[0] === 0x0a) break
      if (bytes.length > MAX_LINE_CHARS) throw new Error('response line too long')
    }
    let line = Buffer.from(bytes).toString('utf8')
    if (line.endsWith('\r\n')) line = line.slice(0, -2)
    else if (line.endsWith('\n')) line = line.slice(0, -1)
    return line
  }

  async readSome() {
    if (!this.length && !this.ended) await this._wait()
    if (this.length) return this.take(this.length)
    if (this.error) throw this.error
    return Buffer.alloc(0)
  }

  detach() {
    this.stream.off('data', this._onData)
    this.stream.off('end', this._onEnd)
    this.stream.off('error', this._onError)
    this.stream.off('close', this._onEnd)
  }
}

// After the SOCKS5 handshake the socket may already have data buffered. This
// duplex replays those bytes before handing the socket to TLS or HTTP.
class SocketDuplex extends Duplex {
  constructor(socket, leftover = Buffer.alloc(0)) {
    super()
    this._socket = socket
    this._leftover = leftover.length ? leftover : null
    this._onData = (chunk) => { if (!this.push(chunk)) socket.pause() }
    this._onEnd = () => this.push(null)
    this._onError = (error) => this.destroy(error)
    socket.on('data', this._onData)
    socket.on('end', this._onEnd)
    socket.on('error', this._onError)
    socket.on('close', this._onEnd)
  }

  _read() {
    if (this._leftover) {
      const leftover = this._leftover
      this._leftover = null
      this.push(leftover)
    }
    this._socket.resume()
  }

  _write(chunk, encoding, callback) {
    this._socket.write(chunk, encoding, callback)
  }

  _final(callback) {
    this._socket.end(callback)
  }

  _destroy(error, callback) {
    this._socket.off('data', this._onData)
    this._socket.off('end', this._onEnd)
    this._socket.off('error', this._onError)
    this._socket.off('close', this._onEnd)
    this._socket.destroy()
    callback(error)
  }
}

function connectHttpProxy(server, host, port, credentials, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return }
    const headers = { Host: `${host}:${port}` }
    if (credentials?.username || credentials?.password) {
      const basic = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')
      headers['Proxy-Authorization'] = `Basic ${basic}`
    }
    const req = httpRequest({
      host: server.host,
      port: server.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      agent: false
    })
    const timer = setTimeout(() => req.destroy(new Error('proxy CONNECT timed out')), CONNECT_TIMEOUT_MS)
    const onAbort = () => req.destroy(signal.reason ?? new Error('aborted'))
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    req.on('connect', (res, socket) => {
      cleanup()
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`proxy CONNECT failed with ${res.statusCode}`))
        return
      }
      resolve(socket)
    })
    req.on('error', (error) => { cleanup(); reject(error) })
    req.on('timeout', () => req.destroy(new Error('proxy CONNECT timed out')))
    req.end()
  })
}

function connectSocks5(server, host, port, credentials, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return }
    const socket = netConnect({ host: server.host, port: server.port })
    let queue = null
    let finished = false
    const timer = setTimeout(() => fail(new Error('SOCKS5 handshake timed out')), CONNECT_TIMEOUT_MS)
    const fail = (error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      queue?.detach()
      socket.destroy()
      reject(error)
    }
    const onAbort = () => fail(signal.reason ?? new Error('aborted'))
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    socket.on('error', fail)
    socket.on('connect', async () => {
      try {
        queue = new ByteQueue(socket)
        const useAuth = Boolean(credentials?.username || credentials?.password)
        // Offer username/password first, then no-auth, as a fallback.
        socket.write(Buffer.from(useAuth ? [0x05, 2, 0x02, 0x00] : [0x05, 1, 0x00]))
        const greeting = await queue.readExactly(2)
        if (greeting[0] !== 0x05) throw new Error('invalid SOCKS5 greeting')
        if (greeting[1] === 0xff) throw new Error('SOCKS5 proxy has no acceptable auth method')
        if (greeting[1] === 0x02) {
          if (!useAuth) throw new Error('SOCKS5 proxy requires authentication')
          const user = Buffer.from(credentials.username ?? '', 'utf8')
          const pass = Buffer.from(credentials.password ?? '', 'utf8')
          socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
          const reply = await queue.readExactly(2)
          if (reply[1] !== 0x00) throw new Error('SOCKS5 authentication failed')
        } else if (greeting[1] !== 0x00) {
          throw new Error(`unsupported SOCKS5 auth method ${greeting[1]}`)
        }
        let address
        if (isIP(host) === 4) {
          address = Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split('.').map(Number))])
        } else {
          // Send literals as a hostname so DNS resolution happens at the proxy,
          // never on the machine running the gateway.
          const hostname = Buffer.from(host, 'utf8')
          if (hostname.length > 255) throw new Error('SOCKS5 host name too long')
          address = Buffer.concat([Buffer.from([0x03, hostname.length]), hostname])
        }
        const portBytes = Buffer.alloc(2)
        portBytes.writeUInt16BE(port)
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), address, portBytes]))
        const reply = await queue.readExactly(4)
        if (reply[0] !== 0x05 || reply[1] !== 0x00) throw new Error(`SOCKS5 connect failed (${reply[1]})`)
        const atyp = reply[3]
        const length = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? (await queue.readExactly(1))[0] : -1
        if (length < 0) throw new Error('invalid SOCKS5 reply')
        await queue.readExactly(length + 2)
        const leftover = queue.take(queue.length)
        queue.detach()
        finished = true
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        resolve(new SocketDuplex(socket, leftover))
      } catch (error) {
        fail(error)
      }
    })
  })
}

async function requestBody(init) {
  const body = init.body
  if (body == null) return Buffer.alloc(0)
  if (Buffer.isBuffer(body)) return body
  if (typeof body === 'string') return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (typeof body.text === 'function') return Buffer.from(await body.text())
  return Buffer.from(String(body))
}

function requestHead(target, init, body) {
  const method = String(init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers ?? {})
  for (const name of HOP_BY_HOP) headers.delete(name)
  headers.set('host', target.host)
  // We decode chunked bodies ourselves and do not implement decompression.
  headers.set('accept-encoding', 'identity')
  if (body.length || ['POST', 'PUT', 'PATCH'].includes(method)) headers.set('content-length', String(body.length))
  // A CONNECT tunnel already targets the origin, so use origin-form for both
  // http and https (absolute-form is only needed for non-tunneled proxies).
  const lines = [`${method} ${target.pathname}${target.search} HTTP/1.1`]
  for (const [name, value] of headers) lines.push(`${name}: ${value}`)
  return `${lines.join('\r\n')}\r\n\r\n`
}

async function readResponseHead(queue) {
  const statusLine = await queue.readLine()
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine)
  if (!match) throw new Error(`invalid upstream response: ${statusLine.slice(0, 120)}`)
  const headers = new Headers()
  for (;;) {
    const line = await queue.readLine()
    if (!line) break
    const colon = line.indexOf(':')
    if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  return { status: Number(match[1]), statusText: match[2] ?? '', headers }
}

function bodyStream(queue, stream, { chunked, contentLength, noBody, signal }) {
  let finished = false
  const onAbort = () => stream.destroy(signal.reason ?? new Error('aborted'))
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  const finish = () => {
    finished = true
    if (signal) signal.removeEventListener('abort', onAbort)
    queue.detach()
    stream.destroy()
  }
  return new ReadableStream({
    async pull(controller) {
      if (finished) { controller.close(); return }
      try {
        if (noBody) {
          finish()
          controller.close()
          return
        }
        if (chunked) {
          const line = await queue.readLine()
          const size = Number.parseInt(line.split(';')[0], 16)
          if (!Number.isFinite(size) || size < 0) throw new Error('invalid chunk size')
          if (size === 0) {
            for (;;) { if (!(await queue.readLine())) break }
            finish()
            controller.close()
            return
          }
          controller.enqueue(await queue.readExactly(size))
          await queue.readExactly(2) // trailing CRLF
          return
        }
        if (contentLength != null) {
          const data = await queue.readExactly(contentLength)
          finish()
          if (data.length) controller.enqueue(data)
          controller.close()
          return
        }
        const data = await queue.readSome()
        if (data.length) controller.enqueue(data)
        if (queue.ended) {
          finish()
          controller.close()
        }
      } catch (error) {
        finish()
        controller.error(error)
      }
    },
    cancel() {
      if (!finished) finish()
    }
  })
}

/**
 * Create a fetch function that optionally tunnels through a VPN/proxy server.
 * With no server it delegates to baseFetch unchanged, so existing routes are
 * byte-for-byte identical to native fetch.
 */
export function createProxyFetch({ getSecret = () => null, baseFetch = globalThis.fetch } = {}) {
  return async function fetchViaVpn(url, init = {}, server) {
    if (!server || server.enabled === false) return baseFetch(url, init)
    const target = new URL(typeof url === 'string' ? url : String(url))
    const signal = init.signal ?? null
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    const credentials = vpnCredentials(server, getSecret)
    const host = target.hostname.replace(/^\[|\]$/g, '')
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80)

    let tunnel
    let stream
    try {
      tunnel = server.type === 'socks5'
        ? await connectSocks5(server, host, port, credentials, signal)
        : await connectHttpProxy(server, host, port, credentials, signal)
      stream = tunnel
      if (target.protocol === 'https:') {
        const secure = tlsConnect({ socket: tunnel, servername: host })
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('TLS handshake timed out')), CONNECT_TIMEOUT_MS)
          const onError = (error) => { clearTimeout(timer); reject(error) }
          secure.once('error', onError)
          secure.once('secureConnect', () => {
            clearTimeout(timer)
            secure.off('error', onError)
            resolve()
          })
        })
        stream = secure
      }
      const queue = new ByteQueue(stream)
      const body = await requestBody(init)
      stream.write(requestHead(target, init, body))
      if (body.length) stream.write(body)
      const timer = setTimeout(() => stream.destroy(new Error('upstream response headers timed out')), HEADER_TIMEOUT_MS)
      let head
      try {
        head = await readResponseHead(queue)
      } finally {
        clearTimeout(timer)
      }
      const noBody = head.status === 204 || head.status === 304 || String(init.method ?? 'GET').toUpperCase() === 'HEAD'
      const chunked = /(?:^|,)\s*chunked\s*(?:,|$)/i.test(head.headers.get('transfer-encoding') ?? '')
      const contentLengthRaw = head.headers.get('content-length')
      const contentLength = noBody || chunked || contentLengthRaw == null ? null : Number(contentLengthRaw)
      const headers = new Headers()
      for (const [name, value] of head.headers) {
        if (!HOP_BY_HOP.has(name.toLowerCase())) headers.append(name, value)
      }
      return new Response(
        noBody ? null : bodyStream(queue, stream, { chunked, contentLength, noBody, signal }),
        { status: head.status, statusText: head.statusText, headers }
      )
    } catch (error) {
      if (stream && !stream.destroyed) stream.destroy()
      else if (tunnel && !tunnel.destroyed) tunnel.destroy()
      throw error
    }
  }
}

export default createProxyFetch
