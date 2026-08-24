// ============================================================================
// hydrate.ts —— 把磁盘上的会话历史还原成界面消息
// ----------------------------------------------------------------------------
// 单独一个文件是为了**能测**：这是纯函数（Message[] 进、ChatMessage[] 出），
// 不需要 React 环境。原来这段逻辑内联在 chat-reducer 的 'loaded' 分支里，
// 测它就得连带整个 reducer 的状态形状。
//
// ## 这里修的是什么
//
// 原来那段是：
//
//     .filter((m) => m.role === 'user' || m.role === 'assistant')
//     .map((m) => ({ role, content, tools: [], streaming: false }))
//
// 两处丢数据：`filter` 把 tool 消息（工具结果）整个扔掉，`map` 又把
// `tools` 硬编码成空数组。所以重开 app 之后历史里只剩正文，
// 「它当时到底做了什么」全没了 —— 而 `toolCalls` 一直都在磁盘上
// （src/types.ts 的 Message 带这个字段，sessions.ts 原样读写）。
//
// ## turn 号是重建出来的，不是存下来的
//
// ToolCallEvent 需要一个 turn 号来分组（MessageBubble 的 groupByTurn 靠它），
// 而磁盘上没存。但它不需要存 —— 由消息顺序唯一决定：
//
//   agent 循环每转一圈，push 一条带 toolCalls 的 assistant，
//   紧跟着 push 那一批 tool 结果（见 src/agent.ts 的循环）。
//
// 所以「一条带 toolCalls 的 assistant + 它后面紧跟的那批 tool」就是一轮，
// 数它出现第几次就是 turn 号。这个结论先在 rs 侧验证过
// （rs/ui/src/history.rs 有一组测试锁着，包括并行调用同轮、多轮不并组）。
//
// ## 为什么工具调用挂在「后面」那条 assistant 上
//
// 界面上工具轨迹画在正文上方（见 MessageBubble），表达的是「为了答这句话，
// 我先做了这些」。而磁盘上的顺序是「带 toolCalls 的 assistant → tool 结果
// → 最终回答的 assistant」，中间那条 assistant 的 content 通常是空的
// （模型那一轮只调工具没说话）。
//
// 所以要把工具攒着，等遇到**有正文的** assistant 时一起交给它。
// 攒的东西在最后没等到正文（那一轮被中断了）也要落地，否则那几次调用
// 会静默消失 —— 而「上次干到哪儿了」正是用户最想回看的情况。
// ============================================================================

import type { Message, ToolCallEvent } from '../../shared/channels'
import type { ChatMessage } from './chat-reducer'

export function hydrateMessages(history: Message[], sessionId: string): ChatMessage[] {
  const out: ChatMessage[] = []
  // 待归属的工具轨迹，等一条有正文的 assistant 来收
  let pending: ToolCallEvent[] = []
  // 已经开了几轮工具调用。turn 从 1 开始，和运行时一致
  let turn = 0
  // toolCallId → 这次调用的轮次/工具名/参数。
  // tool 消息只带 id，名字和参数在前面那条 assistant 的 toolCalls 里
  const calls = new Map<string, { turn: number; name: string; args: Record<string, unknown> }>()

  // 没等到正文的工具轨迹落成一条独立的助手消息
  const flush = () => {
    if (pending.length === 0) return
    out.push({
      role: 'assistant',
      content: '',
      tools: pending,
      streaming: false,
    })
    pending = []
  }

  for (const m of history) {
    if (m.role === 'user') {
      // 用户消息前先把没归属的工具落地，否则它们会跨到下一轮对话里去
      flush()
      out.push({ role: 'user', content: m.content, tools: [], streaming: false })
      continue
    }

    if (m.role === 'assistant') {
      if (m.toolCalls && m.toolCalls.length > 0) {
        // 新一轮工具调用
        turn += 1
        for (const c of m.toolCalls) {
          calls.set(c.id, { turn, name: c.name, args: c.args })
        }
      }
      if (m.content.length > 0) {
        // 有正文：这条就是「答案」，把攒着的工具挂给它
        out.push({
          role: 'assistant',
          content: m.content,
          tools: pending,
          streaming: false,
        })
        pending = []
      }
      continue
    }

    if (m.role === 'tool') {
      // 用 id 找回这次调用的轮次和参数。找不到的话（历史被手改过、
      // 或者上游丢了那条 assistant）仍然显示出来，只是参数空着 ——
      // 比整条丢掉好，用户至少知道调过什么
      const call = m.toolCallId ? calls.get(m.toolCallId) : undefined
      if (m.toolCallId) calls.delete(m.toolCallId)
      pending.push({
        sessionId,
        turn: call?.turn ?? Math.max(turn, 1),
        toolName: call?.name ?? m.name ?? '(未知工具)',
        args: call?.args ?? {},
        output: m.content,
      })
      continue
    }

    // system 不显示：它是我们注入的，不是对话内容
  }

  // 收尾：最后一轮只有工具没有正文（被中断、或者存盘时正好在那个点）
  flush()
  return out
}
