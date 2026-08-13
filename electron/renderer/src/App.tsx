import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { SessionList } from './components/SessionList'
import { ChatWindow, type BlockedBy } from './components/ChatWindow'
import { StartupScreen } from './components/StartupScreen'
import { SettingsPanel } from './components/SettingsPanel'
import { chatReducer, emptySession } from './chat-reducer'
import { api } from './api'
import type { ApprovalDecision, SessionMeta, RuntimeStatusEvent, DesktopSettings } from '../../shared/channels'

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
  const [showSettings, setShowSettings] = useState(false)
  const [settings, setSettings] = useState<DesktopSettings>({})
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
      api.onApprovalRequest((event) => dispatch({ type: 'approval-request', event })),
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

  // 设置必须等 ready 才能拉：getSettings 的 handler 是 setupIpcHandlers 注册的，
  // 而那要等 createRuntime 跑完。挂载就调会输掉这个竞态、被静默丢弃（没有 .catch），
  // settings 就一直停在 {}。后果不是「少显示点东西」——SettingsPanel 的 draft 只在
  // 挂载时从 settings 播种一次，所以用户会看到一排空输入框，然后一点保存就把空配置
  // 写回磁盘，把本来好的 key 冲掉。
  // 加 .catch：这条路径以前是裸 void，失败时连日志都没有（这个项目已经在
  // Task 13/15 因为丢 .catch 栽过两次）。
  useEffect(() => {
    if (status.phase !== 'ready') return
    api
      .getSettings()
      .then(setSettings)
      .catch((err: unknown) => {
        console.error('[settings] 读取失败：', err instanceof Error ? err.message : err)
      })
  }, [status.phase])

  // 启动时拉会话列表，没有会话就开一个新的；同时拉一次 runner 快照，把"谁在跑、
  // 谁在等审批"这两件事也补回来——这两者都活在主进程里，不会因为 renderer 重新
  // 挂载就消失，但本地的 chats 状态是从零开始的，事件流只能捕捉"挂载之后"发生的事。
  // 必须等 status 变 ready 才能调：会话相关的 ipcMain.handle 是 setupIpcHandlers
  // 里注册的，而那要等 createRuntime（装 embedding/建索引/连 MCP）跑完才执行，
  // 比 renderer 挂载慢得多。挂载就调的话会砸在"No handler registered"上，
  // 且没人重试，侧栏会话列表永远是空的。
  useEffect(() => {
    if (status.phase !== 'ready') return
    void (async () => {
      const list = await api.listSessions()
      setSessions(list)
      if (list.length > 0) {
        setCurrentId(list[0].id)
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
  const select = useCallback(async (id: string) => {
    setCurrentId(id)
    const messages = await api.loadSession(id)
    dispatch({ type: 'loaded', sessionId: id, messages })
  }, [])

  const create = useCallback(async () => {
    const id = await api.createSession()
    // 乐观加进列表：空会话不落盘，不这样做的话它在第一次回答前不会出现
    setSessions((prev) => [{ id, title: '新会话', updatedAt: Date.now() }, ...prev])
    setCurrentId(id)
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
        // 主进程拒绝了（大概率是这个会话正在被 agent 处理，见 ipc-handlers.ts）。
        // 撤销 tombstone——它没被真的删掉，不该继续被排除在合并结果之外。
        deletedIdsRef.current.delete(id)
        // 反馈挂在当前打开的会话上（用户点删除时眼睛在哪儿，反馈就出现在哪儿），
        // 但被拒的未必是当前这个 —— 侧边栏的 ✕ 对任何会话都可点。
        // 所以文案必须点名是哪个会话，否则会把当前打开的这个误指成"正在处理中"的那个。
        const blocked = sessions.find((s) => s.id === id)
        if (currentId) {
          dispatch({
            type: 'error',
            event: {
              sessionId: currentId,
              code: 'DELETE_BLOCKED',
              message: blocked
                ? `「${blocked.title}」还在处理中，等它跑完再删。`
                : '那个会话还在处理中，等它跑完再删。',
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

  const saveSettings = useCallback(async (patch: DesktopSettings) => {
    try {
      const next = await api.saveSettings(patch)
      setSettings(next)
      // 不再自动关闭面板——auto-save 模式下用户一直在编辑
    } catch (err) {
      // 验证失败：保持面板打开，让 SettingsPanel 显示错误
      throw err
    }
  }, [])

  const chat = (currentId && chats[currentId]) || emptySession()

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
          sessions={sessions}
          currentId={currentId}
          onSelect={(id) => void select(id)}
          onCreate={() => void create()}
          onDelete={(id) => void remove(id)}
          onOpenSettings={() => setShowSettings(true)}
        />
        <ChatWindow
          chat={chat}
          sessionId={currentId ?? ''}
          onSend={send}
          onDecide={onDecide}
          blockedBy={blockedBy}
          onJumpToBlocking={jumpToBlocking}
        />
      </div>
      {showSettings && (
        <SettingsPanel
          settings={settings}
          onSave={(p) => saveSettings(p)}
          onClose={() => setShowSettings(false)}
          onRestart={() => api.restartApp()}
        />
      )}
    </div>
  )
}
