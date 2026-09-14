import test from 'node:test'
import assert from 'node:assert/strict'
import { createFetchEntry } from '@leolee9086/sac-path-router'
import {
  buildRouter, globMatch, hostLooksRouted, normalizeConfig, requestTarget, resolveTemplate, routeApplies,
} from '../lib/rules.js'

/** 用给定配置跑一次真实请求，返回入口、上游收到的请求与记录。 */
function harness(rawConfig, { scope, response } = {}) {
  const config = normalizeConfig(rawConfig)
  const records = []
  const built = buildRouter(config, {
    nextRequestId: () => 'req-fixed',
    record: entry => records.push(entry),
  })
  const upstream = []
  const entry = createFetchEntry({
    router: built.router,
    scope: () => scope,
    network: (request) => {
      upstream.push(request)
      return Promise.resolve(response ?? new Response('upstream', { status: 200 }))
    },
  })
  return { config, built, entry, records, upstream }
}

const OPENCODE = {
  routes: [{
    id: 'opencode-session-chat',
    match: { host: 'opencode.ai', path: '/zen/go/v1/chat/completions', methods: ['POST'], provider: 'opencode-go*' },
    require: ['session'],
    headers: { 'x-opencode-session': '$session' },
  }],
}

test('配置规范化：默认值与路由模式', () => {
  const config = normalizeConfig(OPENCODE)
  assert.equal(config.ifAbsent, true)
  assert.equal(config.allowMock, false)
  assert.equal(config.onMissing, 'fail')
  assert.deepEqual(config.reserved, ['user-agent'])
  assert.equal(config.routes[0].pattern, 'opencode.ai/zen/go/v1/chat/completions')
  assert.deepEqual(config.routes[0].methods, ['POST'])
})

test('配置规范化：非法配置一律拒绝', () => {
  assert.throws(() => normalizeConfig({ routes: [{}] }), /needs match\.host/)
  assert.throws(() => normalizeConfig({ routes: null }), /routes must be an array/)
  assert.throws(() => normalizeConfig({ routes: [], panel: { path: 'fetch-router' } }), /panel\.path/)
  assert.throws(() => normalizeConfig({ onMissing: 'ignore', routes: [] }), /onMissing/)
  assert.throws(
    () => normalizeConfig({ routes: [{ match: { host: 'a.test' }, headers: { 'User-Agent': 'x' } }] }),
    /reserved header/,
  )
  assert.throws(
    () => normalizeConfig({ routes: [{ match: { host: 'a.test' }, respond: { status: 200 } }] }),
    /allowMock/,
  )
})

