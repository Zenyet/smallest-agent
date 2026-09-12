import { describe, it, expect, beforeEach } from 'vitest'
import { createAgentRunner, type AgentEmitter, type RunnerDeps } from '../../electron/main/agent-runner'
import { buildCallModel } from '../../electron/main/call-model'
import { CancelToken, Cancelled } from '../../electron/main/cancel'
import { runAgent } from '../../src/agent'
import { truncateAtNthUser } from '../../electron/main/truncate'
import type { Config, Message, ModelResult } from '../../src/types'

// ============================================================================
// 端到端：从 runner.cancel() 到那次 fetch 真的被中断
//
// 前三轮我修了三个地方（循环里查取消、AbortSignal 一路传、中止不重试），
// 每次都只测了**那一层**，从没验证过整条链接起来是通的。而用户三次都说
// 「依旧不行」—— 说明我在逐层打补丁，没有一次真正跟着请求走一遍。
//
// 这一组从 runner 的公开 API 出发，用一个「会挂住直到 signal 被 abort 的
// 假 fetch」当终点，验证取消能穿过：
//
//   runner.cancel(id) → token.cancel() → signal.abort() → fetch 中断
//                     → AbortError → isCancelled() → emit.cancelled
//
// 任何一层断了这组都会失败。
// ============================================================================

function fakeConfig(over: Partial<Config> = {}): Config {
  return {
    apiKey: 'k',
    baseURL: 'http://127.0.0.1:1/v1', // 不会被真的连上 —— fetch 是注入的假的
    model: 'm',
    temperature: 0,
    maxTurns: 5,
    systemPrompt: 'sys',
    embeddingModel: 'e',
    notesDir: '/tmp/notes',
    sessionId: 's',
    sessionsDir: '/tmp/sessions',
    maxContextTokens: 1000,
    keepRecent: 4,
    fallbackModel: 'm', // 和主模型相同 → 不套 withFallback
    maxRetries: 0,
    cacheEnabled: false,
    cacheDir: '/tmp/cache',
    stream: false,
    ...over,
  }
}

function collector() {
  const events: string[] = []
  const emit: AgentEmitter = {
    chunk: () => events.push('chunk'),
    toolCall: () => events.push('toolCall'),
    complete: () => events.push('complete'),
    verdict: () => events.push('verdict'),
    cacheHit: () => events.push('cacheHit'),
    error: (e) => events.push(`error:${e.code}`),
    approvalRequest: () => events.push('approvalRequest'),
    cancelled: () => events.push('cancelled'),
  }
  return { events, emit }
}

function makeDeps(over: Partial<RunnerDeps> = {}): RunnerDeps {
  const { emit } = collector()
  return {
    loadConfig: fakeConfig,
    makeSessionStore: () => ({ load: async () => [] as Message[], save: async () => {} }),
    buildCallModel: () => async () => ({ text: 'ok', toolCalls: [] }),
    makeSummarize: () => async () => 'summary',
    verify: async () => ({ grounded: true, issues: [] }),
    runAgent,
    registry: {},
    emit,
    gate: {
      request: async () => 'allow',
      pending: () => [],
      settle: () => {},
      cancelSession: () => {},
    } as unknown as RunnerDeps['gate'],
    ...over,
  }
}

