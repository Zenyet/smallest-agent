// 请求级装配 + 串行锁。每条消息走一次这里。
// 串行的理由：会话文件是「读-改-写」，并发会互相覆盖；个人使用也没有并发收益。
import { runAgent as realRunAgent } from '../../src/agent'
import { makeCallModel } from '../../src/llm'
import { createJsonSessionStore } from '../../src/memory/store'
import { makeSummarizer } from '../../src/memory/summarize'
import { type Summarize } from '../../src/memory/compact'
import { makeVerifier, type Verdict, type VerifyInput } from '../../src/verify'
import { loadConfig as realLoadConfig } from '../../src/config'
import { buildCallModel as realBuildCallModel } from './call-model'
import { toErrorEvent } from './errors'
import { createApprovalGate, type ApprovalGate, type GuardMode } from './approval'
import { CancelToken, isCancelled } from './cancel'
import { createBuiltinProvider } from './provider/builtin'
import type { Provider, TurnEvent } from './provider/types'
import type { FsToolsPool } from './fs-tools'
import { applyAgent, filterTools, type AgentDef } from './agents'
import { makeTaskTool } from './subagent'
import type { SessionStore } from '../../src/memory/store'
import type { CallModel, Config, Message, ToolRegistry } from '../../src/types'
import type {
  ApprovalRequestEvent,
  CacheHitEvent,
  CancelledEvent,
  ErrorEvent,
  MessageChunkEvent,
  MessageCompleteEvent,
  ToolCallEvent,
  VerdictEvent,
} from '../shared/channels'

export interface AgentEmitter {
  chunk: (e: MessageChunkEvent) => void
  toolCall: (e: ToolCallEvent) => void
  complete: (e: MessageCompleteEvent) => void
  verdict: (e: VerdictEvent) => void
  cacheHit: (e: CacheHitEvent) => void
  error: (e: ErrorEvent) => void
  approvalRequest: (e: ApprovalRequestEvent) => void
  cancelled: (e: CancelledEvent) => void
}

export interface RunnerDeps {
  loadConfig: () => Config
  makeSessionStore: (dir: string) => SessionStore
  buildCallModel: (
    config: Config,
    registry: ToolRegistry,
    onText: (d: string) => void,
    onCacheHit: () => void,
  ) => CallModel
  makeSummarize: (config: Config) => Summarize
  verify: (config: Config, input: VerifyInput) => Promise<Verdict>
  runAgent: typeof realRunAgent
  registry: ToolRegistry
  emit: AgentEmitter
  // 写工具审批闸口。按 session 装饰 registry 必须在 run() 里做（每条请求一次），
  // 不能在 makeDefaultRunnerDeps 里做一次——那时候还没有 sessionId。
  gate: ApprovalGate
  /**
   * 这一轮该由哪个 provider 跑。返回 null / 不传 = 用内置 agent。
   *
   * **可选**是有意的：绝大多数测试只关心内置那条路，不传就是原来的行为，
   * 那 19 条锁 runner 契约的测试因此一行不用改。真实装配在
   * makeDefaultRunnerDeps 里接上（见那边）。
   *
   * 传 sessionId 而不是让 runner 自己读 providers 状态：那份状态活在
   * electron-store 里，而 runner 是纯逻辑、测试里不该被迫去 mock 一个 store。
   */
  resolveProvider?: (sessionId: string) => Provider | null
  /**
   * 这个会话的工作目录（外部 CLI 的 cwd）。不传 = 没有项目目录。
   *
   * 和 resolveProvider 分开而不是打包成一个「会话上下文」：cwd 的真相在
   * 项目分组那边（projects-store），provider 的真相在 providers-store，
   * 两个来源，合成一个对象只会让「谁该更新它」变模糊。
   */
  resolveCwd?: (sessionId: string) => string | undefined
  /**
   * 这个会话的权限模式（只对内置 agent 有意义 —— 外部 CLI 自带权限模型）。
   * 不传 = 'ask'，也就是原来的行为。
   */
  resolvePermission?: (sessionId: string) => GuardMode
  /** 文件工具池：按项目目录懒建 + 缓存，见 fs-tools.ts */
  fsPool?: FsToolsPool
  /**
   * 这个会话绑的自定义 agent（系统提示 + 工具白名单）。返回 undefined = 没绑。
   *
   * 可选：不传就是没有自定义 agent 的行为，所以现有测试不用改。
   */
  resolveAgent?: (sessionId: string) => AgentDef | undefined
  /**
   * 能被派活的子 agent 有哪些（停用的调用方先滤掉）。
   *
   * 和 resolveAgent 分开：那个答「这个会话用哪套预设」（一个），
   * 这个答「可以派给谁」（一批）。同一份数据两种用途，见 subagent.ts 的文件头。
   *
   * 空数组 / 不传 = 不给 task 工具（一个调了必然报错的工具比没有更糟）。
   */
  resolveSubagents?: (sessionId: string) => AgentDef[]
}

