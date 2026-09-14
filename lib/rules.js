/**
 * 配置到路由：把 routes 配置编译成 sac-path-router 的中间件。
 * 本模块是纯函数，供单测直接调用。
 */

import { createRouter } from 'sac-path-router'

/** 配置默认值。 */
export const DEFAULT_CONFIG = {
  reserved: ['user-agent'],
  ifAbsent: true,
  allowMock: false,
  onMissing: 'fail',
  log: { matched: true, passthrough: false, headers: false, buffer: 200 },
  panel: { enabled: true, path: '/fetch-router' },
  routes: [],
}

/** 永不被规则覆盖的请求头。 */
const ALWAYS_RESERVED = ['user-agent']

/**
 * 校验并补全配置。
 * @param {object} raw 插件配置。
 * @returns {object} 规范化后的配置。
 * @throws {Error} 配置不合法时抛出，调用方据此拒绝安装。
 */
export function normalizeConfig(raw) {
  if (raw === undefined || raw === null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-fetch-router: config must be an object')
  }
  const log = { ...DEFAULT_CONFIG.log, ...(raw.log ?? {}) }
  const panel = { ...DEFAULT_CONFIG.panel, ...(raw.panel ?? {}) }
  const onMissing = raw.onMissing ?? DEFAULT_CONFIG.onMissing
  if (onMissing !== 'fail' && onMissing !== 'skip') {
    throw new Error(`dsh-fetch-router: onMissing must be "fail" or "skip", got ${JSON.stringify(onMissing)}`)
  }
  if (typeof panel.enabled !== 'boolean') throw new Error('dsh-fetch-router: panel.enabled must be a boolean')
  if (typeof panel.path !== 'string' || !panel.path.startsWith('/')) {
    throw new Error('dsh-fetch-router: panel.path must be an absolute path')
  }
  if (!Array.isArray(raw.routes)) throw new Error('dsh-fetch-router: routes must be an array')
  const reserved = [...ALWAYS_RESERVED, ...(raw.reserved ?? [])].map(name => String(name).toLowerCase())
  const allowMock = raw.allowMock === true
  const routes = raw.routes.map((route, index) => normalizeRoute(route, index, { reserved, onMissing, allowMock }))
  return {
    reserved,
    ifAbsent: raw.ifAbsent !== false,
    allowMock,
    onMissing,
    log,
    panel,
    routes,
  }
}

/** 校验单条规则。 */
function normalizeRoute(raw, index, context) {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`dsh-fetch-router: routes[${index}] must be an object`)
  }
  const id = raw.id ?? `route-${index + 1}`
  const match = raw.match ?? {}
  if (typeof match.host !== 'string' || match.host.length === 0) {
    throw new Error(`dsh-fetch-router: route "${id}" needs match.host`)
  }
  const methods = (match.methods ?? []).map(method => String(method).toUpperCase())
  for (const method of methods) {
    if (!/^[A-Z]+$/.test(method)) throw new Error(`dsh-fetch-router: route "${id}" has an invalid method ${method}`)
  }
  const headers = raw.headers ?? {}
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error(`dsh-fetch-router: route "${id}" headers must be an object`)
  }
  for (const name of Object.keys(headers)) {
    if (context.reserved.includes(name.toLowerCase())) {
      throw new Error(`dsh-fetch-router: route "${id}" tries to set reserved header "${name}"`)
    }
  }
  if (raw.respond !== undefined && !context.allowMock) {
    throw new Error(`dsh-fetch-router: route "${id}" uses respond but allowMock is not enabled`)
  }
  const onMissing = raw.onMissing ?? context.onMissing
  if (onMissing !== 'fail' && onMissing !== 'skip') {
    throw new Error(`dsh-fetch-router: route "${id}" onMissing must be "fail" or "skip"`)
  }
  const rewrite = raw.rewrite ?? {}
  if (rewrite.url !== undefined) {
    try {
      new URL(rewrite.url)
    } catch {
      throw new Error(`dsh-fetch-router: route "${id}" rewrite.url is not a valid URL`)
    }
  }
  const path = typeof match.path === 'string' && match.path.length > 0 ? match.path : '/**'
  return {
    id,
    pattern: `${match.host}${path === '/' ? '/' : path}`,
    host: match.host,
    methods,
    provider: match.provider,
    model: match.model,
    purpose: match.purpose,
    require: raw.require ?? [],
    onMissing,
    headers,
    rewrite,
    respond: raw.respond,
    path,
  }
}

/**
 * 判断一个值是否匹配 glob（只支持 `*` 通配，用于 provider/model/host 前缀匹配）。
 * @param {string} pattern 模式。
 * @param {string|undefined} value 待匹配值。
 * @returns {boolean} 是否匹配。
 */
