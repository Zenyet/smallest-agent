// ============================================================================
// subagent.ts —— task 工具：派生子 agent 跑一段子任务
// ----------------------------------------------------------------------------
// 对齐 pi 的 examples/extensions/subagent（1038 行那个）。
//
// ## 和 agents.ts 的分工
//
// agents.ts 是**预设**（这个会话用哪套系统提示和工具）—— 换的是主 agent 自己
// 的设定，没有第二个 agent。
//
// 这个文件是**派生**：主 agent 在一轮之内开一个独立上下文的子 agent 去做一件
// 事，拿到结果再继续。两者共用同一份 AgentDef 数据（名字/系统提示/模型/工具
// 白名单正好是子 agent 需要的全部），但用途不同。
//
// ## 为什么进程内嵌套，而 pi 是 spawn 子进程
//
// pi 起的是自己那个 CLI（`--mode json -p --no-session`），这样拿到的是真进程
// 隔离。我们不这么做，两个原因：
//
//   1. 独立上下文这个语义**不需要**进程 —— runAgent 每次调用都新建一个
//      messages 数组（见 src/agent.ts 开头），子 agent 天然看不到主 agent
//      的历史。pi 的 `--no-session` 要的就是这个效果。
//   2. 起子进程要求 CLI 被打包进 app 并且能在打包环境里被找到。mcp-paths.ts
//      的文件头记着我们在这上面栽过一次（`npx tsx` 打包后必然失败）。
//
// 代价是子 agent 崩溃会影响主进程 —— 所以每个子任务都包在 try 里，
// 失败作为一条结果返回给模型，而不是让整轮对话挂掉。
//
// ## 深度只有一层
//
// 子 agent 拿不到 task 工具，所以它开不出孙子 agent。
//
// 不做「可配置的最大深度」：深度 2 已经很难解释清楚（一个子 agent 又派生了
// 三个,那些孙子的输出该怎么汇总给主 agent?),而实际需求里几乎没有。
// 一层的边界清楚 —— 主 agent 派活,子 agent 干活。
//
// ## 三种模式都建在一个原语上
//
// single / parallel / chain 全都是 runOne 的组合：
//   single    一个 agent 一件事
//   parallel  多件事同时跑（有并发上限），互不看见对方的输出
//   chain     多件事顺序跑，前一步的输出喂给下一步
//
// chain 和 parallel 的区别不是「快慢」而是**信息流**：chain 里第二步能看到
// 第一步的结果，parallel 里看不到。选错了模型会拿不到它需要的上下文。
// ============================================================================

import { runAgent as realRunAgent } from '../../src/agent'
import type { CancelToken } from './cancel'
import { filterTools, type AgentDef } from './agents'
import type { CallModel, Config, Tool, ToolRegistry } from '../../src/types'

/** 一次最多派几件事。再多模型自己也管不住那么多结果。 */
const MAX_TASKS = 8
/** 同时最多跑几个。对齐 pi 的 MAX_CONCURRENCY —— 每个子 agent 都在烧 API 配额。 */
const MAX_CONCURRENCY = 4
/**
 * 每个子任务的输出上限（字符）。
 *
 * 没有上限的话八个子任务的全文一起塞回主 agent 的上下文里，主 agent 立刻
 * 就没有余量做汇总 —— 那正是派活给子 agent 想省下的东西。
 */
const PER_TASK_OUTPUT_CAP = 8_000

export interface SubagentResult {
  agent: string
  task: string
  ok: boolean
  output: string
  /** 输出被截断过。要告诉模型，否则它把残缺当完整（同 fetch_url 那条）。 */
  truncated?: boolean
  /** 第几步。chain 模式下有意义。 */
  step?: number
}

