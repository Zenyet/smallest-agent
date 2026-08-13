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
    },
  }
}

function makeDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  const { emit } = makeEmitter()
  const saved: { id: string; messages: Message[] }[] = []
  return {
    loadConfig: () => config,
    makeSessionStore: () => ({
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
