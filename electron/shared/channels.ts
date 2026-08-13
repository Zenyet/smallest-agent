// IPC 频道名 + 事件负载类型。Main 和 Renderer 共用这一份定义，
// 改频道名时两边一起编译报错，比字符串字面量分散在各处安全。
import type { Message } from '../../src/types'
import type { DesktopSettings } from '../main/config-env'

export type { DesktopSettings }

export const CH = {
  // Renderer → Main（invoke，有返回值）
  ping: 'agent:ping',
  listSessions: 'agent:list-sessions',
  createSession: 'agent:create-session',
  deleteSession: 'agent:delete-session',
  loadSession: 'agent:load-session',
  sendMessage: 'agent:send-message',
  getSettings: 'agent:get-settings',
  saveSettings: 'agent:save-settings',
  restartApp: 'agent:restart-app',
  // Provider detection（两段式）
  detectProviders: 'agent:detect-providers',
  importProvider: 'agent:import-provider',
  // 状态快照：renderer 挂载/重新挂载时主动拉一次"现在是什么状态"，
  // 不能只靠 Main → Renderer 的单向推送——推送只在事件发生的那一刻有效，
  // 错过那一刻（比如 reload）就永远收不到了，而 Main 进程这边的真相
  // （运行阶段 / 谁占着串行锁 / 哪些审批还悬着）在整个进程生命周期内持续存在。
  getRuntimeStatus: 'agent:get-runtime-status',
  getRunnerSnapshot: 'agent:get-runner-snapshot',
  // Main → Renderer（send，单向推送）
  messageChunk: 'agent:message-chunk',
  toolCall: 'agent:tool-call',
  messageComplete: 'agent:message-complete',
  verdict: 'agent:verdict',
  cacheHit: 'agent:cache-hit',
  error: 'agent:error',
  runtimeStatus: 'agent:runtime-status',
  // 审批：Main → Renderer 发请求，Renderer → Main 回决定
  approvalRequest: 'agent:approval-request',
  approvalResponse: 'agent:approval-response',
} as const

export interface MessageChunkEvent {
  sessionId: string
  text: string // 增量 delta，不是全量
}

export interface ToolCallEvent {
  sessionId: string
  turn: number
  toolName: string
  args: Record<string, unknown>
  output: string // runTool 返回的 JSON 字符串；工具失败时形如 {"error":"..."}
  elapsedMs?: number // 可选：这一轮工具调用的耗时（毫秒）。agent-runner 测量后附加，保持已有测试有效。
}

export interface MessageCompleteEvent {
  sessionId: string
  text: string // 完整答案，前端用它替换累积的 delta，保证最终一致
}

export interface VerdictEvent {
  sessionId: string
  grounded: boolean
  issues: string[]
}

export interface CacheHitEvent {
  sessionId: string
}

// 没有 TOOL_ERROR：runTool 把工具异常包成 JSON 返回给模型，不会中断循环，
// 因此工具失败以 ToolCallEvent.output 的形式展示，不走这里。
// DELETE_BLOCKED：删除一个正在被 agent 处理的会话被主进程拒绝——没有真正的取消机制
// （src/ 冻结，runAgent 跑起来就停不下来），只能不让删，并把理由说清楚。
export type ErrorCode =
  | 'API_KEY_MISSING'
  | 'MODEL_ERROR'
  | 'MAX_TURNS'
  | 'BUSY'
  | 'DELETE_BLOCKED'
  | 'UNKNOWN'

export interface ErrorEvent {
  sessionId: string
  code: ErrorCode
  message: string
}

export interface RuntimeStatusEvent {
  phase: 'embedding' | 'indexing' | 'mcp' | 'ready' | 'failed'
  detail: string
}

export interface SessionMeta {
  id: string
  title: string
  updatedAt: number
}

// 写类工具执行前的审批请求。requestId 用来把 Renderer 的回答对上是哪一次请求 ——
// 一轮里可能有多个写操作排队等审批。
export interface ApprovalRequestEvent {
  sessionId: string
  requestId: string
  toolName: string
  args: Record<string, unknown>
}

export type ApprovalDecision = 'allow' | 'deny'

// getRunnerSnapshot 的返回值：重新挂载时用它一次性补全"谁在跑 / 谁在等审批"，
// 而不是假装 Main 进程的状态是从 renderer 这次挂载才开始存在的。
// pendingApprovals 复用 ApprovalRequestEvent 的形状（字段完全一致：requestId/
// sessionId/toolName/args），approval.ts 的 PendingApproval 结构上与它相同，
// 不需要为了这一次 IPC 往返再定义一个几乎一样的类型。
export interface RunnerSnapshot {
  runningSessionId: string | null
  pendingApprovals: ApprovalRequestEvent[]
}

// Provider detection 类型
export interface ProviderDetection {
  provider: 'claude' | 'codex' | 'gemini'
  available: boolean
  reason?: string
  model?: string
  baseUrl?: string
}

export interface ProviderSecret {
  apiKey: string
  baseUrl?: string
  model?: string
}

export type { Message }
