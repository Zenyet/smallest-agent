// 项目分组：把会话按「本地目录」归类。纯逻辑，不 import electron —— 主进程的
// 接线（原生目录选择器、electron-store 持久化）分别在 ipc-handlers.ts 和
// projects-store.ts 里，这份文件可以被 vitest 直接跑。
//
// 为什么项目映射不能存进会话文件里：src/ 是冻结的，会话文件的形状由
// src/memory/store.ts 的 createJsonSessionStore 决定（就是一个 Message[] 数组），
// 没有地方放元数据，而且 runAgent 每答完一轮都会整体覆写那个文件 ——
// 任何塞进去的额外字段都会被下一次 save() 抹掉。所以项目映射走 Electron 层
// 自己的持久化（electron-store，settings 已经在用它）。
// 刻意不 import 'node:path'：这个模块被 renderer 也用着（App.tsx 从这里拿
// groupSessions，SessionList 拿 SessionGroup 类型），而 renderer 是浏览器环境，
// bundler 会把 node:path 外部化成一个空壳，构建直接失败。
// 需要的只是 basename 这一件事，用字符串切一下就够了（见 projectNameFromDir）。
import type { SessionMeta } from '../shared/channels'

export interface Project {
  id: string
  /** 展示名，默认取目录 basename，用户可改（本版还没做重命名 UI） */
  name: string
  /** 绝对路径。项目的身份由它决定 —— 同一个目录不重复添加 */
  dir: string
  createdAt: number
}

// 「未分组」不是一个真的项目（没有目录、不可删），但折叠状态要能被记住，
// 所以它需要一个稳定的 id 参与 collapsed 集合。前缀带下划线，和
// newProjectId 生成的 'p...' 形状不会撞。
export const UNGROUPED_ID = '_ungrouped'

export interface ProjectsState {
  projects: Project[]
  /** sessionId → projectId。一个会话最多属于一个项目；不在这里的会话归「未分组」 */
  sessionProject: Record<string, string>
  /** 折叠着的分组 id（含 UNGROUPED_ID）。持久化，重启后仍然折叠 */
  collapsed: string[]
}

export function emptyProjectsState(): ProjectsState {
  return { projects: [], sessionProject: {}, collapsed: [] }
}

// 存进 electron-store 的东西下次启动会原样读回来，但磁盘上的 JSON 可能是
// 手改过的、或者旧版本写的。读回来先过一遍这里，坏字段就地降级成空，
// 而不是让一个畸形的 collapsed 字段在渲染时炸掉整个侧边栏。
export function normalizeProjectsState(raw: unknown): ProjectsState {
  if (!raw || typeof raw !== 'object') return emptyProjectsState()
  const obj = raw as Partial<ProjectsState>

  const projects = Array.isArray(obj.projects)
    ? obj.projects.filter(
        (p): p is Project =>
          Boolean(p) &&
          typeof p === 'object' &&
          typeof (p as Project).id === 'string' &&
          typeof (p as Project).dir === 'string' &&
          typeof (p as Project).name === 'string',
      )
    : []

  const knownIds = new Set(projects.map((p) => p.id))
  const sessionProject: Record<string, string> = {}
  if (obj.sessionProject && typeof obj.sessionProject === 'object') {
    for (const [sessionId, projectId] of Object.entries(obj.sessionProject)) {
      // 指向已删项目的映射是垃圾数据（删除项目时会清，但手改文件/旧版本可能留下）。
      // 留着它会让那个会话既不在任何项目下、也不在「未分组」里 —— 直接从列表消失。
      if (typeof projectId === 'string' && knownIds.has(projectId)) {
        sessionProject[sessionId] = projectId
      }
    }
  }

  const collapsed = Array.isArray(obj.collapsed)
    ? obj.collapsed.filter((id): id is string => typeof id === 'string')
    : []

  return { projects, sessionProject, collapsed }
}

// 自己切 basename 而不是用 node:path（见文件顶部：这个模块 renderer 也在用）。
// 两种分隔符都认，因为 Windows 上 dialog 返回的是反斜杠路径。
export function projectNameFromDir(dir: string): string {
  // 先去掉尾部分隔符（用户可能选了个带斜杠的路径），再取最后一段。
  const trimmed = dir.replace(/[/\\]+$/, '')
  const last = trimmed.split(/[/\\]/).pop() ?? ''
  // 兜底分两级：取不出名字时退回原始路径（比泛泛的占位符有信息量），
  // 路径本身也是空的才用占位符。空名字在侧边栏里是一行点不到的空白。
  return last || dir || '未命名项目'
}

// 和 sessions.ts 的 newSessionId 同样的手法：时间戳前缀保证可排序，
// 进程内自增计数器保证同一毫秒内连续添加也不碰撞（不是概率性的"大概不会撞"）。
let idCounter = 0

export function newProjectId(seed: number): string {
  idCounter += 1
  return `p${seed.toString(36)}-${idCounter.toString(36)}`
}

