/**
 * 线上层：把 globalThis.fetch 换成走路由的入口。
 * 未命中任何 host 时直接调用原 fetch，不构造 Request。
 */

import { createFetchEntry } from 'sac-path-router'
import { hostLooksRouted, requestTarget } from './rules.js'

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
  const wrapped = (input, init) => {
    if (!state.active) return original.call(target, input, init)
    const url = urlOf(input)
    if (url === undefined || !hostLooksRouted(url, options.hosts)) {
      options.recorder.countPassthrough()
      return original.call(target, input, init)
    }
    const startedAt = Date.now()
    return entry(input, init).then(
      (response) => {
        options.recorder.settleSince(startedAt, response.status)
        return response
      },
      (error) => {
        options.recorder.record({
          outcome: 'error',
          target: requestTarget(url),
          method: methodOf(input, init),
          detail: String(error?.message ?? error),
        })
        throw error
      },
    )
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
