// window.electronAPI 的集中出口。组件不直接摸 window，
// 一来类型集中，二来将来要换传输方式（比如做 Web 版）只改这一个文件。
import type { ElectronAPI } from '../../main/preload'

// 测试环境的 fallback mock
const emptyProvidersView = {
  options: [{ id: 'builtin', name: '内置 agent', external: false }],
  current: 'builtin',
  models: [],
  permission: 'ask' as const,
  configPath: '',
}

const mockAPI: ElectronAPI = {
  ping: async () => 'pong',
  sendMessage: async () => {},
  cancelMessage: async () => false,
  getSettings: async () => ({}),
  saveSettings: async () => ({}),
  restartApp: async () => {},
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
  truncateSession: async () => [],
  assignSession: async () => ({ projects: [], sessionProject: {}, collapsed: [] }),
  toggleProjectCollapsed: async () => ({ projects: [], sessionProject: {}, collapsed: [] }),
  respondApproval: async () => {},
  getProviders: async () => emptyProvidersView,
  setSessionProvider: async () => emptyProvidersView,
  setSessionModel: async () => emptyProvidersView,
  setSessionPermission: async () => emptyProvidersView,
  onProvidersChanged: () => () => {},
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
  onOpenSettings: () => () => {},
  onSettingsChanged: () => () => {},
  onProjectsChanged: () => () => {},
}

export const api: ElectronAPI = (typeof window !== 'undefined' && window.electronAPI) || mockAPI
