import { describe, it, expect } from 'vitest'
import {
  agentForSession,
  agentOptions,
  applyAgent,
  assignAgent,
  emptyAgentsState,
  filterTools,
  findAgent,
  forgetSession,
  newAgent,
  newAgentId,
  normalizeAgentsState,
  removeAgent,
  upsertAgent,
  type AgentDef,
  type AgentsState,
} from '../../electron/main/agents'
import { loadConfig } from '../../src/config'
import type { Tool, ToolRegistry } from '../../src/types'

const config = loadConfig({ DEEPSEEK_API_KEY: 'k' })

const fakeTool = (name: string): Tool => ({
  name,
  description: 'd',
  parameters: undefined,
  run: async () => 'x',
})

const registry: ToolRegistry = {
  read_file: fakeTool('read_file'),
  write_file: fakeTool('write_file'),
  web_search: fakeTool('web_search'),
}

const state = (over: Partial<AgentsState> = {}): AgentsState => ({
  ...emptyAgentsState(),
  agents: [
    { id: 'a1', name: '代码审查', systemPrompt: '你只审查，不改代码' },
    { id: 'a2', name: '只读助手', tools: ['read_file', 'web_search'] },
  ],
  ...over,
})

describe('newAgentId', () => {
  // 用户会改名字，而 id 被会话绑定引用着 —— 改名导致绑定失效是最难解释的
  // 一类 bug（「我只是改了个名字」）
  it('不从名字派生，改名不会影响 id', () => {
    const a = newAgent('原名')
    const renamed = { ...a, name: '新名' }
    expect(renamed.id).toBe(a.id)
  })

  // 同一毫秒内建两个会撞 id（和 sessions.ts 的 newSessionId 同一个坑）
  it('同一毫秒内建两个也不撞', () => {
    expect(newAgentId(1000)).not.toBe(newAgentId(1000))
  })
})

describe('normalizeAgentsState', () => {
  it('不是对象就给空状态', () => {
    expect(normalizeAgentsState(null)).toEqual(emptyAgentsState())
    expect(normalizeAgentsState('字符串')).toEqual(emptyAgentsState())
  })

  // 没有 id 没法绑定；没有名字选择器上是一片空白
  it('丢掉没有 id 或没有名字的条目', () => {
    const out = normalizeAgentsState({
      agents: [
        { id: 'ok', name: '好的' },
        { name: '没有 id' },
        { id: '没有名字' },
        { id: 'x', name: '   ' },
        null,
      ],
    })
    expect(out.agents.map((a) => a.id)).toEqual(['ok'])
  })

  it('同 id 只留第一个', () => {
    const out = normalizeAgentsState({
      agents: [
        { id: 'dup', name: '先' },
        { id: 'dup', name: '后' },
      ],
    })
    expect(out.agents).toHaveLength(1)
    expect(out.agents[0].name).toBe('先')
  })

  // 悬空绑定会让选择器显示空白，用户不知道这个会话在用什么设定
  it('清掉指向已删 agent 的绑定', () => {
    const out = normalizeAgentsState({
      agents: [{ id: 'alive', name: '在' }],
      sessionAgent: { s1: 'alive', s2: '已经删了的' },
    })
    expect(out.sessionAgent).toEqual({ s1: 'alive' })
  })

  it('空的可选字段不落盘（少一项噪音）', () => {
    const out = normalizeAgentsState({ agents: [{ id: 'a', name: 'n', systemPrompt: '  ' }] })
    expect(out.agents[0]).toEqual({ id: 'a', name: 'n' })
  })

  it('工具白名单里的空串被滤掉', () => {
    const out = normalizeAgentsState({
      agents: [{ id: 'a', name: 'n', tools: ['read_file', '', '  '] }],
    })
    expect(out.agents[0].tools).toEqual(['read_file'])
  })
})

describe('agentForSession', () => {
  it('没绑过是 undefined', () => {
    expect(agentForSession(state(), 's1')).toBeUndefined()
  })

  it('绑了就给出那个', () => {
    const s = state({ sessionAgent: { s1: 'a1' } })
    expect(agentForSession(s, 's1')?.name).toBe('代码审查')
  })

  // 用户停用它就是不想用了，但**绑定留着** —— 重新启用之后那些会话还是它的，
  // 不用重新一个个绑回去
  it('停用的当成没绑定，但绑定本身留着', () => {
    const s: AgentsState = {
      agents: [{ id: 'a1', name: '停用的', disabled: true }],
      sessionAgent: { s1: 'a1' },
    }
    expect(agentForSession(s, 's1')).toBeUndefined()
    expect(s.sessionAgent.s1).toBe('a1')
  })
})

