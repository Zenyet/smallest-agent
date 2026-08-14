import { describe, it, expect } from 'vitest'
import {
  addProject,
  assignSession,
  decorateSessions,
  emptyProjectsState,
  forgetSession,
  groupSessions,
  newProjectId,
  normalizeProjectsState,
  projectNameFromDir,
  removeProject,
  toggleCollapsed,
  UNGROUPED_ID,
  type ProjectsState,
} from '../../electron/main/projects'
import type { SessionMeta } from '../../electron/shared/channels'

const session = (id: string, over: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: `会话 ${id}`,
  updatedAt: 1,
  ...over,
})

// 常用的起始状态：一个项目 p1
const withP1 = (): ProjectsState => ({
  projects: [{ id: 'p1', name: '项目一', dir: '/a/proj-one', createdAt: 1 }],
  sessionProject: {},
  collapsed: [],
})

describe('projectNameFromDir', () => {
  it('默认取目录的 basename', () => {
    expect(projectNameFromDir('/Users/me/code/smallest-agent')).toBe('smallest-agent')
  })

  it('尾部带分隔符也能取对（原生选择器有时给带斜杠的路径）', () => {
    expect(projectNameFromDir('/Users/me/code/smallest-agent/')).toBe('smallest-agent')
  })

  // 不变量是「永远不返回空串」——空名字在侧边栏是一行点不到的空白。
  // 兜底分两级：basename 取不出来时先退回原始路径（比一个泛泛的占位符更有信息量，
  // 用户至少知道自己选中的是哪儿），路径本身也是空的才用占位符。
  it('根目录退回原始路径，而不是空串', () => {
    expect(projectNameFromDir('/')).toBe('/')
  })

  it('空路径才用占位名', () => {
    expect(projectNameFromDir('')).toBe('未命名项目')
  })
})

describe('newProjectId', () => {
  it('同一毫秒内多次调用也不碰撞（连着添加两个项目会走到这条路）', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newProjectId(1739000000000)))
    expect(ids.size).toBe(500)
  })

  it('时间戳在前，所以 id 仍然可按创建时间排序', () => {
    expect(newProjectId(1) < newProjectId(2)).toBe(true)
  })
})

describe('addProject', () => {
  it('加进去，名字默认取目录 basename', () => {
    const { state, project } = addProject(emptyProjectsState(), {
      dir: '/a/my-app',
      id: 'p1',
      createdAt: 5,
    })
    expect(state.projects).toHaveLength(1)
    expect(project).toMatchObject({ id: 'p1', name: 'my-app', dir: '/a/my-app' })
  })

  it('显式传名字时用它', () => {
    const { project } = addProject(emptyProjectsState(), {
      dir: '/a/my-app',
      name: '自定义名',
      id: 'p1',
      createdAt: 5,
    })
    expect(project.name).toBe('自定义名')
  })

  it('名字是纯空白时退回 basename，而不是留一个空名字', () => {
    const { project } = addProject(emptyProjectsState(), {
      dir: '/a/my-app',
      name: '   ',
      id: 'p1',
      createdAt: 5,
    })
    expect(project.name).toBe('my-app')
  })

  it('同一个目录重复添加不会长出第二个项目（原生选择器每次从头开始，用户很容易重复选）', () => {
    const first = addProject(emptyProjectsState(), { dir: '/a/proj', id: 'p1', createdAt: 1 })
    const second = addProject(first.state, { dir: '/a/proj', id: 'p2', createdAt: 2 })
    expect(second.state.projects).toHaveLength(1)
    // 返回原来那个，让调用方拿着同一个 id 继续（比如把新会话挂到它下面）
    expect(second.project.id).toBe('p1')
  })
})

