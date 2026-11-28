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
