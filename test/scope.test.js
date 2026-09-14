import test from 'node:test'
import assert from 'node:assert/strict'
import { currentScope, installScope, runInScope, wrapIterable, wrapStream } from '../lib/scope.js'

test('作用域穿透异步迭代：每次 next() 都在作用域内', async () => {
  async function* source() {
    yield currentScope()?.sessionId
    yield currentScope()?.provider
  }
  const wrapped = wrapIterable(source(), { sessionId: 's-9', provider: 'opencode-go' })
  assert.equal((await wrapped.next()).value, 's-9')
  assert.equal((await wrapped.next()).value, 'opencode-go')
  assert.equal((await wrapped.next()).done, true)
})

test('作用域外读不到值', () => {
  assert.equal(currentScope(), undefined)
  assert.equal(runInScope({ sessionId: 'x' }, () => currentScope()?.sessionId), 'x')
})

test('wrapStream 同时支持 promise 与流', async () => {
  async function* source() {
    yield currentScope()?.model
  }
  const fromPromise = await wrapStream(Promise.resolve(source()), { model: 'm-1' })
  assert.equal((await fromPromise.next()).value, 'm-1')
  assert.equal(wrapStream(undefined, {}), undefined)
})

test('installScope：包装 llm/stream 的返回值', async () => {
  const listeners = []
  const ctx = { on: (name, listener) => { listeners.push({ name, listener }) } }
  installScope(ctx)
  assert.equal(listeners[0].name, 'llm/stream')

  async function* adapterStream() {
    yield currentScope()?.sessionId
  }
  const result = listeners[0].listener(
    { provider: 'opencode-go-completions', model: 'deepseek-v4.1-flash', sessionId: 'session-abc', purpose: 'chat' },
    () => adapterStream(),
  )
  assert.equal((await result.next()).value, 'session-abc')
})

test('installScope 会向下游传 next()（瀑布语义）', () => {
  const listeners = []
  const ctx = { on: (name, listener) => { listeners.push({ name, listener }) } }
  installScope(ctx)
  let called = 0
  listeners[0].listener({ sessionId: 's' }, () => { called += 1; return undefined })
  assert.equal(called, 1)
})
