import type { ProjectTask } from '../../shared/project-task'
import type { ContentPart } from '../../../src/types'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { SessionList } from './components/SessionList'
import { catalog as buildCatalog, DEFAULT_VENDOR, defaultModel } from '../../main/vendors'
import { ChatWindow } from './components/ChatWindow'
import { SettingsPanel, type SettingsPanelHandle } from './components/SettingsPanel'
import { SettingsNav } from './components/SettingsNav'
import { SECTIONS, type SectionId } from './settings-fields'
import type { PermissionMode } from '../../main/providers'
import { StartupScreen } from './components/StartupScreen'
import { ContextMenu, CLOSED, type ContextMenuState } from './components/ContextMenu'
import { chatReducer, emptySession } from './chat-reducer'
import { groupSessions } from '../../main/projects'
import { api } from './api'
import type {
  ApprovalDecision,
  DesktopSettings,
  SessionMeta,
  ProjectsState,
  RuntimeStatusEvent,
  ProvidersView,
} from '../../shared/channels'

// 新建的空会话在第一条消息回完之前不落盘（见 create() 的乐观更新），
// 但任何一个会话的消息一答完，onMessageComplete 就会用磁盘列表刷新 sessions。
// 如果直接拿磁盘列表整体覆盖，本地还没落盘的那个空会话会被这次刷新静默冲掉——
// 用户明明能看见它在侧边栏，一转头（比如另一个会话答完了）它就消失了。
// 磁盘列表是"已落盘"部分的真相，本地列表里磁盘没有的 id 就是"还没落盘"，两边取并集。
//
// deletedIds 解决的是另一个更窄的竞态：remove() 里 `await api.deleteSession(id)` 和
// 它自己的 `await api.listSessions()` 之间有个空档，这期间别的会话答完消息触发的
// onMessageComplete 可能拿着"删除动作发起前"的旧 prev 闭包（仍然带着这个 id）调用
// mergeSessions——如果不特别处理，这份旧闭包会被当成"还没落盘的本地会话"合并回来，
// 删除等于白删。deletedIds 是一个跨越这整段异步空档、同步维护的 tombstone 集合：
// 不管哪次并发调用、按什么顺序落地，只要 id 在这个集合里，就必须从结果里排除——
// 光靠 remove() 自己最后再 `.filter(id !== deleted)` 不够，因为它挡不住"别人后调用、
// 但用的是更旧的 prev"这种情况。
export function mergeSessions(
  diskList: SessionMeta[],
  prev: SessionMeta[],
  deletedIds: ReadonlySet<string> = new Set(),
): SessionMeta[] {
  const diskIds = new Set(diskList.map((s) => s.id))
  const localOnly = prev.filter((s) => !diskIds.has(s.id) && !deletedIds.has(s.id))
  const disk = diskList.filter((s) => !deletedIds.has(s.id))
  return [...localOnly, ...disk].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function App() {
  const [chats, dispatch] = useReducer(chatReducer, {})
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [projectTasks, setProjectTasks] = useState<Record<string, ProjectTask>>({})
  const [startingTask, setStartingTask] = useState(false)
  const [taskStartError, setTaskStartError] = useState('')
  const receiveTask = useCallback((task: ProjectTask) => {
    setProjectTasks((prev) => (prev[task.sessionId]?.revision ?? -1) > task.revision
      ? prev : { ...prev, [task.sessionId]: task })
  }, [])
  const [status, setStatus] = useState<RuntimeStatusEvent>({ phase: 'embedding', detail: '启动中…' })
  // 项目分组状态。真相在主进程的 electron-store 里（会话文件存不了这个，
  // 见 main/projects.ts 顶部），这里只是一份副本：每次写操作拿主进程返回的
  // 完整状态覆盖它，另外订阅 onProjectsChanged 接住别处（比如设置窗口将来
  // 也能改）的改动，而不是自己推算下一个状态。
  const [projects, setProjects] = useState<ProjectsState>({
    projects: [],
    sessionProject: {},
    collapsed: [],
  })
  // 当前选中的项目：决定新会话落在哪儿。跟 currentId（当前会话）是两件事——
  // 用户可以选中一个项目却不打开它下面任何会话（比如刚添加完，里面还是空的）。
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  // 右键菜单：自绘（components/ContextMenu.tsx）。主进程只回「有哪几项」，
  // 弹出、定位、关闭都在这边。
  const [menu, setMenu] = useState<ContextMenuState>(CLOSED)
  // 正在改名的会话 id。null = 没在改名。改名的输入框就地替换那一行的标题
  // （对应 gpui 侧 sidebar.rs 的 renaming 状态）。
  const [renamingId, setRenamingId] = useState<string | null>(null)
  // remove() 发起删除的那一刻起同步打上 tombstone，见上面 mergeSessions 的注释。
  // 用 ref 而不是 state：它不需要触发渲染，只需要在异步空档里被任何并发调用
  // 同步地看到——用 state 的话，读到的可能是还没被这次 setState 提交的旧值。
  const deletedIdsRef = useRef<Set<string>>(new Set())

  const pendingSends = useRef(new Map<string, (ok: boolean) => void>())
  const settleSend = useCallback((id: string, ok: boolean) => {
    pendingSends.current.get(id)?.(ok)
    pendingSends.current.delete(id)
  }, [])

  // 订阅所有 Main → Renderer 事件。每个事件都带 sessionId，
  // reducer 按 sessionId 分桶，所以即使用户切走了，消息也还在。
  useEffect(() => {
    const offs = [
      api.onRuntimeStatus(setStatus),
      api.onProjectTaskChanged(({ sessionId, task }) => {
        if (deletedIdsRef.current.has(sessionId)) return
        if (task) receiveTask(task)
        else setProjectTasks((prev) => { const next = { ...prev }; delete next[sessionId]; return next })
      }),
      api.onMessageChunk((event) => dispatch({ type: 'chunk', event })),
      api.onToolCall((event) => dispatch({ type: 'tool-call', event })),
      api.onCacheHit((event) => dispatch({ type: 'cache-hit', event })),
      api.onVerdict((event) => dispatch({ type: 'verdict', event })),
      api.onError((event) => { dispatch({ type: 'error', event }); settleSend(event.sessionId, false) }),
      api.onCancelled((event) => { dispatch({ type: 'cancelled', event }); settleSend(event.sessionId, true) }),
      api.onApprovalRequest((event) => dispatch({ type: 'approval-request', event })),
      // 项目状态的广播。这个窗口自己的写操作已经用返回值更新过一次了，
      // 但广播是"任何来源的改动都到得了每个窗口"的那条通路，两者不冲突
      // （同一份状态覆盖两次是幂等的）。
      api.onProjectsChanged(setProjects),
      api.onMessageComplete((event) => {
        dispatch({ type: 'complete', event })
        settleSend(event.sessionId, true)
        // 答完了会话文件才落盘，这时候刷新列表才能拿到标题
        void api
          .listSessions()
          .then((list) => setSessions((prev) => mergeSessions(list, prev, deletedIdsRef.current)))
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // 挂载时（包括手动 reload 之后的重新挂载）主动拉一次"现在到哪了"，不能只等推送。
  // sendStatus 在主进程里只在阶段真的变化时调用一次；reload 会让这个组件从
  // useState 的初始值 { phase: 'embedding' } 重新开始，但主进程早就跑到 'ready' 了，
  // 而且不会再发第二次 'ready' 事件——单靠订阅（上面那个 effect）永远等不到它。
  // getRuntimeStatus 是"拉"，随时问都能拿到当下的真相，用它把这个空当补上。
  useEffect(() => {
    void api.getRuntimeStatus().then(setStatus)
  }, [])

  // 设置的一份副本，只为 composer 左下角那个模型选择器存在。
  //
  // 这块以前删掉过，理由是「没有消费者，留着会慢慢变旧」。现在有了真消费者：
  // 选择器要显示当前模型、要按已配的厂商列出可选项，这两件事都得读设置。
  // 订阅 onSettingsChanged 而不是只靠 saveSettings 的返回值：设置也可能
  // 在别处改（主进程自己写、将来的第二个窗口），只认自己那次写的结果会让
  // 手里这份悄悄变成死的。
  const [settings, setSettings] = useState<DesktopSettings | null>(null)
  const settled = status.phase === 'ready' || status.phase === 'failed'
  useEffect(() => {
    // phase 落定之前不能调：会话/设置那些 ipcMain.handle 是 createRuntime
    // 跑完才注册的，早调会砸在 No handler registered 上，而且没人重试。
    if (!settled) return
    void api.getSettings().then(setSettings).catch((err: unknown) => {
      console.error('[settings] 读取失败：', err instanceof Error ? err.message : err)
    })
  }, [settled])
  useEffect(() => api.onSettingsChanged(setSettings), [])

  // 设置在右栏渲染，不开第二个窗口。原来是独立 BrowserWindow（照 macOS ⌘,
  // 的原生做法），但这个 app 的设置是「跟着对话调的东西」——改完 key 要回来
  // 接着问，独立窗口每次都得切窗口、还会挡住对话。放右栏之后它和会话是同一
  // 层级的两个视图，侧边栏始终在，切回来就是一下。
  const [showSettings, setShowSettings] = useState(false)
  const settingsPanel = useRef<SettingsPanelHandle>(null)
  const [initialMemoryTab, setInitialMemoryTab] = useState<'facts' | 'notes'>('facts')
  // 当前在设置的哪一页。状态提到这里而不是留在 SettingsPanel 里，因为
  // 现在有**两个**组件要读它：左栏的 SettingsNav 画选中态，右栏的
  // SettingsPanel 决定渲染哪一页。留在面板里的话导航拿不到。
  const [settingsSection, setSettingsSection] = useState<SectionId>(SECTIONS[0].id)

  // Agent 模式（内置 agent / 外部 CLI）。
  //
  // 按会话取而不是全局一份：绑定是每会话的（会话 A 用内置、B 用 Claude Code），
  // 所以切会话要重新取。写操作的返回值就是新视图，不自己推算下一个状态 ——
  // 和项目分组同一条理由。
  const [providers, setProviders] = useState<ProvidersView | null>(null)

  // 原生菜单的 ⌘, 走主进程 → 这里。菜单项在主进程注册（app-menu.ts），
  // 它没法直接改 renderer 的 state，所以发一个事件过来。
  useEffect(() => api.onOpenSettings(() => setShowSettings(true)), [])

  // 保存：拿主进程返回的完整设置覆盖本地副本，不自己推算下一个状态
  // （和 projects 那几个写操作同一个约定）。主进程还会广播
  // onSettingsChanged，那次覆盖是幂等的。
  const saveSettings = useCallback(async (patch: DesktopSettings, unset?: string[]) => {
    const next = await api.saveSettings(patch, unset)
    setSettings(next)
  }, [])

  const restart = useCallback(async () => {
    await api.restartApp()
  }, [])

  // 「settings 没读回来就渲染面板 → 一排空输入框 → 一保存把好 key 冲掉」这个坑
  // 现在归这里管了（面板在右栏）：settings 为 null 时渲染「读取设置中…」而不是
  // SettingsPanel —— 它的 draft 只在挂载时播种一次，用空对象播种之后用户一改
  // 别的字段就会把磁盘上那份整体冲掉。见下面 showSettings 那段渲染。
  //
  // 改了设置什么时候生效：主进程每轮都用 readConfig() 重新读一次
  // （见 ipc-handlers.ts），所以 STREAM / MAX_TURNS 这类下一轮自然生效。
  // NOTES_DIR / EMBEDDING_MODEL 要重启，那条路由 SettingsPanel 自己的
  // 重启警告负责。

  // 启动时拉会话列表和项目状态，没有会话就开一个新的；同时拉一次 runner 快照，
  // 把"谁在跑、谁在等审批"这两件事也补回来——这两者都活在主进程里，不会因为
  // renderer 重新挂载就消失，但本地的 chats 状态是从零开始的，事件流只能捕捉
  // "挂载之后"发生的事。
  // 必须等 status 变 ready 才能调：会话相关的 ipcMain.handle 是 setupIpcHandlers
  // 里注册的，而那要等 createRuntime（装 embedding/建索引/连 MCP）跑完才执行，
  // 比 renderer 挂载慢得多。挂载就调的话会砸在"No handler registered"上，
  // 且没人重试，侧栏会话列表永远是空的。
  useEffect(() => {
    if (status.phase !== 'ready') return
    void (async () => {
      // 项目状态和会话列表一起拉：会话行要嵌在项目下面，少哪个都渲染不出分组。
      const [list, projectsState] = await Promise.all([api.listSessions(), api.getProjects()])
      setSessions(list)
      setProjects(projectsState)
      if (list.length > 0) {
        setCurrentId(list[0].id)
        // 打开的会话属于哪个项目，就把那个项目也标成选中的——否则用户接着点
        // 「新对话」会莫名落到「未分组」，而他眼里明明正在某个项目里干活。
        setCurrentProjectId(list[0].projectId ?? null)
      } else {
        setCurrentId(await api.createSession())
      }

      const snapshot = await api.getRunnerSnapshot()
      // 主进程是「谁在跑」的权威真相，用它整体对齐一次。
      // reconcile 而不是 hydrate-running：那个只会**点亮**，没法熄灭 ——
      // 见 chat-reducer 里 reconcile-running 的注释。
      dispatch({ type: 'reconcile-running', sessionIds: snapshot.runningSessionIds })
      for (const req of snapshot.pendingApprovals) {
        dispatch({ type: 'approval-request', event: req })
      }
    })()
  }, [status.phase])

  useEffect(() => {
    if (!currentId || status.phase !== 'ready') return
    let cancelled = false
    void api.getProjectTask(currentId).then((task) => {
      if (!cancelled && task && !deletedIdsRef.current.has(task.sessionId)) receiveTask(task)
    }).catch((err: unknown) => {
      if (!cancelled) setTaskStartError(err instanceof Error ? err.message : String(err))
    })
    return () => { cancelled = true }
  }, [currentId, status.phase, receiveTask])

  // --- composer 的模型选择器 ---
  //
  // 可选项从设置推出来（哪几家配了 key、自定义端点填了哪些模型），
  // 解析逻辑跟主进程共用 main/vendors.ts —— 那个文件不 import electron，
  // 所以两边读的是同一份目录，不会各自推算出不同的清单。
  const modelCatalog = useMemo(
    () => (settings ? buildCatalog((key) => settings[key]) : []),
    [settings],
  )
  // 当前选中的厂商/模型。设置里没写时退回默认值 —— 跟主进程
  // resolveActiveProvider 的兜底规则一致（config-env.ts），否则选择器显示的
  // 和实际请求用的会是两回事。
  const activeVendor = settings?.ACTIVE_VENDOR || DEFAULT_VENDOR
  const activeModel = settings?.ACTIVE_MODEL || defaultModel(activeVendor) || ''

  // 换模型：一次写两个键（厂商和模型绑在一起，见 ModelPicker 的文件头）。
  // 乐观更新本地副本，让选择器立刻反映点击结果 —— saveSettings 要走一趟
  // 主进程，不先更新的话会看到一下明显的迟滞。主进程随后广播
  // onSettingsChanged，那次覆盖是幂等的。
  const pickModel = useCallback((vendorId: string, modelId: string) => {
    setSettings((prev) => (prev ? { ...prev, ACTIVE_VENDOR: vendorId, ACTIVE_MODEL: modelId } : prev))
    void api
      .saveSettings({ ACTIVE_VENDOR: vendorId, ACTIVE_MODEL: modelId })
      .catch((err: unknown) => {
        console.error('[settings] 保存模型选择失败：', err instanceof Error ? err.message : err)
      })
  }, [])

  // 取当前会话的 Agent 模式视图。切会话要重新取 —— 绑定是每会话的。
  useEffect(() => {
    if (!currentId) {
      setProviders(null)
      return
    }
    let alive = true
    void api
      .getProviders(currentId)
      .then((view) => {
        // 取回来的时候用户可能已经切走了。不判的话晚到的响应会把新会话的
        // 视图覆盖成旧会话的 —— 表现为「切过去一瞬间显示的是上一个会话的引擎」
        if (alive) setProviders(view)
      })
      .catch((err: unknown) => {
        console.error('[providers] 读取失败：', err instanceof Error ? err.message : err)
      })
    return () => {
      alive = false
    }
  }, [currentId])

  // 主进程广播的变更（另一个窗口改了、或者配置文件被重新加载）
  useEffect(() => api.onProvidersChanged(setProviders), [])

  const pickProvider = useCallback(
    (providerId: string) => {
      if (!currentId) return
      // 乐观更新：点了立刻反映在选择器上，saveProvider 的返回值随后覆盖一次
      // （幂等）。不乐观的话点一下要等一个 IPC 往返才变，看着像没点上
      setProviders((prev) => (prev ? { ...prev, current: providerId } : prev))
      void api.setSessionProvider(currentId, providerId).then(setProviders).catch((err: unknown) => {
        console.error('[providers] 切换引擎失败：', err instanceof Error ? err.message : err)
      })
    },
    [currentId],
  )

  const pickCliModel = useCallback(
    (modelId: string) => {
      if (!currentId) return
      setProviders((prev) => (prev ? { ...prev, currentModel: modelId } : prev))
      void api.setSessionModel(currentId, modelId).then(setProviders).catch((err: unknown) => {
        console.error('[providers] 切换模型失败：', err instanceof Error ? err.message : err)
      })
    },
    [currentId],
  )

  // 启用/停用一个外部 CLI（设置页的开关）。和 pickProvider 同一个约定：
  // 拿主进程返回的完整视图覆盖，不自己推算。
  const toggleProvider = useCallback(
    (providerId: string, enabled: boolean) => {
      if (!currentId) return
      void api.toggleProvider(currentId, providerId, enabled).then(setProviders).catch((err: unknown) => {
        console.error('[providers] 启用/停用失败：', err instanceof Error ? err.message : err)
      })
    },
    [currentId],
  )

  const pickPermission = useCallback(
    (mode: PermissionMode) => {
      if (!currentId) return
      setProviders((prev) => (prev ? { ...prev, permission: mode } : prev))
      void api.setSessionPermission(currentId, mode).then(setProviders).catch((err: unknown) => {
        console.error('[providers] 切换权限失败：', err instanceof Error ? err.message : err)
      })
    },
    [currentId],
  )

  // 切换会话时从磁盘加载历史（内存里没有的话）
  const select = useCallback(
    async (id: string) => {
      setCurrentId(id)
      // 选中会话时把它所属的项目也标成选中：用户点开某个项目下的会话，
      // 接着点「新对话」应该继续落在那个项目里，而不是掉回「未分组」。
      const projectId = sessions.find((s) => s.id === id)?.projectId ?? null
      setCurrentProjectId(projectId)
      // 一起问「现在谁在跑」，拿主进程那份权威真相对齐一次。
      //
      // 为什么切会话时要对齐：前端的 running 只靠事件维护，而事件是「当时在场
      // 才收得到」。丢一个终止事件、或者到达时序乱了，那个会话就永久卡在
      // 「正在思考…」—— 用户报过这个症状，只能重启 app 才能解开。
      // 有了这次对齐，最坏情况也只持续到下一次切会话。
      //
      // 并发发出去而不是串行 await 两次：它们互不依赖，串起来会让切换多等
      // 一个往返（切会话是高频操作，用户能感觉到这一下迟滞）。
      const [messages, snapshot] = await Promise.all([
        api.loadSession(id),
        api.getRunnerSnapshot(),
      ])
      // 顺序要紧：先对齐 running，再放 messages。
      //
      // 反过来的话 loaded 会先看到一个过期的 running=true（那一轮其实已经
      // 结束了），于是走「在跑就保留内存那份」的分支、拒绝这次磁盘历史 ——
      // 而磁盘上恰好是刚刚答完的完整内容。用户看到的就是「切回来还在转圈，
      // 内容也没更新」。
      dispatch({ type: 'reconcile-running', sessionIds: snapshot.runningSessionIds })
      dispatch({ type: 'loaded', sessionId: id, messages })
    },
    [sessions],
  )

  const create = useCallback(async () => {
    // 新会话落在当前选中的项目里。projectId 交给主进程去建映射（它才是真相
    // 所在），而不是本地先记一份再想办法同步。
    const id = await api.createSession(currentProjectId)
    // 乐观加进列表：空会话不落盘，不这样做的话它在第一次回答前不会出现。
    // projectId 一并带上，否则它会先在「未分组」里出现一下，等第一次回答完
    // listSessions 刷新才跳到项目下面——用户看得见这一下跳动。
    setSessions((prev) => [
      { id, title: '新会话', updatedAt: Date.now(), ...(currentProjectId ? { projectId: currentProjectId } : {}) },
      ...prev,
    ])
    setCurrentId(id)
  }, [currentProjectId])

  // --- 项目操作 ---
  // 写操作都用主进程返回的完整状态覆盖本地副本，不自己推算。
  const addProject = useCallback(async () => {
    // 主进程弹原生目录选择器。用户取消时返回 null —— 取消不是失败，原样不动。
    const result = await api.addProject()
    if (!result) return
    setProjects(result.state)
    // 刚添加完就选中它：用户下一步大概率是在这个项目里开对话。
    setCurrentProjectId(result.project.id)
  }, [])

  const startProjectTask = useCallback(async () => {
    if (startingTask) return
    setStartingTask(true)
    setTaskStartError('')
    try {
      let projectId = currentProjectId
      if (!projectId) {
        const added = await api.addProject()
        if (!added) return
        setProjects(added.state)
        projectId = added.project.id
        setCurrentProjectId(projectId)
      }
      const task = await api.startProjectTask(projectId)
      receiveTask(task)
      setSessions((prev) => mergeSessions([{ id: task.sessionId, title: `理解项目 · ${task.projectName}`,
        updatedAt: task.createdAt, projectId: task.projectId }], prev, deletedIdsRef.current))
      await select(task.sessionId)
      setCurrentProjectId(task.projectId)
    } catch (err) {
      setTaskStartError(err instanceof Error ? err.message : String(err))
    } finally { setStartingTask(false) }
  }, [currentProjectId, receiveTask, select, startingTask])

  const removeProjectById = useCallback(
    async (id: string) => {
      const next = await api.removeProject(id)
      setProjects(next)
      // 选中的项目被移掉了，选中态得跟着放掉，否则新会话会挂到一个已经不存在
      // 的项目 id 上（主进程的 assignSession 会当 null 处理，但 UI 上那一行
      // 已经没了，选中态无处可显示，用户不知道新会话要去哪儿）。
      if (currentProjectId === id) setCurrentProjectId(null)
    },
    [currentProjectId],
  )

  const toggleCollapsed = useCallback(async (id: string) => {
    setProjects(await api.toggleProjectCollapsed(id))
  }, [])

  const remove = useCallback(
    async (id: string) => {
      // 在任何 await 之前同步打上 tombstone：见 mergeSessions 上面的注释，
      // 这一行必须先于 deleteSession 的 IPC 往返，才能挡住"删除动作发起后、
      // 结果回来前"这段空档里发生的并发合并。
      deletedIdsRef.current.add(id)
      try {
        await api.deleteSession(id)
      } catch (err) {
        // 删除失败。**不再有 DELETE_BLOCKED 这一类**：正在跑的会话现在会被
        // 主进程先取消再删（ipc-handlers.ts 的 deleteSession），不会拒绝用户。
        // 能走到这里的只剩真故障 —— 文件权限、磁盘满之类。
        //
        // 撤销 tombstone：它没被真的删掉，不该继续被排除在合并结果之外。
        deletedIdsRef.current.delete(id)
        // 反馈挂在当前打开的会话上（用户点删除时眼睛在哪儿，反馈就出现在哪儿），
        // 但失败的未必是当前这个 —— 侧边栏的 ✕ 对任何会话都可点。
        // 所以文案要点名是哪个会话。
        const target = sessions.find((s) => s.id === id)
        if (currentId) {
          dispatch({
            type: 'error',
            event: {
              sessionId: currentId,
              code: 'UNKNOWN',
              message: target
                ? `删不掉「${target.title}」：${err instanceof Error ? err.message : String(err)}`
                : `删除失败：${err instanceof Error ? err.message : String(err)}`,
            },
          })
        }
        return
      }
      // 删成功了，把它的 chats 桶也丢掉。不清的话那个桶会一直留着，
      // 里面的消息（可能很长，含工具输出）占着内存直到 app 关掉。
      //
      // 放在 catch 之后：删除失败时桶要留着，那个会话还在。
      dispatch({ type: 'session-removed', sessionId: id })

      const list = await api.listSessions()
      const merged = mergeSessions(list, sessions, deletedIdsRef.current)
      setSessions(merged)
      if (id === currentId) {
        setCurrentId(merged[0]?.id ?? (await api.createSession()))
      }
    },
    [currentId, sessions],
  )

  // 停止当前会话正在跑的那一轮。
  //
  // **不在这里乐观地清 running**：取消是轮边界的，点完之后那一轮还在跑
  // （当前的模型请求和已开跑的工具要跑完）。提前清掉会让 composer 立刻可用，
  // 而这时发新消息会撞上串行锁吃一个 BUSY —— 用户看到的是「停了但发不出去」。
  // 等主进程的 cancelled 事件到达再清，那时它才是真的停了。
  const cancel = useCallback(() => {
    if (!currentId) return
    // 返回值是「有没有受理」。没受理（那一轮刚好自己结束了）就什么都不做 ——
    // running 会由 complete 事件清掉。
    api.cancelMessage(currentId).catch(() => {
      // 取消这次 IPC 往返失败不值得弹错：那一轮要么还在跑（用户可以再点一次），
      // 要么已经结束（complete/error 会清掉 running）。两种情况都不是死局。
    })
  }, [currentId])

  const send = useCallback(
    (text: string, attachments?: ContentPart[]): Promise<boolean> => {
      if (!currentId || pendingSends.current.has(currentId)) return Promise.resolve(false)
      const id = currentId
      const outcome = new Promise<boolean>((resolve) => pendingSends.current.set(id, resolve))
      dispatch({ type: 'user-sent', sessionId: id, text, attachments })
      void api.sendMessage(id, text, attachments).catch((err: unknown) => {
        dispatch({ type: 'error', event: { sessionId: id, code: 'UNKNOWN',
          message: err instanceof Error ? err.message : String(err) } })
        settleSend(id, false)
      })
      return outcome
    },
    [currentId, settleSend],
  )

  // 编辑重发：砍掉这条及之后的历史，用新内容重新提问。
  //
  // ## 为什么要砍历史
  //
  // 编辑重发的语义是「从这里重新开始」。不砍的话，模型下一轮会看到
  // 「旧问题 + 旧答案 + 新问题」，而旧答案回答的是一个已经被改掉的问题。
  //
  // ## 为什么磁盘也要砍
  //
  // 只改界面不改磁盘的话，重开 app 之后被砍掉的那几条会**回来** ——
  // 而且下一轮对话仍然会带着它们（core 每轮从磁盘读历史）。
  //
  // ## 界面下标怎么变成「第几条 user」
  //
  // 磁盘和界面的下标不是一一对应的（磁盘上一轮是好几条消息，界面压成一个
  // 气泡），所以传下标过去没意义。能对齐两边的锚点是用户消息 —— 它在两边
  // 都是一条、顺序一致。见 main/truncate.ts。
  const editResend = useCallback(
    (idx: number, text: string) => {
      if (!currentId) return
      const chat = chats[currentId]
      if (!chat) return
      // 这条之前有几条用户消息 = 它是第几条 user（0-based）
      const nthUser = chat.messages.slice(0, idx).filter((m) => m.role === 'user').length
      // 先砍磁盘再重放界面，最后走正常的发送路径。
      //
      // 复用 send() 而不是自己拼一遍：那条路上有必须做的事（乐观标 running、
      // 失败兜底成看得见的错误），抄一份必然漏掉其中一件。
      api
        .truncateSession(currentId, nthUser)
        .then((truncated) => {
          // 用主进程返回的那份重放界面，而不是本地 slice 一刀 ——
          // 「砍完剩什么」的真相在磁盘那边（它按 user 锚点定位，
          // 会把那一轮的工具轨迹一起带走），renderer 不自己推算。
          dispatch({ type: 'loaded', sessionId: currentId, messages: truncated })
          void send(text, chat.messages[idx]?.contentParts?.filter((p) => p.type !== 'text'))
        })
        .catch((err: unknown) => {
          dispatch({
            type: 'error',
            event: {
              sessionId: currentId,
              code: 'UNKNOWN',
              message: err instanceof Error ? err.message : String(err),
            },
          })
        })
    },
    [currentId, chats, send],
  )

  // agent 是全局串行的（agent-runner.ts 的 busy 锁不区分 session），所以「哪个会话在跑」
  // 这件事必须在 UI 里显式暴露出来，否则用户在别的会话里点发送只会换来一个
  // 事后才出现的 BUSY 错误，既不知道是谁占着、也没法去处理挡路的那个审批。
  const onDecide = useCallback(
    (decision: ApprovalDecision) => {
      if (!currentId) return
      const requestId = chats[currentId]?.pendingApproval?.requestId
      if (!requestId) return
      void api.respondApproval(requestId, decision)
      dispatch({ type: 'approval-settled', sessionId: currentId, requestId })
    },
    [currentId, chats],
  )

  const chat = (currentId && chats[currentId]) || emptySession()

  // 侧边栏要给正在跑的那些会话显示转动指示。
  //
  // 从 chats 推而不是另存一份：那些桶里的 running 已经是权威真相的投影
  // （主进程的 runner 是源头，切会话时会 reconcile 一次 —— 见 select）。
  // 再存一份就是第三个真相，迟早和前两个分叉。
  const runningIds = useMemo(
    () => new Set(Object.entries(chats).filter(([, c]) => c.running).map(([id]) => id)),
    [chats],
  )

  // 会话按项目分组。分组逻辑在 main/projects.ts 里（纯函数，可单测），
  // 这里只把两份数据交给它 —— 不在组件里现算，免得同一套规则在别处再写一遍。
  const groups = useMemo(() => groupSessions(sessions, projects), [sessions, projects])

  if (status.phase !== 'ready') {
    // 失败路径的 restartApp handler 目前不带守卫（这时没有正在跑的 turn 或待审批要保护），
    // 所以正常不会 reject。但不能靠这个假设：一旦将来给它加了守卫，裸 void 会把拒绝
    // 理由静默吞掉，用户点重启只会看到"什么都没发生"——这个项目已经栽过两次了
    // （Task 13 丢 .catch、Task 15 的两个 void 调用）。至少让它可见。
    return (
      <StartupScreen
        status={status}
        onRetry={() =>
          void api.restartApp().catch((err: unknown) => {
            setStatus({
              phase: 'failed',
              detail: `重启失败：${err instanceof Error ? err.message : String(err)}`,
            })
          })
        }
      />
    )
  }

  return (
    // #root 是 flex row（styles.css），这个 wrapper 是它唯一的子元素，flex-1 撑满宽度。
    // 顶部拖拽条 + 下面的 sidebar/chat 行合在一起是完整窗口，所以要用 flex-col 包一层，
    // 否则拖拽条会跟 sidebar/chat 并排而不是叠在上面。
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {/* 这里以前横着一条 h-9 的窗口拖拽区，把左右两栏整体往下压了 36px。
          现在拖拽区挪进了 SessionList 顶部（见那个文件里的 titlebar 说明）：
          既然红绿灯本来就只在左上角，让侧边栏自己给它让位就够了，
          没必要让整个 app 顶上留一条空白横条。
          这样左右两个容器直接顶到窗口上沿，占满整个视口。 */}
      <div className="flex min-h-0 flex-1">
        {/* 左栏：设置打开时整个换成分区导航，而不是在右栏里再长出
            第二列导航。理由见 SettingsNav.tsx 的文件头 —— 224px 的一栏
            放不下两组导航，而在设置里的时候用户并不需要切会话。 */}
        {showSettings ? (
          <SettingsNav
            active={settingsSection}
            onSelect={setSettingsSection}
            onClose={() => { if (settingsPanel.current) void settingsPanel.current.requestClose(); else setShowSettings(false) }}
          />
        ) : (
          <SessionList
            groups={groups}
            currentId={currentId}
            currentProjectId={currentProjectId}
            onSelect={(id) => void select(id)}
            onCreate={() => void create()}
            // 右键菜单：SessionList 只报告「哪一项被右键了 + 光标在哪」，菜单内容
            // 从主进程拿（menuFor，产品决定留在那一侧），弹出和关闭在这边自绘。
            // 删除本身没变 —— 包括 tombstone；正在跑的会话现在会先取消再删。
            onSessionContextMenu={(id, title, at) => {
              void api
                .showContextMenu({ kind: 'session', id, title })
                .then((specs) => {
                  setMenu({
                    at,
                    items: specs.map((spec) => ({
                      label: spec.label,
                      destructive: spec.destructive,
                      onSelect: () => {
                        if (spec.action === 'delete-session') void remove(id)
                        // 改名不在这里落盘：先把这一行换成输入框，用户敲完
                        // 回车才写（见 SessionList 的 renaming 分支）
                        if (spec.action === 'rename-session') setRenamingId(id)
                      },
                    })),
                  })
                })
                .catch((err: unknown) => {
                  console.error('[context-menu] 取菜单项失败：', err instanceof Error ? err.message : err)
                })
            }}
            onProjectContextMenu={(id, name, at) => {
              void api
                .showContextMenu({ kind: 'project', id, name })
                .then((specs) => {
                  setMenu({
                    at,
                    items: specs.map((spec) => ({
                      label: spec.label,
                      destructive: spec.destructive,
                      onSelect: () => {
                        if (spec.action === 'remove-project') void removeProjectById(id)
                      },
                    })),
                  })
                })
                .catch((err: unknown) => {
                  console.error('[context-menu] 取菜单项失败：', err instanceof Error ? err.message : err)
                })
            }}
            renamingId={renamingId}
            onRename={(id, title) => {
              setRenamingId(null)
              void api
                .renameSession(id, title)
                // 改完重新拉一次列表：标题的真相在主进程（listSessions 会把
                // 用户起的名字覆盖上去），renderer 不自己改手里那份 ——
                // 那样两处各推算一份，迟早分叉。走 mergeSessions 是为了尊重
                // tombstone（见文件头那段说明）。
                .then(async () => {
                  const list = await api.listSessions()
                  setSessions(mergeSessions(list, sessions, deletedIdsRef.current))
                })
                .catch((err: unknown) => {
                  console.error('[rename] 改名失败：', err instanceof Error ? err.message : err)
                })
            }}
            onCancelRename={() => setRenamingId(null)}
            onOpenSettings={() => setShowSettings(true)}
            onAddProject={() => void addProject()}
            onToggleCollapsed={(id) => void toggleCollapsed(id)}
            onSelectProject={setCurrentProjectId}
            runningIds={runningIds}
          />
        )}
        {showSettings ? (
          // settings 还没读回来时不渲染面板：SettingsPanel 的 draft 只在挂载时
          // 播种一次，提前挂载等于用空对象播种，用户一改别的字段就会把磁盘上
          // 那份好的设置整体冲掉（这个坑在独立窗口那版就记着，跟着搬过来）。
          settings ? (
            <SettingsPanel
              ref={settingsPanel}
              settings={settings}
              activeSection={settingsSection}
              providers={providers ?? undefined}
              onToggleProvider={toggleProvider}
              onSave={saveSettings}
              onRestart={restart}
              runtimeStatus={status}
              projectPath={projects.projects.find(p => p.id === currentProjectId)?.dir}
              initialMemoryTab={initialMemoryTab}
              onClose={() => setShowSettings(false)}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-[12.5px] text-ink-3">
              读取设置中…
            </div>
          )
        ) : null}
        <div className={showSettings ? 'hidden' : 'flex min-w-0 flex-1'}>
          <ChatWindow
            chat={chat}
            sessionId={currentId ?? ''}
            onSend={send}
            projectTask={currentId ? projectTasks[currentId] : undefined}
            projectName={projects.projects.find((p) => p.id === currentProjectId)?.name}
            onStartProjectTask={() => void startProjectTask()}
            startingTask={startingTask}
            taskStartError={taskStartError}
            onAcceptProjectTask={async () => { if (currentId) receiveTask(await api.acceptProjectTask(currentId)) }}
            onExportProjectTask={() => currentId ? api.exportProjectTask(currentId) : Promise.resolve(null)}
            capabilities={status.capabilities}
            onOpenRetrievalSettings={() => { setInitialMemoryTab('notes'); setSettingsSection('memory'); setShowSettings(true) }}
            onCancel={cancel}
            onDecide={onDecide}
            modelCatalog={modelCatalog}
            currentVendor={activeVendor}
            currentModel={activeModel}
            onPickModel={pickModel}
            onEditResend={editResend}
            providers={providers ?? undefined}
            onPickProvider={pickProvider}
            onPickCliModel={pickCliModel}
            onPickPermission={pickPermission}
          />
        </div>
      </div>
      {/* 右键菜单挂在最外层：popover 会自己进 top layer，所以挂哪儿都不会被
          父容器的 overflow 裁掉，但放在这里更符合「它不属于某一栏」的事实。 */}
      <ContextMenu state={menu} onClose={() => setMenu(CLOSED)} />
    </div>
  )
}