// 目录即身份：同一个目录再选一次不该长出第二个同名项目（用户很容易这么干 ——
// 原生选择器每次都从头开始，记不住上次选过什么）。已存在就原样返回，
// 让调用方拿着同一个 id 继续往下走（比如把新会话挂到它下面）。
export function addProject(
  state: ProjectsState,
  input: { dir: string; name?: string; id: string; createdAt: number },
): { state: ProjectsState; project: Project } {
  const existing = state.projects.find((p) => p.dir === input.dir)
  if (existing) return { state, project: existing }

  const project: Project = {
    id: input.id,
    name: input.name?.trim() || projectNameFromDir(input.dir),
    dir: input.dir,
    createdAt: input.createdAt,
  }
  return { state: { ...state, projects: [...state.projects, project] }, project }
}

// 删项目不删会话：目录只是个分类标签，会话本身（磁盘上的对话历史）还在。
// 名下的会话回到「未分组」，而不是跟着一起消失。
export function removeProject(state: ProjectsState, id: string): ProjectsState {
  const sessionProject: Record<string, string> = {}
  for (const [sessionId, projectId] of Object.entries(state.sessionProject)) {
    if (projectId !== id) sessionProject[sessionId] = projectId
  }
  return {
    projects: state.projects.filter((p) => p.id !== id),
    sessionProject,
    collapsed: state.collapsed.filter((c) => c !== id),
  }
}

// projectId 传 null 表示挪回「未分组」。指向不存在的项目一律当 null 处理，
// 否则会造出一条 normalizeProjectsState 下次启动才会清掉的悬空映射。
export function assignSession(
  state: ProjectsState,
  sessionId: string,
  projectId: string | null,
): ProjectsState {
  const sessionProject = { ...state.sessionProject }
  if (projectId && state.projects.some((p) => p.id === projectId)) {
    sessionProject[sessionId] = projectId
  } else {
    delete sessionProject[sessionId]
  }
  return { ...state, sessionProject }
}

// 会话被删掉后它的映射就是垃圾了。不清的话，将来某个新会话万一拿到同样的 id
// （sessions.ts 的计数器保证进程内不会，但跨进程重启后时间戳可能重合）
// 会莫名其妙地出现在一个它从没被放进去过的项目下。
export function forgetSession(state: ProjectsState, sessionId: string): ProjectsState {
  if (!(sessionId in state.sessionProject)) return state
  const sessionProject = { ...state.sessionProject }
  delete sessionProject[sessionId]
  return { ...state, sessionProject }
}

export function toggleCollapsed(state: ProjectsState, id: string): ProjectsState {
  const collapsed = state.collapsed.includes(id)
    ? state.collapsed.filter((c) => c !== id)
    : [...state.collapsed, id]
  return { ...state, collapsed }
}

export interface SessionGroup {
  /** 项目 id，或 UNGROUPED_ID */
  id: string
  name: string
  /** 「未分组」没有目录 */
  dir: string | null
  collapsed: boolean
  sessions: SessionMeta[]
}

// 渲染层要的形状：项目按添加顺序、「未分组」垫在最后。
//
// 空项目也要出现（sessions 为空的分组不跳过）—— 用户刚添加一个目录、还没在里面
// 开对话时，如果这一行不显示，那次「添加项目」看起来就像什么都没发生。
// 反过来，「未分组」在没有游离会话时不显示：那是个兜底分类，不是用户建的东西，
// 空着还占一行只是噪音。
export function groupSessions(sessions: SessionMeta[], state: ProjectsState): SessionGroup[] {
  const collapsed = new Set(state.collapsed)
  const byProject = new Map<string, SessionMeta[]>()
  const ungrouped: SessionMeta[] = []

  for (const session of sessions) {
    // 兼容两个来源：listSessions 已经把 projectId 贴在 meta 上了，
    // 但前端乐观插入的新会话（还没落盘）可能只有 sessionProject 里的映射。
    const projectId = session.projectId ?? state.sessionProject[session.id]
    if (projectId && state.projects.some((p) => p.id === projectId)) {
      const list = byProject.get(projectId)
      if (list) list.push(session)
      else byProject.set(projectId, [session])
    } else {
      ungrouped.push(session)
    }
  }

  const groups: SessionGroup[] = state.projects.map((p) => ({
    id: p.id,
    name: p.name,
    dir: p.dir,
    collapsed: collapsed.has(p.id),
    sessions: byProject.get(p.id) ?? [],
  }))

  if (ungrouped.length > 0) {
    groups.push({
      id: UNGROUPED_ID,
      name: '未分组',
      dir: null,
      collapsed: collapsed.has(UNGROUPED_ID),
      sessions: ungrouped,
    })
  }

  return groups
}

// listSessions 拿到的 meta 里没有项目信息（它只认磁盘上的会话文件）。
// 在交给渲染层之前把映射贴上去，让「一个会话属于哪个项目」只有一个真相来源。
export function decorateSessions(sessions: SessionMeta[], state: ProjectsState): SessionMeta[] {
  return sessions.map((s) => {
    const projectId = state.sessionProject[s.id]
    return projectId ? { ...s, projectId } : s
  })
}
