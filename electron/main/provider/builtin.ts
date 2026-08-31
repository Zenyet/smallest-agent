// ============================================================================
// provider/builtin.ts —— 内置 agent：本仓库自己的 ReAct 循环
// ----------------------------------------------------------------------------
// 这里面的每一行原来都在 agent-runner.ts 的 runTurn 里。搬过来是为了让
// 「装配一轮」和「这一轮由谁来跑」分开：runner 继续管持久化、串行锁、
// IPC 翻译、错误分流，这个文件只管「调 src/agent.ts 那个循环」。
//
// 搬的时候**行为一行没改** —— 那 19 条锁 runner 契约的测试原封不动全绿，
// 是这次重构唯一可信的验收标准。
//
// ## 为什么内置 provider 不缓存实例
//
// 它无状态（历史每轮显式传进来），重建的代价只是建一个 client。而缓存它
// 反而要处理「MCP 工具热插进来之后什么时候失效」—— 外部 CLI 那边反过来，
// 见 acp.ts。
// ============================================================================

import { compactMessages, type Summarize } from '../../../src/memory/compact'
import { guardRegistry, type ApprovalGate, type GuardMode } from '../approval'
import { withCancel } from '../cancel'
import type { runAgent as realRunAgent, TurnInfo } from '../../../src/agent'
import type { CallModel, Config, Message, Tool, ToolRegistry } from '../../../src/types'
import type { ApprovalRequestEvent } from '../../shared/channels'
import type { Provider, TurnRequest, TurnResult } from './types'
import { BUILTIN_ID } from '../providers'

export interface BuiltinDeps {
  buildCallModel: (
    config: Config,
    registry: ToolRegistry,
    onText: (d: string) => void,
    onCacheHit: () => void,
  ) => CallModel
  makeSummarize: (config: Config) => Summarize
  runAgent: typeof realRunAgent
  registry: ToolRegistry
  /** 写工具的审批闸口 */
  gate: ApprovalGate
  /** 有工具要审批时通知出去（runner 转成 IPC 事件） */
  onApprovalRequest: (event: ApprovalRequestEvent) => void
  /** 这个会话的权限模式。不传 = 'ask'（原来的行为） */
  permission?: GuardMode
  /**
   * 造 task 工具（派子 agent）。返回 null = 这一轮不给这个工具。
   *
   * 为什么是个回调而不是直接传工具：它要拿到**审批装饰过**的注册表，
   * 而那个装饰是请求级的（sessionId 只在 runTurn 里才知道）。传现成的工具
   * 就只能拿到未装饰的注册表 —— 那样「派个子 agent 去改文件」会绕过审批。
   */
  makeTaskTool?: (guardedRegistry: ToolRegistry, config: Config) => Tool | null
}

export function createBuiltinProvider(deps: BuiltinDeps): Provider {
  return {
    id: BUILTIN_ID,

    async runTurn(req: TurnRequest): Promise<TurnResult> {
      // 审批装饰是**请求级**的：sessionId 只在这里才知道，装饰过的 registry
      // 不能在构造 provider 时做一次给所有会话共用。
      const guardedRegistry = guardRegistry(
        deps.registry,
        req.sessionId,
        deps.gate,
        deps.onApprovalRequest,
        deps.permission,
      )

      // task 工具在**装饰之后**注入：子 agent 拿到的是同一份带审批的注册表，
      // 所以它写文件同样要用户点确认。装饰之前注入的话，「派个子 agent 去
      // 改文件」就是一条绕过审批的旁路。
      const task = deps.makeTaskTool?.(guardedRegistry, req.config)
      const registry: ToolRegistry = task
        ? { ...guardedRegistry, [task.name]: task }
        : guardedRegistry

      // 流式回调绑定本次请求 —— 这就是 callModel 必须请求级重建的原因
      const callModel = deps.buildCallModel(
        req.config,
        registry,
        (text) => req.emit({ kind: 'delta', text }),
        () => req.emit({ kind: 'cache-hit' }),
      )

      // withCancel 套在**最外层**，即 buildCallModel 的返回值之外。
      //
      // 位置不是洁癖，套错了有实际后果（见 cancel.ts 的注释）：
      //   • 套在 withRetry 里面 → 取消被当成可重试失败，反复退避几轮才放弃
      //   • 套在 withFallback 里面 → 取消触发「换备用模型」，反而多打一次请求
      const cancellableCallModel = withCancel(callModel, req.token)

      const summarize = deps.makeSummarize(req.config)
      const evidence: string[] = []

      // TurnInfo（src/agent.ts，冻结）不带时间戳。onTurn 在每轮的工具都跑完后才
      // 触发一次，从不按单个工具调用触发，所以这里能诚实测量的只有「这一轮」的
      // 耗时（模型调用 + 该轮所有工具执行），不是某个具体工具的耗时。
      // turnStartedAt 在每轮结束时重置，作为下一轮的起点。
      let turnStartedAt = Date.now()

      const answer = await deps.runAgent(req.question, {
        callModel: cancellableCallModel,
        tools: registry,
        config: req.config,
        history: req.history,
        compact: (messages: Message[]) =>
          compactMessages(messages, {
            maxTokens: req.config.maxContextTokens,
            keepRecent: req.config.keepRecent,
            summarize,
          }),
        // system prompt 由 config 决定，不进历史文件。
        //
        // 过滤放在这一层而不是 runner 里：system 是**这个循环自己注入的**，
        // 所以「它不算历史」这件事只有这里知道。ACP provider 那边压根不会
        // 产出 system 消息（历史在 CLI 自己那侧）。
        onComplete: (messages: Message[]) =>
          req.onComplete(messages.filter((m) => m.role !== 'system')),
        onTurn: (info: TurnInfo) => {
          const elapsedMs = Date.now() - turnStartedAt
          turnStartedAt = Date.now()
          for (const t of info.toolResults) {
            evidence.push(`${t.name}: ${t.output}`)
            req.emit({
              kind: 'tool-call',
              turn: info.turn,
              name: t.name,
              args: t.args,
              output: t.output,
              // 同一轮内的所有工具调用共享这一个耗时值 —— 它们本来就是
              // 同一轮里一起测量的
              elapsedMs,
            })
          }
        },
      })

      return { answer, evidence }
    },
  }
}
