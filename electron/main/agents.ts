// ============================================================================
// agents.ts —— 自定义 agent（纯数据 + 纯函数）
// ----------------------------------------------------------------------------
// 移植自 rs/core/src/agents.rs。
//
// 一个自定义 agent 就是「一套预设」：系统提示 + 用哪个模型 + 能用哪些工具。
//
// ## 它不是 subagent
//
// rs 那边的文件头写「对应 Claude Code 的 subagent」，容易让人误解。它**不能
// 派生子任务、不能并行、没有独立上下文** —— 只是换一套设定在同一个循环里跑。
// 真正的 subagent（开一个新 agent 实例跑一段子任务再把结果带回来）两边都没有。
//
// ## 为什么它不是一个新的 Provider
//
// Provider 答的是「谁来跑这一轮」（我们自己 vs 外部 CLI 子进程）。
// 自定义 agent 答的是「用什么设定跑」—— 它**总是**内置 provider 跑的。
// 做成 Provider 会让「Claude Code + 我的代码审查 agent」这种组合无法表达
// （外部 CLI 有它自己的系统提示，我们插不进去）。
//
// 所以它是内置 provider 的一层参数，和厂商/模型选择并列。
//
// ## 工具白名单为什么可以为空
//
// 空 = 全部可用。这是刻意的默认值：多数 agent 只是「换个说话方式」，
// 限制工具是少数场景（一个只读的代码审查 agent 不该能写文件）。
// 默认全开意味着用户建一个 agent 时不用先想清楚工具清单。
// ============================================================================

import type { Config, ToolRegistry } from '../../src/types'

/** 一个自定义 agent。 */
export interface AgentDef {
  /** 唯一 id。会话绑定引用它。 */
  id: string
  name: string
  /** 一句话说明。**只给人看**，不发给模型 —— 模型看到的是 systemPrompt。 */
  description?: string
  /** 系统提示。空 = 用全局那个（config.systemPrompt）。 */
  systemPrompt?: string
  /** 用哪家的哪个模型，形状是 `厂商id/模型id`。空 = 跟着会话自己选的走。 */
  model?: string
  /** 允许用的工具名。空 = 全部可用，见文件头。 */
  tools?: string[]
  /** 停用的不出现在选择器里，也不生效（见 agentForSession）。 */
  disabled?: boolean
}

export interface AgentsState {
  agents: AgentDef[]
  /** sessionId → agentId。不在这里的会话不用任何自定义 agent。 */
  sessionAgent: Record<string, string>
}

export function emptyAgentsState(): AgentsState {
  return { agents: [], sessionAgent: {} }
}

/**
 * 建一个新 agent，id 用时间戳。
 *
 * **不用名字派生 id**：用户会改名字，而 id 被会话绑定引用着 —— 改名导致
 * 绑定失效是最难解释的一类 bug（「我只是改了个名字」）。
 *
 * seed 可注入是为了测试能给确定的值；生产传 Date.now()。
 * 同一毫秒内建两个会撞 id，所以带一个进程内自增的后缀 —— 和
 * sessions.ts 的 newSessionId 同一个理由（那边的注释解释了为什么不用随机）。
 */
let idCounter = 0
export function newAgentId(seed: number = Date.now()): string {
  idCounter += 1
  return `agent-${seed.toString(36)}-${idCounter.toString(36)}`
}

