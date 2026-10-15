import { describe, it, expect, vi } from 'vitest'
import { createAgentRunner, type RunnerDeps } from '../../electron/main/agent-runner'
import { createApprovalGate } from '../../electron/main/approval'
import { loadConfig } from '../../src/config'
import type { Config } from '../../src/types'
import type { AgentDef } from '../../electron/main/agents'
import type { Message } from '../../src/types'
import type { TurnRequest } from '../../electron/main/provider/types'
import { buildEnv } from '../../electron/main/config-env'

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

describe('外部 CLI 认证隔离', () => {
  const withoutKey: RunnerDeps['loadConfig'] = (options) => loadConfig(
    buildEnv({}, {}, { sessionsDir: '/tmp/cli-sessions', cacheDir: '/tmp/cli-cache' }), options,
  )

  it.each(['codex', 'claude-code'])('%s 无内置 API Key 也能完成对话和存盘，不调用内置模型', async (id) => {
    const { events, emit } = makeEmitter()
    const save = vi.fn(async () => {})
    const forDir = vi.fn(async () => { throw new Error('不应启动内置文件工具') })
    const buildCallModel = vi.fn(), makeSummarize = vi.fn(), verify = vi.fn(), makeExtract = vi.fn()
    const runTurn = vi.fn(async (request: TurnRequest) => {
      expect(request.config.apiKey).toBe('')
      expect(request.cwd).toBe('/tmp/project')
      request.emit({ kind: 'delta', text: 'CLI 回答' })
      await request.onComplete([
        ...request.history,
        { role: 'user', content: request.question },
        { role: 'assistant', content: 'CLI 回答' },
      ])
      return { answer: 'CLI 回答', evidence: ['CLI 管理的工具结果'] }
    })
    const runner = createAgentRunner(makeDeps({
      loadConfig: withoutKey, emit, buildCallModel, makeSummarize, verify, makeExtract,
      makeSessionStore: () => ({ load: async () => [], save }),
      resolveProvider: () => ({ id, runTurn }),
      resolveCwd: () => '/tmp/project',
      fsPool: { forDir, disposeAll: async () => {} },
      facts: { getAll: () => [], remember: vi.fn(), forget: vi.fn() },
    }))
    await runner.run('s1', '我一直使用本机订阅登录，希望记住这个偏好')
    expect(runTurn).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('s1', expect.arrayContaining([
      { role: 'assistant', content: 'CLI 回答' },
    ]))
    expect(events.map(e => e.type)).toEqual(['chunk', 'complete'])
    for (const call of [buildCallModel, makeSummarize, verify, makeExtract, forDir]) {
      expect(call).not.toHaveBeenCalled()
    }
  })

  it('切回内置引擎后仍校验 API Key', async () => {
    const { events, emit } = makeEmitter()
    const runTurn = vi.fn(async () => ({ answer: 'ok', evidence: [] }))
    const resolveProvider = vi.fn<NonNullable<RunnerDeps['resolveProvider']>>()
      .mockReturnValueOnce({ id: 'codex', runTurn }).mockReturnValueOnce(null)
    const runner = createAgentRunner(makeDeps({ loadConfig: withoutKey, emit, resolveProvider }))
    await runner.run('s1', 'hello')
    await runner.run('s1', 'hello again')
    expect(runTurn).toHaveBeenCalledTimes(1)
    expect(events.filter(e => e.type === 'error')).toEqual([
      { type: 'error', payload: expect.objectContaining({ code: 'API_KEY_MISSING' }) },
    ])
  })

  it('CLI 登录失败时显示其错误，不回落到内置模型', async () => {
    const { events, emit } = makeEmitter()
    const buildCallModel = vi.fn()
    const runner = createAgentRunner(makeDeps({
      loadConfig: withoutKey, emit, buildCallModel,
      resolveProvider: () => ({ id: 'codex', runTurn: async () => { throw new Error('请运行 codex login') } }),
    }))
    await runner.run('s1', 'hello')
    expect(events).toEqual([{ type: 'error', payload: expect.objectContaining({ message: '请运行 codex login' }) }])
    expect(buildCallModel).not.toHaveBeenCalled()
  })
})

