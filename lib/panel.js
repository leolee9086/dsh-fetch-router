/**
 * 面板数据面：在宿主 web 服务器上挂 /fetch-router 下的只读接口与 SSE。
 * 只服务本机（loopback）请求。
 */

/** 允许访问面板数据面的远端地址。 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * 判断请求是否来自本机。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {boolean} 是否本机。
 */
export function isLoopback(req) {
  const address = req.socket?.remoteAddress
  return typeof address === 'string' && LOOPBACK.has(address)
}

/** 读请求体（上限 64KB）。 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 65536) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 注册面板数据面。
 * @param {object} ctx 插件上下文。
 * @param {object} options 依赖。
 * @param {object} options.recorder 记录器。
 * @param {object} options.config 规范化配置。
 * @param {() => object[]} options.describeRoutes 路由表描述。
 * @param {(message: string) => void} options.warn 诊断输出。
 * @returns {void}
 */
export function installPanel(ctx, options) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    options.warn('dsh-fetch-router: webServer is unavailable, the monitor panel has no data source')
    return
  }
  const base = options.config.panel.path.replace(/\/+$/, '')
  const json = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: base,
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        json(res, 403, { error: 'loopback only' })
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
        const cleanup = () => { clearInterval(heartbeat); unsubscribe() }
        req.on('close', cleanup)
        res.on('close', cleanup)
        return
      }
      if (req.method === 'POST' && route === '/recording') {
        try {
          const body = await readBody(req)
          const payload = body.length === 0 ? {} : JSON.parse(body)
          options.recorder.setPaused(payload.paused === true)
          json(res, 200, { paused: options.recorder.paused })
        } catch (error) {
          json(res, 400, { error: String(error?.message ?? error) })
        }
        return
      }
      json(res, 404, { error: 'not found' })
    },
  }))
}
