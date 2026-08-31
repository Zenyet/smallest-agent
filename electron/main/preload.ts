import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CH } from '../shared/channels'
import type { ContextTarget, MenuItemSpec } from './context-menu'
import type {
  ApprovalDecision,
  ApprovalRequestEvent,
  DesktopSettings,
  ErrorEvent,
  MessageChunkEvent,
  MessageCompleteEvent,
  Message,
  Project,
  ProjectsState,
  RuntimeStatusEvent,
  RunnerSnapshot,
  SessionMeta,
  ToolCallEvent,
  VerdictEvent,
  CacheHitEvent,
  CancelledEvent,
  ProviderDetection,
  ProviderSecret,
  ProvidersView,
  AgentsView,
} from '../shared/channels'
import type { ContentPart } from '../../src/types'

// 事件订阅统一包成「注册回调 → 返回取消函数」，React 的 useEffect 直接 return 它就能清理。
function subscribe<T>(channel: string, cb: (data: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, data: T) => cb(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  ping: (): Promise<'pong'> => ipcRenderer.invoke(CH.ping),
  sendMessage: (sessionId: string, message: string, attachments?: ContentPart[]): Promise<void> =>
    ipcRenderer.invoke(CH.sendMessage, sessionId, message, attachments),
  // 返回「有没有受理」，不代表已经停了 —— 真停下来时会收到 onCancelled。
  cancelMessage: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke(CH.cancelMessage, sessionId),
  getSettings: (): Promise<DesktopSettings> => ipcRenderer.invoke(CH.getSettings),
  saveSettings: (patch: DesktopSettings): Promise<DesktopSettings> =>
    ipcRenderer.invoke(CH.saveSettings, patch),
  restartApp: (): Promise<void> => ipcRenderer.invoke(CH.restartApp),
  listSessions: (): Promise<SessionMeta[]> => ipcRenderer.invoke(CH.listSessions),
  // projectId：新会话落在哪个项目下。不传/传 null 就是「未分组」。
  createSession: (projectId?: string | null): Promise<string> =>
    ipcRenderer.invoke(CH.createSession, projectId ?? null),
  deleteSession: (id: string): Promise<void> => ipcRenderer.invoke(CH.deleteSession, id),
  loadSession: (id: string): Promise<Message[]> => ipcRenderer.invoke(CH.loadSession, id),

  // --- 项目分组 ---
  // 写操作统一返回写完之后的完整状态：renderer 不自己推算下一个状态，
  // 否则两个窗口各推算一份迟早分叉。addProject 额外返回那个项目本身，
  // 好让调用方立刻选中它（用户刚添加完，期望它是选中的）。
  getProjects: (): Promise<ProjectsState> => ipcRenderer.invoke(CH.getProjects),
  addProject: (): Promise<{ state: ProjectsState; project: Project } | null> =>
    ipcRenderer.invoke(CH.addProject),
  removeProject: (id: string): Promise<ProjectsState> => ipcRenderer.invoke(CH.removeProject, id),
  /** 弹原生右键菜单，返回用户选的动作（没选返回 null） */
  // 返回菜单该有哪几项，由 renderer 自己画（components/ContextMenu.tsx）。
  // 原来这里返回的是「用户选了哪个动作」，因为菜单是主进程弹的原生菜单。
  showContextMenu: (target: ContextTarget): Promise<MenuItemSpec[]> =>
    ipcRenderer.invoke(CH.showContextMenu, target),
  getSessionTitles: (): Promise<Record<string, string>> =>
    ipcRenderer.invoke(CH.getSessionTitles),
  // 空标题 = 恢复自动推导的名字。返回写完之后的完整表。
  renameSession: (id: string, title: string): Promise<Record<string, string>> =>
    ipcRenderer.invoke(CH.renameSession, id, title),
  // 编辑重发前砍历史。nthUser 是「这条之前有几条用户消息」（0-based）——
  // 磁盘和界面的下标不是一一对应的，见 main/truncate.ts。
  // 返回砍完之后的历史，renderer 拿它重放界面，不自己推算。
  truncateSession: (id: string, nthUser: number): Promise<Message[]> =>
    ipcRenderer.invoke(CH.truncateSession, id, nthUser),
  assignSession: (sessionId: string, projectId: string | null): Promise<ProjectsState> =>
    ipcRenderer.invoke(CH.assignSession, sessionId, projectId),
  toggleProjectCollapsed: (id: string): Promise<ProjectsState> =>
    ipcRenderer.invoke(CH.toggleProjectCollapsed, id),

  respondApproval: (requestId: string, decision: ApprovalDecision): Promise<void> =>
    ipcRenderer.invoke(CH.approvalResponse, requestId, decision),

  // --- 自定义 agent ---
  getAgents: (sessionId: string): Promise<AgentsView> =>
    ipcRenderer.invoke(CH.getAgents, sessionId),
  saveAgent: (sessionId: string, def: Record<string, unknown>): Promise<AgentsView> =>
    ipcRenderer.invoke(CH.saveAgent, sessionId, def),
  deleteAgent: (sessionId: string, id: string): Promise<AgentsView> =>
    ipcRenderer.invoke(CH.deleteAgent, sessionId, id),
  setSessionAgent: (sessionId: string, agentId: string | null): Promise<AgentsView> =>
    ipcRenderer.invoke(CH.setSessionAgent, sessionId, agentId),

  // --- Agent 模式（内置 agent / 外部 CLI）---
  // 写操作返回写完之后的完整视图，renderer 不自己推算下一个状态。
  getProviders: (sessionId: string): Promise<ProvidersView> =>
    ipcRenderer.invoke(CH.getProviders, sessionId),
  setSessionProvider: (sessionId: string, providerId: string): Promise<ProvidersView> =>
    ipcRenderer.invoke(CH.setSessionProvider, sessionId, providerId),
  setSessionModel: (sessionId: string, modelId: string): Promise<ProvidersView> =>
    ipcRenderer.invoke(CH.setSessionModel, sessionId, modelId),
  setSessionPermission: (sessionId: string, mode: string): Promise<ProvidersView> =>
    ipcRenderer.invoke(CH.setSessionPermission, sessionId, mode),

  // Provider detection（两段式）
  detectProviders: (): Promise<ProviderDetection[]> => ipcRenderer.invoke(CH.detectProviders),
  importProvider: (provider: 'claude' | 'codex'): Promise<ProviderSecret | null> =>
    ipcRenderer.invoke(CH.importProvider, provider),

  // 挂载/重新挂载时主动拉一次现状，而不是只靠事件推送——见 index.ts / ipc-handlers.ts 里
  // 对应 handler 上的注释。
  getRuntimeStatus: (): Promise<RuntimeStatusEvent> => ipcRenderer.invoke(CH.getRuntimeStatus),
  getRunnerSnapshot: (): Promise<RunnerSnapshot> => ipcRenderer.invoke(CH.getRunnerSnapshot),

  onMessageChunk: (cb: (d: MessageChunkEvent) => void) => subscribe(CH.messageChunk, cb),
  onToolCall: (cb: (d: ToolCallEvent) => void) => subscribe(CH.toolCall, cb),
  onMessageComplete: (cb: (d: MessageCompleteEvent) => void) => subscribe(CH.messageComplete, cb),
  onVerdict: (cb: (d: VerdictEvent) => void) => subscribe(CH.verdict, cb),
  onCacheHit: (cb: (d: CacheHitEvent) => void) => subscribe(CH.cacheHit, cb),
  onError: (cb: (d: ErrorEvent) => void) => subscribe(CH.error, cb),
  // 那一轮真的停了。不走 onError —— 用户主动停止不是错误。
  onCancelled: (cb: (d: CancelledEvent) => void) => subscribe(CH.cancelled, cb),
  onRuntimeStatus: (cb: (d: RuntimeStatusEvent) => void) => subscribe(CH.runtimeStatus, cb),
  onApprovalRequest: (cb: (d: ApprovalRequestEvent) => void) => subscribe(CH.approvalRequest, cb),
  // 主进程广播的两条：设置和项目状态。两个窗口之后单靠 invoke 的返回值不够——
  // 那只回给发起调用的那个窗口，另一个窗口手里的副本会悄悄变成死的。
  // 原生菜单的 ⌘, 打过来的。设置在右栏渲染，主进程只负责喊一声。
  onOpenSettings: (cb: () => void) => subscribe<void>(CH.openSettings, cb),
  onSettingsChanged: (cb: (d: DesktopSettings) => void) => subscribe(CH.settingsChanged, cb),
  onProjectsChanged: (cb: (d: ProjectsState) => void) => subscribe(CH.projectsChanged, cb),
  onProvidersChanged: (cb: (d: ProvidersView) => void) => subscribe(CH.providersChanged, cb),
  onAgentsChanged: (cb: (d: AgentsView) => void) => subscribe(CH.agentsChanged, cb),
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