describe('自定义 agent 预设', () => {
  const tools = (): Record<string, { name: string; description: string; parameters: unknown; run: () => Promise<string> }> => ({
    read_file: { name: 'read_file', description: 'd', parameters: undefined, run: async () => '' },
    write_file: { name: 'write_file', description: 'd', parameters: undefined, run: async () => '' },
    web_search: { name: 'web_search', description: 'd', parameters: undefined, run: async () => '' },
  })

  /** 跑一轮，返回 agent 实际拿到的系统提示和工具名 */
  async function ranWith(agent: AgentDef | undefined, nativeSearch?: Config['nativeSearch']) {
    let seenTools: string[] = []
    let seenPrompt = ''
    const runner = createAgentRunner(
      makeDeps({
        loadConfig: () => ({ ...config, ...(nativeSearch ? { nativeSearch } : {}) }),
        registry: tools(),
        resolveAgent: () => agent,
        runAgent: async (_input, agentDeps) => {
          seenTools = Object.keys(agentDeps.tools).sort()
          seenPrompt = agentDeps.config.systemPrompt
          return 'ok'
        },
      }),
    )
    await runner.run('s1', 'q')
    return { seenTools, seenPrompt }
  }

  it('系统提示被换成 agent 的那个', async () => {
    const { seenPrompt } = await ranWith({ id: 'a', name: 'n', systemPrompt: '你只审查代码' })
    expect(seenPrompt).toBe('你只审查代码')
  })

  // 空字段表示「不管这一项」，不是「设成空」—— 清掉全局提示会让模型失去所有指令
  it('agent 没填系统提示时用全局那个', async () => {
    const { seenPrompt } = await ranWith({ id: 'a', name: 'n' })
    expect(seenPrompt).toBe(config.systemPrompt)
    expect(seenPrompt).not.toBe('')
  })

  it('没绑 agent 时行为不变', async () => {
    const { seenPrompt, seenTools } = await ranWith(undefined)
    expect(seenPrompt).toBe(config.systemPrompt)
    expect(seenTools).toEqual(['read_file', 'web_search', 'write_file'])
  })

  it('工具白名单生效，一个只读 agent 拿不到 write_file', async () => {
    const { seenTools } = await ranWith({ id: 'a', name: '只读', tools: ['read_file'] })
    expect(seenTools).toEqual(['read_file'])
  })

  it('空白名单 = 全部可用', async () => {
    const { seenTools } = await ranWith({ id: 'a', name: 'n' })
    expect(seenTools).toEqual(['read_file', 'web_search', 'write_file'])
  })

  // ## 顺序：先撤 web_search，再过白名单
  //
  // 反过来的话，一个白名单里写了 web_search 的 agent 在智谱那种自带搜索的
  // 厂商下会把它加回来 —— 而那个工具此刻不该存在（厂商自带的会重复）。
  it('厂商自带搜索时，白名单里写了 web_search 也不该把它加回来', async () => {
    const { seenTools } = await ranWith(
      { id: 'a', name: 'n', tools: ['read_file', 'web_search'] },
      { kind: 'enable-flag' },
    )
    expect(seenTools).toEqual(['read_file'])
  })
})

