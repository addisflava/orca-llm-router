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
