// 把 Main 进程里抛出的各种异常翻译成前端能展示的错误码。
// 注意这里没有 TOOL_ERROR —— runTool 把工具异常包成 JSON 返回给模型
// （src/tools/index.ts），工具失败不会抛到这里，而是作为工具卡片的内容展示。
import type { ErrorCode, ErrorEvent } from '../shared/channels'

// 按「消息里出现什么关键字」判断错误类型。顺序有意义：先匹配具体的，再兜底。
const RULES: { code: ErrorCode; test: RegExp }[] = [
  { code: 'API_KEY_MISSING', test: /DEEPSEEK_API_KEY/i },
  { code: 'MAX_TURNS', test: /exceeded maxTurns/i },
  { code: 'MODEL_ERROR', test: /\b(4\d{2}|5\d{2})\b|fetch failed|timeout|ECONNREFUSED|ENOTFOUND/i },
]

export function toErrorEvent(sessionId: string, err: unknown): ErrorEvent {
  const message = err instanceof Error ? err.message : String(err)
  const rule = RULES.find((r) => r.test.test(message))
  return { sessionId, code: rule?.code ?? 'UNKNOWN', message }
}
