/**
 * dsh-fetch-router：按 host + path 路由出网请求，附带原生右侧栏监控面板。
 */

import { buildRouter, normalizeConfig, requestTarget } from './rules.js'
import { createRecorder } from './recorder.js'
import { installFetch } from './interceptor.js'
import { installPanel } from './panel.js'
import { currentScope, installScope } from './scope.js'

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
  const handle = installFetch({
    router: built.router,
    hosts: built.hosts,
    scope: currentScope,
    recorder,
    warn,
  })
  if (handle.installed) {
    ctx.effect(() => () => handle.dispose())
    info(`dsh-fetch-router: ${normalized.routes.length} rule(s) active`
      + `${normalized.panel.enabled ? `, monitor at ${normalized.panel.path}` : ', monitor off'}`)
  }
  if (normalized.panel.enabled) {
    installPanel(ctx, { recorder, config: normalized, describeRoutes: built.describe, warn })
  }
}
