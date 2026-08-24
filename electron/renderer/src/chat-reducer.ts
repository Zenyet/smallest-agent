// 前端把 IPC 事件流累积成可渲染的消息列表。做成纯 reducer 是为了能直接单测 ——
// 流式累加 / 缓存命中没有 chunk / 事件分桶 这几处最容易写错，值得测。
import type {
  ErrorCode,
  MessageChunkEvent,
  MessageCompleteEvent,
  ToolCallEvent,
  VerdictEvent,
  CacheHitEvent,
  ErrorEvent,
  Message,
  ApprovalRequestEvent,
} from '../../shared/channels'
import { hydrateMessages } from './hydrate'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  tools: ToolCallEvent[]
  verdict?: { grounded: boolean; issues: string[] }
  cacheHit?: boolean
  streaming: boolean
}

export interface SessionChat {
  messages: ChatMessage[]
  running: boolean
  error?: { code: ErrorCode; message: string }
  // Task 8.5 的写工具审批：等待用户 allow/deny 期间 agent 仍算"运行中"，
  // 这个字段只是驱动 UI 弹出确认框，跟 running 是两个独立的信号。
  pendingApproval?: ApprovalRequestEvent
}

export type ChatState = Record<string, SessionChat>

export type ChatAction =
  | { type: 'user-sent'; sessionId: string; text: string }
  | { type: 'loaded'; sessionId: string; messages: Message[] }
  | { type: 'chunk'; event: MessageChunkEvent }
  | { type: 'tool-call'; event: ToolCallEvent }
  | { type: 'complete'; event: MessageCompleteEvent }
  | { type: 'verdict'; event: VerdictEvent }
  | { type: 'cache-hit'; event: CacheHitEvent }
  | { type: 'error'; event: ErrorEvent }
  | { type: 'approval-request'; event: ApprovalRequestEvent }
  | { type: 'approval-settled'; sessionId: string; requestId: string }
  // 重新挂载后用 getRunnerSnapshot 补状态：这个 sessionId 在主进程里已经在跑，
  // 只是本地 reducer 从零开始、没看到过 user-sent。跟 user-sent 不同，这里不追加
  // 消息（没有对应的用户输入文本可补，消息内容本身靠 select() 的 loadSession 找回），
  // 只补 running 这个信号本身。
  | { type: 'hydrate-running'; sessionId: string }

export function emptySession(): SessionChat {
  return { messages: [], running: false }
}

// 取出（必要时先创建）最后一条 assistant 消息。
// 缓存命中时不会有 chunk 事件，complete 直接到达，所以这个「按需创建」很关键。
function withAssistant(chat: SessionChat, mutate: (m: ChatMessage) => ChatMessage): SessionChat {
  const last = chat.messages.at(-1)
  if (last?.role === 'assistant') {
    return { ...chat, messages: [...chat.messages.slice(0, -1), mutate(last)] }
  }
  const fresh: ChatMessage = { role: 'assistant', content: '', tools: [], streaming: true }
  return { ...chat, messages: [...chat.messages, mutate(fresh)] }
}