describe('取消能穿透到 HTTP 层', () => {
  // ## 这是最接近真实的一条：请求已经在飞，用户点停止
  //
  // 假 fetch 返回一个「除了被 abort 之外永不 resolve」的 promise ——
  // 真实场景里那是「模型正在慢慢生成」。如果 signal 没传到这儿，
  // 这个测试会超时（而不是失败），那本身就是症状。
  it('请求飞在半空时 cancel()，那次 fetch 被 abort', async () => {
    let sawSignal: AbortSignal | undefined
    let fetchStarted!: () => void
    const started = new Promise<void>((r) => {
      fetchStarted = r
    })

    // 挂住的假 fetch：只在 signal abort 时才 reject
    const hangingFetch = (_url: unknown, init?: { signal?: AbortSignal }) => {
      sawSignal = init?.signal
      fetchStarted()
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal
        if (!sig) return // 没给 signal → 永远挂住，测试会超时（就是那个 bug）
        if (sig.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          return
        }
        sig.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    }

    const { events, emit } = collector()
    const runner = createAgentRunner(
      makeDeps({
        emit,
        // 走真实的 buildCallModel（含 retry/cache/fallback 装配）+ 真实的
        // makeCallModel（含 SDK）—— 只把最底下的 fetch 换成假的。
        // 这样测的是**真实的那条链**，不是我自己拼的一条。
        buildCallModel: (config, registry, onText, onCacheHit) =>
          buildCallModel({ ...config, fetch: hangingFetch as typeof fetch }, registry, onText, onCacheHit),
      }),
    )

    const turn = runner.run('s1', 'hi')
    await started

    // 请求已经发出去了，signal 也到了这一层
    expect(sawSignal).toBeInstanceOf(AbortSignal)
    expect(sawSignal!.aborted).toBe(false)

    // 用户点停止
    expect(runner.cancel('s1')).toBe(true)

    await turn

    // signal 被 abort 了 —— 那次请求真的断了，不是等它自己跑完
    expect(sawSignal!.aborted).toBe(true)
    // 而且走的是取消分支，不是红色报错
    expect(events).toContain('cancelled')
    expect(events.some((e) => e.startsWith('error:'))).toBe(false)
  })

  // 锁要在取消后释放，否则这个会话再也发不出消息（永久 BUSY）
  it('取消之后锁释放了，能立刻再发', async () => {
    const abortingFetch = (_u: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_res, rej) => {
        const sig = init?.signal
        sig?.addEventListener('abort', () =>
          rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        )
      })

    const { emit } = collector()
    const runner = createAgentRunner(
      makeDeps({
        emit,
        buildCallModel: (config, registry, onText, onCacheHit) =>
          buildCallModel({ ...config, fetch: abortingFetch as typeof fetch }, registry, onText, onCacheHit),
      }),
    )

    const first = runner.run('s1', 'hi')
    // 等它进到 fetch
    await new Promise((r) => setTimeout(r, 30))
    runner.cancel('s1')
    await first

    expect(runner.isBusy('s1')).toBe(false)
    expect(runner.runningSessionIds()).toEqual([])
  })

  // cancel() 对没在跑的会话返回 false —— 前端据此判断「这次点击有没有被受理」
  it('取消没在跑的会话返回 false', () => {
    const runner = createAgentRunner(makeDeps())
    expect(runner.cancel('nobody')).toBe(false)
  })
})

