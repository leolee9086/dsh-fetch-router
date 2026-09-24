// 真正的 HTTP socket 中断，而不是手工 throw 一个模拟错误。
// 验证 fetch-router 把底层 cause 留在错误行，且继续拒绝原请求。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRecorder } from '../lib/recorder.js'
import { buildRouter, normalizeConfig, requestTarget } from '../lib/rules.js'
import { installFetch } from '../lib/interceptor.js'

const config = normalizeConfig({ routes: [], panel: { enabled: false } })
const recorder = createRecorder(config)
const received = []
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  received.push(Buffer.concat(chunks).toString('utf8'))
  if (req.url === '/disconnect') req.socket.destroy()
  else res.end('ok')
})
const built = buildRouter(config, {
  nextRequestId: () => 'local-transport-check',
  rewrite: ({ body }) => body.replace('before', 'after'),
  record: entry => recorder.record({ ...entry, target: requestTarget(entry.request.url), method: entry.request.method }),
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const nativeFetch = globalThis.fetch
const handle = installFetch({ ...built, recorder, scope: () => undefined, warn: console.warn })
try {
  const base = 'http://127.0.0.1:' + server.address().port
  const send = path => fetch(base + path, { method: 'POST', body: 'before', signal: AbortSignal.timeout(5000) })
  let failure
  try { await send('/disconnect') } catch (error) { failure = error }
  assert.ok(failure, '连接被断开，fetch 必须拒绝')
  assert.equal(failure.message, 'fetch failed')
  assert.ok(failure.cause?.code, '真正的网络异常必须带 cause.code')
  const row = recorder.snapshot(built.describe).rows.find(item => item.outcome === 'error')
  assert.ok(row.detail.includes(failure.cause.code), '记录必须带底层错误码')
  assert.ok(row.detail.includes(failure.cause.message), '记录必须带底层错误信息')
  assert.ok(row.detail.includes(failure.stack), '记录必须保留调用堆栈')
  assert.equal(received[0], 'after', '断连发生于真实改写并发送之后')
  console.log('真实断连：', failure.message, 'cause.code=' + failure.cause.code)
  console.log('错误行保留 cause/message/stack；请求仍拒绝，没有吞错重发')
  const response = await send('/ok')
  assert.equal(response.status, 200)
  await response.text()
  assert.equal(received.length, 2)
  assert.equal(received[1], 'after')
  console.log('随后独立请求：200，服务端收到改后正文')
} finally {
  handle.dispose()
  assert.equal(globalThis.fetch, nativeFetch)
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
