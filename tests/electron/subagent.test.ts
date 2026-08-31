import { describe, it, expect } from 'vitest'
import { makeTaskTool, type TaskToolDeps } from '../../electron/main/subagent'
import { CancelToken } from '../../electron/main/cancel'
import { loadConfig } from '../../src/config'
import type { AgentDef } from '../../electron/main/agents'
import type { AgentDeps } from '../../src/agent'
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
  // 主 agent 手里已经有 task 了 —— 子 agent 不该继承它（深度只有一层）
  task: fakeTool('task'),
}

const agents: AgentDef[] = [
  { id: 'a1', name: '审查员', description: '只读代码', systemPrompt: '你只审查' },
  { id: 'a2', name: '只读工', tools: ['read_file'] },
]

/**
 * 造工具，并记录每次派活时子 agent 实际收到了什么。
 * 这是这组测试的观察点 —— 派下去的设定对不对全看这里。
 */
function setup(over: Partial<TaskToolDeps> = {}) {
  const calls: { task: string; deps: AgentDeps }[] = []
  const inner = over.runAgent ?? (async (task: string) => `${task} 的结论`)
  const tool = makeTaskTool({
    agents,
    baseConfig: config,
    baseRegistry: registry,
    buildCallModel: () => async () => ({ text: '', toolCalls: [] }),
    ...over,
    // 包在 ...over **之后**：这样测试换掉 runAgent 时 calls 照样记得下。
    // 放在前面的话会被 over 里那个覆盖掉，calls 永远是空的。
    runAgent: async (task, deps) => {
      calls.push({ task, deps })
      return inner(task, deps)
    },
  })
  return { tool: tool!, calls }
}

describe('task 工具存在与否', () => {
  // 一个「调了必然报错」的工具比没有这个工具更糟 —— 模型会反复重试，
  // 用户以为是网络问题。同 web_search 那条推理
  it('一个子 agent 都没配时返回 null，不给这个工具', () => {
    const tool = makeTaskTool({
      agents: [],
      baseConfig: config,
      baseRegistry: registry,
      buildCallModel: () => async () => ({ text: '', toolCalls: [] }),
    })
    expect(tool).toBeNull()
  })

  it('描述里列出可用的子 agent 和它们的说明', () => {
    const { tool } = setup()
    expect(tool.description).toContain('审查员')
    expect(tool.description).toContain('只读代码')
    expect(tool.description).toContain('只读工')
  })
})

describe('派给子 agent 的设定', () => {
  it('系统提示换成子 agent 的', async () => {
    const { tool, calls } = setup()
    await tool.run({ mode: 'single', agent: '审查员', task: '看一下这段' })
    expect(calls[0].deps.config.systemPrompt).toBe('你只审查')
  })

  // 空字段 = 「不管这一项」，不是「设成空」（同 applyAgent 的约定）
  it('子 agent 没填系统提示时沿用主 agent 那份', async () => {
    const { tool, calls } = setup()
    await tool.run({ mode: 'single', agent: '只读工', task: 'x' })
    expect(calls[0].deps.config.systemPrompt).toBe(config.systemPrompt)
  })

  // ## 独立上下文就是靠这个成立的
  //
  // 不传 history，runAgent 每次调用自己新建 messages 数组 —— 子 agent
  // 看不到主 agent 聊过什么。pi 用 `--no-session` 达到同一个效果。
  it('不传 history —— 子 agent 看不到主对话', async () => {
    const { tool, calls } = setup()
    await tool.run({ mode: 'single', agent: '审查员', task: 'x' })
    expect(calls[0].deps.history).toBeUndefined()
  })

  // ## 深度只有一层
  //
  // 子 agent 拿不到 task，所以它开不出孙子 agent
  it('子 agent 手里没有 task 工具', async () => {
    const { tool, calls } = setup()
    await tool.run({ mode: 'single', agent: '审查员', task: 'x' })
    expect(calls[0].deps.tools.task).toBeUndefined()
  })

  // ## 顺序：先去掉 task，再过白名单
  //
  // 反过来的话，白名单里写了 task 的 agent 会把它加回来 —— 那就能派孙子了
  it('白名单里写了 task 也不会把它加回来', async () => {
    const withTask: AgentDef[] = [{ id: 'x', name: '想派孙子的', tools: ['read_file', 'task'] }]
    const { tool, calls } = setup({ agents: withTask })
    await tool.run({ mode: 'single', agent: '想派孙子的', task: 'x' })
    expect(Object.keys(calls[0].deps.tools)).toEqual(['read_file'])
  })

  it('工具白名单生效', async () => {
    const { tool, calls } = setup()
    await tool.run({ mode: 'single', agent: '只读工', task: 'x' })
    expect(Object.keys(calls[0].deps.tools)).toEqual(['read_file'])
  })

  // 空白名单 = 全部可用，但仍然不含 task
  it('没设白名单时给全部工具（除了 task）', async () => {
    const { tool, calls } = setup()
    await tool.run({ mode: 'single', agent: '审查员', task: 'x' })
    expect(Object.keys(calls[0].deps.tools).sort()).toEqual(['read_file', 'write_file'])
  })

  // ## 这一条是审批不被绕过的保证
  //
  // 传进来的 baseRegistry 是**审批装饰过**的那份（见 builtin.ts 里
  // makeTaskTool 字段的注释）。子 agent 拿到的必须是同一批被装饰的工具，
  // 否则「派个子 agent 去改文件」就是一条绕过审批的旁路。
  it('子 agent 拿到的是传进来那份注册表里的工具对象本身', async () => {
    const { tool, calls } = setup()
    await tool.run({ mode: 'single', agent: '审查员', task: 'x' })
    expect(calls[0].deps.tools.write_file).toBe(registry.write_file)
  })
})

