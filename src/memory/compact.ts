// ============================================================================
// memory/compact.ts —— 上下文压缩：超预算时把老消息摘要成一条
// ----------------------------------------------------------------------------
// Stage 2「上下文压缩」的核心逻辑。问题：跨会话记忆会让 messages 越来越长，
// 超过模型 context window 就会报错或被截断。
//
// 解法（滑动窗口 + 摘要）：保留 system + 最近 K 条，把更老的消息喂给模型
// 摘成一条 summary message，用少量 token 保住关键信息。
//
// 在 agent 循环里：compact 作为可选钩子注入 runAgent，在进循环之前调用，
// 不改循环本体——这是「在循环周围加东西」的典型示例。
// ============================================================================

import type { Message } from '../types'

// Summarize 是注入的摘要函数签名，由 makeSummarizer 实现；
// 这里只依赖接口，compact 模块对「摘要用哪个模型」一无所知，便于测试替换。
export type Summarize = (messages: Message[]) => Promise<string>

// 粗略估算 token 数：中文（CJK）约 1 token/字，其它（英文/符号）约 4 字符/token。
// 够用即可，真实系统会用分词器。
const CJK = /[一-鿿㐀-䶿　-〿＀-￯]/g

// estimateTokens 对外暴露，便于 cli 打印「当前上下文占用」或写测试断言。
export function estimateTokens(messages: Message[]): number {
  let total = 0
  for (const m of messages) {
    const cjk = (m.content.match(CJK) ?? []).length
    const other = m.content.length - cjk
    total += cjk + Math.ceil(other / 4)
  }
  return total
}

export async function compactMessages(
  messages: Message[],
  opts: { maxTokens: number; keepRecent: number; summarize: Summarize },
): Promise<Message[]> {
  // 未超预算直接返回原数组，不触发摘要（避免不必要的模型调用）。
  if (estimateTokens(messages) <= opts.maxTokens) return messages

  // system prompt 必须始终保留在最前，不能被压缩进摘要。
  const hasSystem = messages[0]?.role === 'system'
  const system = hasSystem ? messages.slice(0, 1) : []
  const rest = hasSystem ? messages.slice(1) : messages

  // recent = 最新的 keepRecent 条，这部分原文保留，给模型充足的近期上下文。
  let recent = rest.slice(-opts.keepRecent)
  // 丢掉开头悬空的 tool 结果：它的 assistant(tool_call) 已被摘进 older，
  // 否则保留窗口会以孤立 tool 消息开头，被 OpenAI 兼容 API 拒绝。
  while (recent[0]?.role === 'tool') recent = recent.slice(1)
  const older = rest.slice(0, rest.length - recent.length)
  // older 为空说明历史全在 recent 窗口里，无可压缩，直接返回。
  if (older.length === 0) return messages

  const summary = await opts.summarize(older)
  // 摘要用 role:'user'（而非 system）：这样它能通过持久化时的 filter(role!=='system')，
  // 重载时也不会和真正的 system prompt 重复。
  const summaryMsg: Message = { role: 'user', content: `【之前对话摘要】\n${summary}` }
  return [...system, summaryMsg, ...recent]
}
