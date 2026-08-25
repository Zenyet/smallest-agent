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
  // 停止正在跑的那一轮。取消是**轮边界**的：当前轮的模型请求和已开跑的工具
  // 会跑完，到下一轮 callModel 入口才停（见 main/cancel.ts 的文件头）。
  //
  // 做成 invoke 而不是 send：调用方（停止按钮）要知道「这次点击有没有被受理」，
  // 而不是发出去就假装停了。取消一个没在跑的会话返回 false，不报错 ——
  // 用户可能在 cancelled 事件到达前又点了一次。
  cancelMessage: 'agent:cancel-message',
  getSettings: 'agent:get-settings',
  saveSettings: 'agent:save-settings',
  restartApp: 'agent:restart-app',
  // 设置窗口：独立 BrowserWindow（macOS 的 ⌘, 原生做法），不是 renderer 里的浮层。
  // openSettings 是单例的——已经开着就聚焦，不会开出第二个。
  openSettings: 'agent:open-settings',
  // 项目分组（会话按本地目录归类）。状态活在主进程的 electron-store 里，
  // 每个写操作都返回写完之后的完整状态，renderer 不自己推算。
  getProjects: 'agent:get-projects',
  addProject: 'agent:add-project',
  removeProject: 'agent:remove-project',
  // 右键菜单：renderer 报告「哪一项被右键了」，主进程弹原生菜单，
  // 把用户选的动作作为返回值给回去（没选就返回 null）。
  // 做成 invoke/handle 的一次往返而不是「主进程再推一个事件」，
  // 是因为菜单的结果天然是这次右键的应答，调用方就在原地等它。
  showContextMenu: 'agent:show-context-menu',
  assignSession: 'agent:assign-session',
  toggleProjectCollapsed: 'agent:toggle-project-collapsed',
  // 会话重命名。用户起的标题存在主进程的 electron-store 里（session-titles.ts）——
  // 会话文件的形状由 src/ 决定（就是 Message[]），塞不进去。
  // 和 projects 那几个一样，写操作返回写完之后的完整表，renderer 不自己推算。
  getSessionTitles: 'agent:get-session-titles',
  renameSession: 'agent:rename-session',
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
  // 那一轮真的停下了。**不走 error 通道**：用户主动停止不是错误，
  // 前端不该把它渲染成红色报错。
  cancelled: 'agent:cancelled',
  runtimeStatus: 'agent:runtime-status',
  // 设置改了：主进程广播给所有窗口（含设置窗口自己）。两个 renderer 之后，
  // 谁写的设置谁知道已经不够了 —— 主窗口得从这里听说，否则它手里那份是死的。
  settingsChanged: 'agent:settings-changed',
  // 项目状态改了：同上，广播而不是只回给发起那一次 invoke 的窗口。
  projectsChanged: 'agent:projects-changed',
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

// 那一轮被用户停下了。
//
// 单独一个事件而不是复用 ErrorEvent：取消不是错误。前端收到它要清掉
// loading 态、把停止键复原，但**不该**显示红色报错 —— 那会让用户以为
// 自己的操作出了问题。
//
// 载荷只有 sessionId：取消路径上已经 sessions.save() 存过盘了（保住已经
// 产生的那几轮对话），前端下次 loadSession 就能拿到，不需要在事件里回传。
export interface CancelledEvent {
  sessionId: string
}

// 没有 TOOL_ERROR：runTool 把工具异常包成 JSON 返回给模型，不会中断循环，
// 因此工具失败以 ToolCallEvent.output 的形式展示，不走这里。
//
// 也没有取消相关的码：取消走 CancelledEvent，不是错误。
//
// DELETE_BLOCKED 已经删掉了。它当初的理由是「没有真正的取消机制（src/ 冻结，
// runAgent 跑起来就停不下来），只能不让删」—— 那个前提不成立了：callModel
// 是注入的，包一层就能在轮边界停下（见 main/cancel.ts）。现在删除正在跑的
// 会话走「先取消、等它停下、再删」，不再拒绝用户。
export type ErrorCode = 'API_KEY_MISSING' | 'MODEL_ERROR' | 'MAX_TURNS' | 'BUSY' | 'UNKNOWN'

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
  // 所属项目。可选而不是必填：会话文件本身（src/memory/store.ts 写的那个
  // Message[] JSON）没地方存这个，映射活在 Electron 层自己的持久化里，
  // 所以「没有项目」是完全正常的状态，归到侧边栏的「未分组」下。
  projectId?: string
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

// 项目分组的类型从 main/projects.ts 转出来，让 renderer 只 import 这一个文件
// （跟 DesktopSettings 同样的处理）。projects.ts 是纯模块，不 import electron，
// 从 renderer 引它的类型不会把 electron 拖进 bundle。
export type { Project, ProjectsState, SessionGroup } from '../main/projects'

export type { Message }