describe('single 模式', () => {
  it('直接给正文，不包一层 JSON', async () => {
    const { tool } = setup()
    expect(await tool.run({ mode: 'single', agent: '审查员', task: '看这段' })).toBe('看这段 的结论')
  })

  it('默认就是 single', async () => {
    const { tool, calls } = setup()
    await tool.run({ agent: '审查员', task: 'x' })
    expect(calls).toHaveLength(1)
  })

  it('缺参数时说清要什么', async () => {
    const { tool } = setup()
    expect(String(await tool.run({ mode: 'single', agent: '审查员' }))).toContain('要给 agent 和 task')
  })

  // 认不出名字时列出可用的 —— 模型下一步能自己改对
  it('agent 名字不认识时列出可用的', async () => {
    const { tool } = setup()
    const out = String(await tool.run({ mode: 'single', agent: '不存在的', task: 'x' }))
    expect(out).toContain('审查员')
    expect(out).toContain('只读工')
  })

  // 一个子任务失败不该让整轮对话挂掉；模型看到原因能自己换做法
  it('子 agent 抛异常时作为失败结果返回，不往外抛', async () => {
    const { tool } = setup({
      runAgent: async () => {
        throw new Error('模型超时')
      },
    })
    const out = String(await tool.run({ mode: 'single', agent: '审查员', task: 'x' }))
    expect(out).toContain('模型超时')
  })
})

describe('parallel 模式', () => {
  it('派多件，结果顺序和入参一致', async () => {
    const { tool } = setup()
    const out = JSON.parse(
      String(
        await tool.run({
          mode: 'parallel',
          tasks: [
            { agent: '审查员', task: '第一件' },
            { agent: '只读工', task: '第二件' },
          ],
        }),
      ),
    ) as { results: { task: string }[] }
    // 乱序会让模型对不上是哪件事
    expect(out.results.map((r) => r.task)).toEqual(['第一件', '第二件'])
  })

  it('并发有上限 —— 每个子 agent 都在烧配额', async () => {
    let running = 0
    let peak = 0
    const { tool } = setup({
      runAgent: async () => {
        running++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 5))
        running--
        return 'ok'
      },
    })
    await tool.run({
      mode: 'parallel',
      tasks: Array.from({ length: 8 }, (_, i) => ({ agent: '审查员', task: `t${i}` })),
    })
    expect(peak).toBeLessThanOrEqual(4)
  })

  it('超过上限时拒绝，让模型拆开派', async () => {
    const { tool } = setup()
    const out = String(
      await tool.run({
        mode: 'parallel',
        tasks: Array.from({ length: 9 }, (_, i) => ({ agent: '审查员', task: `t${i}` })),
      }),
    )
    expect(out).toContain('最多派 8 件')
  })

  it('空列表时说清要什么', async () => {
    const { tool } = setup()
    expect(String(await tool.run({ mode: 'parallel', tasks: [] }))).toContain('非空的 tasks')
  })

  // 一件失败不影响其它几件 —— 那是 parallel 的意义
  it('其中一件失败，其它照常返回', async () => {
    const { tool } = setup({
      runAgent: async (task) => {
        if (task === '会失败的') throw new Error('炸了')
        return '成了'
      },
    })
    const out = JSON.parse(
      String(
        await tool.run({
          mode: 'parallel',
          tasks: [
            { agent: '审查员', task: '会失败的' },
            { agent: '审查员', task: '正常的' },
          ],
        }),
      ),
    ) as { results: { ok: boolean }[] }
    expect(out.results.map((r) => r.ok)).toEqual([false, true])
  })
})

