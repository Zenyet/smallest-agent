import { describe, it, expect, vi } from 'vitest'
import { createAgentRunner, type RunnerDeps } from '../../electron/main/agent-runner'
import { createApprovalGate } from '../../electron/main/approval'
import { loadConfig } from '../../src/config'
import type { Message } from '../../src/types'

const config = loadConfig({ DEEPSEEK_API_KEY: 'k' })

// 收集所有发出的事件，断言用
function makeEmitter() {
  const events: { type: string; payload: unknown }[] = []
  const record = (type: string) => (payload: unknown) => events.push({ type, payload })
  return {
    events,
    emit: {
      chunk: record('chunk'),
      toolCall: record('toolCall'),
      complete: record('complete'),
      verdict: record('verdict'),
      cacheHit: record('cacheHit'),
      error: record('error'),
      approvalRequest: record('approvalRequest'),
      cancelled: record('cancelled'),
    },
  }
}

function makeDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  const { emit } = makeEmitter()
  const saved: { id: string; messages: Message[] }[] = []
  return {
    loadConfig: () => config,
    makeSessionStore: (_dir) => ({
      load: async () => [],
      save: async (id, messages) => {
        saved.push({ id, messages })
      },
    }),
    buildCallModel: () => async () => ({ text: '', toolCalls: [] }),
    makeSummarize: () => async () => 'summary',
    verify: async () => ({ grounded: true, issues: [] }),
    runAgent: async (input, agentDeps) => {
      agentDeps.onTurn?.({
        turn: 1,
        result: { text: '', toolCalls: [] },
        toolResults: [{ name: 'get_weather', args: { city: '北京' }, output: '{"t":25}' }],
      })
      await agentDeps.onComplete?.([
        { role: 'system', content: 'sys' },
        { role: 'user', content: input },
        { role: 'assistant', content: '答案' },
      ])
      return '答案'
    },
    registry: {},
    emit,
    gate: createApprovalGate(),
    ...overrides,
  }
}

