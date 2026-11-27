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
