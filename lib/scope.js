/**
 * 请求语义层：把 llm/stream 的会话作用域挂到当前异步调用链上，
 * 让包装后的 fetch 在出网时能读到 provider/model/sessionId/purpose。
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** 当前请求的作用域存储。 */
export const storage = new AsyncLocalStorage()

/**
 * 读取当前作用域。
 * @returns {object|undefined} 作用域，非 LLM 出网时为 undefined。
 */
export function currentScope() {
  return storage.getStore()
}

/**
 * 在一个作用域内执行函数（供单测与内部使用）。
 * @param {object} scope 作用域。
 * @param {() => any} fn 待执行函数。
 * @returns {any} 函数返回值。
 */
export function runInScope(scope, fn) {
  return storage.run(scope, fn)
}

/**
 * 把异步迭代器的每次 next() 都放进作用域里执行——HTTP 恰好发生在 next() 内部。
 * @param {AsyncIterable<any>} iterable 适配器返回的流。
 * @param {object} scope 本次请求的作用域。
 * @returns {AsyncGenerator<any>} 包装后的流。
 */
export async function* wrapIterable(iterable, scope) {
  const iterator = iterable[Symbol.asyncIterator]()
  try {
    while (true) {
      const step = await storage.run(scope, () => iterator.next())
      if (step.done === true) return step.value
      yield step.value
    }
  } finally {
    if (typeof iterator.return === 'function') await storage.run(scope, () => iterator.return())
  }
}

/**
 * 包装 llm/stream 的返回值：可能是流，也可能是 promise。
 * @param {any} result next() 的返回值。
 * @param {object} scope 作用域。
 * @returns {any} 包装结果。
 */
export function wrapStream(result, scope) {
  if (result === null || result === undefined) return result
  if (typeof result.then === 'function') return result.then(value => wrapStream(value, scope))
  if (typeof result[Symbol.asyncIterator] === 'function') return wrapIterable(result, scope)
  return result
}

/**
 * 安装 llm/stream 监听：为每次模型请求建立作用域。
 * @param {object} ctx 插件上下文。
 * @param {(message: string) => void} [warn] 诊断输出。
 * @returns {void}
 */
export function installScope(ctx, warn) {
  ctx.on('llm/stream', (options, next) => {
    const scope = {
      provider: options?.provider,
      model: options?.model,
      sessionId: options?.sessionId,
      purpose: options?.purpose,
    }
    try {
      return wrapStream(next(), scope)
    } catch (error) {
      if (warn !== undefined) warn(`dsh-fetch-router: llm/stream scope failed: ${String(error?.message ?? error)}`)
      throw error
    }
  })
}