export function globMatch(pattern, value) {
  if (value === undefined || value === null) return false
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === value
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

/** 模板名到 scope 字段的映射。 */
const SCOPE_FIELDS = { session: 'sessionId', provider: 'provider', model: 'model', purpose: 'purpose' }

/**
 * 读作用域里的一个值；空字符串与缺失同等对待。
 * @param {object|undefined} scope 请求作用域。
 * @param {string} name 模板名或字段名。
 * @returns {string|undefined} 取到的值。
 */
export function scopeValue(scope, name) {
  const field = SCOPE_FIELDS[name] ?? name
  const value = scope === undefined ? undefined : scope[field]
  if (value === undefined || value === null || value === '') return undefined
  return String(value)
}

/**
 * 解析模板：`$session`、`$provider`、`$model`、`$purpose`、`$requestId`。
 * @param {string} template 模板字符串。
 * @param {object|undefined} scope 请求作用域。
 * @param {string} requestId 本次请求 id。
 * @returns {string} 解析结果。
 * @throws {Error} 模板引用了取不到的变量。
 */
export function resolveTemplate(template, scope, requestId) {
  return String(template).replace(/\$([A-Za-z][A-Za-z0-9_]*)/g, (match, name) => {
    if (name === 'requestId') return requestId
    const value = scopeValue(scope, name)
    if (value === undefined) {
      throw new Error(`dsh-fetch-router: template ${match} has no value for this request`)
    }
    return value
  })
}

/**
 * 一条规则在当前请求上是否命中（方法 + 作用域条件）。
 * @param {object} route 规范化后的规则。
 * @param {object} ctx 路由上下文。
 * @returns {{ok: boolean, reason?: string}} 判定结果。
 */
export function routeApplies(route, ctx) {
  if (!globMatch(route.host, ctx.url.hostname)) {
    return { ok: false, reason: 'host' }
  }
  if (route.methods.length > 0 && !route.methods.includes(ctx.method)) {
    return { ok: false, reason: 'method' }
  }
  const scope = ctx.scope
  if (route.provider !== undefined && !globMatch(route.provider, scope?.provider)) {
    return { ok: false, reason: 'provider' }
  }
  if (route.model !== undefined && !globMatch(route.model, scope?.model)) {
    return { ok: false, reason: 'model' }
  }
  if (route.purpose !== undefined && !globMatch(route.purpose, scope?.purpose)) {
    return { ok: false, reason: 'purpose' }
  }
  return { ok: true }
}

/**
 * 把规则编译进路由器。
 * @param {object} config 规范化配置。
 * @param {object} hooks 记录与请求 id 来源。
 * @param {(entry: object) => void} hooks.record 记录一次命中。
 * @param {() => string} hooks.nextRequestId 生成本次请求 id。
 * @returns {{router: object, hosts: Set<string>, describe: () => object[]}} 路由器与元信息。
 */
export function buildRouter(config, hooks) {
  const router = createRouter({ matcher: 'radix3' })
  const hosts = new Set()
  const byPath = new Map()
  for (const route of config.routes) {
    hosts.add(route.host)
    const group = byPath.get(route.path)
    if (group === undefined) byPath.set(route.path, [route])
    else group.push(route)
  }
  for (const [path, group] of byPath) {
    router.all(path, async (ctx, next) => {
      const matched = group.find(route => routeApplies(route, ctx).ok)
      if (matched === undefined) return next()
      const route = matched
      const requestId = hooks.nextRequestId()
      const scope = ctx.scope
      const missing = route.require.filter(field => scopeValue(scope, field) === undefined)
      if (missing.length > 0) {
        const message = `dsh-fetch-router: rule "${route.id}" requires ${missing.join(', ')} but this request has none`
        if (route.onMissing === 'skip') {
          hooks.record({ route: route.id, outcome: 'skipped', detail: message, scope, request: ctx.request })
          return next()
        }
        hooks.record({ route: route.id, outcome: 'error', detail: message, scope, request: ctx.request })
        throw new Error(message)
      }
      const changed = []
      for (const [name, template] of Object.entries(route.headers)) {
        if (config.ifAbsent && ctx.get(name) !== null) continue
        const value = resolveTemplate(template, scope, requestId)
        ctx.set(name, value)
        changed.push(name)
      }
      if (route.rewrite.url !== undefined) {
        const target = new URL(route.rewrite.url)
        target.pathname = route.rewrite.path === undefined ? ctx.url.pathname : String(route.rewrite.path)
        if (route.rewrite.search === undefined) target.search = ctx.url.search
        else target.search = String(route.rewrite.search)
        ctx.url = target
      }
      if (route.respond !== undefined) {
        const respond = route.respond
        ctx.status = respond.status ?? 200
        for (const [name, template] of Object.entries(respond.headers ?? {})) {
          ctx.responseHeaders.set(name, resolveTemplate(template, scope, requestId))
        }
        if (respond.json !== undefined) {
          ctx.responseHeaders.set('content-type', 'application/json; charset=utf-8')
          ctx.body = JSON.stringify(respond.json)
        } else if (respond.body !== undefined) {
          ctx.body = String(respond.body)
        }
        hooks.record({ route: route.id, outcome: 'mock', headers: changed, scope, request: ctx.request, status: ctx.status })
        return
      }
      hooks.record({ route: route.id, outcome: 'forward', headers: changed, scope, request: ctx.request, rewrite: route.rewrite.url })
      await next()
    })
  }
  return {
    router,
    hosts,
    describe: () => config.routes.map(route => ({
      id: route.id,
      pattern: route.pattern,
      methods: route.methods,
      provider: route.provider,
      model: route.model,
      purpose: route.purpose,
      require: route.require,
      headers: Object.keys(route.headers),
      rewrite: route.rewrite.url,
      mock: route.respond !== undefined,
    })),
  }
}

/**
 * 请求的目标标识：`host + pathname`。
 * @param {string|URL} url 请求地址。
 * @returns {string} 目标标识。
 */
export function requestTarget(url) {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url
    return `${parsed.host}${parsed.pathname}`
  } catch {
    return String(url)
  }
}

/**
 * 请求是否可能命中任何规则（避免给无关请求构造 Request）。
 * @param {string} url 请求地址。
 * @param {Set<string>} hosts 已配置的 host 集合。
 * @returns {boolean} 是否需要交给路由器。
 */
export function hostLooksRouted(url, hosts) {
  let host
  try {
    host = new URL(url).hostname
  } catch {
    return true
  }
  for (const configured of hosts) {
    if (configured === host) return true
    if (configured.startsWith('*.')) {
      const suffix = configured.slice(1)
      if (host.endsWith(suffix)) return true
    }
  }
  return false
}