export interface AgentRunner {
  run(sessionId: string, input: string, attachments?: any[]): Promise<void>
  /** 某个会话是不是正在跑。 */
  isBusy(sessionId: string): boolean
  /** 哪些会话正在跑（按开始顺序）。前端用它重建 blockedBy 横幅、停止按钮。 */
  runningSessionIds(): string[]
  /**
   * 请求停止某个会话正在跑的那一轮。
   *
   * 返回「有没有受理」：目标没在跑就返回 false（不报错 —— 用户可能在
   * cancelled 事件到达前又点了一次）。受理了也**不代表已经停了**，
   * 取消是轮边界的，见 cancel.ts 的文件头。
   */
  cancel(sessionId: string): boolean
  /**
   * 等某个会话那一轮彻底结束（含取消路径上的存盘）。没在跑就立刻返回。
   *
   * 删除正在跑的会话需要它：取消路径上会 sessions.save()，先删文件的话
   * 存盘后落地、会话又「复活」。
   */
  settled(sessionId: string): Promise<void>
}

export function makeDefaultRunnerDeps(
  registry: ToolRegistry,
  emit: AgentEmitter,
  loadConfig: () => Config = realLoadConfig,
  gate: ApprovalGate = createApprovalGate(),
): RunnerDeps {
  return {
    loadConfig,
    makeSessionStore: createJsonSessionStore,
    buildCallModel: realBuildCallModel,
    makeSummarize: (config) => makeSummarizer(makeCallModel(config, {})),
    verify: (config, input) => makeVerifier(makeCallModel(config, {}))(input),
    runAgent: realRunAgent,
    registry,
    emit,
    gate,
  }
}