describe('agentOptions', () => {
  it('停用的不出现在选择器里', () => {
    const s: AgentsState = {
      agents: [
        { id: 'on', name: '开着' },
        { id: 'off', name: '关着', disabled: true },
      ],
      sessionAgent: {},
    }
    expect(agentOptions(s).map((a) => a.id)).toEqual(['on'])
  })
})

describe('applyAgent', () => {
  it('有系统提示时覆盖', () => {
    const out = applyAgent({ id: 'a', name: 'n', systemPrompt: '你是审查员' }, config)
    expect(out.systemPrompt).toBe('你是审查员')
  })

  // ## 这一条是这个函数最容易写错的地方
  //
  // 空字段表示「不管这一项」，不是「设成空」。所以一个只填了名字的 agent
  // 不该把全局系统提示清掉 —— 那会让模型失去所有指令
  it('没填系统提示时不动原来的', () => {
    const out = applyAgent({ id: 'a', name: 'n' }, config)
    expect(out.systemPrompt).toBe(config.systemPrompt)
    expect(out.systemPrompt).not.toBe('')
  })

  it('只有空白的系统提示也当没填', () => {
    const out = applyAgent({ id: 'a', name: 'n', systemPrompt: '   ' }, config)
    expect(out.systemPrompt).toBe(config.systemPrompt)
  })

  it('不改入参', () => {
    const before = config.systemPrompt
    applyAgent({ id: 'a', name: 'n', systemPrompt: '换掉' }, config)
    expect(config.systemPrompt).toBe(before)
  })
})

describe('filterTools', () => {
  // 空 = 全部可用。多数 agent 只是「换个说话方式」，限制工具是少数场景
  it('空白名单返回全部', () => {
    expect(Object.keys(filterTools({ id: 'a', name: 'n' }, registry)).sort()).toEqual([
      'read_file',
      'web_search',
      'write_file',
    ])
  })

  it('按白名单过滤', () => {
    const a: AgentDef = { id: 'a', name: 'n', tools: ['read_file'] }
    expect(Object.keys(filterTools(a, registry))).toEqual(['read_file'])
  })

  // 名单里有但注册表里没有的通常是 MCP server 没连上，为此报错会让
  // 整个 agent 不可用 —— 代价比「少一个工具」大得多
  it('名单里有但注册表里没有的直接忽略，不报错', () => {
    const a: AgentDef = { id: 'a', name: 'n', tools: ['read_file', '不存在的工具'] }
    expect(Object.keys(filterTools(a, registry))).toEqual(['read_file'])
  })

  it('一个只读 agent 拿不到写工具', () => {
    const a: AgentDef = { id: 'a', name: '只读', tools: ['read_file'] }
    expect(filterTools(a, registry).write_file).toBeUndefined()
  })
})

describe('写操作', () => {
  it('upsert 新建时追加', () => {
    const out = upsertAgent(emptyAgentsState(), { id: 'new', name: '新的' })
    expect(out.agents).toHaveLength(1)
  })

  it('upsert 同 id 时替换而不是追加', () => {
    const out = upsertAgent(state(), { id: 'a1', name: '改过名的' })
    expect(out.agents).toHaveLength(2)
    expect(findAgent(out, 'a1')?.name).toBe('改过名的')
  })

  // 删了 agent 之后绑定就是悬空的，留着会让选择器显示空白
  it('删 agent 时一并清掉指向它的绑定', () => {
    const s = state({ sessionAgent: { s1: 'a1', s2: 'a2' } })
    const out = removeAgent(s, 'a1')
    expect(out.sessionAgent).toEqual({ s2: 'a2' })
  })

  it('assign null = 这个会话不用自定义 agent', () => {
    const s = state({ sessionAgent: { s1: 'a1' } })
    expect(assignAgent(s, 's1', null).sessionAgent).toEqual({})
  })

  it('写操作不改入参', () => {
    const s = state({ sessionAgent: { s1: 'a1' } })
    const before = JSON.stringify(s)
    upsertAgent(s, { id: 'x', name: 'x' })
    removeAgent(s, 'a1')
    assignAgent(s, 's2', 'a2')
    forgetSession(s, 's1')
    expect(JSON.stringify(s)).toBe(before)
  })
})

describe('forgetSession', () => {
  it('清掉这个会话的绑定', () => {
    const s = state({ sessionAgent: { s1: 'a1', s2: 'a2' } })
    expect(forgetSession(s, 's1').sessionAgent).toEqual({ s2: 'a2' })
  })

  // 调用方用引用比较跳过写盘
  it('本来就没绑过时返回同一个引用', () => {
    const s = state()
    expect(forgetSession(s, '没见过')).toBe(s)
  })
})