// 只改一个会话桶，其余原样返回 —— React 靠引用变化决定重渲染
function update(state: ChatState, sessionId: string, fn: (chat: SessionChat) => SessionChat): ChatState {
  return { ...state, [sessionId]: fn(state[sessionId] ?? emptySession()) }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'user-sent':
      return update(state, action.sessionId, (chat) => ({
        ...chat,
        error: undefined,
        running: true,
        messages: [
          ...chat.messages,
          { role: 'user', content: action.text, tools: [], streaming: false },
        ],
      }))

    case 'loaded':
      // 磁盘历史回放时只替换 messages，不破坏当前这轮（如果在跑）的实时状态。
      // 这样用户在等待时切到别的会话，回来后既能看到历史消息，也不会丢掉正在跑的这轮。
      //
      // 保留 running 的安全性依赖一个前提：agent-runner 的 try/catch/finally 保证
      // 每一轮必定发出 complete 或 error 之一（异常都被 catch 成 error 事件），
      // 所以 running: true 不会永久残留。目前唯一收不到终止事件的情况是主进程硬崩，
      // 而那会连带 renderer 一起没掉、内存状态清零，所以不构成问题。
      // 如果将来加了跨窗口/跨重启的状态持久化，或者多窗口重连，这个前提就不再成立，
      // 需要另加一条「重载时校验这轮是否真的还在跑」的机制。
      return update(state, action.sessionId, (chat) => ({
        ...chat,
        // 工具调用要还原出来，不能丢。
        //
        // 原来这里是 `.filter(user|assistant).map(... tools: [])` —— 两处丢数据：
        // tool 消息被过滤掉、tools 又硬编码成空数组。结果是重开 app 之后
        // 历史里只剩正文。而 toolCalls 一直都在磁盘上。
        // 算法见 hydrate.ts（那边是纯函数，有单测）。
        messages: hydrateMessages(action.messages, action.sessionId),
        // error 不持久化（它是运行时状态，没写进 .json），所以回放时显式清掉，
        // 避免上一轮的错误标记残留在新加载的历史上。
        error: undefined,
      }))

    case 'chunk':
      return update(state, action.event.sessionId, (chat) =>
        withAssistant(chat, (m) => ({ ...m, content: m.content + action.event.text, streaming: true })),
      )

    case 'tool-call':
      return update(state, action.event.sessionId, (chat) =>
        withAssistant(chat, (m) => ({ ...m, tools: [...m.tools, action.event] })),
      )

    case 'complete':
      return update(state, action.event.sessionId, (chat) => ({
        // 用完整答案替换累积的 delta：流式可能丢字，以最终文本为准
        ...withAssistant(chat, (m) => ({ ...m, content: action.event.text, streaming: false })),
        running: false,
        // 这轮跑完了，审批弹窗（如果还挂着）必然已失效。Main 进程要么已 resolve（用户点了 allow），
        // 要么 5 分钟超时自动拒绝——无论哪种，UI 都不该再留着"等您决策"的弹窗。
        pendingApproval: undefined,
      }))

    case 'verdict':
      return update(state, action.event.sessionId, (chat) =>
        withAssistant(chat, (m) => ({
          ...m,
          verdict: { grounded: action.event.grounded, issues: action.event.issues },
        })),
      )

    case 'cache-hit':
      return update(state, action.event.sessionId, (chat) =>
        withAssistant(chat, (m) => ({ ...m, cacheHit: true })),
      )

    case 'error':
      return update(state, action.event.sessionId, (chat) => ({
        ...chat,
        // BUSY 是「这次没受理」，不是「正在跑的那个失败了」，
        // 而且它落在被拒的那个 session 桶里，不影响真正在跑的会话
        running: false,
        error: { code: action.event.code, message: action.event.message },
        // 这轮失败了，审批弹窗同样已失效（跟 complete 的理由一样）。
        pendingApproval: undefined,
      }))

    case 'approval-request':
      // 写工具执行前的确认弹窗。agent 还卡在等审批这一步，running 不变——
      // 它反映的是"整轮有没有跑完"，跟"有没有弹窗待处理"是两件事。
      return update(state, action.event.sessionId, (chat) => ({
        ...chat,
        pendingApproval: action.event,
      }))

    case 'approval-settled':
      // 用户点了 allow/deny 之后，Main 进程把决定发回去执行，弹窗该收起了。
      // 只清掉 requestId 匹配的那个：approval.ts 的 gate 支持多个写工具并发排队
      // （虽然当前的 agent.ts 是串行执行，但架构上不该假设这一点），
      // 而且 settled 消息可能在超时后迟到——那时 UI 可能已为新请求弹了别的窗。
      return update(state, action.sessionId, (chat) => ({
        ...chat,
        pendingApproval:
          chat.pendingApproval?.requestId === action.requestId
            ? undefined
            : chat.pendingApproval,
      }))

    case 'hydrate-running':
      return update(state, action.sessionId, (chat) => ({ ...chat, running: true }))
  }
}
