import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRouter, normalizeConfig } from '../lib/rules.js'
import { createRecorder } from '../lib/recorder.js'
import { installFetch } from '../lib/interceptor.js'

/** 装好一个拦截器与假的原始 fetch，返回断言所需的一切。 */
function bench(rawConfig, scope, rewrite) {
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
    ...(rewrite === undefined ? {} : { rewrite }),
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

// 2026-09-24 起，未命中端点规则的请求**也会**进 router：内容改写是中间件层的事，
// 它对所有请求生效（它看的是 body，跟发去哪个 host 无关）。所以这里不再断言
// 「不构造 Request」—— 那正是让未配置 host 的请求连 body 都改不了的原因。
test('未配置 host：不做端点处理，请求原样到达上游', async (t) => {
  const b = bench(CONFIG, { sessionId: 's' })
  t.after(() => b.restore())
  await globalThis.fetch('https://api.deepseek.com/chat/completions', { method: 'POST', body: 'raw' })
  assert.equal(b.seen.length, 1)
  assert.equal(b.seen[0].input.url, 'https://api.deepseek.com/chat/completions')
  assert.equal(await b.seen[0].input.text(), 'raw')
  assert.equal(b.seen[0].input.headers.get('x-opencode-session'), null)
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

// 2026-09-24：内容改写与端点路由是两层，不该共用一道门。
// 改写器只看 body，跟请求发去哪个 host 无关；端点规则管的是注头/改目标/本地应答。
// 之前两层共用 `hostLooksRouted`，于是「未命中端点规则的 host」连 body 都改不了。
test('未命中端点规则的 host：body 照样被改（改写走中间件层）', async (t) => {
  // 走真实装配：buildRouter 把改写装成中间件，中间件在路径匹配之前跑。
  const config = normalizeConfig(CONFIG)
  const recorder = createRecorder(config)
  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = (input) => {
    seen.push(input)
    return Promise.resolve(new Response('upstream', { status: 200 }))
  }
  const built = buildRouter(config, {
    nextRequestId: () => 'req',
    rewrite: async ({ body }) => body.replace('原文', '改过'),
    record: () => {},
  })
  const handle = installFetch({
    router: built.router,
    hosts: built.hosts,
    scope: () => ({ sessionId: 's' }),
    recorder,
    warn: () => {},
  })
  t.after(() => { handle.dispose(); globalThis.fetch = original })

  await globalThis.fetch('https://api.deepseek.com/chat/completions', { method: 'POST', body: '原文' })
  assert.equal(seen.length, 1)
  // 没命中端点规则 ⇒ 不注头；但 body 是改过的那份。
  assert.equal(seen[0].headers.get('x-opencode-session'), null)
  assert.equal(await seen[0].text(), '改过')
})

// 2026-09-24 起请求都进 entry（中间件层要对每个请求跑一次改写），所以「不做多余
// 拷贝」不再是契约 —— 这里改成断言真正要紧的事：没改写时 URL 与 body 原样到达。
test('未命中端点规则且没人改写：URL 与 body 原样到达上游', async (t) => {
  const b = bench(CONFIG, { sessionId: 's' }, async () => undefined)
  t.after(() => b.restore())
  await globalThis.fetch('https://api.deepseek.com/chat/completions', { method: 'POST', body: '原文' })
  assert.equal(b.seen.length, 1)
  assert.equal(b.seen[0].input.url, 'https://api.deepseek.com/chat/completions')
  assert.equal(await b.seen[0].input.text(), '原文')
})

test('命中端点规则时，改写后的 body 同样被带进路由', async (t) => {
  const b = bench(CONFIG, { sessionId: 'session-42' }, async ({ body }) => body.replace('原文', '改过'))
  t.after(() => b.restore())
  await globalThis.fetch('https://opencode.ai/zen/go/v1/chat/completions', { method: 'POST', body: '原文' })
  assert.equal(b.seen.length, 1)
  assert.ok(b.seen[0].input instanceof Request)
  assert.equal(b.seen[0].input.headers.get('x-opencode-session'), 'session-42')
})
