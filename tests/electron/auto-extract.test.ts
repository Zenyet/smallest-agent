import { describe, it, expect } from 'vitest'
import { createAgentRunner, type RunnerDeps } from '../../electron/main/agent-runner'
import { createApprovalGate } from '../../electron/main/approval'
import type { Config, Message } from '../../src/types'
import type { Fact, FactScope } from '../../src/memory/facts'
import type { ExtractedFact } from '../../src/memory/extract'

// ============================================================================
// 自动提取事实：runner 那一侧的接线
//
// 提取器本身（prompt、解析容错）在 tests/extract.test.ts。这一组测的是
// **什么时候该调它、什么时候不该** —— 那几道短路是成本控制的全部，
// 静默失效的话每轮都会多花一次模型调用而没人发现。
// ============================================================================

const config: Config = {
  apiKey: 'k',
  baseURL: 'http://x',
  model: 'm',
  temperature: 0,
  maxTurns: 5,
  systemPrompt: 'sys',
  embeddingModel: 'e',
  notesDir: '/tmp/notes',
  sessionId: 's',
  sessionsDir: '/tmp/sessions',
  maxContextTokens: 8000,
  keepRecent: 4,
  fallbackModel: 'm',
  maxRetries: 0,
  cacheEnabled: false,
  cacheDir: '/tmp/cache',
  stream: false,
}

/** 记录抽取器被调了几次、写进去了什么。 */
function harness(
  opts: {
    extracted?: ExtractedFact[]
    /** 模型这一轮调了哪些工具（用来测「调过 remember 就跳过」） */
    toolsCalled?: string[]
    /** 那些调用的输出。默认 'ok'；给 {"error":...} 就是失败的调用 */
    toolOutput?: string
    cwd?: string
    config?: Partial<Config>
    extractThrows?: boolean
  } = {},
) {
  const written: { key: string; value: string; scope: FactScope }[] = []
  let extractCalls = 0
  let facts: Fact[] = []
  const events: string[] = []

  const deps: RunnerDeps = {
    loadConfig: () => ({ ...config, ...opts.config }),
    makeSessionStore: () => ({ load: async () => [], save: async () => {} }),
    buildCallModel: () => async () => ({ text: '', toolCalls: [] }),
    makeSummarize: () => async () => 'summary',
    verify: async () => ({ grounded: true, issues: [] }),
    runAgent: async (input, agentDeps) => {
      agentDeps.onTurn?.({
        turn: 1,
        result: { text: '', toolCalls: [] },
        toolResults: (opts.toolsCalled ?? []).map((name) => ({
          name,
          args: {},
          output: opts.toolOutput ?? 'ok',
        })),
      })
      await agentDeps.onComplete?.([
        { role: 'user', content: input },
        { role: 'assistant', content: '答案' },
      ])
      return '答案'
    },
    registry: {},
    emit: {
      chunk: () => {},
      toolCall: (e) => events.push(`toolCall:${e.toolName}`),
      complete: () => events.push('complete'),
      verdict: () => {},
      cacheHit: () => {},
      error: (e) => events.push(`error:${e.code}`),
      approvalRequest: () => {},
      cancelled: () => events.push('cancelled'),
    },
    gate: createApprovalGate(),
    facts: {
      getAll: () => facts,
      remember: (input) => {
        written.push({ key: input.key, value: input.value, scope: input.scope })
        facts = [
          ...facts.filter((f) => !(f.key === input.key && f.scope === input.scope)),
          { ...input, updatedAt: Date.now() },
        ]
      },
      forget: () => {},
    },
    makeExtract: () => async () => {
      extractCalls += 1
      if (opts.extractThrows) throw new Error('抽取挂了')
      return opts.extracted ?? []
    },
    ...(opts.cwd ? { resolveCwd: () => opts.cwd } : {}),
  }

  return {
    runner: createAgentRunner(deps),
    written,
    events,
    calls: () => extractCalls,
    facts: () => facts,
  }
}

const LONG = '我最近在用 Rust 写一个命令行工具' // >= 12 字符