// ============================================================================
// 「点了就停」—— 用户报了四轮的那个 bug
//
// 实测日志：用户点了 11 次停止，那一轮才终于抛出来。全程界面显示
// 「Agent 正在处理」，所以他说「停止按钮等同摆设」。他没说错。
//
// 前三轮我一直在往「缩短延迟」上打补丁（循环里查取消、AbortSignal、
// 中止不重试）。方向错了：这一轮的执行权此刻在 SDK/undici 手里，
// 什么时候回来看我们的取消请求不由我们决定 —— 延迟只能缩短，消除不了。
//
// 现在换成：**不缩短延迟，而是让延迟不可见**。cancel() 同步宣布这一轮
// 死亡（释放锁 + 发事件），那个还在飘的请求成为孤儿，之后它说什么都被丢掉。
// ============================================================================
describe('点了就停', () => {
  /** 一个永不结束的 fetch —— 模拟「模型正在慢慢生成」。 */
  const neverEnds = () => new Promise<Response>(() => {})

  function stuckRunner() {
    const { events, emit } = collector()
    const runner = createAgentRunner(
      makeDeps({
        emit,
        buildCallModel: (config, registry, onText, onCacheHit) =>
          buildCallModel({ ...config, fetch: neverEnds as typeof fetch }, registry, onText, onCacheHit),
      }),
    )
    return { runner, events }
  }

  it('cancel() 同步发出 cancelled 事件，不等那一轮收尾', async () => {
    const { runner, events } = stuckRunner()
    void runner.run('s1', 'hi')
    await new Promise((r) => setTimeout(r, 30))

    // 那一轮此刻卡在一个永不返回的 fetch 里
    expect(runner.isBusy('s1')).toBe(true)
    expect(events).not.toContain('cancelled')

    runner.cancel('s1')

    // 关键：**同步**就发了，没有 await
    expect(events).toContain('cancelled')
  })

  it('cancel() 同步释放锁 —— 立刻能重新提问', async () => {
    const { runner } = stuckRunner()
    void runner.run('s1', 'hi')
    await new Promise((r) => setTimeout(r, 30))

    runner.cancel('s1')

    // 锁当场就放了。原来要等那一轮抛出，用户点完停止发新消息会吃 BUSY
    expect(runner.isBusy('s1')).toBe(false)
    expect(runner.runningSessionIds()).toEqual([])
  })

  it('取消后立刻发新消息，不吃 BUSY', async () => {
    const { runner, events } = stuckRunner()
    void runner.run('s1', 'a')
    await new Promise((r) => setTimeout(r, 30))
    runner.cancel('s1')
    void runner.run('s1', 'b')
    await new Promise((r) => setTimeout(r, 30))

    expect(events).not.toContain('error:BUSY')
  })

  // ## 孤儿必须闭嘴
  //
  // 那个被放弃的请求可能几秒后才回来。它再发 complete 会把 running 重新
  // 点亮 —— 用户点了停止、界面恢复了，几秒后又冒出一条完整回答。
  it('孤儿轮次回来后不再发 complete', async () => {
    const { events, emit } = collector()
    let release!: (r: Response) => void
    const held = new Promise<Response>((r) => {
      release = r
    })

    const runner = createAgentRunner(
      makeDeps({
        emit,
        buildCallModel: (config, registry, onText, onCacheHit) =>
          buildCallModel({ ...config, fetch: (() => held) as typeof fetch }, registry, onText, onCacheHit),
      }),
    )

    const turn = runner.run('s1', 'hi')
    await new Promise((r) => setTimeout(r, 30))
    runner.cancel('s1')
    expect(events).toContain('cancelled')

    // 现在那个请求「回来了」（返回一个合法响应）
    release(
      new Response(
        JSON.stringify({
          id: '1',
          object: 'chat.completion',
          created: 0,
          model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: '迟到的答案' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    await turn

    // 那条迟到的答案被丢掉了 —— 只有一次 cancelled，没有 complete
    expect(events).not.toContain('complete')
    expect(events.filter((e) => e === 'cancelled')).toHaveLength(1)
  })

  it('孤儿轮次抛错也不报错（用户已经放弃它了）', async () => {
    const { events, emit } = collector()
    let boom!: (e: Error) => void
    const held = new Promise<Response>((_r, rej) => {
      boom = rej
    })

    const runner = createAgentRunner(
      makeDeps({
        emit,
        buildCallModel: (config, registry, onText, onCacheHit) =>
          buildCallModel({ ...config, fetch: (() => held) as typeof fetch }, registry, onText, onCacheHit),
      }),
    )

    const turn = runner.run('s1', 'hi')
    await new Promise((r) => setTimeout(r, 30))
    runner.cancel('s1')

    boom(new Error('网络挂了'))
    await turn

    // 不给红色报错 —— 那会让用户以为「停止」把什么弄坏了
    expect(events.some((e) => e.startsWith('error:'))).toBe(false)
  })

  // 重复点击是幂等的：第一次之后那个会话已经不在 running 里了
  it('连点多次只发一次 cancelled', async () => {
    const { runner, events } = stuckRunner()
    void runner.run('s1', 'hi')
    await new Promise((r) => setTimeout(r, 30))

    expect(runner.cancel('s1')).toBe(true)
    expect(runner.cancel('s1')).toBe(false)
    expect(runner.cancel('s1')).toBe(false)

    expect(events.filter((e) => e === 'cancelled')).toHaveLength(1)
  })

  // 取消 A 不能碰 B —— 锁是按会话的
  it('取消一个会话不影响另一个', async () => {
    const { runner } = stuckRunner()
    void runner.run('s1', 'a')
    void runner.run('s2', 'b')
    await new Promise((r) => setTimeout(r, 30))

    runner.cancel('s1')

    expect(runner.isBusy('s1')).toBe(false)
    expect(runner.isBusy('s2')).toBe(true)
  })
})

// ============================================================================
// 取消的那一轮要完整落盘
//
// 用户报的两个问题，根子是同一个：
//  1. 历史里的中断对话，刷新后只剩用户提问，流出来的半截回答凭空消失
//  2. 连续取消好几轮后编辑重发，后面的提问被覆盖删除 —— 因为中断的轮次
//     在磁盘上缺失，界面上的 user 计数和磁盘上的对不上
// ============================================================================
describe('取消的那一轮完整落盘', () => {
  /** 提取保存在磁盘上的这一次对话。 */
  let disk: Message[] = []
  const memoryStore = () => ({
    load: async () => disk,
    save: async (id: string, m: Message[]) => {
      disk = m
    },
  })

  /** 一个会先吐几个 chunk、然后永远挂住的 provider。 */
  function streamingThenStuck(runnerDepsOver: Partial<RunnerDeps> = {}) {
    const { events, emit } = collector()
    const runner = createAgentRunner({
      ...makeDeps({ emit, makeSessionStore: memoryStore, ...runnerDepsOver }),
    })
    return { runner, events }
  }

  beforeEach(() => {
    disk = []
  })

  it('取消后，流出来的半截回答进了历史（不只是用户提问）', async () => {
    const { runner } = streamingThenStuck({
      // 真实的 runAgent：先在 turn 1 产出工具轨迹，再在 turn 2 流半截字
      runAgent: (async (input: string, d: any) => {
        void input
        // 产出一个工具轨迹
        d.onTurn?.({
          turn: 1,
          toolResults: [{ name: 'web_search', args: { q: 'x' }, output: 'o' }],
          text: '',
        })
        // 流两个字然后永远挂住
        d.callModel = async () => new Promise<ModelResult>(() => {})
        throw new Cancelled()
      }) as RunnerDeps['runAgent'],
      buildCallModel: (_c, _r, onText, _h) => {
        // 让 callModel 吐出两个 delta
        onText('半截回')
        onText('答')
        return async () => ({ text: '', toolCalls: [] })
      },
    })

    void runner.run('s1', '查一下北京')
    await new Promise((r) => setTimeout(r, 30))

    // 磁盘上有：user 提问 + 半截回答（带「已停止」标记）
    const texts = disk.map((m) => `${m.role}:${m.content}`)
    expect(texts.some((t) => t.startsWith('user:查一下北京'))).toBe(true)
    expect(texts.some((t) => t.includes('半截回答') && t.includes('已停止'))).toBe(true)
  })

  it('取消前调过工具的话，工具轨迹也在历史里（hydrate 能还原）', async () => {
    const { runner } = streamingThenStuck({
      runAgent: (async (_in: string, d: any) => {
        d.onTurn?.({
          turn: 1,
          toolResults: [{ name: 'web_search', args: { q: 'x' }, output: '结果' }],
          text: '',
        })
        throw new Cancelled()
      }) as RunnerDeps['runAgent'],
    })

    void runner.run('s1', '查一下')
    await new Promise((r) => setTimeout(r, 30))

    const roles = disk.map((m) => m.role)
    // user → assistant(带toolCalls) → tool → 半截assistant
    expect(roles).toContain('tool')
    const toolMsg = disk.find((m) => m.role === 'tool')
    expect(toolMsg?.name).toBe('web_search')
    expect(toolMsg?.content).toBe('结果')
  })

  it('连续取消几轮再编辑重发，后面的轮次不丢', async () => {
    const { runner, events } = streamingThenStuck({
      runAgent: (async (_in: string, d: any) => {
        d.onTurn?.({ turn: 1, toolResults: [], text: '' })
        throw new Cancelled()
      }) as RunnerDeps['runAgent'],
    })

    // 连续 3 轮，每轮发出去、流半截字、停止
    for (const q of ['第一问', '第二问', '第三问']) {
      const turn = runner.run('s1', q)
      await new Promise((r) => setTimeout(r, 20))
      runner.cancel('s1')
      await turn
      events.length = 0
    }

    // 磁盘上应该有 3 条 user（每轮都落盘了）
    const userCount = disk.filter((m) => m.role === 'user').length
    expect(userCount).toBe(3)

    // 编辑重发「第二问」（nthUser = 1）：砍到第 1 条 user 之前
    const truncated = truncateAtNthUser(disk, 1)
    // 剩 [第一问] —— 第三问被砍掉了（这是编辑重发的正确语义：
    // 编辑中段 = 从这里重来，它后面的历史全作废）
    expect(truncated.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['第一问'])
  })

  it('同一条中断只落盘一次（连点停止不重复追加）', async () => {
    const { runner } = streamingThenStuck({
      runAgent: (async (_in: string) => {
        throw new Cancelled()
      }) as RunnerDeps['runAgent'],
    })

    const turn = runner.run('s1', 'q')
    await new Promise((r) => setTimeout(r, 20))
    runner.cancel('s1')
    runner.cancel('s1') // 第二次返回 false，不再做事
    await turn

    const userCount = disk.filter((m) => m.role === 'user').length
    expect(userCount).toBe(1)
  })
})
