import test from 'node:test'
import assert from 'node:assert/strict'
import { createRewriteRegistry, REWRITE_SERVICE } from '../lib/rewrite.js'

test('登记一个改写器，apply 拿到它改后的 body', async () => {
  const registry = createRewriteRegistry()
  registry.register('demo', ({ body }) => body.replace('a', 'b'))
  assert.equal(await registry.apply({ url: 'https://x/y', method: 'POST', body: 'aaa' }), 'baa')
  assert.equal(REWRITE_SERVICE, 'requestRewrite')
})

test('没有改写器、或者没人改，都返回 undefined', async () => {
  const registry = createRewriteRegistry()
  assert.equal(await registry.apply({ url: 'u', method: 'POST', body: 'aaa' }), undefined)
  registry.register('noop', () => undefined)
  assert.equal(await registry.apply({ url: 'u', method: 'POST', body: 'aaa' }), undefined)
})

test('多个改写器依次作用，前一个的结果是后一个的输入', async () => {
  const registry = createRewriteRegistry()
  registry.register('one', ({ body }) => body + '1')
  registry.register('two', ({ body }) => body + '2')
  assert.equal(await registry.apply({ url: 'u', method: 'POST', body: 'x' }), 'x12')
})

test('改写器能拿到 url / method / scope', async () => {
  const registry = createRewriteRegistry()
  let seen
  registry.register('peek', request => { seen = request; return undefined })
  await registry.apply({ url: 'https://x/y', method: 'POST', body: 'x', scope: { agentId: 'a1' } })
  assert.deepEqual(seen, { url: 'https://x/y', method: 'POST', body: 'x', scope: { agentId: 'a1' } })
})

test('一个改写器出错不挡住别的，但留下 warn', async () => {
  const warns = []
  const registry = createRewriteRegistry({ warn: message => warns.push(message) })
  registry.register('broken', () => { throw new Error('炸了') })
  registry.register('ok', ({ body }) => body + '!')
  assert.equal(await registry.apply({ url: 'u', method: 'POST', body: 'x' }), 'x!')
  assert.match(warns[0], /broken/)
})

test('返回非字符串时记 warn 并跳过', async () => {
  const warns = []
  const registry = createRewriteRegistry({ warn: message => warns.push(message) })
  registry.register('weird', () => 42)
  assert.equal(await registry.apply({ url: 'u', method: 'POST', body: 'x' }), undefined)
  assert.match(warns[0], /不是字符串/)
})

test('取消登记后不再生效', async () => {
  const registry = createRewriteRegistry()
  const off = registry.register('demo', ({ body }) => body + '!')
  off()
  assert.equal(await registry.apply({ url: 'u', method: 'POST', body: 'x' }), undefined)
})

test('登记参数不对就抛错', () => {
  const registry = createRewriteRegistry()
  assert.throws(() => registry.register('', () => ''), /要有名字/)
  assert.throws(() => registry.register('x', null), /要是一个函数/)
})