export interface TaskToolDeps {
  /** 有哪些子 agent 可用。停用的调用方负责先滤掉。 */
  agents: AgentDef[]
  /** 主 agent 那份配置。子 agent 在它基础上改系统提示/模型。 */
  baseConfig: Config
  /**
   * 主 agent 那份工具注册表（**已经过审批装饰**）。
   *
   * 传装饰过的：子 agent 写文件同样要审批。传原始注册表会让「派个子 agent
   * 去改文件」成为绕过审批的旁路 —— 那是这一层最容易开出来的洞。
   */
  baseRegistry: ToolRegistry
  buildCallModel: (config: Config, registry: ToolRegistry) => CallModel
  runAgent?: typeof realRunAgent
  /** 主轮的取消令牌。用户点停止时，正在跑的子 agent 也要停。 */
  token?: CancelToken
  /** 子 agent 开始/结束时通知外面（UI 上显示「正在派活给 X」）。 */
  onProgress?: (r: SubagentResult) => void
}

function cap(text: string): { output: string; truncated: boolean } {
  if (text.length <= PER_TASK_OUTPUT_CAP) return { output: text, truncated: false }
  return { output: text.slice(0, PER_TASK_OUTPUT_CAP), truncated: true }
}

/**
 * 跑一个子 agent。
 *
 * **不抛异常** —— 失败作为一条 ok:false 的结果返回。一个子任务失败不该让
 * 整轮对话挂掉，而模型看到「这件事没成，原因是 X」能自己决定要不要换个做法。
 */
async function runOne(
  d: TaskToolDeps,
  agentName: string,
  task: string,
  step?: number,
): Promise<SubagentResult> {
  const agent = d.agents.find((a) => a.name === agentName)
  if (!agent) {
    const available = d.agents.map((a) => a.name).join('、') || '（一个都没配）'
    return {
      agent: agentName,
      task,
      ok: false,
      output: `没有叫「${agentName}」的子 agent。可用的：${available}`,
      step,
    }
  }

  // 子 agent 的工具：先去掉 task 自己（不许再往下派，见文件头），
  // 再过它自己的白名单。
  //
  // 顺序要紧：反过来的话，白名单里写了 task 的 agent 会把它加回来。
  const withoutTask: ToolRegistry = { ...d.baseRegistry }
  delete withoutTask.task
  const tools = filterTools(agent, withoutTask)

  // 系统提示和模型都跟着子 agent 的定义走；没定义的沿用主 agent 那份
  // （空字段 = 「不管这一项」，同 applyAgent 的约定）
  const config: Config = { ...d.baseConfig }
  if (agent.systemPrompt?.trim()) config.systemPrompt = agent.systemPrompt
  if (agent.model?.trim()) config.model = agent.model

  const run = d.runAgent ?? realRunAgent
  try {
    const answer = await run(task, {
      callModel: d.buildCallModel(config, tools),
      tools,
      config,
      // 不传 history：这就是「独立上下文」的全部实现 —— runAgent 每次调用
      // 自己新建 messages 数组，子 agent 看不到主 agent 聊过什么。
      // pi 用 `--no-session` 达到同一个效果。
      onTurn: () => {
        // 用户点了停止就别再往下转了。抛出去被下面的 catch 收成一条结果，
        // 主 agent 会看到「这件事被取消了」。
        //
        // 用 throwIfCancelled() 而不是 isCancelled() —— 后者判断的是
        // 「一个**错误**是不是取消」（顺 cause 链找 Cancelled），
        // 不是「这个令牌取消了没有」。
        d.token?.throwIfCancelled()
      },
    })
    const { output, truncated } = cap(answer)
    const r: SubagentResult = { agent: agentName, task, ok: true, output, step }
    if (truncated) r.truncated = true
    d.onProgress?.(r)
    return r
  } catch (err) {
    const r: SubagentResult = {
      agent: agentName,
      task,
      ok: false,
      output: err instanceof Error ? err.message : String(err),
      step,
    }
    d.onProgress?.(r)
    return r
  }
}

