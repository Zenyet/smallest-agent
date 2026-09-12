import type { ContentPart } from '../../../src/types'
// 前端把 IPC 事件流累积成可渲染的消息列表。做成纯 reducer 是为了能直接单测 ——
// 流式累加 / 缓存命中没有 chunk / 事件分桶 这几处最容易写错，值得测。
import type {
  ErrorCode,
  MessageChunkEvent,
  MessageCompleteEvent,
  ToolCallEvent,
  VerdictEvent,
  CacheHitEvent,
  CancelledEvent,
  ErrorEvent,
  Message,
  ApprovalRequestEvent,
} from '../../shared/channels'
import { hydrateMessages } from './hydrate'

export interface ChatMessage {
  usages?: import('../../../src/types').TokenUsage[]
  role: 'user' | 'assistant'
  content: string
  contentParts?: ContentPart[]
  tools: ToolCallEvent[]
  verdict?: { grounded: boolean; issues: string[] }
  cacheHit?: boolean
  streaming: boolean
  /** 用户消息：发送时刻；助手消息：回复完成时刻。Date.now()。历史回放无此字段。 */
  timestamp?: number
}

export interface SessionChat {
  messages: ChatMessage[]
  running: boolean
  error?: { code: ErrorCode; message: string }
  // Task 8.5 的写工具审批：等待用户 allow/deny 期间 agent 仍算"运行中"，
  // 这个字段只是驱动 UI 弹出确认框，跟 running 是两个独立的信号。
  pendingApproval?: ApprovalRequestEvent
  /**
   * 这一轮是什么时候开始的（Date.now()）。running 为 false 时无意义。
   *
   * ## 为什么这个时间戳必须活在 state 里
   *
   * 「已等待 Ns」原来是 LoadingState 自己 `useState(0)` + setInterval 数的，
   * 从**组件挂载**起算。那等于把「这一轮开始于何时」和「这个组件何时被创建」
   * 划了等号 —— 而后者会因为纯 UI 的原因反复发生：切走再切回，ChatWindow
   * 重新挂载，秒表归零。用户看到的是「等了 40 秒，切个会话回来变成 2 秒」。
   *
   * 记在会话桶里之后，秒表读的是「现在 - 这一轮的起点」，跟组件的生命周期
   * 彻底解耦：切走切回、甚至 reload（对齐时补上）都不影响它。
   */
  startedAt?: number
  /**
   * 这个会话已经收到过一次终止事件（complete / error / cancelled）。
   *
   * 只为一件事存在：挡住**过期的** hydrate-running。启动时先建立事件订阅、
   * 再拉 getRunnerSnapshot，如果那一轮正好在这次 IPC 往返期间结束，快照带回
   * 来的 runningSessionId 就是过期的真相 —— 而 hydrate-running 无条件设
   * running=true，且**没有任何后续事件会来清它**（终止事件已经用掉了）。
   *
   * 后果不止是那个会话自己卡在「正在思考…」：blockedBy 遍历所有桶找 running
   * 的，所以别的会话的 composer 也会被这个幽灵永久禁用，横幅说「某会话正在
   * 处理中」，点过去看却是答完的。
   *
   * user-sent 会清掉它 —— 新一轮开始，之前那次落定与这一轮无关。
   */
  settled?: boolean
}

export type ChatState = Record<string, SessionChat>

