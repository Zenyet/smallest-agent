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
import type { SessionStore } from '../../src/memory/store'
import type { CallModel, Config, Message, ToolRegistry } from '../../src/types'
import type {
  ApprovalRequestEvent,
  CacheHitEvent,
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
  // "哪个会话占着锁"这件事（blockedBy 横幅、拒绝删除正在跑的会话），必须能
  // 从外面问出具体是哪个 sessionId，不只是一个布尔值。
  runningSessionId(): string | null
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

  return {
    isBusy: () => busy,
    runningSessionId: () => currentSessionId,

    async run(sessionId, input) {
      if (busy) {
        deps.emit.error({ sessionId, code: 'BUSY', message: '上一个问题还在处理中，请稍候' })
        return
      }
      busy = true
      currentSessionId = sessionId
      try {
        const config = deps.loadConfig()
        const sessions = deps.makeSessionStore(config.sessionsDir)
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

        const summarize = deps.makeSummarize(config)
        const evidence: string[] = []

        // TurnInfo（src/agent.ts，冻结）不带时间戳。onTurn 在每轮的工具都跑完后才触发一次，
        // 从不按单个工具调用触发，所以这里能诚实测量的只有「这一轮」的耗时（模型调用 + 该轮所有工具执行），
        // 不是某个具体工具的耗时。turnStartedAt 在每轮结束时重置，作为下一轮的起点。
        let turnStartedAt = Date.now()

        const answer = await deps.runAgent(input, {
          callModel,
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
            sessions.save(sessionId, messages.filter((m) => m.role !== 'system')),
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
        deps.emit.error(toErrorEvent(sessionId, err))
      } finally {
        busy = false
        currentSessionId = null
      }
    },
  }
}
