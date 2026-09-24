/**
 * 线上层：把 globalThis.fetch 换成走路由的入口。
 *
 * 这一层只做「把请求交给 router」，判断都在 router 的两层里：
 * 中间件层做内容改写（对所有请求生效），路由层做端点处理（按 host+path 匹配）。
 * 未命中端点规则的请求照样进 router —— 它会被中间件改写后原样出网。
 */

import { createFetchEntry } from '@leolee9086/sac-path-router'
import { requestTarget } from './rules.js'
import { errorDetail } from './error-detail.js'

/** 标记我们自己装上的包装器。 */
const MARKER = Symbol.for('dsh-fetch-router/installed-fetch')

/** 取本次调用的 URL 字符串。 */
function urlOf(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input !== null && typeof input === 'object' && typeof input.url === 'string') return input.url
  return undefined
}

/** 取本次调用的方法。 */
function methodOf(input, init) {
  if (typeof init?.method === 'string') return init.method.toUpperCase()
  if (input !== null && typeof input === 'object' && typeof input.method === 'string') return input.method.toUpperCase()
  return 'GET'
}


/**
 * 安装 fetch 包装器。
 * @param {object} options 依赖。
 * @param {object} options.router 已建好的路由器。
 * @param {Set<string>} options.hosts 已配置的 host 集合。
 * @param {() => object|undefined} options.scope 作用域读取函数。
 * @param {object} options.recorder 记录器。
 * @param {(message: string) => void} options.warn 诊断输出。
 * @param {Function} [options.rewrite] 请求体改写入口（见 rewrite.js）。
 * @returns {{installed: boolean, dispose: () => void}} 安装结果与卸载函数。
 */
export function installFetch(options) {
  const target = globalThis
  const original = target.fetch
  if (typeof original !== 'function') throw new Error('dsh-fetch-router: globalThis.fetch is unavailable')
  if (original[MARKER] === true) {
    options.warn('dsh-fetch-router: globalThis.fetch is already patched; this instance stays idle')
    return { installed: false, dispose() {} }
  }
  const state = { active: true }
  const entry = createFetchEntry({
    router: options.router,
    network: request => original.call(target, request),
    scope: options.scope,
  })
  const wrapped = async (input, init) => {
    if (!state.active) return original.call(target, input, init)
    const url = urlOf(input)
    if (url === undefined) {
      options.recorder.countPassthrough()
      return original.call(target, input, init)
    }
    const startedAt = Date.now()
    const method = methodOf(input, init)
    try {
      // 这里只做一件事：把请求交给 entry。
      //
      // 内容改写与端点处理都在 router 里，各占一层：中间件在路径匹配**之前**跑
      // （对所有请求生效，因为它看的是 body，跟发去哪个 host 无关），端点规则
      // 决定注头 / 改目标 / 本地应答。此前把改写判断塞在这个函数里，等于让端点
      // 路由的匹配结果去决定「body 能不能被改」—— 两件正交的事共用了一道门，
      // 结果是未命中端点规则的 host 连 body 都改不了。
      const response = await entry(input, init)
      options.recorder.settleSince(startedAt, response.status)
      return response
    } catch (error) {
      options.recorder.record({
        outcome: 'error',
        target: requestTarget(url),
        method,
        detail: errorDetail(error),
      })
      throw error
    }
  }
  Object.defineProperty(wrapped, MARKER, { value: true })
  target.fetch = wrapped
  return {
    installed: true,
    dispose() {
      state.active = false
      if (target.fetch === wrapped) target.fetch = original
    },
  }
}