describe('removeProject', () => {
  it('删项目不删会话：名下的会话回到「未分组」', () => {
    const state = assignSession(withP1(), 's1', 'p1')
    const next = removeProject(state, 'p1')
    expect(next.projects).toHaveLength(0)
    // 映射被清掉了，s1 于是落回未分组（而不是变成指向不存在项目的悬空映射）
    expect(next.sessionProject).toEqual({})
    const groups = groupSessions([session('s1')], next)
    expect(groups.map((g) => g.id)).toEqual([UNGROUPED_ID])
  })

  it('顺手清掉它的折叠状态，不在 collapsed 里留垃圾', () => {
    const state = toggleCollapsed(withP1(), 'p1')
    expect(removeProject(state, 'p1').collapsed).toEqual([])
  })

  it('不影响别的项目的映射', () => {
    const base: ProjectsState = {
      projects: [
        { id: 'p1', name: 'a', dir: '/a', createdAt: 1 },
        { id: 'p2', name: 'b', dir: '/b', createdAt: 2 },
      ],
      sessionProject: { s1: 'p1', s2: 'p2' },
      collapsed: [],
    }
    expect(removeProject(base, 'p1').sessionProject).toEqual({ s2: 'p2' })
  })
})

describe('assignSession', () => {
  it('把会话挂到项目下', () => {
    expect(assignSession(withP1(), 's1', 'p1').sessionProject).toEqual({ s1: 'p1' })
  })

  it('传 null 挪回「未分组」', () => {
    const state = assignSession(withP1(), 's1', 'p1')
    expect(assignSession(state, 's1', null).sessionProject).toEqual({})
  })

  it('指向不存在的项目一律当 null（不造悬空映射，那会让会话从列表里消失）', () => {
    expect(assignSession(withP1(), 's1', 'nope').sessionProject).toEqual({})
  })

  it('一个会话最多属于一个项目：再挂一次是搬家，不是同时属于两个', () => {
    const base: ProjectsState = {
      projects: [
        { id: 'p1', name: 'a', dir: '/a', createdAt: 1 },
        { id: 'p2', name: 'b', dir: '/b', createdAt: 2 },
      ],
      sessionProject: { s1: 'p1' },
      collapsed: [],
    }
    expect(assignSession(base, 's1', 'p2').sessionProject).toEqual({ s1: 'p2' })
  })
})

describe('forgetSession', () => {
  it('清掉被删会话的映射', () => {
    const state = assignSession(withP1(), 's1', 'p1')
    expect(forgetSession(state, 's1').sessionProject).toEqual({})
  })

  it('本来就没分组时原样返回同一个对象（调用方靠引用比较跳过一次没必要的写盘）', () => {
    const state = withP1()
    expect(forgetSession(state, 'ghost')).toBe(state)
  })
})

describe('toggleCollapsed', () => {
  it('来回切', () => {
    const once = toggleCollapsed(withP1(), 'p1')
    expect(once.collapsed).toEqual(['p1'])
    expect(toggleCollapsed(once, 'p1').collapsed).toEqual([])
  })

  it('「未分组」的折叠状态也能记（它不是真项目，但折叠状态要能持久化）', () => {
    expect(toggleCollapsed(emptyProjectsState(), UNGROUPED_ID).collapsed).toEqual([UNGROUPED_ID])
  })
})

