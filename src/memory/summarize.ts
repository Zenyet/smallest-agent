// ============================================================================
// memory/summarize.ts —— 把一段对话渲染后让模型摘成要点
// ----------------------------------------------------------------------------
// 这是 compact.ts 所需 Summarize 函数的「真实实现」。
// 它本身不直接导入 callModel，而是通过工厂函数参数注入——
// 好处：测试时可以传入假的 callModel（直接返回固定字符串），不需要真实 API。
//
// 在整体流程里：cli 把 makeSummarizer(callModel) 的结果传给 compactMessages，
// compact 再作为钩子传给 runAgent，形成「注入链」。
// ============================================================================

import type { Message, ModelResult } from '../types'
import type { Summarize } from './compact'

// makeSummarizer 是工厂函数：注入 callModel，返回符合 Summarize 签名的闭包。
// 注入 callModel 而非硬编码，所以可以复用 cli 里已有的缓存/重试/日志装饰器。
export function makeSummarizer(
  callModel: (messages: Message[]) => Promise<ModelResult>,
): Summarize {
  return async (messages: Message[]): Promise<string> => {
    // 把结构化 Message[] 展开成纯文本，因为摘要 prompt 的 user 消息只能是字符串。
    const rendered = messages.map((m) => `${m.role}: ${m.content}`).join('\n')
    const result = await callModel([
      {
        role: 'system',
        content:
          '你是对话摘要器。把下面的对话压成简洁中文要点，保留关键事实、决定、用户偏好；只输出摘要文本，不要调用工具。',
      },
      { role: 'user', content: rendered },
    ])
    return result.text
  }
}
