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
}

export interface AgentRunner {
  run(sessionId: string, input: string): Promise<void>
  isBusy(): boolean
  // 串行锁只知道"忙不忙"，不知道"忙着跑谁"——但 renderer 重新挂载后要重建
  // "哪个会话占着锁"这件事（blockedBy 横幅、停止按钮），必须能
  // 从外面问出具体是哪个 sessionId，不只是一个布尔值。
  runningSessionId(): string | null
  /**
   * 请求停止某个会话正在跑的那一轮。
   *
   * 返回「有没有受理」：目标没在跑就返回 false（不报错 —— 用户可能在
   * cancelled 事件到达前又点了一次）。受理了也**不代表已经停了**，
   * 取消是轮边界的，见 cancel.ts 的文件头。
   */
  cancel(sessionId: string): boolean
  /**
   * 等当前这一轮彻底结束（含取消路径上的存盘）。没在跑就立刻返回。
   *
   * 删除正在跑的会话需要它：取消路径上会 sessions.save()，先删文件的话
   * 存盘后落地、会话又「复活」。rs 侧同样的坑用 200ms 定时器兜
   * （ui/src/chat.rs 的注释说明了为什么不做严格的完成信号：要给 bridge
   * 加一条反向通路）。这边不用猜时间 —— runner 就在主进程内，
   * 手里有那个 promise，await 它就行。
   */
  settled(): Promise<void>
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
  let busy = false
  let currentSessionId: string | null = null
  // 当前那一轮的取消令牌。一次性 —— 每轮新建，不复用（见 cancel.ts）。
  let currentToken: CancelToken | null = null
  // 当前那一轮的 promise，给 settled() 用。串行锁保证同时只有一个。
  let inFlight: Promise<void> | null = null

  async function runTurn(sessionId: string, input: string, token: CancelToken): Promise<void> {
    // 取消路径上也要存盘（保住已经产生的那几轮），所以 sessions 得在
    // try 外面拿得到。config 同理。
    let sessions: SessionStore | undefined
    let produced: Message[] | undefined
    try {
        const config = deps.loadConfig()
        sessions = deps.makeSessionStore(config.sessionsDir)
        const history = await sessions.load(sessionId)

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
        const composedRegistry = { ...deps.registry, ...fsTools }

        const provider =
          deps.resolveProvider?.(sessionId) ??
          createBuiltinProvider({
            buildCallModel: deps.buildCallModel,
            makeSummarize: deps.makeSummarize,
            runAgent: deps.runAgent,
            registry: composedRegistry,
            gate: deps.gate,
            onApprovalRequest: (event) => deps.emit.approvalRequest(event),
            permission: deps.resolvePermission?.(sessionId),
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
          sessionId,
          history,
          config,
          cwd: deps.resolveCwd?.(sessionId),
          emit: onEvent,
          token,
          onComplete: (messages) => sessions!.save(sessionId, messages),
        })

        deps.emit.complete({ sessionId, text: answer })

        // 只在真的调过工具时核查：纯聊天没有证据可比对，白花一次模型调用。
        // 外部 CLI 永远走这条短路 —— 它自己管工具，我们拿不到可比对的证据
        // （见 provider/types.ts 里 TurnResult.evidence 的注释）
        if (evidence.length > 0) {
          const verdict = await deps.verify(config, { question: input, answer, evidence })
          deps.emit.verdict({ sessionId, ...verdict })
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
        busy = false
        currentSessionId = null
        currentToken = null
        inFlight = null
      }
  }

  return {
    isBusy: () => busy,
    runningSessionId: () => currentSessionId,

    cancel(sessionId) {
      // 只取消「正在跑的就是它」的情况。不匹配就当没受理 ——
      // 否则用户在 A 会话点停止会把 B 会话正在跑的那轮停掉。
      if (!busy || currentSessionId !== sessionId || !currentToken) return false
      currentToken.cancel()
      return true
    },

    settled: () => inFlight ?? Promise.resolve(),

    run(sessionId, input) {
      if (busy) {
        deps.emit.error({ sessionId, code: 'BUSY', message: '上一个问题还在处理中，请稍候' })
        return Promise.resolve()
      }
      busy = true
      currentSessionId = sessionId
      const token = new CancelToken()
      currentToken = token
      // 存下 promise 而不是直接 await：settled() 要能从外面拿到它，
      // 删除正在跑的会话靠它等存盘落完（见 settled 的注释）。
      inFlight = runTurn(sessionId, input, token)
      return inFlight
    },
  }
}
