/**
 * sac-path-router 0.1.x 的已发布入口未传递 requestBody；在插件边界补齐它，
 * 保留库的匹配、内部重派和本地应答，不依赖另一仓库尚未发布的开发产物。
 */
import { createContext, createFetchEntry } from '@leolee9086/sac-path-router'

function isTextBody(request) {
  const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? ''
  return type === 'application/json' || type.endsWith('+json') || type.startsWith('text/')
}

/** 每次请求持有自己的上下文，异步并发不会混用请求体。 */
export function createRoutedFetch(options) {
  const dispatch = options.router.routes()
  const router = { routes: () => dispatch, claims: options.router.claims?.bind(options.router) }
  return async (input, init) => {
    const incoming = input instanceof Request && init === undefined ? input : new Request(input, init)
    const carriesBody = incoming.method !== 'GET' && incoming.method !== 'HEAD' && incoming.body !== null
    let body
    if (typeof init?.body === 'string') body = init.body
    // SDK 的 Request 已经丢失原始 BodyInit 类型，只读取明确的 JSON/文本媒体类型。
    else if (carriesBody && init?.body === undefined && isTextBody(incoming)) body = await incoming.clone().text()
    const originalBody = body
    let context
    const entry = createFetchEntry({
      router,
      scope: options.scope,
      createContext(request) {
        // 内部路径重派仍须携带上一跳中间件改过的内容。
        body = context?.requestBody ?? body
        context = createContext(request)
        context.requestBody = body
        return context
      },
      network(request) {
        const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
        const rewritten = typeof context.requestBody === 'string' && context.requestBody !== originalBody
        // 旧版内部 rebuild 会丢失原始 body；正常流式转发不读、不再次包装它。
        const lostBody = hasBody && request.body === null && incoming.body !== null
        if (hasBody && (rewritten || lostBody)) {
          const headers = new Headers(request.headers)
          if (rewritten) headers.delete('content-length')
          request = new Request(request, {
            headers,
            body: context.requestBody ?? incoming.body,
            duplex: 'half',
          })
        }
        return options.network(request)
      },
    })
    return entry(incoming)
  }
}