describe('什么时候调抽取器', () => {
  it('正常一轮之后调一次', async () => {
    const h = harness()
    await h.runner.run('s1', LONG)
    expect(h.calls()).toBe(1)
  })

  // ## 短路 1：功能关了
  it('AUTO_EXTRACT_FACTS 关掉时不调', async () => {
    const h = harness({ config: { autoExtractFacts: false } })
    await h.runner.run('s1', LONG)
    expect(h.calls()).toBe(0)
  })

  // ## 短路 2：模型已经自己记了
  //
  // 两道保险的意义在这里：模型主动调 remember 是零成本的那一道，
  // 它成功了就不该再花一次调用去抽同一件事
  it('这一轮调过 remember 就跳过', async () => {
    const h = harness({ toolsCalled: ['remember'] })
    await h.runner.run('s1', LONG)
    expect(h.calls()).toBe(0)
  })

  // ## 这一条锁的是「两条路都没记上」那个 bug
  //
  // 实测撞到过：remember 工具不可用，模型调了、拿到
  // `{"error":"unknown tool: remember"}`，而短路只看「调过没」——
  // 于是抽取也被跳过，那条事实两条路都丢了。
  //
  // 短路的判据必须是「成功了」，不是「试过」。
  it('remember 调**失败**时不短路，抽取要接手', async () => {
    const h = harness({
      toolsCalled: ['remember'],
      toolOutput: '{"error":"unknown tool: remember"}',
      extracted: [{ key: 'k', value: '抽取接手记下的', scope: 'global' }],
    })
    await h.runner.run('s1', LONG)
    expect(h.calls()).toBe(1)
    expect(h.written).toHaveLength(1)
  })

  it('调的是别的工具则照常抽', async () => {
    const h = harness({ toolsCalled: ['get_weather'] })
    await h.runner.run('s1', LONG)
    expect(h.calls()).toBe(1)
  })

  // ## 短路 3：太短的消息
  //
  // 「好的」「继续」「谢谢」在真实对话里占很大比例，而它们不可能包含
  // 一条完整事实
  it('太短的用户消息不抽', async () => {
    const h = harness()
    await h.runner.run('s1', '好的')
    await h.runner.run('s1', '继续')
    await h.runner.run('s1', '跑一下测试')
    expect(h.calls()).toBe(0)
  })

  it('刚好到阈值就抽', async () => {
    const h = harness()
    await h.runner.run('s1', '一二三四五六七八九十十一') // 12 字符
    expect(h.calls()).toBe(1)
  })

  it('没有 facts 依赖时不抽（CLI 那条路可能不接记忆）', async () => {
    const h = harness()
    // 手工造一个没有 facts 的 runner
    const noFacts = createAgentRunner({
      loadConfig: () => config,
      makeSessionStore: () => ({ load: async () => [], save: async () => {} }),
      buildCallModel: () => async () => ({ text: '', toolCalls: [] }),
      makeSummarize: () => async () => 's',
      verify: async () => ({ grounded: true, issues: [] }),
      runAgent: async () => '答案',
      registry: {},
      emit: {
        chunk: () => {}, toolCall: () => {}, complete: () => {}, verdict: () => {},
        cacheHit: () => {}, error: () => {}, approvalRequest: () => {}, cancelled: () => {},
      },
      gate: createApprovalGate(),
      makeExtract: () => async () => {
        throw new Error('不该被调到')
      },
    })
    await expect(noFacts.run('s1', LONG)).resolves.toBeUndefined()
    void h
  })
})

describe('抽出来的事实怎么落盘', () => {
  it('写进记忆', async () => {
    const h = harness({
      extracted: [{ key: 'user-location', value: '用户住在深圳', scope: 'global' }],
    })
    await h.runner.run('s1', LONG)
    expect(h.written).toEqual([
      { key: 'user-location', value: '用户住在深圳', scope: 'global' },
    ])
  })

  it('project 作用域落到当前工作目录', async () => {
    const h = harness({
      cwd: '/lab/x',
      extracted: [{ key: 'pkg', value: '这个项目用 pnpm', scope: 'project' }],
    })
    await h.runner.run('s1', LONG)
    expect(h.written[0].scope).toBe('project:/lab/x')
  })

  // 和 remember 工具里同一个决定：作用域偏大好过丢掉这条事实
  it('要 project 但没有工作目录时降级到 global', async () => {
    const h = harness({
      extracted: [{ key: 'pkg', value: '用 pnpm', scope: 'project' }],
    })
    await h.runner.run('s1', LONG)
    expect(h.written[0].scope).toBe('global')
  })

  it('抽到多条就写多条', async () => {
    const h = harness({
      extracted: [
        { key: 'a', value: '事实一', scope: 'global' },
        { key: 'b', value: '事实二', scope: 'global' },
      ],
    })
    await h.runner.run('s1', LONG)
    expect(h.written).toHaveLength(2)
  })

  it('抽到空数组时什么都不写（最常见的情况）', async () => {
    const h = harness({ extracted: [] })
    await h.runner.run('s1', LONG)
    expect(h.written).toHaveLength(0)
  })

  // ## 自动写记忆必须看得见
  //
  // 它在背后改用户的长期记忆，而记错一条会污染之后每一次对话。
  // 不给反馈的话这就是个隐形副作用。
  it('抽到东西时报一个工具调用事件，让用户看得见', async () => {
    const h = harness({
      extracted: [{ key: 'k', value: '用户住在深圳', scope: 'global' }],
    })
    await h.runner.run('s1', LONG)
    expect(h.events).toContain('toolCall:remember')
  })

  it('没抽到东西时不报事件（别拿空卡片刷屏）', async () => {
    const h = harness({ extracted: [] })
    await h.runner.run('s1', LONG)
    expect(h.events.filter((e) => e === 'toolCall:remember')).toHaveLength(0)
  })

  it('已有事实传给抽取器（让它别重复抽）', async () => {
    let seenExisting: readonly Fact[] = []
    const written: unknown[] = []
    let facts: Fact[] = [
      { key: 'user-location', value: '用户住在深圳', scope: 'global', updatedAt: 0 },
    ]
    const runner = createAgentRunner({
      loadConfig: () => config,
      makeSessionStore: () => ({ load: async () => [], save: async () => {} }),
      buildCallModel: () => async () => ({ text: '', toolCalls: [] }),
      makeSummarize: () => async () => 's',
      verify: async () => ({ grounded: true, issues: [] }),
      runAgent: async () => '答案',
      registry: {},
      emit: {
        chunk: () => {}, toolCall: () => {}, complete: () => {}, verdict: () => {},
        cacheHit: () => {}, error: () => {}, approvalRequest: () => {}, cancelled: () => {},
      },
      gate: createApprovalGate(),
      facts: {
        getAll: () => facts,
        remember: (i) => written.push(i),
        forget: () => {},
      },
      makeExtract: () => async ({ existing }) => {
        seenExisting = existing
        return []
      },
    })
    await runner.run('s1', LONG)
    expect(seenExisting.map((f) => f.key)).toEqual(['user-location'])
    void facts
  })
})

