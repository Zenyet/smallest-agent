import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { SessionList } from './components/SessionList'
import { ChatWindow, type BlockedBy } from './components/ChatWindow'
import { StartupScreen } from './components/StartupScreen'
import { ContextMenu, CLOSED, type ContextMenuState } from './components/ContextMenu'
import { chatReducer, emptySession } from './chat-reducer'
import { groupSessions } from '../../main/projects'
import { api } from './api'
import type {
  ApprovalDecision,
  SessionMeta,
  ProjectsState,
  RuntimeStatusEvent,
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

  // 订阅所有 Main → Renderer 事件。每个事件都带 sessionId，
  // reducer 按 sessionId 分桶，所以即使用户切走了，消息也还在。
  useEffect(() => {
    const offs = [
      api.onRuntimeStatus(setStatus),
      api.onMessageChunk((event) => dispatch({ type: 'chunk', event })),
      api.onToolCall((event) => dispatch({ type: 'tool-call', event })),
      api.onCacheHit((event) => dispatch({ type: 'cache-hit', event })),
      api.onVerdict((event) => dispatch({ type: 'verdict', event })),
      api.onError((event) => dispatch({ type: 'error', event })),
      api.onCancelled((event) => dispatch({ type: 'cancelled', event })),
      api.onApprovalRequest((event) => dispatch({ type: 'approval-request', event })),
      // 项目状态的广播。这个窗口自己的写操作已经用返回值更新过一次了，
      // 但广播是"任何来源的改动都到得了每个窗口"的那条通路，两者不冲突
      // （同一份状态覆盖两次是幂等的）。
      api.onProjectsChanged(setProjects),
      api.onMessageComplete((event) => {
        dispatch({ type: 'complete', event })
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

  // 这里以前还有一个「等 ready 之后拉 settings」的 effect。设置搬进独立窗口后，
  // 那份 state 在主窗口里没有任何消费者了（面板不在这儿渲染，draft 也不在这儿播种），
  // 所以整块删掉，而不是留一份没人读、还会慢慢变旧的副本。
  //
  // 那段注释警告的坑（settings 没读回来就渲染面板 → 一排空输入框 → 一保存把好的
  // key 冲掉）没有丢，它跟着面板搬到了 SettingsWindow.tsx：那边同样等 phase 落定
  // 才 getSettings，且在拿到之前不渲染 SettingsPanel。
  //
  // 设置改动要不要通知主窗口：主进程每轮都用 readConfig() 重新读一次设置
  // （见 ipc-handlers.ts），所以 STREAM / MAX_TURNS 这类改动下一轮自然生效，
  // 主窗口不需要知道。NOTES_DIR / EMBEDDING_MODEL 要重启才生效，那条路由
  // 设置窗口自己的重启警告负责。广播（CH.settingsChanged）仍然发给所有窗口，
  // 设置窗口靠它推进重启警告的比较基线。

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
      if (snapshot.runningSessionId) {
        dispatch({ type: 'hydrate-running', sessionId: snapshot.runningSessionId })
      }
      for (const req of snapshot.pendingApprovals) {
        dispatch({ type: 'approval-request', event: req })
      }
    })()
  }, [status.phase])

  // 切换会话时从磁盘加载历史（内存里没有的话）
  const select = useCallback(
    async (id: string) => {
      setCurrentId(id)
      // 选中会话时把它所属的项目也标成选中：用户点开某个项目下的会话，
      // 接着点「新对话」应该继续落在那个项目里，而不是掉回「未分组」。
      const projectId = sessions.find((s) => s.id === id)?.projectId ?? null
      setCurrentProjectId(projectId)
      const messages = await api.loadSession(id)
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
    (text: string) => {
      if (!currentId) return
      dispatch({ type: 'user-sent', sessionId: currentId, text })
      // sendMessage 这次 IPC 往返本身失败（比如主进程那边的 handler 抛错）
      // 不代表"这轮没跑"会自然被别的事件告知——user-sent 已经乐观地把这个会话标成
      // running，没人清掉的话它会一直卡在"正在思考…"，还会通过 blockedBy 把
      // 全局串行锁误报成被这个会话永久占着。必须在这里显式兜底，把它变成一条
      // 看得见的错误，并释放这个会话的 running。
      api.sendMessage(currentId, text).catch((err: unknown) => {
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
    [currentId],
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

  const blockedBy: BlockedBy | undefined = useMemo(() => {
    if (!currentId) return undefined
    const other = Object.entries(chats).find(([id, chat]) => id !== currentId && chat.running)
    if (!other) return undefined
    const [id, chat] = other
    const title = sessions.find((s) => s.id === id)?.title ?? '另一个会话'
    return { sessionId: id, title, pendingApproval: Boolean(chat.pendingApproval) }
  }, [currentId, chats, sessions])

  const jumpToBlocking = useCallback(() => {
    if (blockedBy) void select(blockedBy.sessionId)
  }, [blockedBy, select])

  // saveSettings 从这里搬走了：写设置现在是设置窗口自己的事（SettingsWindow.tsx），
  // 主窗口只负责把那个窗口叫出来。

  const chat = (currentId && chats[currentId]) || emptySession()

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
          // 设置是另一个窗口了（macOS ⌘, 的原生做法），不再是这里的一个 state。
          // 单例、聚焦、重复打开这些都由主进程负责，这边只管喊一声。
          // .catch 不能省：这个项目已经在 Task 13/15 因为丢 .catch 栽过两次，
          // 裸 void 的话「点了齿轮什么都没发生」会连日志都没有。
          onOpenSettings={() =>
            void api.openSettings().catch((err: unknown) => {
              console.error('[settings] 打开设置窗口失败：', err instanceof Error ? err.message : err)
            })
          }
          onAddProject={() => void addProject()}
          onToggleCollapsed={(id) => void toggleCollapsed(id)}
          onSelectProject={setCurrentProjectId}
        />
        <ChatWindow
          chat={chat}
          sessionId={currentId ?? ''}
          onSend={send}
          onCancel={cancel}
          onDecide={onDecide}
          blockedBy={blockedBy}
          onJumpToBlocking={jumpToBlocking}
        />
      </div>
      {/* 右键菜单挂在最外层：popover 会自己进 top layer，所以挂哪儿都不会被
          父容器的 overflow 裁掉，但放在这里更符合「它不属于某一栏」的事实。 */}
      <ContextMenu state={menu} onClose={() => setMenu(CLOSED)} />
    </div>
  )
}