export function createAgentRunner(deps: RunnerDeps): AgentRunner {
  // 按会话并发 —— 全局锁的理由只有「会话文件是读-改-写」，但文件本身是
  // 按会话分的，不同会话的请求根本不冲突。串行锁让用户没法同时问两个问题，
  // 完全是设计缺陷不是限制。
  /** 正在跑的会话 ID 集合。 */
  const running = new Set<string>()
  /** sessionId → 它那一轮的取消令牌（一次性，每轮新建）。 */
  const tokens = new Map<string, CancelToken>()
  /** sessionId → 它那一轮的 promise，给 settled(id) 用。 */
  const inFlight = new Map<string, Promise<void>>()
  // 轮次序号，全局单调递增。只用来判断「一个异步结果回来时，它那一轮还是
  // 这个会话最近的一轮吗」—— 事后核查移到锁外之后需要这个判据，
  // 见 runTurn 末尾。用序号而不是时间戳：同一毫秒内开两轮时时间戳分不开。
  let seq = 0
  /** sessionId → 它最近开的那一轮的序号。 */
  const lastTurnOf = new Map<string, number>()

  async function runTurn(sessionId: string, input: string, token: CancelToken, attachments?: any[]): Promise<void> {
    const mySeq = ++seq
    lastTurnOf.set(sessionId, mySeq)
    // 取消路径上也要存盘（保住已经产生的那几轮），所以 sessions 得在
    // try 外面拿得到。config 同理。
    let sessions: SessionStore | undefined
    let produced: Message[] | undefined
    // 事后核查的入料。带出 try 是为了让核查在**锁外**跑 —— 见下面
    // finally 之后那段。
    let pendingVerify: { config: Config; input: VerifyInput } | null = null
    try {
        const config = deps.loadConfig()
        sessions = deps.makeSessionStore(config.sessionsDir)
        const history = await sessions.load(sessionId)

        // 上层已取消（窗口关了 / 用户在 IPC 往返期间按了停止）—— 往下跑没意义。
        // 静默返回不发事件：这不是错误，也不该往历史里塞东西。
        if (token.isCancelled()) return

        // 这一轮由谁来跑：外部 CLI（ACP）还是内置 agent。
        //
        // 回落到内置而不是报错：resolveProvider 返回 null 的情况是「那个
        // provider 被删了 / 配置改坏了」，而用户此刻只是想问句话。
        // 静默回落 + 内置能答，好过让这一轮失败。
        //
        // 内置每轮新建而不是构造 runner 时建一个：它无状态（历史每轮显式传），
        // 重建的代价只是建一个 client；而缓存它反而要处理「MCP 工具热插进来
        // 之后什么时候失效」。外部反过来 —— 那边按 (provider, 模型) 缓存，
        // 见 provider/registry.ts。
        // 文件工具按这个会话的工作目录取。没有工作目录（未分组会话）返回空注册表。
        const cwd = deps.resolveCwd?.(sessionId)
        const fsTools = (await deps.fsPool?.forDir(cwd)) ?? {}
        const composedRegistry: ToolRegistry = { ...deps.registry, ...fsTools }

        // 这家厂商自带服务端搜索的话，撤掉我们自己那个 web_search。
        //
        // 留着两个的后果不是「多一个选择」而是**更差**：模型会在两条路之间
        // 乱挑，而我们那个在没配 Brave/Tavily 时只能搜维基百科 —— 厂商自带
        // 的是全网。给它一个更差的同名选项没有意义。
        //
        // fetch_url 不撤：抓具体网址和搜索是两件事，服务端搜索不覆盖
        // 「把这个链接读一下」。
        //
        // 放在每轮而不是启动时：用户可以在 composer 上随时换厂商，
        // 从智谱切到 DeepSeek 之后我们的 web_search 得回来。
        if (config.nativeSearch && config.nativeSearch.kind !== 'none') {
          delete composedRegistry.web_search
        }

        // 这个会话绑的自定义 agent（一套预设：系统提示 + 工具白名单）。
        //
        // 只对内置 provider 生效 —— 外部 CLI 有它自己的系统提示，我们插不进去
        // （见 agents.ts 的文件头「为什么它不是一个新的 Provider」）。
        //
        // 顺序要紧：**在**撤 web_search 之后过白名单。反过来的话，一个白名单里
        // 写了 web_search 的 agent 在智谱那种自带搜索的厂商下会把它加回来，
        // 而那个工具此刻不该存在。
        const agent = deps.resolveAgent?.(sessionId)
        const turnConfig = agent ? applyAgent(agent, config) : config
        const turnRegistry = agent ? filterTools(agent, composedRegistry) : composedRegistry

        const provider =
          deps.resolveProvider?.(sessionId) ??
          createBuiltinProvider({
            buildCallModel: deps.buildCallModel,
            makeSummarize: deps.makeSummarize,
            runAgent: deps.runAgent,
            registry: turnRegistry,
            gate: deps.gate,
            onApprovalRequest: (event) => deps.emit.approvalRequest(event),
            permission: deps.resolvePermission?.(sessionId),
            // 在审批装饰之后造 task 工具 —— 见 builtin.ts 里那个字段的注释。
            //
            // 每轮重造而不是缓存：子 agent 清单可以在设置里改，
            // 而缓存它就要处理失效通知。
            makeTaskTool: (guardedRegistry, turnCfg) => {
              const subagents = deps.resolveSubagents?.(sessionId) ?? []
              if (subagents.length === 0) return null
              return makeTaskTool({
                agents: subagents,
                baseConfig: turnCfg,
                baseRegistry: guardedRegistry,
                buildCallModel: (c, r) => deps.buildCallModel(c, r, () => {}, () => {}),
                runAgent: deps.runAgent,
                token,
                onProgress: (result) =>
                  deps.emit.toolCall({
                    sessionId,
                    turn: 0,
                    toolName: `task:${result.agent}`,
                    args: { task: result.task },
                    output: result.ok ? result.output : `失败：${result.output}`,
                  }),
              })
            },
          })

        // provider 产出的事件翻译成 IPC 事件。
        //
        // 这一层留在 runner 里而不是让 provider 直接发 IPC：provider 只该知道
        // 「发生了什么」，不该知道有哪些频道、哪个频道要带 sessionId。
        // 现有的 8 个频道一个都没动 —— renderer 侧零改动的前提。
        const onEvent = (e: TurnEvent) => {
          switch (e.kind) {
            case 'delta':
              deps.emit.chunk({ sessionId, text: e.text })
              break
            case 'tool-call':
              deps.emit.toolCall({
                sessionId,
                turn: e.turn,
                toolName: e.name,
                args: e.args,
                output: e.output,
                elapsedMs: e.elapsedMs,
              })
              break
            case 'cache-hit':
              deps.emit.cacheHit({ sessionId })
              break
            case 'notice':
              // 外部 CLI 的状态提示（「正在起子进程」之类）。现在还没有 provider
              // 会发它 —— 内置 agent 没有这类状态。等 ACP 接进来时它需要一条
              // 显示通路，那时再决定是新开一个频道还是复用 chunk；在此之前
              // 记一行日志，比静默丢掉好排查
              console.log(`[provider] ${e.text}`)
              break
          }
        }

        const { answer, evidence } = await provider.runTurn({
          question: input,
          attachments,
          sessionId,
          history,
          // 应用过自定义 agent 预设的那份（没绑 agent 时就是原样）
          config: turnConfig,
          cwd: deps.resolveCwd?.(sessionId),
          emit: onEvent,
          token,
          onComplete: (messages) => sessions!.save(sessionId, messages),
        })

        deps.emit.complete({ sessionId, text: answer })

        // 只在真的调过工具时核查：纯聊天没有证据可比对，白花一次模型调用。
        // 外部 CLI 永远走这条短路 —— 它自己管工具，我们拿不到可比对的证据
        // （见 provider/types.ts 里 TurnResult.evidence 的注释）
        //
        // ⚠️ 这里只**记下要核查什么**，不在这里 await。核查是一次完整的
        // LLM 调用（可能好几秒），而此刻 complete 已经发出去了 —— 前端认为
        // 这轮结束、composer 恢复可用。如果核查在锁内跑，这几秒里前端和
        // 主进程的认知是矛盾的：用户去另一个会话发消息会撞上 busy，吃一个
        // 「上一个问题还在处理中」，而屏幕上那个会话明明已经答完了，
        // 他根本找不到是谁在处理。真实的 bug，见 tests/electron/turn-state.test.ts。
        //
        // 存盘已经在 provider.runTurn 的 onComplete 里落完了，这一轮对状态的
        // 影响到此为止；核查只是给答案贴个质量标注，没有理由占着串行锁。
        if (evidence.length > 0) {
          pendingVerify = { config, input: { question: input, answer, evidence } }
        }
      } catch (err) {
        // 取消和真错误分流。用 isCancelled 顺 cause 链判类型，不比字符串 ——
        // 否则「网络挂了」会被静默显示成「已停止」，用户以为是自己点的。
        if (isCancelled(err)) {
          // 取消路径上也存盘：用户点停止不该丢掉前面几轮已经产生的对话。
          //
          // runAgent 抛出时 onComplete 没机会跑，而它内部的 messages 数组
          // 拿不到（src/ 冻结，不给我们）。所以这里退一步：把「用户这次的
          // 提问」补进历史存下去 —— 已经流出去的 assistant 文字前端手里有，
          // 但那不是权威副本，不写盘的话刷新就没了。
          if (sessions) {
            const history = await sessions.load(sessionId).catch(() => [])
            produced = [...history, { role: 'user' as const, content: input }]
            await sessions.save(sessionId, produced).catch(() => {})
          }
          deps.emit.cancelled({ sessionId })
        } else {
          deps.emit.error(toErrorEvent(sessionId, err))
        }
      } finally {
        running.delete(sessionId)
        tokens.delete(sessionId)
        inFlight.delete(sessionId)
      }

      // --- 锁已经放了，事后核查在这里跑 ---
      //
      // 为什么在锁外：见上面 pendingVerify 那段。简述 —— 核查是一次完整的
      // LLM 调用，而 complete 已经发出去了；占着锁的话用户去别的会话发消息
      // 会吃一个「上一个问题还在处理中」，而那个会话明明已经答完。
      //
      // 代价是这里要自己处理两件锁内不用管的事：
      //
      // 1. **贴错消息**。核查回来时下一轮可能已经开跑了，那时 reducer 的
      //    withAssistant 会把 verdict 贴到**新那轮**的回答上（它只认「最后
      //    一条 assistant」）。所以先确认这个会话最近开的还是我这一轮，
      //    不是就丢掉 —— verdict 是给答案贴的质量标注，对话都往下走了，
      //    一个迟到的标注没有价值，贴错位置反而是错的信息。
      //
      // 2. **核查自己失败**。原来它在 try 里，抛出会走 catch 分支 emit.error，
      //    于是用户看到一条红色报错、而回答好好地在屏幕上 —— 那是误报。
      //    答案已经交付了，核查失败只该让标注缺席，不该变成这一轮的错误。
      if (pendingVerify) {
        try {
          const verdict = await deps.verify(pendingVerify.config, pendingVerify.input)
          // 判断必须在核查**返回之后**做，不能在调用之前 —— 之前那一刻
          // 从 finally 到这里没有 await，单线程下不可能有别的轮插进来，
          // 检查恒为真、是死代码。真正的窗口是核查那几秒。
          if (lastTurnOf.get(sessionId) === mySeq) {
            deps.emit.verdict({ sessionId, ...verdict })
          }
        } catch {
          // 静默跳过，理由见上面第 2 点
        }
      }
  }

  return {
    /** 某个会话是不是正在跑。 */
    isBusy: (sessionId: string) => running.has(sessionId),
    /** 哪些会话正在跑（数组，按开始顺序）。 */
    runningSessionIds: () => Array.from(running),

    cancel(sessionId) {
      const token = tokens.get(sessionId)
      if (!token) return false
      token.cancel()
      return true
    },

    /** 等这个会话那一轮彻底结束（存盘完成）。没在跑时立刻返回。 */
    settled: (sessionId: string) => inFlight.get(sessionId) ?? Promise.resolve(),

    run(sessionId, input, attachments) {
      // 按 session 拒绝，不是全局：**同一个**会话并发会互相覆盖（会话文件是
      // 读-改-写、整体覆写），不同会话之间没有共享状态，可以同时跑。
      if (running.has(sessionId)) {
        deps.emit.error({ sessionId, code: 'BUSY', message: '上一个问题还在处理中，请稍候' })
        return Promise.resolve()
      }
      // ⚠️ 锁必须在这里**同步**拿到，不能挪进 runTurn。那边第一句 await
      // （sessions.load）之前有一个事件循环空档，同一会话连发两条的话两次
      // 检查都会通过，然后两轮并发读-改-写同一个文件、后写的覆盖前写的。
      const token = new CancelToken()
      running.add(sessionId)
      tokens.set(sessionId, token)
      // 存下 promise：settled(id) 要能从外面拿到它，删除正在跑的会话靠它
      // 等存盘落完（见 settled 的注释）。runTurn 内部有 await，所以这一句
      // 一定在它的 finally 之前跑到。
      const promise = runTurn(sessionId, input, token, attachments)
      inFlight.set(sessionId, promise)
      return promise
    },
  }
}
