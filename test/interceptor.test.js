import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRouter, normalizeConfig } from '../lib/rules.js'
import { createRecorder } from '../lib/recorder.js'
import { installFetch } from '../lib/interceptor.js'

/** 装好一个拦截器与假的原始 fetch，返回断言所需的一切。 */
function bench(rawConfig, scope) {
  const config = normalizeConfig(rawConfig)
  const recorder = createRecorder(config)
  const built = buildRouter(config, {
    nextRequestId: () => 'req',
    record: entry => recorder.record({
      route: entry.route,
      outcome: entry.outcome,
      headers: entry.headers,
      scope: entry.scope,
      request: entry.request,
      detail: entry.detail,
    }),
  })
  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = (input, init) => {
    seen.push({ input, init })
    return Promise.resolve(new Response('upstream', { status: 200 }))
  }
  const handle = installFetch({
    router: built.router,
    hosts: built.hosts,
    scope: () => scope,
    recorder,
    warn: () => {},
  })
  return {
    handle,
    recorder,
    seen,
    restore() {
      handle.dispose()
      globalThis.fetch = original
    },
  }
}

const CONFIG = {
  routes: [{
    id: 'r',
    match: { host: 'opencode.ai', path: '/zen/go/v1/**', methods: ['POST'] },
    headers: { 'x-opencode-session': '$session' },
  }],
}

test('命中 host：请求被路由，注入的头到达上游', async (t) => {
  const b = bench(CONFIG, { sessionId: 'session-42' })
  t.after(() => b.restore())
  const response = await globalThis.fetch('https://opencode.ai/zen/go/v1/chat/completions', { method: 'POST' })
  assert.equal(response.status, 200)
  assert.equal(b.seen.length, 1)
  assert.ok(b.seen[0].input instanceof Request)
  assert.equal(b.seen[0].input.headers.get('x-opencode-session'), 'session-42')
})

test('未配置 host：原样透传，不构造 Request', async (t) => {
  const b = bench(CONFIG, { sessionId: 's' })
  t.after(() => b.restore())
  const init = { method: 'POST', body: 'raw' }
  await globalThis.fetch('https://api.deepseek.com/chat/completions', init)
  assert.equal(b.seen.length, 1)
  assert.equal(b.seen[0].input, 'https://api.deepseek.com/chat/completions')
  assert.equal(b.seen[0].init, init)
  assert.equal(b.recorder.snapshot(() => []).counters.passthrough, 1)
})

test('dispose 之后即使命中 host 也纯透传', async () => {
  const b = bench(CONFIG, { sessionId: 's' })
  const original = globalThis.fetch
  try {
    b.handle.dispose()
    assert.notEqual(globalThis.fetch, original)
    const init = { method: 'POST' }
    await globalThis.fetch('https://opencode.ai/zen/go/v1/chat/completions', init)
    assert.equal(b.seen.length, 1)
    assert.equal(b.seen[0].input, 'https://opencode.ai/zen/go/v1/chat/completions')
    assert.equal(b.seen[0].init, init)
  } finally {
    globalThis.fetch = original
  }
})

test('重复安装：第二个实例保持闲置', async (t) => {
  const b = bench(CONFIG, { sessionId: 's' })
  t.after(() => b.restore())
  const second = installFetch({
    router: buildRouter(normalizeConfig(CONFIG), { nextRequestId: () => 'r', record: () => {} }).router,
    hosts: new Set(['opencode.ai']),
    scope: () => undefined,
    recorder: b.recorder,
    warn: () => {},
  })
  assert.equal(second.installed, false)
  second.dispose()
})

test('上游失败：为该请求记一次 error 并把错误继续抛给调用方', async (t) => {
  const config = normalizeConfig(CONFIG)
  const recorder = createRecorder(config)
  const built = buildRouter(config, {
    nextRequestId: () => 'req',
    record: entry => recorder.record({ route: entry.route, outcome: entry.outcome, request: entry.request }),
  })
  const original = globalThis.fetch
  globalThis.fetch = () => Promise.reject(new Error('boom'))
  const handle = installFetch({ router: built.router, hosts: built.hosts, scope: () => undefined, recorder, warn: () => {} })
  t.after(() => { handle.dispose(); globalThis.fetch = original })
  await assert.rejects(() => globalThis.fetch('https://opencode.ai/zen/go/v1/models'), /boom/)
  assert.equal(recorder.snapshot(() => []).counters.error, 1)
})