describe('groupSessions', () => {
  it('会话嵌在它所属的项目下', () => {
    const state = assignSession(withP1(), 's1', 'p1')
    const groups = groupSessions([session('s1')], state)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ id: 'p1', name: '项目一', dir: '/a/proj-one' })
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['s1'])
  })

  it('没有项目的会话归「未分组」，且它垫在最后', () => {
    const state = assignSession(withP1(), 's1', 'p1')
    const groups = groupSessions([session('s1'), session('s2')], state)
    expect(groups.map((g) => g.id)).toEqual(['p1', UNGROUPED_ID])
    expect(groups[1].sessions.map((s) => s.id)).toEqual(['s2'])
    // 未分组没有目录：它是兜底分类，不是用户选的某个文件夹
    expect(groups[1].dir).toBeNull()
  })

  it('空项目也出现（否则刚添加完目录看起来像什么都没发生）', () => {
    const groups = groupSessions([], withP1())
    expect(groups.map((g) => g.id)).toEqual(['p1'])
    expect(groups[0].sessions).toEqual([])
  })

  it('没有游离会话时不显示「未分组」（空着占一行只是噪音）', () => {
    const state = assignSession(withP1(), 's1', 'p1')
    expect(groupSessions([session('s1')], state).map((g) => g.id)).toEqual(['p1'])
  })

  it('认 meta 上的 projectId（listSessions 已经贴好的那份）', () => {
    const groups = groupSessions([session('s1', { projectId: 'p1' })], withP1())
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['s1'])
  })

  it('也认 sessionProject 里的映射（前端乐观插入的新会话还没落盘，meta 上可能没有）', () => {
    const state = assignSession(withP1(), 's1', 'p1')
    expect(groupSessions([session('s1')], state)[0].sessions).toHaveLength(1)
  })

  it('meta 上指向已删项目的 projectId 落到「未分组」，不会让会话凭空消失', () => {
    const groups = groupSessions([session('s1', { projectId: 'gone' })], emptyProjectsState())
    expect(groups.map((g) => g.id)).toEqual([UNGROUPED_ID])
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['s1'])
  })

  it('折叠状态带到分组上（渲染层直接用，不自己再查一遍 collapsed）', () => {
    const state = toggleCollapsed(assignSession(withP1(), 's1', 'p1'), 'p1')
    expect(groupSessions([session('s1')], state)[0].collapsed).toBe(true)
    // 折叠不影响内容：会话还在，只是渲染层不画它们
    expect(groupSessions([session('s1')], state)[0].sessions).toHaveLength(1)
  })

  it('项目按添加顺序排，不按名字（用户建的顺序就是他的心智顺序）', () => {
    const base: ProjectsState = {
      projects: [
        { id: 'p1', name: 'zzz', dir: '/z', createdAt: 1 },
        { id: 'p2', name: 'aaa', dir: '/a', createdAt: 2 },
      ],
      sessionProject: {},
      collapsed: [],
    }
    expect(groupSessions([], base).map((g) => g.id)).toEqual(['p1', 'p2'])
  })

  it('保持传入的会话顺序（listSessions 已经按 updatedAt 排好了，这里不重排）', () => {
    const state = { ...withP1(), sessionProject: { s1: 'p1', s2: 'p1', s3: 'p1' } }
    const groups = groupSessions([session('s3'), session('s1'), session('s2')], state)
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['s3', 's1', 's2'])
  })
})

describe('decorateSessions', () => {
  it('把项目归属贴到 meta 上（listSessions 只认磁盘文件，不知道项目这回事）', () => {
    const state = assignSession(withP1(), 's1', 'p1')
    const [decorated] = decorateSessions([session('s1')], state)
    expect(decorated.projectId).toBe('p1')
  })

  it('没有归属的会话不加这个字段（保持「没有项目」是个正常状态）', () => {
    const [decorated] = decorateSessions([session('s1')], withP1())
    expect('projectId' in decorated).toBe(false)
  })
})

describe('normalizeProjectsState', () => {
  it('不是对象时给空状态（磁盘上的 JSON 可能被手改坏）', () => {
    expect(normalizeProjectsState(null)).toEqual(emptyProjectsState())
    expect(normalizeProjectsState('nope')).toEqual(emptyProjectsState())
    expect(normalizeProjectsState(undefined)).toEqual(emptyProjectsState())
  })

  it('丢掉字段不全的项目条目', () => {
    const state = normalizeProjectsState({
      projects: [{ id: 'p1', name: 'ok', dir: '/a', createdAt: 1 }, { id: 'p2' }, null, 'x'],
      sessionProject: {},
      collapsed: [],
    })
    expect(state.projects.map((p) => p.id)).toEqual(['p1'])
  })

  it('丢掉指向不存在项目的悬空映射（留着会让那个会话从列表里彻底消失）', () => {
    const state = normalizeProjectsState({
      projects: [{ id: 'p1', name: 'ok', dir: '/a', createdAt: 1 }],
      sessionProject: { s1: 'p1', s2: 'gone' },
      collapsed: [],
    })
    expect(state.sessionProject).toEqual({ s1: 'p1' })
  })

  it('collapsed 里的非字符串项被过滤掉', () => {
    const state = normalizeProjectsState({ projects: [], sessionProject: {}, collapsed: ['p1', 3, null] })
    expect(state.collapsed).toEqual(['p1'])
  })

  it('字段整个缺失时降级成空，而不是抛错', () => {
    expect(normalizeProjectsState({})).toEqual(emptyProjectsState())
  })
})
