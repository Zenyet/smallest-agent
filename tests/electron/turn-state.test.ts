import { describe, it, expect, vi } from 'vitest'
import { createAgentRunner, type AgentEmitter, type RunnerDeps } from '../../electron/main/agent-runner'
import { chatReducer, emptySession, type ChatState } from '../../electron/renderer/src/chat-reducer'
import type { Config, Message } from '../../src/types'

// ============================================================================
// 这一组锁的是「一轮请求的状态什么时候算结束」。
//
// 症状（用户报的）：发出提问、AI 正在回、切到别的会话，然后状态错乱 ——
// 那一轮明明答完了，界面还说「上一个问题还在处理中」。
//
// 根因不是一个，是三个独立的时序缺陷叠在一起。每个都在下面单独钉住。
// ============================================================================

function fakeConfig(): Config {
  return {
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
    maxContextTokens: 1000,
    keepRecent: 4,
    fallbackModel: 'f',
    maxRetries: 0,
    cacheEnabled: false,
    cacheDir: '/tmp/cache',
    stream: false,
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

/** 最小可跑的 deps。各测试按需覆盖。 */
function makeDeps(over: Partial<RunnerDeps> = {}): RunnerDeps {
  const { emit } = collector()
  return {
    loadConfig: fakeConfig,
    makeSessionStore: () => ({
      load: async () => [] as Message[],
      save: async () => {},
    }),
    buildCallModel: () => async () => ({ text: 'ok', toolCalls: [] }),
    makeSummarize: () => async () => 'summary',
    verify: async () => ({ grounded: true, issues: [] }),
    runAgent: (async () => 'answer') as RunnerDeps['runAgent'],
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

describe('缺陷 1：串行锁比 complete 事件晚释放', () => {
  // ## 这是用户报的主症状的根因
  //
  // agent-runner 的顺序是：
  //   emit.complete(答案)  →  await verify(...)  →  finally { busy = false }
  //
  // verify 是一次**完整的 LLM 调用**（LLM-as-Judge 事后核查），有工具证据时
  // 才跑，可能好几秒。在这段时间里两边的认知是矛盾的：
  //   • 前端收到 complete，认为「这轮跑完了」，composer 恢复可用
  //   • 主进程的 busy 还是 true，认为「还忙着」
  //
  // 用户在这个窗口里去另一个会话发消息 → runner.run 撞上 busy → 吃一个
  // BUSY「上一个问题还在处理中」。而屏幕上那个会话**明明已经答完了**，
  // 用户找不到是谁在处理 —— 这正是「结束了还在说有请求处理中」。
  //
  // 窗口宽度 = verify 那次 LLM 调用的时长。不是理论上的窄缝。

  /**
   * 造一个「有工具证据、并且第一轮的 verify 会卡住」的 runner。
   *
   * **只卡第一轮**：run() 返回的 promise 包含锁外那次核查，所以如果每轮都卡，
   * 测试里 `await runner.run(...)` 会等一个还没 release 的 promise —— 死锁。
   * 这也更贴近真实情况：卡住的是某一次核查，不是所有核查。
   */
  function runnerStuckInVerify() {
    const { events, emit } = collector()
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    let entered!: () => void
    const inVerify = new Promise<void>((r) => {
      entered = r
    })
    let calls = 0

    const runner = createAgentRunner(
      makeDeps({
        emit,
        // 报一个工具结果 —— 没有证据的话根本不会走 verify
        runAgent: (async (_input: string, d: any) => {
          d.onTurn?.({ turn: 1, toolResults: [{ name: 't', args: {}, output: 'o' }], text: '' })
          return 'answer'
        }) as RunnerDeps['runAgent'],
        verify: async () => {
          calls += 1
          if (calls === 1) {
            entered()
            await held
          }
          return { grounded: true, issues: [] }
        },
      }),
    )
    return { runner, events, release, inVerify }
  }

  it('锁在核查之前就放了 —— complete 和「不忙了」是同一时刻', async () => {
    const { runner, events, release, inVerify } = runnerStuckInVerify()
    const turn = runner.run('s1', 'hi')
    await inVerify

    // 前端已经收到 complete
    expect(events).toContain('complete')
    // 主进程这侧也已经不忙了 —— 两边认知一致，这是修复的核心
    expect(runner.isBusy('s1')).toBe(false)
    expect(runner.runningSessionIds()).toEqual([])

    release()
    await turn
  })

  it('核查期间别的会话能正常发消息，不吃 BUSY', async () => {
    const { runner, events, release, inVerify } = runnerStuckInVerify()
    const first = runner.run('s1', 'hi')
    await inVerify

    // s1 界面上已经答完了，用户去 s2 发消息 —— 必须能发出去
    await runner.run('s2', 'another')
    expect(events).not.toContain('error:BUSY')

    release()
    await first
  })

  it('核查结果照常发出（挪到锁外不等于丢掉它）', async () => {
    const { runner, events, release, inVerify } = runnerStuckInVerify()
    const turn = runner.run('s1', 'hi')
    await inVerify
    release()
    await turn
    expect(events).toContain('verdict')
  })

  // 核查移出锁之后多了一个后果：它可能在**下一轮已经开跑**时才回来。
  // 那时 reducer 的 withAssistant 会把 verdict 贴到新那轮的回答上
  // （它只认「最后一条 assistant」）。所以过期的核查要丢掉 ——
  // 对话都往下走了，一个迟到的质量标注没有价值，贴错位置反而是错信息。
  it('核查回来时这个会话已经开了新一轮 —— 过期的 verdict 丢掉', async () => {
    const { events, emit } = collector()
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    let entered!: () => void
    const inVerify = new Promise<void>((r) => {
      entered = r
    })
    let verifyCalls = 0

    const runner = createAgentRunner(
      makeDeps({
        emit,
        runAgent: (async (_i: string, d: any) => {
          d.onTurn?.({ turn: 1, toolResults: [{ name: 't', args: {}, output: 'o' }], text: '' })
          return 'answer'
        }) as RunnerDeps['runAgent'],
        verify: async () => {
          verifyCalls += 1
          // 只卡住第一次，第二轮的核查放它过去
          if (verifyCalls === 1) {
            entered()
            await held
          }
          return { grounded: true, issues: [] }
        },
      }),
    )

    const first = runner.run('s1', 'hi')
    await inVerify
    // 同一个会话开了新一轮（锁已经放了，所以发得出去）
    await runner.run('s1', 'again')
    // 现在放开第一轮那个迟到的核查
    release()
    await first

    // 第二轮自己那次核查发了 verdict，第一轮那个过期的被丢掉 —— 总共一条
    expect(events.filter((e) => e === 'verdict')).toHaveLength(1)
  })

  // 原来核查在 try 里，抛出会走 catch 分支 emit.error，于是用户看到一条
  // 红色报错、而回答好好地在屏幕上 —— 那是误报。答案已经交付了，
  // 核查失败只该让标注缺席。
  it('核查自己失败时不报错 —— 答案已经交付，不该变成这一轮的错误', async () => {
    const { events, emit } = collector()
    const runner = createAgentRunner(
      makeDeps({
        emit,
        runAgent: (async (_i: string, d: any) => {
          d.onTurn?.({ turn: 1, toolResults: [{ name: 't', args: {}, output: 'o' }], text: '' })
          return 'answer'
        }) as RunnerDeps['runAgent'],
        verify: async () => {
          throw new Error('核查用的模型挂了')
        },
      }),
    )
    await runner.run('s1', 'hi')

    expect(events).toContain('complete')
    expect(events.some((e) => e.startsWith('error:'))).toBe(false)
    expect(events).not.toContain('verdict')
  })
})

describe('缺陷 2：切走再切回会抹掉正在跑那轮的消息', () => {
  // ## select() 里的竞态
  //
  // 切换会话时 App.select() 会 `await api.loadSession(id)` 然后 dispatch
  // 'loaded'，而 'loaded' 把 messages **整体替换**成磁盘上那份。
  //
  // 问题：那一轮还在跑时，磁盘上是**上一轮结束时**的历史 —— 不含用户刚发的
  // 提问，也不含正在流的这半句回答（存盘发生在 onComplete）。于是切回来
  // 那一刻，内存里正在流的内容被磁盘那份旧历史覆盖掉。
  //
  // 之后 chunk 继续到达，withAssistant 发现最后一条不是 assistant（被抹了），
  // 就**新建**一条，从半句话开始累积。用户看到：自己的提问不见了，
  // AI 的回答从中间开始。
  //
  // reducer 里那段注释说「loaded 时不破坏当前这轮（如果在跑）的实时状态」——
  // 它保住了 running 这个**标志**，但没保住 messages。注释和代码不一致。

  it('跑到一半切回来，提问和已流出的回答都还在', () => {
    let s: ChatState = {}
    // 用户发问
    s = chatReducer(s, { type: 'user-sent', sessionId: 's1', text: '介绍一下自己' })
    // AI 开始流
    s = chatReducer(s, { type: 'chunk', event: { sessionId: 's1', text: '我是' } })
    expect(s.s1.messages).toHaveLength(2)

    // 用户切走再切回 —— select() 从磁盘读，磁盘上还是**上一轮**的历史（这里是空）
    s = chatReducer(s, { type: 'loaded', sessionId: 's1', messages: [] })

    expect(s.s1.running).toBe(true)
    // 内存那份保住了：磁盘是旧的，不该覆盖正在跑的这轮
    expect(s.s1.messages).toHaveLength(2)
    expect(s.s1.messages[0].content).toBe('介绍一下自己')
    expect(s.s1.messages[1].content).toBe('我是')
  })

  it('切回来之后继续流，接在原来那半句后面而不是新起一条', () => {
    let s: ChatState = {}
    s = chatReducer(s, { type: 'user-sent', sessionId: 's1', text: '介绍一下自己' })
    s = chatReducer(s, { type: 'chunk', event: { sessionId: 's1', text: '我是一个' } })
    s = chatReducer(s, { type: 'loaded', sessionId: 's1', messages: [] })
    // 后半句到达
    s = chatReducer(s, { type: 'chunk', event: { sessionId: 's1', text: 'AI 助手' } })

    // 用户消息 + 一条完整的回答
    expect(s.s1.messages).toHaveLength(2)
    expect(s.s1.messages[1].content).toBe('我是一个AI 助手')
  })

  // 没在跑的时候仍然要以磁盘为准 —— 那是「切换会话时读历史」的正常路径，
  // 也是编辑重发（truncateSession → loaded）依赖的行为：那里必须让
  // 主进程返回的那份**替换**内存，否则砍掉的消息不会从界面上消失。
  it('没在跑时照常用磁盘那份替换（切会话读历史的正常路径）', () => {
    let s: ChatState = {}
    s = chatReducer(s, { type: 'user-sent', sessionId: 's1', text: '旧问题' })
    s = chatReducer(s, { type: 'complete', event: { sessionId: 's1', text: '旧答案' } })
    expect(s.s1.running).toBe(false)

    s = chatReducer(s, {
      type: 'loaded',
      sessionId: 's1',
      messages: [{ role: 'user', content: '磁盘上的' }],
    })
    expect(s.s1.messages).toHaveLength(1)
    expect(s.s1.messages[0].content).toBe('磁盘上的')
  })

  // 重新挂载的场景：对齐把 running 补成 true，但桶是空的 ——
  // 这时磁盘是唯一的历史来源，必须读进来
  it('在跑但内存为空时（重新挂载后）仍然读盘', () => {
    let s: ChatState = {}
    s = chatReducer(s, { type: 'reconcile-running', sessionIds: ['s1'] })
    expect(s.s1.messages).toHaveLength(0)

    s = chatReducer(s, {
      type: 'loaded',
      sessionId: 's1',
      messages: [
        { role: 'user', content: '之前问的' },
        { role: 'assistant', content: '之前答的' },
      ],
    })
    expect(s.s1.messages).toHaveLength(2)
    expect(s.s1.running).toBe(true)
  })
})

describe('缺陷 3：前端的 running 没有「熄灭」的通路', () => {
  // ## 这是「一直卡在思考中」的根因
  //
  // 原来只有 hydrate-running：带一个 sessionId、把 running 设成 true。
  // 那个方向是**单向的** —— 能点亮，不能熄灭。于是任何一次事件丢失或时序
  // 错乱，前端就永久卡在 true：用户看到「Agent 正在处理…」转个没完，
  // 而那一轮早就答完了（按 cmd+R 刷新就能看到完整回答）。只能重启 app。
  //
  // 而且卡住的不只是那个会话自己：blockedBy 遍历所有桶找 running 的，
  // 所以别的会话也会被这个幽灵拖住。
  //
  // 现在换成 reconcile-running：传**完整集合**，不在集合里的一律熄灭。
  // 主进程的 runner 是唯一权威（进程内的 Set，不会丢），前端只是它的投影。

  // ### 熄灭方向 —— 新增的能力，正是修复所在
  it('主进程说没在跑，前端那个幽灵被熄灭', () => {
    let s: ChatState = {}
    s = chatReducer(s, { type: 'user-sent', sessionId: 's1', text: '问题' })
    expect(s.s1.running).toBe(true)

    // 那一轮实际上已经结束了，只是终止事件没到（丢了 / 时序乱了）。
    // 主进程说：没有任何会话在跑。
    s = chatReducer(s, { type: 'reconcile-running', sessionIds: [] })

    expect(s.s1.running).toBe(false)
  })

  it('熄灭时把悬着的审批也收掉', () => {
    let s: ChatState = {}
    s = chatReducer(s, { type: 'user-sent', sessionId: 's1', text: '问题' })
    s = chatReducer(s, {
      type: 'approval-request',
      event: { sessionId: 's1', requestId: 'r1', toolName: 'write_file', args: {} },
    })
    expect(s.s1.pendingApproval).toBeDefined()

    s = chatReducer(s, { type: 'reconcile-running', sessionIds: [] })
    expect(s.s1.pendingApproval).toBeUndefined()
  })

  it('多个会话同时在跑时，只熄灭不在集合里的那些', () => {
    let s: ChatState = {}
    s = chatReducer(s, { type: 'user-sent', sessionId: 's1', text: 'a' })
    s = chatReducer(s, { type: 'user-sent', sessionId: 's2', text: 'b' })
    s = chatReducer(s, { type: 'user-sent', sessionId: 's3', text: 'c' })

    // s2 已经结束了，s1 / s3 还在跑
    s = chatReducer(s, { type: 'reconcile-running', sessionIds: ['s1', 's3'] })

    expect(s.s1.running).toBe(true)
    expect(s.s2.running).toBe(false)
    expect(s.s3.running).toBe(true)
  })

  // ### 点亮方向 —— 仍然要挡住过期快照
  //
  // 启动时先建立事件订阅（挂载即生效），再拉快照。如果那一轮正好在快照这次
  // IPC 往返期间结束，快照带回来的就是过期的真相；认它会把 running 重新
  // 点亮，而这一次连熄灭都救不了（下一次对齐时它又会被重新点亮）。
  it('complete 先到、过期快照后到 —— 不认那个快照', () => {
    let s: ChatState = {}
    s = chatReducer(s, { type: 'complete', event: { sessionId: 's1', text: '答案' } })
    expect(s.s1.running).toBe(false)

    s = chatReducer(s, { type: 'reconcile-running', sessionIds: ['s1'] })
    expect(s.s1.running).toBe(false)
  })

  it('error / cancelled 落定的也一样挡得住', () => {
    let a: ChatState = chatReducer({}, {
      type: 'error',
      event: { sessionId: 's1', code: 'MODEL_ERROR', message: 'x' },
    })
    a = chatReducer(a, { type: 'reconcile-running', sessionIds: ['s1'] })
    expect(a.s1.running).toBe(false)

    let b: ChatState = chatReducer({}, { type: 'cancelled', event: { sessionId: 's1' } })
    b = chatReducer(b, { type: 'reconcile-running', sessionIds: ['s1'] })
    expect(b.s1.running).toBe(false)
  })

  it('别的会话不再被幽灵锁死', () => {
    let s: ChatState = {}
    s = chatReducer(s, { type: 'complete', event: { sessionId: 's1', text: '答案' } })
    s = chatReducer(s, { type: 'reconcile-running', sessionIds: ['s1'] })
    s = chatReducer(s, { type: 'loaded', sessionId: 's2', messages: [] })

    // blockedBy 的算法（见 App.tsx）：找一个「不是当前」且 running 的
    const currentId = 's2'
    const blocker = Object.entries(s).find(([id, c]) => id !== currentId && c.running)
    expect(blocker).toBeUndefined()
  })

  // 反面：真在跑的会话必须补得上，否则重新挂载后那一轮就「消失」了 ——
  // 界面上没有任何正在处理的迹象，而主进程还在跑，用户会重复发问
  it('本地没有这个桶时建一个（reload 之后的正常路径）', () => {
    const s = chatReducer({}, { type: 'reconcile-running', sessionIds: ['s1'] })
    expect(s.s1.running).toBe(true)
    // 消息内容靠 select() 的 loadSession 找回，这里只补 running 这个信号
    expect(s.s1.messages).toEqual([])
  })

  it('新一轮开始后，落定标记被清掉（否则这个会话再也补不上）', () => {
    let s: ChatState = {}
    s = chatReducer(s, { type: 'complete', event: { sessionId: 's1', text: '第一轮' } })
    // 第二轮
    s = chatReducer(s, { type: 'user-sent', sessionId: 's1', text: '再问' })
    expect(s.s1.running).toBe(true)

    // 这次的快照是**当下**的真相（第二轮真在跑），要认
    s = chatReducer(s, { type: 'reconcile-running', sessionIds: ['s1'] })
    expect(s.s1.running).toBe(true)
  })

  // 这个 action 每次切会话都派发，绝大多数时候什么都没变 ——
  // 返回同一个引用能省掉一整棵树的重渲染
  it('什么都没变时返回同一个引用（省掉无意义的重渲染）', () => {
    const before = chatReducer({}, { type: 'user-sent', sessionId: 's1', text: 'q' })
    const after = chatReducer(before, { type: 'reconcile-running', sessionIds: ['s1'] })
    expect(after).toBe(before)
  })

  it('删掉会话时把它的桶一起清掉，不留下泄漏的消息', () => {
    let s: ChatState = {}
    s = chatReducer(s, { type: 'user-sent', sessionId: 's1', text: '问题' })
    s = chatReducer(s, { type: 'complete', event: { sessionId: 's1', text: '答案' } })
    s = chatReducer(s, { type: 'loaded', sessionId: 's2', messages: [] })
    expect(Object.keys(s)).toContain('s1')

    s = chatReducer(s, { type: 'session-removed', sessionId: 's1' })
    expect(Object.keys(s)).not.toContain('s1')
    // 别的会话原样留着
    expect(s.s2).toBeDefined()
  })
})