describe('失败和取消', () => {
  // 提取是增强，它坏掉不该有任何用户可见的后果
  it('抽取器抛错时静默，不发 error 事件', async () => {
    const h = harness({ extractThrows: true })
    await h.runner.run('s1', LONG)
    expect(h.events.some((e) => e.startsWith('error:'))).toBe(false)
    expect(h.written).toHaveLength(0)
  })

  it('抽取器抛错不影响那一轮的答案', async () => {
    const h = harness({ extractThrows: true })
    await h.runner.run('s1', LONG)
    expect(h.events).toContain('complete')
  })

  // ## isCurrent() 真正防的是什么
  //
  // 我第一版在这里断言「取消之后不写」—— 那是错的，取消**到不了**锁外的
  // 工作：cancel() 第一行就是 `tokens.get(sessionId)`，而抽取开始时
  // finally 已经把 tokens 清空了，所以 cancel 直接返回 false、序号也不推进。
  //
  // 这不是抽取独有的，verify 也一样 —— 锁外的东西一律拦不住。
  //
  // isCurrent() 挡的是另一件事：**同一会话开了新一轮**。那时旧轮的抽取
  // 结果属于一段已经被覆盖的对话（用户可能正是因为答得不对才重问的），
  // 写进去会污染记忆。下面这条测那个。
  //
  // 「取消后那几秒里抽取仍会写一次」是已知的、有界的行为：最多一条，
  // 而且用户在设置的记忆页看得见、能删。要彻底堵住得让 cancel 也能
  // 触达锁外任务（给每轮一个独立的 AbortController），那是另一个改动。
  it('同一会话开了新一轮时，旧轮抽出来的事实不写进记忆', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    const written: unknown[] = []

    const runner = createAgentRunner({
      loadConfig: () => config,
      makeSessionStore: () => ({ load: async () => [], save: async () => {} }),
      buildCallModel: () => async () => ({ text: '', toolCalls: [] }),
      makeSummarize: () => async () => 's',
      verify: async () => ({ grounded: true, issues: [] }),
      runAgent: async () => '答案',
      registry: {},
      emit: {
        chunk: () => {}, toolCall: () => {}, complete: () => {}, verdict: () => {},
        cacheHit: () => {}, error: () => {}, approvalRequest: () => {}, cancelled: () => {},
      },
      gate: createApprovalGate(),
      facts: {
        getAll: () => [],
        remember: (i) => written.push(i),
        forget: () => {},
      },
      // 抽取卡住 —— 模拟「它还在飞的时候用户点了停止」
      makeExtract: () => async () => {
        await held
        return [{ key: 'k', value: '不该被写进去', scope: 'global' as const }]
      },
    })

    const first = runner.run('s1', LONG)
    // 等第一轮进到抽取（此刻锁已经放了）
    await new Promise((r) => setTimeout(r, 20))
    // 用户又问了一句 —— 同一个会话的新一轮，它会把序号推进一格
    await runner.run('s1', '换个问题问问')
    // 现在放开第一轮那个卡住的抽取
    release()
    await first

    // 第一轮的抽取结果被丢掉了（第二轮自己的抽取返回空数组）
    expect(written).toHaveLength(0)
  })
})
