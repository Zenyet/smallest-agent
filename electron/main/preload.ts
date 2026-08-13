import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CH } from '../shared/channels'
import type {
  ApprovalDecision,
  ApprovalRequestEvent,
  DesktopSettings,
  ErrorEvent,
  MessageChunkEvent,
  MessageCompleteEvent,
  Message,
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

  listSessions: (): Promise<SessionMeta[]> => ipcRenderer.invoke(CH.listSessions),
  createSession: (): Promise<string> => ipcRenderer.invoke(CH.createSession),
  deleteSession: (id: string): Promise<void> => ipcRenderer.invoke(CH.deleteSession, id),
  loadSession: (id: string): Promise<Message[]> => ipcRenderer.invoke(CH.loadSession, id),

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
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
