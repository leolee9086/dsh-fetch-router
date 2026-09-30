import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRouter, normalizeConfig } from '../lib/rules.js'
import { createRecorder } from '../lib/recorder.js'
import { installFetch } from '../lib/interceptor.js'

function bench(t) {
  const config = normalizeConfig({ routes: [] })
  const seen = []
  const rewrites = []
  const built = buildRouter(config, {
    nextRequestId: () => 'req', record: () => {},
    rewrite: async input => { rewrites.push(input); return input.body.replace('original', 'rewritten') },
  })
  const original = globalThis.fetch
  globalThis.fetch = async request => { seen.push(request); return new Response('ok') }
  const handle = installFetch({ router: built.router, scope: () => ({ sessionId: 's' }), recorder: createRecorder(config), warn: () => {} })
  t.after(() => { handle.dispose(); globalThis.fetch = original })
  return { seen, rewrites }
}

test('SDK Request JSON bodies are rewritten and retain headers and cancellation', async t => {
  const b = bench(t)
  const controller = new AbortController()
  await fetch(new Request('https://example.invalid/chat', {
    method: 'POST', body: '{"text":"original"}', headers: { 'content-type': 'application/json', 'x-original': 'kept' }, signal: controller.signal,
  }))
  assert.equal(await b.seen[0].text(), '{"text":"rewritten"}')
  assert.equal(b.seen[0].headers.get('x-original'), 'kept')
  assert.equal(b.rewrites[0].scope.sessionId, 's')
  controller.abort()
  assert.equal(b.seen[0].signal.aborted, true)
})

test('binary Request bodies are preserved byte for byte and never sent to text rewriters', async t => {
  const b = bench(t)
  const bytes = new Uint8Array([0, 255, 128, 1])
  await fetch(new Request('https://example.invalid/upload', { method: 'POST', body: bytes, headers: { 'content-type': 'application/octet-stream' } }))
  assert.deepEqual(new Uint8Array(await b.seen[0].arrayBuffer()), bytes)
  assert.equal(b.rewrites.length, 0)
})

test('explicit streams and FormData are not buffered or rewritten', async t => {
  const b = bench(t)
  const bytes = new Uint8Array([255, 1, 128])
  await fetch('https://example.invalid/upload', {
    method: 'POST', body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } }), duplex: 'half',
  })
  assert.deepEqual(new Uint8Array(await b.seen[0].arrayBuffer()), bytes)
  const form = new FormData()
  form.set('text', 'original')
  await fetch(new Request('https://example.invalid/form', { method: 'POST', body: form }))
  assert.equal((await b.seen[1].formData()).get('text'), 'original')
  assert.equal(b.rewrites.length, 0)
})
