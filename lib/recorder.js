/**
 * 记录器：环形缓冲 + 计数，供右侧栏面板取数。
 * 只保存展示所需的最小信息，敏感头一律只留名字。
 */

/** 永远只显示名字、不记录值的头。 */
const SECRET_HEADERS = [/^authorization$/i, /^cookie$/i, /^set-cookie$/i, /api[-_]?key$/i, /token/i, /secret/i]

/**
 * 创建记录器。
 * @param {object} config 规范化配置。
 * @returns {object} 记录器。
 */
export function createRecorder(config) {
  const limit = Math.max(1, Number(config.log.buffer) || 200)
  const rows = []
  const counters = { matched: 0, passthrough: 0, mock: 0, skipped: 0, error: 0, rewritten: 0 }
  const listeners = new Set()
  let paused = false
  let version = 0

  const notify = () => {
    version += 1
    for (const listener of listeners) listener()
  }

  /** 会话 id 打码：只留前 8 位。 */
  const shortSession = sessionId => (typeof sessionId === 'string' && sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId)

  /** 头名列表；值为机密时永不返回。 */
  const headerView = names => {
    if (names === undefined || names.length === 0) return []
    if (config.log.headers !== true) return names
    return names.map(name => (SECRET_HEADERS.some(pattern => pattern.test(name)) ? `${name}=<masked>` : name))
  }

  return {
    /** 是否暂停记录。 */
    get paused() { return paused },

    /** 版本号，面板据此判断是否需要重取。 */
    get version() { return version },

    /**
     * 记录一次命中；返回行对象，调用方可在响应回来后补状态与耗时。
     * @param {object} entry 记录内容。
     * @returns {object|undefined} 行对象（暂停或未匹配且不记透传时为 undefined）。
     */
    record(entry) {
      if (entry.outcome === 'passthrough') {
        counters.passthrough += 1
        if (config.log.passthrough !== true) return undefined
      } else if (entry.outcome === 'mock') counters.mock += 1
      else if (entry.outcome === 'skipped') counters.skipped += 1
      else if (entry.outcome === 'error') counters.error += 1
      // 请求体被改写单独计数:它既不是"透传"(请求变了),也不是"命中路由"
      // (路由管去哪,改写管内容)。混进 matched 就看不出有没有改写发生过。
      else if (entry.outcome === 'rewritten') counters.rewritten += 1
      else counters.matched += 1
      if (paused) { notify(); return undefined }
      const row = {
        time: Date.now(),
        target: entry.target ?? '',
        method: entry.method ?? '',
        rule: entry.route ?? 'passthrough',
        outcome: entry.outcome,
        headers: headerView(entry.headers),
        provider: entry.scope?.provider,
        model: entry.scope?.model,
        session: shortSession(entry.scope?.sessionId),
        detail: entry.detail,
        rewrite: entry.rewrite,
        status: entry.status,
        ms: undefined,
      }
      rows.unshift(row)
      if (rows.length > limit) rows.length = limit
      notify()
      return row
    },

    /**
     * 记一次直接透传（host 未配置任何规则，不产生行）。
     */
    countPassthrough() {
      counters.passthrough += 1
    },

    /**
     * 给本次请求产生的行补上状态码与耗时。
     * @param {number} startedAt 本次请求起始时间戳。
     * @param {number} status 上游状态码。
     */
    settleSince(startedAt, status) {
      const row = rows.find(candidate => candidate.time >= startedAt && candidate.status === undefined)
      if (row === undefined) return
      row.status = status
      row.ms = Math.max(0, Date.now() - startedAt)
      notify()
    },

    /**
     * 暂停或恢复记录。
     * @param {boolean} value 目标状态。
     */
    setPaused(value) {
      paused = value === true
      notify()
    },

    /**
     * 订阅变更。
     * @param {() => void} listener 监听器。
     * @returns {() => void} 取消订阅。
     */
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    /**
     * 面板用的快照。
     * @param {() => object[]} describeRoutes 当前生效路由表。
     * @returns {object} 快照。
     */
    snapshot(describeRoutes) {
      return {
        enabled: true,
        paused,
        version,
        counters,
        routes: describeRoutes(),
        rows: rows.slice(0, limit),
      }
    },
  }
}
