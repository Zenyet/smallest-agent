import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CH } from '../shared/channels'
import type { ContextTarget } from './context-menu'
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
  ProviderDetection,
  ProviderSecret,
} from '../shared/channels'

// 事件订阅统一包成「注册回调 → 返回取消函数」，React 的 useEffect 直接 return 它就能清理。
function subscribe<T>(channel: string, cb: (data: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, data: T) => cb(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  ping: (): Promise<'pong'> => ipcRenderer.invoke(CH.ping),
  sendMessage: (sessionId: string, message: string): Promise<void> =>
    ipcRenderer.invoke(CH.sendMessage, sessionId, message),
  getSettings: (): Promise<DesktopSettings> => ipcRenderer.invoke(CH.getSettings),
  saveSettings: (patch: DesktopSettings): Promise<DesktopSettings> =>
    ipcRenderer.invoke(CH.saveSettings, patch),
  restartApp: (): Promise<void> => ipcRenderer.invoke(CH.restartApp),
  // 打开设置窗口（独立 BrowserWindow）。单例由主进程保证：已经开着就聚焦，
  // 连点两次不会开出第二个。
  openSettings: (): Promise<void> => ipcRenderer.invoke(CH.openSettings),

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
  showContextMenu: (target: ContextTarget): Promise<string | null> =>
    ipcRenderer.invoke(CH.showContextMenu, target),
  assignSession: (sessionId: string, projectId: string | null): Promise<ProjectsState> =>
    ipcRenderer.invoke(CH.assignSession, sessionId, projectId),
  toggleProjectCollapsed: (id: string): Promise<ProjectsState> =>
    ipcRenderer.invoke(CH.toggleProjectCollapsed, id),

  respondApproval: (requestId: string, decision: ApprovalDecision): Promise<void> =>
    ipcRenderer.invoke(CH.approvalResponse, requestId, decision),

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
  onRuntimeStatus: (cb: (d: RuntimeStatusEvent) => void) => subscribe(CH.runtimeStatus, cb),
  onApprovalRequest: (cb: (d: ApprovalRequestEvent) => void) => subscribe(CH.approvalRequest, cb),
  // 主进程广播的两条：设置和项目状态。两个窗口之后单靠 invoke 的返回值不够——
  // 那只回给发起调用的那个窗口，另一个窗口手里的副本会悄悄变成死的。
  onSettingsChanged: (cb: (d: DesktopSettings) => void) => subscribe(CH.settingsChanged, cb),
  onProjectsChanged: (cb: (d: ProjectsState) => void) => subscribe(CH.projectsChanged, cb),
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
