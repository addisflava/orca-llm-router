import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createNetServer, connect as netConnect } from 'node:net'
import { once } from 'node:events'
import test from 'node:test'
import { createProxyFetch, findVpnServer, normalizeVpnServer, normalizeVpnServers } from '../worker/proxy.mjs'

function closeServer(server, sockets = new Set()) {
  for (const socket of sockets) socket.destroy()
  return new Promise((resolve) => server.close(resolve))
}

function track(server) {
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return sockets
}

function listen(server) {
  const sockets = track(server)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    close: () => closeServer(server, sockets)
  })))
}

async function httpProxy() {
  const authHeaders = []
  const sockets = new Set()
  const server = createServer()
  server.on('connect', (req, clientSocket, head) => {
    sockets.add(clientSocket)
    clientSocket.on('close', () => sockets.delete(clientSocket))
    authHeaders.push(req.headers['proxy-authorization'] ?? null)
    const [host, port] = req.url.split(':')
    const upstream = netConnect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    authHeaders,
    close: () => closeServer(server, sockets)
  }
}

async function socks5Proxy({ username = '', password = '' } = {}) {
  const connects = []
  const sockets = new Set()
  const server = createNetServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let phase = 'greeting'
    let buffer = Buffer.alloc(0)
    const needsAuth = Boolean(username)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (phase === 'greeting') {
          if (buffer.length < 2) return
          const count = buffer[1]
          if (buffer.length < 2 + count) return
          const methods = [...buffer.subarray(2, 2 + count)]
          buffer = buffer.subarray(2 + count)
          assert.ok(needsAuth ? methods.includes(0x02) : methods.includes(0x00))
          socket.write(Buffer.from([0x05, needsAuth ? 0x02 : 0x00]))
          phase = needsAuth ? 'auth' : 'connect'
          continue
        }
        if (phase === 'auth') {
          if (buffer.length < 2) return
          const userLen = buffer[1]
          if (buffer.length < 2 + userLen + 1) return
          const passLen = buffer[2 + userLen]
          if (buffer.length < 3 + userLen + passLen) return
          const user = buffer.subarray(2, 2 + userLen).toString()
          const pass = buffer.subarray(3 + userLen, 3 + userLen + passLen).toString()
          buffer = buffer.subarray(3 + userLen + passLen)
          socket.write(Buffer.from([0x01, user === username && pass === password ? 0x00 : 0x01]))
          phase = 'connect'
          continue
        }
        if (phase === 'connect') {
          if (buffer.length < 5) return
          const atyp = buffer[3]
          let offset = 4
          let host
          if (atyp === 0x03) {
            const length = buffer[4]
            if (buffer.length < 5 + length + 2) return
            host = buffer.subarray(5, 5 + length).toString()
            offset = 5 + length
          } else if (atyp === 0x01) {
            if (buffer.length < 10) return
            host = [...buffer.subarray(4, 8)].join('.')
            offset = 8
          } else {
            assert.fail(`unexpected atyp ${atyp}`)
          }
          const port = buffer.readUInt16BE(offset)
          buffer = buffer.subarray(offset + 2)
          connects.push({ host, port })
          const upstream = netConnect(port, host, () => {
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80]))
            upstream.pipe(socket)
            socket.pipe(upstream)
          })
          upstream.on('error', () => socket.destroy())
          phase = 'tunnel'
          continue
        }
        return
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    connects,
    close: () => closeServer(server, sockets)
  }
}

test('normalizeVpnServer accepts explicit fields and URL shorthand, never URL credentials', () => {
  const server = normalizeVpnServer({ id: 'vpn-main', name: 'Main', type: 'socks5', host: '10.0.0.2', port: 1080, secretKey: 'vpn.main' })
  assert.deepEqual(server, { id: 'vpn-main', name: 'Main', type: 'socks5', host: '10.0.0.2', port: 1080, enabled: true, secretKey: 'vpn.main' })
  const fromUrl = normalizeVpnServer({ url: 'http://alice:secret@proxy.example:3128' })
  assert.equal(fromUrl.type, 'http')
  assert.equal(fromUrl.host, 'proxy.example')
  assert.equal(fromUrl.port, 3128)
  assert.equal(fromUrl.secretKey, undefined)
  assert.equal(normalizeVpnServer({ type: 'wireguard', host: 'x' }), null)
  assert.equal(normalizeVpnServer({ type: 'http', host: '' }), null)
  assert.deepEqual(normalizeVpnServers([{ id: 'a', type: 'http', host: 'h' }, { id: 'a', type: 'http', host: 'g' }]).map((s) => s.id), ['a', 'a-2'])
  assert.equal(findVpnServer({ vpnServers: [server] }, 'vpn-main'), server)
  assert.equal(findVpnServer({ vpnServers: [{ ...server, enabled: false }] }, 'vpn-main'), null)
})

test('HTTP CONNECT tunnel forwards the request and streams chunked responses', async () => {
  const upstream = createServer((req, res) => {
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'transfer-encoding': 'chunked' })
      res.write('data: one\n\n')
      res.write('data: two\n\n')
      res.end()
      return
    }
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-custom': 'yes' })
      res.end(JSON.stringify({ ok: true, method: req.method, body, auth: req.headers['proxy-authorization'] ?? null, encoding: req.headers['accept-encoding'] }))
    })
  })
  const local = await listen(upstream)
  const proxy = await httpProxy()
  const server = { id: 'p', name: 'P', type: 'http', host: '127.0.0.1', port: proxy.port, enabled: true, secretKey: 'vpn.p' }
  const fetchViaVpn = createProxyFetch({
    getSecret: (key) => key === 'vpn.p' ? JSON.stringify({ username: 'alice', password: 'pw' }) : null,
    baseFetch: () => { throw new Error('direct fetch must not be used') }
  })

  const response = await fetchViaVpn(`http://127.0.0.1:${local.port}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' })
  }, server)
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('x-custom'), 'yes')
  assert.deepEqual(await response.json(), {
    ok: true, method: 'POST', body: '{"hello":"world"}',
    // Proxy auth belongs to the proxy, never to the upstream provider.
    auth: null,
    encoding: 'identity'
  })
  assert.deepEqual(proxy.authHeaders, [`Basic ${Buffer.from('alice:pw').toString('base64')}`])

  const streamed = await fetchViaVpn(`http://127.0.0.1:${local.port}/sse`, {}, server)
  const reader = streamed.body.getReader()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += Buffer.from(value).toString()
  }
  assert.equal(text, 'data: one\n\ndata: two\n\n')

  const direct = await createProxyFetch({ baseFetch: () => 'direct' })('http://x', {}, null)
  assert.equal(direct, 'direct')
  await proxy.close()
  await local.close()
})

test('SOCKS5 tunnel sends hostname to the proxy and authenticates from the secret store', async () => {
  const upstream = createServer((req, res) => res.end('hello'))
  const local = await listen(upstream)
  const proxy = await socks5Proxy({ username: 'bob', password: 'secret' })
  const server = { id: 's', name: 'S', type: 'socks5', host: '127.0.0.1', port: proxy.port, enabled: true, secretKey: 'vpn.s' }
  const fetchViaVpn = createProxyFetch({ getSecret: (key) => key === 'vpn.s' ? JSON.stringify({ username: 'bob', password: 'secret' }) : null })
  const response = await fetchViaVpn(`http://localhost:${local.port}/`, {}, server)
  assert.equal(await response.text(), 'hello')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(proxy.connects, [{ host: 'localhost', port: local.port }])
  await proxy.close()
  await local.close()
})
