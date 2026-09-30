/**
 * 面板数据面：复用 DSH Connection 的 Host/Origin 和签名 Cookie 校验，另限 loopback。
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const MAX_BODY_BYTES = 65536

export function isLoopback(req) {
  return LOOPBACK.has(req.socket?.remoteAddress)
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/** 超限后排空请求，不销毁 socket，才能把 413 真正送回调用方。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const cleanup = () => {
      req.off('data', data)
      req.off('end', end)
      req.off('error', fail)
      req.off('aborted', aborted)
    }
    const fail = error => { cleanup(); reject(error) }
    const aborted = () => fail(new Error('request aborted'))
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')) }
    const data = chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(Object.assign(new Error('body too large'), { status: 413 }))
        req.resume()
        return
      }
      chunks.push(chunk)
    }
    req.on('data', data)
    req.once('end', end)
    req.once('error', fail)
    req.once('aborted', aborted)
  })
}

/** 独立 HTTP 处理器，便于用真实 Node 请求测试，不伪造整个 Cordis 上下文。 */
export function createPanelHandler(options, connection, base) {
  const clients = new Set()
  const handler = async (req, res) => {
    if (!isLoopback(req)) { json(res, 403, { error: 'loopback only' }); return }
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) {
      json(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.slice(base.length) || '/'
    if (req.method === 'GET' && route === '/stats.json') {
      json(res, 200, options.recorder.snapshot(options.describeRoutes))
      return
    }
    if (req.method === 'GET' && route === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      let last = -1
      const push = () => {
        const snapshot = options.recorder.snapshot(options.describeRoutes)
        if (snapshot.version === last) return
        last = snapshot.version
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`)
      }
      push()
      const unsubscribe = options.recorder.subscribe(push)
      const heartbeat = setInterval(() => { res.write(': keep-alive\n\n') }, 15000)
      const cleanup = () => {
        clearInterval(heartbeat)
        unsubscribe()
        clients.delete(close)
      }
      const close = () => { cleanup(); res.end() }
      clients.add(close)
      // IncomingMessage 的 close 也会在请求读完时发生；SSE 的寿命属于 response。
      res.once('close', cleanup)
      return
    }
    if (req.method === 'POST' && route === '/recording') {
      try {
        const payload = JSON.parse(await readBody(req))
        if (payload === null || typeof payload !== 'object' || typeof payload.paused !== 'boolean') {
          throw new Error('paused must be a boolean')
        }
        options.recorder.setPaused(payload.paused)
        json(res, 200, { paused: options.recorder.paused })
      } catch (error) {
        if (!res.destroyed) json(res, error.status ?? 400, { error: String(error?.message ?? error) })
      }
      return
    }
    json(res, 404, { error: 'not found' })
  }
  return { handler, dispose: () => { for (const close of clients) close() } }
}

/** 等待 webServer 与 Connection；缺少认证服务时不会开放数据面。 */
export function installPanel(ctx, options) {
  const base = options.config.panel.path.replace(/\/+$/, '')
  // inject 回调不能返回普通值，Cordis 会把返回值当成生命周期 effect。
  ctx.inject(['webServer', 'connection'], webCtx => {
    const webServer = webCtx.get('webServer')
    const connection = webCtx.get('connection')
    if (typeof webServer?.register !== 'function' || typeof connection?.requestRejection !== 'function') {
      options.warn('dsh-fetch-router: webServer or Connection authentication is unavailable')
      return
    }
    webCtx.effect(() => {
      const panel = createPanelHandler(options, connection, base)
      const unregister = webServer.register({ kind: 'prefix', path: base, handler: panel.handler })
      return () => { panel.dispose(); unregister() }
    })
    options.info?.(`dsh-fetch-router: authenticated monitor panel mounted at ${base}`)
  })
}
