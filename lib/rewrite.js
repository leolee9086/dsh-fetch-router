/**
 * 请求体改写：给别的插件一个在请求发出去之前改 body 的口子。
 *
 * 为什么需要这一层：有些上下文变换在 pre-step 里做不到 —— 组装好的请求体里
 * 除了消息，还有系统提示词、工具定义等等，那些只有在请求层才看得见。
 *
 * 谁决定改什么：登记改写器的那个插件。这一层不认识「规则」「预算」「召回」，
 * 它只知道有人要在 body 上做点什么、以及做完之后 body 变成了什么。
 */

/** 本插件注册的改写服务名。 */
export const REWRITE_SERVICE = 'requestRewrite'

/**
 * 建改写登记处。
 *
 * @param {object} [options]
 * @param {(message: string) => void} [options.warn] 保留的诊断接口；改写异常直接向调用方传播。
 * @returns {{register: Function, apply: Function, size: () => number}}
 */
export function createRewriteRegistry({ warn = () => {} } = {}) {
  /** 改写器：名字 → 函数。 */
  const rewrites = new Map()

  /**
   * 登记一个改写器。返回取消登记的函数。
   *
   * @param {string} name 名字，出错时报出来。
   * @param {(request: {url: string, method: string, body: string, scope: object|undefined}) =>
   *   (string|undefined|null|Promise<string|undefined|null>)} rewrite
   *        返回改后的 body；undefined / null 表示不改这一条。
   */
  function register(name, rewrite) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('dsh-fetch-router: 改写器要有名字')
    }
    if (typeof rewrite !== 'function') {
      throw new Error(`dsh-fetch-router: 改写器 "${name}" 要是一个函数`)
    }
    rewrites.set(name, rewrite)
    return () => rewrites.delete(name)
  }

  /**
   * 对一次请求依次跑所有改写器。
   *
   * 改写失败立即拒绝请求，原始异常（包括 stack/cause）不包装、不吞掉。
   * 不得把「改写失败」伪装成「无需改写」后继续发送。
   *
   * @param {{url: string, method: string, body: string, scope: object|undefined}} request 原始请求。
   * @returns {Promise<string|undefined>} 改后的 body；没人改动就 undefined。
   */
  async function apply(request) {
    let current = request.body
    let changed = false
    for (const [name, rewrite] of rewrites) {
      const next = await rewrite({ ...request, body: current })
      if (next === undefined || next === null) continue
      if (typeof next !== 'string') {
        throw new TypeError(`dsh-fetch-router: 改写器 "${name}" 返回的不是字符串`)
      }
      current = next
      changed = true
    }
    return changed ? current : undefined
  }

  return { register, apply, size: () => rewrites.size }
}