describe('createAgentRunner', () => {
  it('跑完发出 complete 事件，带完整答案', async () => {
    const { events, emit } = makeEmitter()
    const runner = createAgentRunner(makeDeps({ emit }))
    await runner.run('s1', '天气')
    expect(events.filter((e) => e.type === 'complete')).toEqual([
      { type: 'complete', payload: { sessionId: 's1', text: '答案' } },
    ])
  })

  it('每个工具结果发一个 toolCall 事件', async () => {
    const { events, emit } = makeEmitter()
    const runner = createAgentRunner(makeDeps({ emit }))
    await runner.run('s1', '天气')
    const calls = events.filter((e) => e.type === 'toolCall')
    expect(calls).toHaveLength(1)
    expect(calls[0].payload).toMatchObject({ sessionId: 's1', turn: 1, toolName: 'get_weather' })
  })

  it('有工具证据时做 LLM-as-Judge 核查并发 verdict', async () => {
    const { events, emit } = makeEmitter()
    const runner = createAgentRunner(makeDeps({ emit }))
    await runner.run('s1', '天气')
    expect(events.some((e) => e.type === 'verdict')).toBe(true)
  })

  it('没有工具证据时不做核查（纯聊天没必要花这次调用）', async () => {
    const { events, emit } = makeEmitter()
    const runner = createAgentRunner(
      makeDeps({
        emit,
        runAgent: async (_input, agentDeps) => {
          agentDeps.onTurn?.({ turn: 1, result: { text: 'hi', toolCalls: [] }, toolResults: [] })
          return 'hi'
        },
      }),
    )
    await runner.run('s1', '你好')
    expect(events.some((e) => e.type === 'verdict')).toBe(false)
  })

  it('存会话时过滤掉 system 消息（system prompt 由 config 决定，不进历史）', async () => {
    const saved: Message[][] = []
    const runner = createAgentRunner(
      makeDeps({
        makeSessionStore: () => ({
          load: async () => [],
          save: async (_id, messages) => {
            saved.push(messages)
          },
        }),
      }),
    )
    await runner.run('s1', '天气')
    expect(saved[0].some((m) => m.role === 'system')).toBe(false)
    expect(saved[0]).toHaveLength(2)
  })

  it('串行锁：已有任务在跑时再 run，发 BUSY 错误且不启动第二次', async () => {
    const { events, emit } = makeEmitter()
    let started = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const runner = createAgentRunner(
      makeDeps({
        emit,
        runAgent: async () => {
          started++
          await gate
          return 'done'
        },
      }),
    )
    const first = runner.run('s1', 'a')
    // 等一小会儿，让第一个 run 真正进入 runAgent 并阻塞在 gate 上
    await new Promise((r) => setTimeout(r, 10))
    await runner.run('s2', 'b') // 第二次应立刻被拒
    expect(started).toBe(1)
    expect(events.find((e) => e.type === 'error')?.payload).toMatchObject({
      sessionId: 's2',
      code: 'BUSY',
    })
    release()
    await first
  })

  it('runAgent 抛错时发映射后的错误码，并释放锁', async () => {
    const { events, emit } = makeEmitter()
    let calls = 0
    const runner = createAgentRunner(
      makeDeps({
        emit,
        runAgent: async () => {
          calls++
          if (calls === 1) throw new Error('Agent exceeded maxTurns (10) without finishing')
          return 'ok'
        },
      }),
    )
    await runner.run('s1', 'a')
    expect(events.find((e) => e.type === 'error')?.payload).toMatchObject({ code: 'MAX_TURNS' })
    expect(runner.isBusy()).toBe(false)
    await runner.run('s1', 'b') // 锁已释放，能再跑
    expect(calls).toBe(2)
  })

  it('toolCall 事件带上这一轮的耗时（elapsedMs 是数字）', async () => {
    const { events, emit } = makeEmitter()
    const runner = createAgentRunner(makeDeps({ emit }))
    await runner.run('s1', '天气')
    const call = events.find((e) => e.type === 'toolCall')
    expect(call?.payload).toMatchObject({ elapsedMs: expect.any(Number) })
    expect((call!.payload as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('写工具的调用会先经过审批闸口再真正执行——deny 时不落到 registry.run', async () => {
    const { events, emit } = makeEmitter()
    let ran = false
    const gate = createApprovalGate()
    const runner = createAgentRunner(
      makeDeps({
        emit,
        gate,
        registry: {
          write_file: {
            name: 'write_file',
            description: '',
            parameters: { type: 'object', properties: {} },
            run: async () => {
              ran = true
              return 'ok'
            },
          },
        },
        runAgent: async (_input, agentDeps) => {
          const result = await agentDeps.tools.write_file.run({ path: 'a.txt', content: 'x' })
          agentDeps.onTurn?.({
            turn: 1,
            result: { text: '', toolCalls: [] },
            toolResults: [{ name: 'write_file', args: {}, output: JSON.stringify(result) }],
          })
          return 'done'
        },
      }),
    )

    const run = runner.run('s1', '写个文件')
    // guardRegistry 先注册等待再 emit，所以 pending() 迟早能看到这条请求；
    // 但 run() 内部到 runAgent 之间还有几个 await（load session 等），
    // 不能假设它在这一次 microtask 里就已经跑到 tool.run，所以用 waitFor 轮询。
    const [pending] = await vi.waitFor(() => {
      const p = gate.pending()
      if (p.length === 0) throw new Error('还没排上审批队列')
      return p
    })
    expect(pending).toMatchObject({ sessionId: 's1', toolName: 'write_file' })
    gate.resolve(pending.requestId, 'deny')
    await run

    expect(ran).toBe(false)
    expect(events.find((e) => e.type === 'approvalRequest')?.payload).toMatchObject({
      sessionId: 's1',
      toolName: 'write_file',
    })
  })
})

// 取消（轮边界）。机制见 electron/main/cancel.ts 的文件头：callModel 是
// 注入的，包一层就能让 ReAct 循环在下一轮入口停下，src/ 一行不改。
describe('createAgentRunner 的取消', () => {
  // 模拟一个「会转好几轮」的 agent：每轮都调 callModel，所以取消能在轮边界生效。
  // 真实的 runAgent 就是这个形状（src/agent.ts:51-81 的 for 循环）。
  function multiTurnRunAgent(turns = 5): RunnerDeps['runAgent'] {
    return async (input, agentDeps) => {
      for (let t = 1; t <= turns; t++) {
        // runAgent 不捕获 callModel 的抛错 —— 这是取消能生效的前提
        await agentDeps.callModel([{ role: 'user', content: input }])
      }
      return '答案'
    }
  }

  it('取消后发 cancelled 事件，不发 error', async () => {
    const { events, emit } = makeEmitter()
    const runner = createAgentRunner(
      makeDeps({
        emit,
        runAgent: async (input, agentDeps) => {
          // 第一轮正常，然后外部取消，第二轮入口就该抛
          await agentDeps.callModel([{ role: 'user', content: input }])
          runner.cancel('s1')
          await agentDeps.callModel([{ role: 'user', content: input }])
          return '不该走到这里'
        },
      }),
    )
    await runner.run('s1', '很长的活')

    expect(events.filter((e) => e.type === 'cancelled')).toEqual([
      { type: 'cancelled', payload: { sessionId: 's1' } },
    ])
    // 关键：取消不是错误。走 error 通道会让前端渲染成红色报错，
    // 用户以为自己的操作出了问题
    expect(events.some((e) => e.type === 'error')).toBe(false)
    // 也不该发 complete —— 那一轮没有答案
    expect(events.some((e) => e.type === 'complete')).toBe(false)
  })

  it('取消路径上存盘（保住用户这次的提问）', async () => {
    const saved: { id: string; messages: Message[] }[] = []
    const runner = createAgentRunner(
      makeDeps({
        makeSessionStore: () => ({
          load: async () => [{ role: 'user', content: '上一轮' } as Message],
          save: async (id, messages) => {
            saved.push({ id, messages })
          },
        }),
        runAgent: async (input, agentDeps) => {
          runner.cancel('s1')
          await agentDeps.callModel([{ role: 'user', content: input }])
          return '不该走到这里'
        },
      }),
    )
    await runner.run('s1', '这次的提问')

    expect(saved).toHaveLength(1)
    expect(saved[0].messages).toEqual([
      { role: 'user', content: '上一轮' },
      { role: 'user', content: '这次的提问' },
    ])
  })

  it('真错误不被当成取消', async () => {
    const { events, emit } = makeEmitter()
    const runner = createAgentRunner(
      makeDeps({
        emit,
        runAgent: async () => {
          throw new Error('fetch failed')
        },
      }),
    )
    await runner.run('s1', '天气')

    expect(events.some((e) => e.type === 'cancelled')).toBe(false)
    expect(events.find((e) => e.type === 'error')?.payload).toMatchObject({
      sessionId: 's1',
      code: 'MODEL_ERROR',
    })
  })

  it('取消后释放串行锁', async () => {
    const runner = createAgentRunner(
      makeDeps({
        runAgent: async (input, agentDeps) => {
          runner.cancel('s1')
          await agentDeps.callModel([{ role: 'user', content: input }])
          return '不该走到这里'
        },
      }),
    )
    await runner.run('s1', '活')
    expect(runner.isBusy()).toBe(false)
    expect(runner.runningSessionId()).toBeNull()
  })

  it('取消没在跑的会话返回 false，不抛', () => {
    const runner = createAgentRunner(makeDeps())
    expect(runner.cancel('s1')).toBe(false)
  })

  // 用户在 A 会话点停止，不该把 B 会话正在跑的那轮停掉
  it('只取消正在跑的那个会话', async () => {
    const { events, emit } = makeEmitter()
    const accepted: boolean[] = []
    const runner = createAgentRunner(
      makeDeps({
        emit,
        runAgent: async (input, agentDeps) => {
          accepted.push(runner.cancel('别的会话'))
          await agentDeps.callModel([{ role: 'user', content: input }])
          return '答案'
        },
      }),
    )
    await runner.run('s1', '活')

    expect(accepted).toEqual([false])
    expect(events.some((e) => e.type === 'cancelled')).toBe(false)
    expect(events.some((e) => e.type === 'complete')).toBe(true)
  })

  it('取消是一次性的：下一轮不受上一轮影响', async () => {
    const { events, emit } = makeEmitter()
    let firstRun = true
    const runner = createAgentRunner(
      makeDeps({
        emit,
        runAgent: async (input, agentDeps) => {
          if (firstRun) {
            firstRun = false
            runner.cancel('s1')
          }
          await agentDeps.callModel([{ role: 'user', content: input }])
          return '答案'
        },
      }),
    )
    await runner.run('s1', '第一次')
    await runner.run('s1', '第二次')

    // 第一次被取消，第二次必须正常跑完 —— 令牌复用会让取消泄漏到下一轮
    expect(events.filter((e) => e.type === 'cancelled')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'complete')).toHaveLength(1)
  })

  it('settled() 等到那一轮真的结束', async () => {
    let finished = false
    const runner = createAgentRunner(
      makeDeps({
        runAgent: multiTurnRunAgent(3),
        buildCallModel: () => async () => {
          await new Promise((r) => setTimeout(r, 1))
          return { text: '', toolCalls: [] }
        },
      }),
    )
    const run = runner.run('s1', '活').then(() => {
      finished = true
    })
    // settled() 拿到的是同一个 promise，await 它之后那一轮必须已经收尾
    await runner.settled()
    await run
    expect(finished).toBe(true)
    expect(runner.isBusy()).toBe(false)
  })

  it('没在跑时 settled() 立刻返回', async () => {
    const runner = createAgentRunner(makeDeps())
    await expect(runner.settled()).resolves.toBeUndefined()
  })

  it('多轮 agent 在下一轮入口停下，不跑完所有轮', async () => {
    const calls: number[] = []
    const runner = createAgentRunner(
      makeDeps({
        runAgent: async (input, agentDeps) => {
          for (let t = 1; t <= 5; t++) {
            calls.push(t)
            if (t === 2) runner.cancel('s1')
            await agentDeps.callModel([{ role: 'user', content: input }])
          }
          return '答案'
        },
      }),
    )
    await runner.run('s1', '活')

    // 第 2 轮里先调了 cancel，紧接着那次 callModel 就被拦下 —— 所以停在 2，
    // 剩下的 3/4/5 轮一次都没进。这也说明取消是「下一次 callModel」生效，
    // 而不是「下一次循环迭代」
    expect(calls).toEqual([1, 2])
  })
})