export function newAgent(name: string, seed?: number): AgentDef {
  return { id: newAgentId(seed), name }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

function normalizeAgent(raw: unknown): AgentDef | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Partial<AgentDef>
  // 没有 id 没法绑定；没有名字选择器上是一片空白。缺哪个都整条丢掉，
  // 比留一个点不动的条目好
  if (typeof a.id !== 'string' || a.id === '') return null
  const name = str(a.name)
  if (!name) return null
  const tools = Array.isArray(a.tools)
    ? a.tools.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    : []
  return {
    id: a.id,
    name,
    ...(str(a.description) ? { description: a.description } : {}),
    ...(str(a.systemPrompt) ? { systemPrompt: a.systemPrompt } : {}),
    ...(str(a.model) ? { model: a.model } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(a.disabled === true ? { disabled: true } : {}),
  }
}

/**
 * 读盘之后过一遍。
 *
 * 清掉指向已删 agent 的绑定 —— 悬空绑定会让选择器显示空白，用户不知道
 * 这个会话在用什么设定（和 providers.ts 的 normalize 同一条理由）。
 */
export function normalizeAgentsState(raw: unknown): AgentsState {
  if (!raw || typeof raw !== 'object') return emptyAgentsState()
  const obj = raw as Partial<AgentsState>

  const agents: AgentDef[] = []
  const seen = new Set<string>()
  if (Array.isArray(obj.agents)) {
    for (const item of obj.agents) {
      const a = normalizeAgent(item)
      // 同 id 只留第一个：重复条目会让「按 id 查」的结果取决于遍历顺序
      if (a && !seen.has(a.id)) {
        seen.add(a.id)
        agents.push(a)
      }
    }
  }

  const sessionAgent: Record<string, string> = {}
  if (obj.sessionAgent && typeof obj.sessionAgent === 'object') {
    for (const [sid, aid] of Object.entries(obj.sessionAgent)) {
      if (typeof aid === 'string' && seen.has(aid)) sessionAgent[sid] = aid
    }
  }

  return { agents, sessionAgent }
}

export function findAgent(state: AgentsState, id: string): AgentDef | undefined {
  return state.agents.find((a) => a.id === id)
}

/**
 * 这个会话用哪个自定义 agent。undefined = 不用。
 *
 * 停用的当成没绑定：用户停用它就是不想用了。但**绑定留着** ——
 * 重新启用之后那些会话还是它的，不用重新一个个绑回去。
 */
export function agentForSession(state: AgentsState, sessionId: string): AgentDef | undefined {
  const id = state.sessionAgent[sessionId]
  if (!id) return undefined
  const a = findAgent(state, id)
  return a && !a.disabled ? a : undefined
}

/** 选择器里列哪些。停用的不列。 */
export function agentOptions(state: AgentsState): { id: string; name: string }[] {
  return state.agents.filter((a) => !a.disabled).map((a) => ({ id: a.id, name: a.name }))
}

/**
 * 把这个 agent 的设定应用到一份配置上。
 *
 * **只覆盖它明确指定了的东西** —— 空字段表示「不管这一项」，而不是
 * 「设成空」。所以一个只填了系统提示的 agent 不会把模型清掉。
 */
export function applyAgent(agent: AgentDef, config: Config): Config {
  const out = { ...config }
  if (agent.systemPrompt?.trim()) out.systemPrompt = agent.systemPrompt
  return out
}

/**
 * 按白名单过滤工具注册表。
 *
 * 空白名单返回原样（全部可用）。名单里有但注册表里没有的工具**直接忽略** ——
 * 那通常是 MCP server 没连上，而为此报错会让整个 agent 不可用，
 * 代价比「少一个工具」大得多。
 */
export function filterTools(agent: AgentDef, tools: ToolRegistry): ToolRegistry {
  const allow = agent.tools
  if (!allow || allow.length === 0) return tools
  const out: ToolRegistry = {}
  for (const [name, tool] of Object.entries(tools)) {
    if (allow.includes(name)) out[name] = tool
  }
  return out
}

// --- 写操作：都返回新状态，不改入参 ---

export function upsertAgent(state: AgentsState, agent: AgentDef): AgentsState {
  const at = state.agents.findIndex((a) => a.id === agent.id)
  const agents = [...state.agents]
  if (at >= 0) agents[at] = agent
  else agents.push(agent)
  return { ...state, agents }
}

export function removeAgent(state: AgentsState, id: string): AgentsState {
  const agents = state.agents.filter((a) => a.id !== id)
  // 绑定跟着清：留着就是悬空绑定，normalize 下次读盘会清，但内存态里还在
  const sessionAgent: Record<string, string> = {}
  for (const [sid, aid] of Object.entries(state.sessionAgent)) {
    if (aid !== id) sessionAgent[sid] = aid
  }
  return { agents, sessionAgent }
}

/** agentId 传 null = 这个会话不用自定义 agent。 */
export function assignAgent(
  state: AgentsState,
  sessionId: string,
  agentId: string | null,
): AgentsState {
  const sessionAgent = { ...state.sessionAgent }
  if (agentId === null) delete sessionAgent[sessionId]
  else sessionAgent[sessionId] = agentId
  return { ...state, sessionAgent }
}

/**
 * 会话被删了，它的 agent 绑定也是垃圾。
 *
 * 没有绑定时返回同一个引用，调用方可以用引用比较跳过写盘
 * （和 projects.ts / providers.ts 的 forgetSession 同一条）。
 */
export function forgetSession(state: AgentsState, sessionId: string): AgentsState {
  if (!(sessionId in state.sessionAgent)) return state
  const sessionAgent = { ...state.sessionAgent }
  delete sessionAgent[sessionId]
  return { ...state, sessionAgent }
}