/** 带并发上限地跑一批。保持结果顺序和入参一致 —— 乱序会让模型对不上是哪件事。 */
async function runPool(
  d: TaskToolDeps,
  items: { agent: string; task: string }[],
): Promise<SubagentResult[]> {
  const out: SubagentResult[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await runOne(d, items[i].agent, items[i].task)
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * 造 task 工具。
 *
 * 没有可用子 agent 时返回 null —— 一个「调了必然报错」的工具比没有这个工具
 * 更糟（模型会反复重试，用户以为是网络问题）。同 web_search 那条推理。
 */
export function makeTaskTool(deps: TaskToolDeps): Tool | null {
  if (deps.agents.length === 0) return null

  const names = deps.agents.map((a) => a.name)
  const roster = deps.agents
    .map((a) => `  - ${a.name}${a.description ? `：${a.description}` : ''}`)
    .join('\n')

  return {
    name: 'task',
    description:
      '把一件独立的子任务派给一个子 agent 去做，拿回它的结论。\n' +
      '子 agent 有自己的上下文（看不到当前对话），适合「去查清楚 X」这类\n' +
      '能一句话交代清楚、结论能一段话说完的活。\n' +
      `可用的子 agent：\n${roster}\n` +
      'mode=single 派一件；parallel 同时派多件（互不可见）；' +
      'chain 顺序派、前一步结论喂给下一步。',
    // 不用 zod：这个 schema 里 tasks 是「对象数组」，而注册表里其它工具都是
    // 平铺的标量参数。手写 JSON Schema 比 zod 转出来的更可控。
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['single', 'parallel', 'chain'],
          description: '默认 single',
        },
        agent: { type: 'string', enum: names, description: 'single 模式下派给谁' },
        task: { type: 'string', description: 'single 模式下派什么活' },
        tasks: {
          type: 'array',
          description: 'parallel / chain 模式下的任务列表',
          items: {
            type: 'object',
            properties: {
              agent: { type: 'string', enum: names },
              task: { type: 'string' },
            },
            required: ['agent', 'task'],
          },
        },
      },
    },
    run: async (args: {
      mode?: 'single' | 'parallel' | 'chain'
      agent?: string
      task?: string
      tasks?: { agent: string; task: string }[]
    }) => {
      const mode = args.mode ?? 'single'

      if (mode === 'single') {
        if (!args.agent || !args.task) {
          return 'single 模式要给 agent 和 task 两个参数'
        }
        const r = await runOne(deps, args.agent, args.task)
        // single 只有一条结果，直接给正文 —— 包一层 JSON 只是让模型多剥一层
        return r.ok ? r.output : `子 agent 失败：${r.output}`
      }

      const list = (args.tasks ?? []).filter((t) => t?.agent && t?.task)
      if (list.length === 0) return `${mode} 模式要给非空的 tasks 列表`
      if (list.length > MAX_TASKS) {
        return `一次最多派 ${MAX_TASKS} 件，收到 ${list.length} 件。拆成几次。`
      }

      if (mode === 'parallel') {
        const results = await runPool(deps, list)
        return JSON.stringify({ mode, results }, null, 2)
      }

      // chain：顺序跑，把上一步的结论接在下一步的任务描述后面。
      //
      // 拼进 task 文本而不是塞进子 agent 的 history：子 agent 的独立上下文
      // 是这个设计的前提（见文件头），塞 history 会把它变成「共享上下文」，
      // 那 chain 和「主 agent 自己连着问三遍」就没区别了。
      const results: SubagentResult[] = []
      for (let i = 0; i < list.length; i++) {
        const prev = results[i - 1]
        const task =
          prev && prev.ok
            ? `${list[i].task}\n\n上一步（${prev.agent}）的结论：\n${prev.output}`
            : list[i].task
        const r = await runOne(deps, list[i].agent, task, i + 1)
        results.push(r)
        // 断链就停：后面几步都依赖这一步的结论，硬跑下去只是浪费配额
        if (!r.ok) break
      }
      return JSON.stringify(
        { mode, results, stoppedEarly: results.length < list.length },
        null,
        2,
      )
    },
  }
}
