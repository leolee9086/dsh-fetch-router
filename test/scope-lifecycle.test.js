import test from 'node:test'
import assert from 'node:assert/strict'
import { currentScope, installScope, runInScope, wrapIterable } from '../lib/scope.js'

function listener(warn) {
  let handler
  installScope({ on: (event, callback) => {
    assert.equal(event, 'llm/stream')
    handler = callback
  } }, warn)
  return handler
}

test('scope covers eager dispatch, async preparation, iterator construction and cancellation', async () => {
  const observed = []
  const mark = stage => observed.push([stage, currentScope()?.sessionId])
  const stream = await listener()({ sessionId: 'session-a' }, async () => {
    mark('dispatch')
    await Promise.resolve()
    mark('prepare')
    return {
      [Symbol.asyncIterator]() {
        mark('iterator')
        return {
          async next() { mark('next'); return { value: 'chunk', done: false } },
          async return() { mark('return'); return { done: true } },
        }
      },
    }
  })
  assert.equal(currentScope(), undefined)
  assert.equal((await stream.next()).value, 'chunk')
  await stream.return()
  assert.deepEqual(observed, ['dispatch', 'prepare', 'iterator', 'next', 'return'].map(stage => [stage, 'session-a']))
  assert.equal(currentScope(), undefined)
})

test('completed iterators are not closed a second time', async () => {
  let closed = 0
  const stream = wrapIterable({
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ value: 'result', done: true }),
        return: async () => { closed += 1; return { done: true } },
      }
    },
  }, { sessionId: 'complete' })
  assert.deepEqual(await stream.next(), { value: 'result', done: true })
  assert.equal(closed, 0)
})

test('parallel model calls keep their own scopes and restore the consumer scope', async () => {
  const intercept = listener()
  const stream = sessionId => intercept({ sessionId }, async () => {
    await Promise.resolve()
    assert.equal(currentScope()?.sessionId, sessionId)
    return (async function* () {
      await Promise.resolve()
      yield currentScope()?.sessionId
      await Promise.resolve()
      yield currentScope()?.sessionId
    })()
  })
  await runInScope({ sessionId: 'consumer' }, async () => {
    const [a, b] = await Promise.all([stream('a'), stream('b')])
    const collect = async source => { const result = []; for await (const value of source) result.push(value); return result }
    assert.deepEqual(await Promise.all([collect(a), collect(b)]), [['a', 'a'], ['b', 'b']])
    assert.equal(currentScope()?.sessionId, 'consumer')
  })
  assert.equal(currentScope(), undefined)
})

test('dispatch and iteration failures are propagated without scope leakage', async () => {
  const warnings = []
  const failure = new Error('dispatch failed')
  assert.throws(() => listener(value => warnings.push(value))({}, () => { throw failure }), error => error === failure)
  assert.equal(warnings.length, 1)
  const stream = listener()({ sessionId: 'failed' }, () => (async function* () { throw failure })())
  await assert.rejects(stream.next(), error => error === failure)
  assert.equal(currentScope(), undefined)
})
