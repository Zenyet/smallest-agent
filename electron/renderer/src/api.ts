// window.electronAPI 的集中出口。组件不直接摸 window，
// 一来类型集中，二来将来要换传输方式（比如做 Web 版）只改这一个文件。
import type { ElectronAPI } from '../../main/preload'

// 测试环境的 fallback mock
const mockAPI: ElectronAPI = {
  ping: async () => 'pong',
  sendMessage: async () => {},
  cancelMessage: async () => false,
  getSettings: async () => ({}),
  saveSettings: async () => ({}),
  restartApp: async () => {},
  openSettings: async () => {},
  listSessions: async () => [],
  createSession: async () => 'mock-session',
  deleteSession: async () => {},
  loadSession: async () => [],
  getProjects: async () => ({ projects: [], sessionProject: {}, collapsed: [] }),
  addProject: async () => null,
  removeProject: async () => ({ projects: [], sessionProject: {}, collapsed: [] }),
  showContextMenu: async () => [],
  getSessionTitles: async () => ({}),
  renameSession: async () => ({}),
  assignSession: async () => ({ projects: [], sessionProject: {}, collapsed: [] }),
  toggleProjectCollapsed: async () => ({ projects: [], sessionProject: {}, collapsed: [] }),
  respondApproval: async () => {},
  detectProviders: async () => [],
  importProvider: async () => null,
  getRuntimeStatus: async () => ({ phase: 'ready', detail: 'mock' }),
  getRunnerSnapshot: async () => ({ runningSessionId: null, pendingApprovals: [] }),
  onMessageChunk: () => () => {},
  onToolCall: () => () => {},
  onMessageComplete: () => () => {},
  onVerdict: () => () => {},
  onCacheHit: () => () => {},
  onError: () => () => {},
  onCancelled: () => () => {},
  onRuntimeStatus: () => () => {},
  onApprovalRequest: () => () => {},
  onSettingsChanged: () => () => {},
  onProjectsChanged: () => () => {},
}

export const api: ElectronAPI = (typeof window !== 'undefined' && window.electronAPI) || mockAPI
