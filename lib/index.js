/**
 * dsh-fetch-router：按 host + path 路由出网请求，附带原生右侧栏监控面板。
 */

import { buildRouter, normalizeConfig, requestTarget } from './rules.js'
import { createRecorder } from './recorder.js'
import { installFetch } from './interceptor.js'
import { installPanel } from './panel.js'
import { currentScope, installScope } from './scope.js'
import { createRewriteRegistry, REWRITE_SERVICE } from './rewrite.js'

export const name = 'dsh-fetch-router'

export const inject = []

/**
 * 装载插件：校验配置 → 建路由 → 装 scope → 换 fetch → 挂面板数据面。
 * @param {object} ctx 插件上下文。
 * @param {object} [config] 插件配置。
 */
export function apply(ctx, config) {
  const warn = (message) => {
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message)
    else console.warn(message)
  }
  const info = (message) => {
    if (typeof ctx.logger?.info === 'function') ctx.logger.info(message)
  }

  const normalized = normalizeConfig(config)
  const recorder = createRecorder(normalized)
  let sequence = 0
  const built = buildRouter(normalized, {
    nextRequestId: () => `fr-${Date.now().toString(36)}-${(++sequence).toString(36)}`,
    record: entry => recorder.record({
      route: entry.route,
      outcome: entry.outcome,
      headers: entry.headers,
      scope: entry.scope,
      detail: entry.detail,
      rewrite: entry.rewrite,
      status: entry.status,
      target: requestTarget(entry.request.url),
      method: entry.request.method,
    }),
  })

  installScope(ctx, warn)

  // 请求体改写：别的插件在请求发出去之前改 body 的口子。
  // 这一层不认识「规则」「预算」「召回」,只知道有人要在 body 上做点什么。
  const rewrites = createRewriteRegistry({ warn })
  ctx.provide(REWRITE_SERVICE, { register: rewrites.register })
  const handle = installFetch({
    router: built.router,
    hosts: built.hosts,
    scope: currentScope,
    recorder,
    warn,
    rewrite: rewrites.apply,
  })
  if (handle.installed) {
    ctx.effect(() => () => handle.dispose())
    info(`dsh-fetch-router: ${normalized.routes.length} rule(s) active`
      + `${normalized.panel.enabled ? `, monitor at ${normalized.panel.path}` : ', monitor off'}`)
  }
  if (normalized.panel.enabled) {
    installPanel(ctx, { recorder, config: normalized, describeRoutes: built.describe, warn, info })
  }
}
