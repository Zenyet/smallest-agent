// 把 Main 进程里抛出的各种异常翻译成前端能展示的错误码。
// 注意这里没有 TOOL_ERROR —— runTool 把工具异常包成 JSON 返回给模型
// （src/tools/index.ts），工具失败不会抛到这里，而是作为工具卡片的内容展示。
import type { ErrorCode, ErrorEvent } from '../shared/channels'

// 按「消息里出现什么关键字」判断错误类型。顺序有意义：先匹配具体的，再兜底。
const RULES: { code: ErrorCode; test: RegExp }[] = [
  { code: 'API_KEY_MISSING', test: /DEEPSEEK_API_KEY/i },
  { code: 'MAX_TURNS', test: /exceeded maxTurns/i },
  {
    code: 'MODEL_ERROR',
    // 「No output generated」也算模型错误：那是 AI SDK 在流式路径上
    // 「一个 chunk 都没收到就结束了」时抛的，实际原因几乎总是 API 调用失败
    // （401、配额、网络）。归到 UNKNOWN 的话前端显示「出错了」，
    // 而这明确是模型这一层的问题。
    test: /\b(4\d{2}|5\d{2})\b|fetch failed|timeout|ECONNREFUSED|ENOTFOUND|No output generated/i,
  },
]

/**
 * AI SDK 的流式路径吞掉真实原因，这里把它捞回来。
 *
 * ## 问题
 *
 * `streamText` 不会因为 API 调用失败而 reject —— 失败是异步发生的，而
 * `await result.text` 抛的是 `NoOutputGeneratedError`，消息只有一句
 * 「No output generated. Check the stream for errors.」。而且它构造时
 * **没有传 cause**（核对过 ai@6.0.205 的 index.mjs:7142），所以顺 cause 链
 * 也找不到真正的错误。
 *
 * 用户看到的是「出错了 / No output generated」，对排查毫无帮助 ——
 * 实际原因可能是 key 错了、配额没了、或者模型名不属于这家厂商。
 *
 * ## 做法
 *
 * 不改 src/llm.ts（它和 CLI 共用，零修改约束）。在这里把这句话换成一句
 * 说得出下一步的话，并提示去看主进程日志 —— 真实的 APICallError 会由
 * SDK 打在那儿（含 url、model、responseBody）。
 */
function humanize(message: string): string {
  if (!/No output generated/i.test(message)) return message
  return (
    '模型没有返回任何内容。常见原因：API Key 无效或过期、额度用尽、' +
    '当前模型不属于所选厂商（对话框左下角重新选一个）。' +
    '具体的服务端报错在应用日志里（含请求地址和模型名）。'
  )
}

export function toErrorEvent(sessionId: string, err: unknown): ErrorEvent {
  const raw = err instanceof Error ? err.message : String(err)
  const rule = RULES.find((r) => r.test.test(raw))
  return { sessionId, code: rule?.code ?? 'UNKNOWN', message: humanize(raw) }
}
