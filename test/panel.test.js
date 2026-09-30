import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createPanelHandler, installPanel, isLoopback } from '../lib/panel.js'
import { createRecorder } from '../lib/recorder.js'
import { normalizeConfig } from '../lib/rules.js'

async function bench(t) {
  const config = normalizeConfig({ routes: [] })
  const recorder = createRecorder(config)
  let subscriptions = 0
  const subscribe = recorder.subscribe
  recorder.subscribe = callback => {
    subscriptions += 1
    const release = subscribe(callback)
    let active = true
    return () => { if (active) { active = false; subscriptions -= 1; release() } }
  }
  const connection = { requestRejection: req => {
    const denial = req.headers['x-test-deny']
    return denial === undefined ? undefined : Number(denial)
  } }
  const panel = createPanelHandler({ recorder, describeRoutes: () => [] }, connection, '/fetch-router')
  let lastResponse
  const server = createServer((req, res) => {
    lastResponse = res
    panel.handler(req, res).catch(error => { res.writeHead(500); res.end(error.message) })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    panel.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  return {
    recorder, panel, subscriptions: () => subscriptions, response: () => lastResponse,
    url: route => `http://127.0.0.1:${server.address().port}/fetch-router${route}`,
  }
}

test('panel applies Connection authentication to stats, SSE and mutations', async t => {
  const b = await bench(t)
  for (const denial of [401, 403]) {
    for (const [route, method] of [['/stats.json', 'GET'], ['/events', 'GET'], ['/recording', 'POST']]) {
      const response = await fetch(b.url(route), { method, headers: { 'x-test-deny': String(denial) } })
      assert.equal(response.status, denial)
      assert.equal((await response.json()).error, denial === 401 ? 'unauthorized' : 'forbidden')
    }
  }
  assert.equal(b.recorder.paused, false)
  assert.equal(b.subscriptions(), 0)
  const response = await fetch(b.url('/stats.json'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual((await response.json()).routes, [])
})

test('recording changes require an explicit boolean and oversized bodies receive 413', async t => {
  const b = await bench(t)
  const send = body => fetch(b.url('/recording'), { method: 'POST', body })
  for (const body of ['', 'invalid', 'null', '{}', '{"paused":"true"}']) {
    assert.equal((await send(body)).status, 400)
    assert.equal(b.recorder.paused, false)
  }
  const response = await send('{"paused":true}')
  assert.deepEqual(await response.json(), { paused: true })
  assert.equal((await send('x'.repeat(65537))).status, 413)
  assert.equal(b.recorder.paused, true)
  assert.deepEqual(await (await send('{"paused":false}')).json(), { paused: false })
})

test('SSE sends live updates and releases subscriptions when the client disconnects', async t => {
  const b = await bench(t)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const response = await fetch(b.url('/events'), { signal: controller.signal })
  const reader = response.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /"paused":false/)
  assert.equal(b.subscriptions(), 1)
  b.recorder.setPaused(true)
  assert.match(new TextDecoder().decode((await reader.read()).value), /"paused":true/)
  const closed = once(b.response(), 'close')
  await reader.cancel()
  await closed
  assert.equal(b.subscriptions(), 0)
})

test('unloading the panel closes active SSE clients and releases subscriptions', async t => {
  const b = await bench(t)
  const response = await fetch(b.url('/events'))
  const reader = response.body.getReader()
  await reader.read()
  b.panel.dispose()
  assert.equal(b.subscriptions(), 0)
  assert.equal((await reader.read()).done, true)
  b.panel.dispose()
})

test('panel mounting waits for both webServer and Connection, without returning an invalid effect', () => {
  let requires
  let callback
  installPanel({ inject: (names, fn) => { requires = names; callback = fn } }, {
    config: normalizeConfig({ routes: [] }), warn: () => {},
  })
  assert.deepEqual(requires, ['webServer', 'connection'])
  let registered = false
  assert.equal(callback({ get: name => name === 'webServer' ? { register: () => { registered = true } } : undefined }), undefined)
  assert.equal(registered, false)
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback({ socket: { remoteAddress } }), true)
  assert.equal(isLoopback({ socket: { remoteAddress: '192.168.1.2' } }), false)
})