describe('厂商自带搜索时撤掉我们的 web_search', () => {
  // 留着两个不是「多一个选择」而是更差：模型会在两条路之间乱挑，
  // 而我们那个在没配 Brave/Tavily 时只能搜维基百科 —— 厂商自带的是全网。
  //
  // 撤的时机是**每轮**而不是启动时：用户能在 composer 上随时换厂商，
  // 从智谱切回 DeepSeek 之后我们的 web_search 得回来。
  const webTools = (): Record<string, { name: string; description: string; parameters: unknown; run: () => Promise<string> }> => ({
    web_search: { name: 'web_search', description: 'd', parameters: undefined, run: async () => '' },
    fetch_url: { name: 'fetch_url', description: 'd', parameters: undefined, run: async () => '' },
  })

  /** 跑一轮，返回 agent 实际拿到的工具名 */
  async function toolsSeenBy(nativeSearch: Config['nativeSearch']) {
    let seen: string[] = []
    const runner = createAgentRunner(
      makeDeps({
        loadConfig: () => ({ ...config, ...(nativeSearch ? { nativeSearch } : {}) }),
        registry: webTools(),
        runAgent: async (_input, agentDeps) => {
          seen = Object.keys(agentDeps.tools).sort()
          return 'ok'
        },
      }),
    )
    await runner.run('s1', 'q')
    return seen
  }

  it('智谱那种（tool-type）撤掉 web_search', async () => {
    expect(await toolsSeenBy({ kind: 'tool-type', toolType: 'web_search' })).toEqual(['fetch_url'])
  })

  it('通义那种（enable-flag）也撤', async () => {
    expect(await toolsSeenBy({ kind: 'enable-flag' })).toEqual(['fetch_url'])
  })

  // fetch_url 不撤：抓具体网址和搜索是两件事，服务端搜索不覆盖
  // 「把这个链接读一下」
  it('不撤 fetch_url', async () => {
    const seen = await toolsSeenBy({ kind: 'enable-flag' })
    expect(seen).toContain('fetch_url')
  })

  it('没有自带搜索的厂商，两个都留着', async () => {
    expect(await toolsSeenBy(undefined)).toEqual(['fetch_url', 'web_search'])
  })

  it('kind==="none" 等于没有', async () => {
    expect(await toolsSeenBy({ kind: 'none' })).toEqual(['fetch_url', 'web_search'])
  })
})

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

  // ## 锁是按会话的，不是全局的
  //
  // 原来这条断言的是「s1 在跑时 s2 被拒 BUSY」。那是全局串行锁的行为，
  // 而它没有正当理由：锁存在的唯一目的是防止会话文件的读-改-写互相覆盖，
  // 而文件本身就是按会话分开的。全局锁的实际后果是用户没法同时问两个问题 ——
  // 一个会话在跑，整个 app 的输入框全禁用。那是设计缺陷，不是限制。
  it('不同会话可以同时跑，不再互相拒绝', async () => {
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
    await new Promise((r) => setTimeout(r, 10))
    const second = runner.run('s2', 'b')
    await new Promise((r) => setTimeout(r, 10))

    // 两轮都真的开跑了
    expect(started).toBe(2)
    expect(events.find((e) => e.type === 'error')).toBeUndefined()
    expect(runner.isBusy('s1')).toBe(true)
    expect(runner.isBusy('s2')).toBe(true)
    expect(runner.runningSessionIds().sort()).toEqual(['s1', 's2'])

    release()
    await Promise.all([first, second])
  })

  // 同一个会话仍然要拒绝：会话文件是读-改-写、整体覆写，
  // 并发两轮会让后写的把前写的盖掉
  it('同一个会话并发时拒绝第二次（文件会互相覆盖）', async () => {
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
    await new Promise((r) => setTimeout(r, 10))
    await runner.run('s1', 'b')

    expect(started).toBe(1)
    expect(events.find((e) => e.type === 'error')?.payload).toMatchObject({
      sessionId: 's1',
      code: 'BUSY',
    })
    release()
    await first
  })

  // 锁必须在 run() 里**同步**拿到。挪进 runTurn 的话，那边第一句 await
  // （sessions.load）之前有一个事件循环空档 —— 同一会话连发两条时两次检查
  // 都会通过，然后两轮并发读-改-写同一个文件。
  it('同一会话同一 tick 连发两条，第二条也被拒（锁是同步拿的）', async () => {
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
    // 不 await，同一 tick 里连发
    const a = runner.run('s1', 'a')
    const b = runner.run('s1', 'b')
    await new Promise((r) => setTimeout(r, 10))

    expect(started).toBe(1)
    expect(events.find((e) => e.type === 'error')?.payload).toMatchObject({ code: 'BUSY' })
    release()
    await Promise.all([a, b])
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
    expect(runner.isBusy('s1')).toBe(false)
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
      // 历史那条来自测试构造的假数据，本来就没有 timestamp
      { role: 'user', content: '上一轮' },
      // 这一轮的提问要带上时刻（取消路径也要打戳，见 runTurn 的 askedAt）
      { role: 'user', content: '这次的提问', timestamp: expect.any(Number) },
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
    expect(runner.isBusy('s1')).toBe(false)
    expect(runner.runningSessionIds()).toEqual([])
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
    await runner.settled('s1')
    await run
    expect(finished).toBe(true)
    expect(runner.isBusy('s1')).toBe(false)
  })

  it('没在跑时 settled() 立刻返回', async () => {
    const runner = createAgentRunner(makeDeps())
    await expect(runner.settled('s1')).resolves.toBeUndefined()
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