export type ChatAction =
  | { type: 'user-sent'; sessionId: string; text: string; attachments?: ContentPart[] }
  | { type: 'loaded'; sessionId: string; messages: Message[] }
  | { type: 'chunk'; event: MessageChunkEvent }
  | { type: 'tool-call'; event: ToolCallEvent }
  | { type: 'complete'; event: MessageCompleteEvent }
  | { type: 'verdict'; event: VerdictEvent }
  | { type: 'cache-hit'; event: CacheHitEvent }
  | { type: 'error'; event: ErrorEvent }
  | { type: 'cancelled'; event: CancelledEvent }
  | { type: 'approval-request'; event: ApprovalRequestEvent }
  | { type: 'approval-settled'; sessionId: string; requestId: string }
  /**
   * 拿主进程那份「现在谁在跑」整体对齐一次。
   *
   * ## 为什么必须是 reconcile 而不是 hydrate
   *
   * 原来这里是 `hydrate-running`（只带一个 sessionId、只把 running 设成 true）。
   * 那个方向是单向的：**能点亮，不能熄灭**。于是丢一个终止事件、或者事件到达
   * 时序乱了，前端的 running 就永久卡在 true —— 用户看到「一直在思考中」，
   * 而那一轮早就答完了，只能重启 app。这正是用户报的症状。
   *
   * 现在传的是**完整集合**：不在集合里的会话一律熄灭。主进程的 runner 是
   * 「谁在跑」唯一的权威真相（进程内的 Set，不会丢），前端只是它的投影。
   * 有了这条通路，任何原因导致的状态漂移都能在下一次对齐时自我修复。
   *
   * 调用点不止启动一次 —— 切会话时也对齐（见 App.tsx 的 select），
   * 所以「卡住」最多持续到用户下一次切会话。
   */
  | { type: 'reconcile-running'; sessionIds: string[] }
  /**
   * 会话被删了，把它那个桶整个丢掉。
   *
   * 不加这条的话被删会话的桶会一直留在 chats 里。两个后果，第二个是真 bug：
   *   1. 那份消息（可能很长，含工具输出）一直占着内存，直到 app 关掉。
   *   2. 桶里的 running 如果因为别的原因残留成 true，blockedBy 会拿它去挡
   *      **所有**会话的 composer —— 而用户在侧边栏里已经找不到这个会话了，
   *      横幅让他「前往处理」，点过去却是一个不存在的东西。
   */
  | { type: 'session-removed'; sessionId: string }

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
    case 'user-sent': {
      const now = Date.now()
      return update(state, action.sessionId, (chat) => ({
        ...chat,
        error: undefined,
        running: true,
        // 这一轮的起点。秒表读它而不是自己从挂载起数 —— 见 startedAt 的注释。
        startedAt: now,
        // 新一轮开始：之前那次落定跟这一轮无关，清掉。不清的话这个会话
        // 之后再也没法被 reconcile 补上「正在跑」。
        settled: false,
        messages: [
          ...chat.messages,
          { role: 'user', content: action.text, ...(action.attachments?.length ? { contentParts: action.attachments } : {}), tools: [], streaming: false, timestamp: now },
        ],
      }))
    }

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
        // ## 跑到一半时不能拿磁盘那份覆盖内存
        //
        // 存盘发生在一轮结束（onComplete），所以这轮还在跑的时候，磁盘上是
        // **上一轮结束时**的历史 —— 不含用户刚发的提问，也不含正在流的这半句
        // 回答。切走再切回时 select() 会 loadSession + dispatch 'loaded'，
        // 拿那份旧历史一覆盖，用户的提问和已经流出来的字全没了。
        //
        // 之后 chunk 继续到达，withAssistant 发现最后一条不是 assistant
        // （被抹了），就新建一条从半句开始累积 —— 用户看到的是「我的问题
        // 不见了，AI 的回答从中间开始」。
        //
        // 所以在跑且内存里有东西时，保留内存那份：它是磁盘那份的超集
        // （先前某次 loaded 打的底 + 这一轮的实时增量）。
        //
        // 「内存为空」那种情况仍然要读盘：重新挂载后 hydrate 把 running 补成
        // true，但桶是空的，这时磁盘是唯一的历史来源。
        messages:
          chat.running && chat.messages.length > 0
            ? chat.messages
            : // 工具调用要还原出来，不能丢。
              //
              // 原来这里是 `.filter(user|assistant).map(... tools: [])` —— 两处丢
              // 数据：tool 消息被过滤掉、tools 又硬编码成空数组。结果是重开 app
              // 之后历史里只剩正文。而 toolCalls 一直都在磁盘上。
              // 算法见 hydrate.ts（那边是纯函数，有单测）。
              hydrateMessages(action.messages, action.sessionId),
        // error 不持久化（它是运行时状态，没写进 .json），所以回放时显式清掉，
        // 避免上一轮的错误标记残留在新加载的历史上。
        error: undefined,
      }))

    case 'chunk':
      return update(state, action.event.sessionId, (chat) =>
        withAssistant(chat, (m) => ({ ...m, content: m.content + action.event.text, ...(action.event.usage ? { usages: [...(m.usages ?? []), action.event.usage] } : {}), streaming: true })),
      )

    case 'tool-call':
      return update(state, action.event.sessionId, (chat) =>
        withAssistant(chat, (m) => ({ ...m, tools: [...m.tools, action.event] })),
      )

    case 'complete': {
      const completedAt = Date.now()
      return update(state, action.event.sessionId, (chat) => ({
        // 用完整答案替换累积的 delta：流式可能丢字，以最终文本为准
        ...withAssistant(chat, (m) => ({ ...m, content: action.event.text, streaming: false, timestamp: completedAt })),
        running: false,
        // 这一轮落定了。之后到达的 hydrate-running（快照可能拍摄于这之前）
        // 要被挡掉，否则会把 running 重新点亮而再没人来清 —— 见 settled 的注释。
        settled: true,
        // 这轮跑完了，审批弹窗（如果还挂着）必然已失效。Main 进程要么已 resolve（用户点了 allow），
        // 要么 5 分钟超时自动拒绝——无论哪种，UI 都不该再留着"等您决策"的弹窗。
        pendingApproval: undefined,
      }))
    }

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
        // 同 complete：落定了，挡住过期的 hydrate-running。
        // BUSY 也算落定 —— 它是「这次没受理」，那一轮压根没开始，
        // 而 user-sent 已经把 settled 清成 false 了，这里把它标回来。
        settled: true,
      }))

    case 'cancelled':
      // 用户主动停的那一轮。和 error 的区别只有一个但很关键：**不设 error**。
      // 走 error 分支会让 ChatWindow 渲染出红色报错，用户以为自己的操作
      // 出了问题 —— 而这本来就是他要的结果。
      //
      // 已经流出来的那段 assistant 文字保留在 messages 里不动：那是真实发生
      // 过的输出，抹掉它等于骗用户「什么都没发生」。主进程那侧也存了盘
      // （agent-runner 的取消分支），刷新后还在。
      return update(state, action.event.sessionId, (chat) => ({
        ...chat,
        running: false,
        // 停止的同时把悬着的审批弹窗收掉：那一轮已经不跑了，
        // 留个等确认的框在屏幕上没有意义（跟 complete / error 同一个理由）
        pendingApproval: undefined,
        // 同 complete / error：落定了，挡住过期的 hydrate-running。
        settled: true,
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

    case 'session-removed': {
      // 不能走 update()：那个 helper 在桶不存在时会**建**一个，
      // 正好和这里要做的事相反。
      //
      // 桶本来就不在时原样返回同一个引用，不返回新对象 —— 避免一次
      // 无意义的重渲染（删除路径上会有重复调用：主进程广播 + 本地乐观更新）。
      if (!(action.sessionId in state)) return state
      const next = { ...state }
      delete next[action.sessionId]
      return next
    }

    case 'reconcile-running': {
      const authoritative = new Set(action.sessionIds)
      let changed = false
      const next: ChatState = {}

      for (const [id, chat] of Object.entries(state)) {
        const shouldRun = authoritative.has(id)
        // 熄灭方向：不在集合里就一定没在跑。主进程的 Set 只在 finally 里删，
        // 所以「不在里面」是可信的。**这个方向是修复的关键** ——
        // 原来的 hydrate-running 只能点亮，丢一个终止事件就永久卡住。
        //
        // 点亮方向：已经落定过的不认（settled）。快照可能拍摄于那一轮结束
        // 之前，是过期的真相；认它会把 running 重新点亮而再没人来清。
        const nextRun = shouldRun ? (chat.settled ? false : true) : false

        if (nextRun === chat.running) {
          next[id] = chat
          continue
        }
        changed = true
        next[id] = {
          ...chat,
          running: nextRun,
          // 点亮时如果没有起点就补一个（reload 之后本地没见过 user-sent）。
          // 秒表会从这一刻起算，比实际短 —— 但「这一轮开始于何时」在 reload
          // 之后确实无从得知（主进程不记，会话文件里也没有），
          // 显示一个偏小的值好过不显示或者显示 NaN。
          ...(nextRun && chat.startedAt === undefined ? { startedAt: Date.now() } : {}),
          // 熄灭时把悬着的审批也收掉：那一轮已经不在跑了，留个等确认的框
          // 在屏幕上没有意义（跟 complete / error / cancelled 同一个理由）。
          ...(nextRun ? {} : { pendingApproval: undefined }),
        }
      }

      // 主进程说在跑、但本地压根没有这个桶（reload 之后的常见情况）：
      // 建一个带 running 的空桶，消息内容靠 select() 的 loadSession 找回。
      for (const id of action.sessionIds) {
        if (!(id in next)) {
          next[id] = { ...emptySession(), running: true, startedAt: Date.now() }
          changed = true
        }
      }

      // 引用不变时返回原对象，省掉一次无意义的重渲染 —— 这个 action 在
      // 每次切会话时都会派发，绝大多数时候什么都没变。
      return changed ? next : state
    }
  }
}