test('命中规则：注入会话头，请求头与 body 保真', async () => {
  const { entry, upstream, records } = harness(OPENCODE, { scope: { sessionId: 'session-7', provider: 'opencode-go-completions' } })
  const response = await entry('https://opencode.ai/zen/go/v1/chat/completions', {
    method: 'POST',
    body: '{"model":"x"}',
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(response.status, 200)
  assert.equal(upstream.length, 1)
  assert.equal(upstream[0].headers.get('x-opencode-session'), 'session-7')
  assert.equal(upstream[0].headers.get('content-type'), 'application/json')
  assert.equal(await upstream[0].text(), '{"model":"x"}')
  assert.equal(records[0].outcome, 'forward')
  assert.deepEqual(records[0].headers, ['x-opencode-session'])
})

test('方法不匹配时不命中', async () => {
  const { entry, upstream, records } = harness(OPENCODE, { scope: { sessionId: 's' } })
  await entry('https://opencode.ai/zen/go/v1/chat/completions', { method: 'GET' })
  assert.equal(upstream[0].headers.get('x-opencode-session'), null)
  assert.equal(records.length, 0)
})

test('provider 不匹配时不命中', async () => {
  const { entry, upstream } = harness(OPENCODE, { scope: { sessionId: 's', provider: 'deepseek-official' } })
  await entry('https://opencode.ai/zen/go/v1/chat/completions', { method: 'POST' })
  assert.equal(upstream[0].headers.get('x-opencode-session'), null)
})

test('ifAbsent：目标头已存在则不覆盖', async () => {
  const { entry, upstream } = harness(OPENCODE, { scope: { sessionId: 's' } })
  await entry('https://opencode.ai/zen/go/v1/chat/completions', {
    method: 'POST',
    headers: { 'x-opencode-session': 'already-there' },
  })
  assert.equal(upstream[0].headers.get('x-opencode-session'), 'already-there')
})

test('require 不满足：默认抛错并点明缺哪个字段', async () => {
  const { entry, upstream, records } = harness(OPENCODE, { scope: { provider: 'opencode-go-completions' } })
  await assert.rejects(
    () => entry('https://opencode.ai/zen/go/v1/chat/completions', { method: 'POST' }),
    /requires session/,
  )
  assert.equal(upstream.length, 0)
  assert.equal(records[0].outcome, 'error')
})

test('require 不满足且 onMissing=skip：放行且记录', async () => {
  const config = structuredClone(OPENCODE)
  config.routes[0].onMissing = 'skip'
  const { entry, upstream, records } = harness(config, { scope: { provider: 'opencode-go-completions' } })
  await entry('https://opencode.ai/zen/go/v1/chat/completions', { method: 'POST' })
  assert.equal(upstream.length, 1)
  assert.equal(upstream[0].headers.get('x-opencode-session'), null)
  assert.equal(records[0].outcome, 'skipped')
})

test('respond：本地应答且不出网（allowMock 打开时）', async () => {
  const { entry, upstream, records } = harness({
    allowMock: true,
    routes: [{
      id: 'mock',
      match: { host: 'mock.local', path: '/**' },
      respond: { status: 201, json: { ok: true }, headers: { 'x-mock': 'yes' } },
    }],
  })
  const response = await entry('https://mock.local/anything')
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('x-mock'), 'yes')
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(upstream.length, 0)
  assert.equal(records[0].outcome, 'mock')
})

test('未配置的 host 直接透传', async () => {
  const { entry, upstream, records } = harness(OPENCODE, { scope: { sessionId: 's' } })
  await entry('https://api.deepseek.com/chat/completions', { method: 'POST' })
  assert.equal(upstream.length, 1)
  assert.equal(records.length, 0)
})

test('模板与 glob 工具函数', () => {
  assert.equal(resolveTemplate('$session', { sessionId: 's1' }, 'r1'), 's1')
  assert.equal(resolveTemplate('$requestId', undefined, 'r1'), 'r1')
  assert.throws(() => resolveTemplate('$session', undefined, 'r1'), /no value/)
  assert.equal(globMatch('opencode-go*', 'opencode-go-completions'), true)
  assert.equal(globMatch('opencode-go*', 'deepseek'), false)
  assert.equal(globMatch('*', undefined), false)
  assert.equal(hostLooksRouted('https://opencode.ai/x', new Set(['opencode.ai'])), true)
  assert.equal(hostLooksRouted('https://other.test/x', new Set(['opencode.ai'])), false)
  assert.equal(hostLooksRouted('https://a.example.com/x', new Set(['*.example.com'])), true)
  assert.equal(requestTarget('https://opencode.ai/zen/go/v1/models?x=1'), 'opencode.ai/zen/go/v1/models')
})

test('routeApplies 逐条件判定', () => {
  const route = normalizeConfig(OPENCODE).routes[0]
  const url = new URL('https://opencode.ai/zen/go/v1/chat/completions')
  const base = { url, method: 'POST', scope: { provider: 'opencode-go-responses' } }
  assert.equal(routeApplies(route, base).ok, true)
  assert.equal(routeApplies(route, { ...base, method: 'GET' }).reason, 'method')
  assert.equal(routeApplies(route, { ...base, scope: { provider: 'deepseek' } }).reason, 'provider')
  assert.equal(routeApplies(route, { ...base, url: new URL('https://other.test/x') }).reason, 'host')
})
