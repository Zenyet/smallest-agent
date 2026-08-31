// ============================================================================
// provider/types.ts —— 「这一轮由谁来跑」的抽象
// ----------------------------------------------------------------------------
// 到目前为止 agent-runner 直接调 runAgent，也就是把「内置 agent」这一种实现
// 写死在了请求装配里。这个接口把它变成两种之一：
//
//   • BuiltinProvider —— 本仓库自己的 ReAct 循环（src/agent.ts）
//   • AcpProvider     —— 驱动外部 agent CLI（Claude Code / Codex / …），
//                        走 ACP 协议，模型逻辑在别人进程里
//
// 两者**并列而不是取代**：内置 agent 是一份能读懂的最小实现（那套教学注释是
// 资产），外部 CLI 是「一个界面管所有 agent」的实用价值。
//
// ## 为什么事件收进一个 sink，而不是保留 runner 那组独立回调
//
// runner 现在用 emit.chunk / emit.toolCall / emit.cacheHit 几个独立回调，各自
// 绑一个 IPC 频道。这在只有内置 agent 时够用，但 ACP 那边天生就是一条通知流
// （session/update），硬拆成几个回调是反着来的。统一成一个 sink 之后，
// 「翻译成哪个 IPC 事件」留在 runner 里，provider 只管产出事件。
//
// 现有的 8 个 IPC 事件频道一个都不动 —— 那是 renderer 侧零改动的前提。
// ============================================================================

import type { CancelToken } from '../cancel'
import type { Config, Message } from '../../../src/types'

/**
 * 一轮对话过程中发生的事。两种 provider 都产出这些。
 *
 * ACP 那边的 session/update 通知会被翻译成这里的变体，内置 agent 则由
 * runAgent 的钩子转过来。
 */
export type TurnEvent =
  /** 流式文本增量，逐 token 到达 */
  | { kind: 'delta'; text: string }
  /** 一个工具跑完了 */
  | {
      kind: 'tool-call'
      /** 第几轮（ReAct 的圈数）。ACP 那边没有这个概念，填 0。 */
      turn: number
      name: string
      args: Record<string, unknown>
      output: string
      /** 这一轮的耗时。同一轮内所有工具共享同一个值（按轮测量，不是按工具）。 */
      elapsedMs?: number
    }
  /** 缓存命中，这一轮没联网。只有内置 provider 会发。 */
  | { kind: 'cache-hit' }
  /**
   * provider 想说一句话（连接状态、认证提示之类），UI 显示成提示行。
   *
   * 有这个变体是因为外部 CLI 会报告一些内置 agent 没有的状态
   * （「正在起子进程」「需要先登录」），不该为每种都加一个变体。
   */
  | { kind: 'notice'; text: string }

/**
 * 事件接收端。
 *
 * 主进程是单线程事件循环，所以这里不像 rs 侧那样需要考虑「可能在任意线程上
 * 被调用」—— 那边的注释是绕 Send 约束的，不是设计的一部分。
 */
export type EventSink = (event: TurnEvent) => void

/**
 * 跑一轮需要的东西。
 *
 * 打包成结构体而不是一串参数：字段会随 provider 种类增加（ACP 要 cwd、
 * 要权限模式），位置参数迟早排到七八个。
 */
export interface TurnRequest {
  question: string
  /**
   * 附件（图片、PDF 等）。可选，用于多模态输入。
   */
  attachments?: any[]
  /**
   * 这一轮属于**哪个会话**（我们自己的会话 id，不是 ACP 那边的）。
   *
   * ## 为什么 provider 必须知道会话 id
   *
   * 一个 provider 实例服务多个会话 —— 外部 CLI 的实例按 (provider, 模型)
   * 缓存，因为起一个 node 子进程要几秒，不能每个会话起一个。但「共用子进程」
   * 不等于「共用对话」：ACP 协议本身支持一个连接上开多个 session，
   * 所以子进程可以共用，会话必须分开。
   *
   * 不带这个字段的后果是一类看不见的 bug：两个会话都走 Claude Code 时，
   * 它们发到同一个 ACP session 上，B 的提问带着 A 的上下文回答。界面上是
   * 两条独立对话，CLI 那侧是一条 —— 只表现成「模型莫名提到我没说过的事」。
   */
  sessionId: string
  /** 这一轮之前的历史。runner 从磁盘读好传进来 —— 持久化归 runner 管。 */
  history: Message[]
  /**
   * 这一轮用哪份配置。runner 每轮读一次传进来，而不是 provider 自己读 ——
   * 一轮之内配置只该有一个真相（用户中途改设置不该让同一轮前后半段用两份）。
   */
  config: Config
  /**
   * 工作目录。外部 CLI 的 cwd 决定它能看到哪些文件；内置 agent 目前不用它
   * （文件工具走 MCP，沙盒根由那边定）。
   *
   * 复用侧边栏那个项目的目录，不另设一个全局设置 —— 会话本来就有工作目录，
   * 新建对话时就选了。两个真相一旦不一致，用户看着 A 目录、agent 在 B 里干活。
   */
  cwd?: string
  emit: EventSink
  token: CancelToken
  /**
   * 一轮结束时存盘。
   *
   * 放在请求上而不是构造 provider 时给：provider 实例跨会话复用（外部 CLI
   * 按 (provider, 模型) 缓存），而存盘钩子绑一个会话。rs 侧也是为这个把
   * on_complete 从构造挪到了 TurnRequest 上。
   */
  onComplete: (messages: Message[]) => Promise<void>
}

/** 一轮的结果。 */
export interface TurnResult {
  /** 完整答案 */
  answer: string
  /**
   * 工具轨迹，给事后核查（verify）用。
   *
   * 外部 CLI 返回空：它自己管工具，我们看不到它调了什么，拿不到可比对的证据。
   * 而 verify 的语义是「答案有没有被这些证据支撑」—— 没有证据时跑它只是
   * 白花一次模型调用（runner 侧已经有「evidence 为空就跳过」的判断）。
   */
  evidence: string[]
}

/** 「一轮对话由谁来跑」。 */
export interface Provider {
  readonly id: string
  runTurn(req: TurnRequest): Promise<TurnResult>
}
