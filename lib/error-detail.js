/**
 * 将 fetch 的异常链转成侧栏可读文字。
 * Node 的顶层 message 通常只有 "fetch failed"，真正原因在 cause.code/message。
 * 只取错误诊断字段，不序列化请求、响应、headers 或 SDK 附带的整个对象。
 */
export function errorDetail(error) {
  const lines = []
  const seen = new Set()
  const visit = (value, label, depth) => {
    if (depth > 8) { lines.push(label + ': [depth limit]'); return }
    if (value === null || typeof value !== 'object') {
      lines.push(label + ': ' + String(value))
      return
    }
    if (seen.has(value)) { lines.push(label + ': [circular]'); return }
    seen.add(value)
    const name = typeof value.name === 'string' ? value.name : 'Error'
    const code = typeof value.code === 'string' || typeof value.code === 'number' ? ' [' + value.code + ']' : ''
    const message = typeof value.message === 'string' ? value.message : ''
    lines.push(label + ': ' + name + code + ': ' + message)
    if (typeof value.stack === 'string') lines.push(value.stack)
    if (value.cause !== undefined) visit(value.cause, label + '.cause', depth + 1)
    // 某些连接失败是 AggregateError，每个地址的失败原因都值得保留。
    if (Array.isArray(value.errors)) {
      value.errors.slice(0, 8).forEach((item, index) => visit(item, label + '.errors[' + index + ']', depth + 1))
    }
  }
  try {
    visit(error, 'error', 0)
  } catch {
    // 异常也可能是第三方抛出的带 getter 的对象。诊断失败不能覆盖原异常。
    lines.push('[error diagnostics unavailable]')
  }
  return lines.join('\n').slice(0, 24000)
}