describe('chain 模式', () => {
  // chain 和 parallel 的区别不是快慢而是**信息流**：
  // chain 里第二步能看到第一步的结果
  it('前一步的结论喂给下一步', async () => {
    const { tool, calls } = setup()
    await tool.run({
      mode: 'chain',
      tasks: [
        { agent: '审查员', task: '先查这个' },
        { agent: '只读工', task: '再根据结果做那个' },
      ],
    })
    expect(calls[1].task).toContain('再根据结果做那个')
    expect(calls[1].task).toContain('先查这个 的结论')
  })

  // 拼进 task 文本而不是塞 history：独立上下文是这个设计的前提，
  // 塞 history 会让 chain 退化成「主 agent 自己连着问三遍」
  it('用拼文本传递，不是塞 history', async () => {
    const { tool, calls } = setup()
    await tool.run({
      mode: 'chain',
      tasks: [
        { agent: '审查员', task: '一' },
        { agent: '审查员', task: '二' },
      ],
    })
    expect(calls[1].deps.history).toBeUndefined()
  })

  it('顺序跑，不并发', async () => {
    const order: string[] = []
    const { tool } = setup({
      runAgent: async (task) => {
        order.push(`start:${task.slice(0, 1)}`)
        await new Promise((r) => setTimeout(r, 5))
        order.push(`end:${task.slice(0, 1)}`)
        return 'ok'
      },
    })
    await tool.run({
      mode: 'chain',
      tasks: [
        { agent: '审查员', task: 'A' },
        { agent: '审查员', task: 'B' },
      ],
    })
    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B'])
  })

  // 后面几步都依赖这一步的结论，硬跑下去只是浪费配额
  it('断链就停，并标出来', async () => {
    const { tool, calls } = setup({
      runAgent: async (task) => {
        if (task.startsWith('会失败')) throw new Error('炸了')
        return 'ok'
      },
    })
    const out = JSON.parse(
      String(
        await tool.run({
          mode: 'chain',
          tasks: [
            { agent: '审查员', task: '会失败的第一步' },
            { agent: '审查员', task: '不该跑到的第二步' },
          ],
        }),
      ),
    ) as { results: unknown[]; stoppedEarly: boolean }
    expect(calls).toHaveLength(1)
    expect(out.stoppedEarly).toBe(true)
  })

  it('每条结果带步号', async () => {
    const { tool } = setup()
    const out = JSON.parse(
      String(
        await tool.run({
          mode: 'chain',
          tasks: [
            { agent: '审查员', task: '一' },
            { agent: '审查员', task: '二' },
          ],
        }),
      ),
    ) as { results: { step: number }[] }
    expect(out.results.map((r) => r.step)).toEqual([1, 2])
  })
})

describe('输出上限', () => {
  // 八个子任务的全文一起塞回主 agent 的上下文，主 agent 立刻没余量做汇总 ——
  // 那正是派活想省下的东西
  it('过长的输出被截断，并标 truncated', async () => {
    const { tool } = setup({ runAgent: async () => 'x'.repeat(20_000) })
    const out = JSON.parse(
      String(await tool.run({ mode: 'parallel', tasks: [{ agent: '审查员', task: 't' }] })),
    ) as { results: { output: string; truncated?: boolean }[] }
    expect(out.results[0].output).toHaveLength(8_000)
    expect(out.results[0].truncated).toBe(true)
  })

  it('没超长时不标 truncated', async () => {
    const { tool } = setup()
    const out = JSON.parse(
      String(await tool.run({ mode: 'parallel', tasks: [{ agent: '审查员', task: 't' }] })),
    ) as { results: { truncated?: boolean }[] }
    expect(out.results[0].truncated).toBeUndefined()
  })
})

describe('取消', () => {
  // 用户点停止时，正在跑的子 agent 也要停
  it('主轮被取消后，子 agent 在轮边界停下', async () => {
    const token = new CancelToken()
    token.cancel()
    const { tool } = setup({
      token,
      runAgent: async (_task, deps) => {
        // 真的 runAgent 每轮调一次 onTurn，这里模拟那一次
        deps.onTurn?.({ turn: 1, result: { text: '', toolCalls: [] }, toolResults: [] })
        return '不该走到这儿'
      },
    })
    const out = String(await tool.run({ mode: 'single', agent: '审查员', task: 'x' }))
    expect(out).toContain('已取消')
  })
})
