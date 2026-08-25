// 请求级装配 + 串行锁。每条消息走一次这里。
// 串行的理由：会话文件是「读-改-写」，并发会互相覆盖；个人使用也没有并发收益。
import { runAgent as realRunAgent, type TurnInfo } from '../../src/agent'
import { makeCallModel } from '../../src/llm'
import { createJsonSessionStore } from '../../src/memory/store'
import { makeSummarizer } from '../../src/memory/summarize'
import { compactMessages, type Summarize } from '../../src/memory/compact'
import { makeVerifier, type Verdict, type VerifyInput } from '../../src/verify'
import { loadConfig as realLoadConfig } from '../../src/config'
import { buildCallModel as realBuildCallModel } from './call-model'
import { toErrorEvent } from './errors'
import { createApprovalGate, guardRegistry, type ApprovalGate } from './approval'
import { CancelToken, isCancelled, withCancel } from './cancel'
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

        // 审批装饰同样是请求级的：sessionId 只在这里才知道，装饰过的 registry
        // 不能在 makeDefaultRunnerDeps 里提前做一次给所有 session 共用。
        const guardedRegistry = guardRegistry(deps.registry, sessionId, deps.gate, (event) =>
          deps.emit.approvalRequest(event),
        )

        // 流式回调绑定本次请求的 sessionId —— 这就是 callModel 必须请求级重建的原因
        const callModel = deps.buildCallModel(
          config,
          guardedRegistry,
          (text) => deps.emit.chunk({ sessionId, text }),
          () => deps.emit.cacheHit({ sessionId }),
        )

        // withCancel 套在**最外层**，即 buildCallModel 的返回值之外。
        //
        // 位置不是洁癖，套错了有实际后果（见 cancel.ts 的注释）：
        //   • 套在 withRetry 里面 → 取消被当成可重试失败，反复退避几轮才放弃
        //   • 套在 withFallback 里面 → 取消触发「换备用模型」，反而多打一次请求
        const cancellableCallModel = withCancel(callModel, token)

        const summarize = deps.makeSummarize(config)
        const evidence: string[] = []

        // TurnInfo（src/agent.ts，冻结）不带时间戳。onTurn 在每轮的工具都跑完后才触发一次，
        // 从不按单个工具调用触发，所以这里能诚实测量的只有「这一轮」的耗时（模型调用 + 该轮所有工具执行），
        // 不是某个具体工具的耗时。turnStartedAt 在每轮结束时重置，作为下一轮的起点。
        let turnStartedAt = Date.now()

        const answer = await deps.runAgent(input, {
          callModel: cancellableCallModel,
          tools: guardedRegistry,
          config,
          history,
          compact: (messages: Message[]) =>
            compactMessages(messages, {
              maxTokens: config.maxContextTokens,
              keepRecent: config.keepRecent,
              summarize,
            }),
          // system prompt 由 config 决定，不需要进历史文件
          onComplete: (messages: Message[]) =>
            sessions!.save(sessionId, messages.filter((m) => m.role !== 'system')),
          onTurn: (info: TurnInfo) => {
            const elapsedMs = Date.now() - turnStartedAt
            turnStartedAt = Date.now()
            for (const t of info.toolResults) {
              evidence.push(`${t.name}: ${t.output}`)
              deps.emit.toolCall({
                sessionId,
                turn: info.turn,
                toolName: t.name,
                args: t.args,
                output: t.output,
                // 同一轮内的所有工具调用共享这一个耗时值 —— 它们本来就是同一轮里一起测量的。
                elapsedMs,
              })
            }
          },
        })

        deps.emit.complete({ sessionId, text: answer })

        // 只在真的调过工具时核查：纯聊天没有证据可比对，白花一次模型调用
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
