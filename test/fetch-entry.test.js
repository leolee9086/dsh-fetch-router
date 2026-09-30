import test from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '@leolee9086/sac-path-router'
import { createRoutedFetch } from '../lib/fetch-entry.js'

function bench(configure) {
  const router = createRouter({ matcher: 'radix3' })
  const seen = []
  configure(router)
  const fetch = createRoutedFetch({
    router,
    network: async request => { seen.push(request); return new Response('ok') },
  })
  return { fetch, seen }
}

test('rewritten bodies survive internal path redispatch and discard stale content length', async () => {
  const b = bench(router => {
    router.use(async (ctx, next) => {
      ctx.requestBody = ctx.requestBody.replace('original', 'a longer rewrite')
      await next()
    })
    router.post('/before', ctx => { ctx.path = '/after' })
  })
  await b.fetch('https://example.invalid/before', { method: 'POST', body: 'original', headers: { 'content-length': '8' } })
  assert.equal(b.seen.length, 1)
  assert.equal(b.seen[0].url, 'https://example.invalid/after')
  assert.equal(await b.seen[0].text(), 'a longer rewrite')
  assert.equal(b.seen[0].headers.has('content-length'), false)
})

test('binary streams survive path redispatch without being converted to text', async () => {
  const b = bench(router => { router.post('/before', ctx => { ctx.path = '/after' }) })
  const bytes = new Uint8Array([0, 255, 128, 1])
  await b.fetch('https://example.invalid/before', {
    method: 'POST', body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } }), duplex: 'half',
  })
  assert.equal(b.seen[0].url, 'https://example.invalid/after')
  assert.deepEqual(new Uint8Array(await b.seen[0].arrayBuffer()), bytes)
})

test('concurrent requests do not share mutable body contexts', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const b = bench(router => {
    router.use(async (ctx, next) => {
      const original = ctx.requestBody
      if (original === 'first') await gate
      else release()
      ctx.requestBody = original + '-rewritten'
      await next()
    })
  })
  await Promise.all(['first', 'second'].map(body => b.fetch('https://example.invalid/chat', { method: 'POST', body })))
  assert.deepEqual((await Promise.all(b.seen.map(request => request.text()))).sort(), ['first-rewritten', 'second-rewritten'])
})

test('an empty rewritten body is sent rather than falling back to the original', async () => {
  const b = bench(router => { router.use(async (ctx, next) => { ctx.requestBody = ''; await next() }) })
  await b.fetch('https://example.invalid/chat', { method: 'POST', body: 'original' })
  assert.equal(await b.seen[0].text(), '')
})

test('explicit text-labelled streams are still excluded from text rewriting', async () => {
  let body
  const b = bench(router => { router.use(async (ctx, next) => { body = ctx.requestBody; await next() }) })
  await b.fetch('https://example.invalid/stream', {
    method: 'POST', headers: { 'content-type': 'text/plain' }, duplex: 'half',
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('original')); c.close() } }),
  })
  assert.equal(body, undefined)
  assert.equal(await b.seen[0].text(), 'original')
})

test('local responses and middleware failures never fall through to the network', async () => {
  const failure = new Error('rewriter failed')
  const b = bench(router => {
    router.post('/mock', ctx => { ctx.status = 202; ctx.body = 'local' })
    router.post('/failure', () => { throw failure })
  })
  const response = await b.fetch('https://example.invalid/mock', { method: 'POST', body: 'original' })
  assert.equal(response.status, 202)
  assert.equal(await response.text(), 'local')
  await assert.rejects(b.fetch('https://example.invalid/failure', { method: 'POST', body: 'original' }), error => error === failure)
  assert.equal(b.seen.length, 0)
})

test('Request init overrides and structured JSON media types reach the rewriter', async () => {
  const b = bench(router => {
    router.use(async (ctx, next) => { ctx.requestBody = ctx.requestBody.replace('original', 'rewritten'); await next() })
  })
  const request = new Request('https://example.invalid/chat', { method: 'POST', body: '{"value":"original"}', headers: { 'content-type': 'application/problem+json' } })
  await b.fetch(request, { headers: { 'content-type': 'application/problem+json', 'x-override': 'yes' } })
  assert.equal(await b.seen[0].text(), '{"value":"rewritten"}')
  assert.equal(b.seen[0].headers.get('x-override'), 'yes')
})
