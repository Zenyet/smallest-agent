// ============================================================================
// provider/acp.ts —— 驱动外部 agent CLI（Claude Code / Codex / Gemini / …）
// ----------------------------------------------------------------------------
// 走 ACP（Agent Client Protocol）标准协议，模型逻辑在别人进程里。
//
// ## 为什么一个实现就够，不用每家一个 driver
//
// 凡是提供 ACP 适配器的 CLI 都是同一套请求-通知流。waku 那边 `src/driver/`
// 有 12 个文件，因为它用各家原生协议、要拿到各家独有能力（rewind、
// computer-use 那些）。走标准协议拿不到那些，换来的是「一个界面管所有 agent」
// 只需要这一个文件。
//
// ## 必须用 connect 而不是 connectWith
//
// SDK 的例子用 `connectWith(stream, async (ctx) => ...)`，那是**作用域式**的：
// 整个会话活在那个闭包里，闭包返回连接就断。而我们要的是「建一次连接、
// 多轮对话」—— 用户在同一个会话里连续提问，CLI 那侧维护着上下文，
// 那正是用外部 CLI 的意义。
//
// `connect(stream)` 返回长命的 ClientConnection，存在字段里，跨轮复用。
//
// （gpui 侧为这件事写了一整套「连接住在长任务里 + mpsc 把手」的结构，那是绕
// Rust 的 `ConnectionTo<Agent>: !Send` 约束用的 —— TS 没有这个约束，
// 所以这个文件比那边短很多。见设计文档「和 gpui 侧的差异」。）
//
// ## 一个连接、多个 ACP 会话
//
// 实例按 (providerId, modelId) 缓存（见 registry.ts），所以两个都走
// Claude Code 的会话共用同一个子进程 —— 起一个 node 进程要几秒，不能每个
// 会话起一个。但「共用子进程」不等于「共用对话」：这里按我们自己的 sessionId
// 各开一个 ACP 会话，存在 #sessions 里。
//
// 不这么做的后果是一类看不见的 bug：B 的提问带着 A 的上下文回答，界面上是
// 两条独立对话，CLI 那侧是一条 —— 只表现成「模型莫名提到我没说过的事」。
// ============================================================================

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { Cancelled } from '../cancel'
import type { Message } from '../../../src/types'
import type { ApprovalDecision, ApprovalRequestEvent } from '../../shared/channels'
import type { Provider, TurnRequest, TurnResult } from './types'

/** 起一个 ACP agent 要知道的东西。resolveLaunch 的输出直接喂进来。 */
export interface AcpSpec {
  /** provider id，做实例 id 用 */
  id: string
  /** 显示名，错误消息里用（「Claude Code 起不来」比「claude-code 起不来」好读） */
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  /** 子进程的工作目录，同时是 ACP 会话的 cwd */
  cwd?: string
}

export interface AcpDeps {
  /**
   * 要审批时问用户。复用现有的审批闸口（approval.ts）——
   * ACP 的权限请求和内置 agent 的写工具审批是同一件事：
   * 「有后果的动作执行前必须显式确认」。
   */
  requestApproval: (event: ApprovalRequestEvent) => Promise<ApprovalDecision>
  /** 生成审批请求 id。注入是为了测试里能给出确定的值。 */
  newRequestId: () => string
}

/** 把 ContentBlock 里的文字取出来。非文本块（图片、资源）给一个占位。 */
/**
 * ACP 那侧的 sessionId → 我们这侧正在跑的那一轮属于哪个会话。
 *
 * 见 createAcpProvider 里 slots 的注释。
 */
export type TurnSlots = Map<string, { sessionId: string }>

/**
 * 一个权限请求该记到我们哪个会话名下。查不到返回 null（调用方拒绝它）。
 *
 * ## 为什么单独抽出来
 *
 * 这行逻辑原来长在连接回调里（onRequest 的闭包），从外面测不到 —— 要测得
 * 起一个真的子进程、走完握手。而它恰恰是并发之后最容易错的一处：拿错了
 * 会把 A 会话的写文件确认框弹到 B 会话头上，而这种错误在界面上看起来像
 * 「审批框串台」，不像一个归属查询的 bug。
 */
export function resolveTurnOwner(
  slots: TurnSlots,
  acpSessionId: string,
): { sessionId: string } | null {
  return slots.get(acpSessionId) ?? null
}

function blockText(block: acp.ContentBlock): string {
  if (block.type === 'text') return block.text
  // 图片/音频/资源链接：正文里放一个标记，比静默丢掉好 ——
  // 用户至少知道那里有个东西没显示出来
  return `[${block.type}]`
}

/** 工具调用的输出：把 content 数组压成一段文字。 */
function toolOutput(content: acp.ToolCallContent[] | null | undefined): string {
  if (!content || content.length === 0) return ''
  return content
    .map((c) => {
      if (c.type === 'content') return blockText(c.content)
      if (c.type === 'diff') return `--- ${c.path}\n${c.newText}`
      // terminal：输出在那个终端里，这里只能标一下
      return '[terminal]'
    })
    .join('\n')
}

/**
 * ACP 的权限选项映射到我们的「允许 / 拒绝」。
 *
 * ACP 给的是四档（allow_once / allow_always / reject_once / reject_always），
 * 我们的审批卡只有两个按钮。**一律选 once 那一档**：
 * always 会让 CLI 记住这个决定，而用户点的是我们这张卡，他不知道自己在给
 * 那个 CLI 写一条持久规则。要 always 就得先有个「记住这次选择」的复选框，
 * 那是另一件事。
 *
 * 找不到对应档位时回落到任意一个同向选项 —— 各家 CLI 给的选项集不完全一样，
 * 硬要 once 会导致某些 CLI 上永远批不过。
 */
function pickOption(
  options: acp.PermissionOption[],
  decision: ApprovalDecision,
): acp.PermissionOptionId | null {
  const want: acp.PermissionOptionKind[] =
    decision === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
  for (const kind of want) {
    const hit = options.find((o) => o.kind === kind)
    if (hit) return hit.optionId
  }
  return null
}

/**
 * 把之前的历史压成一段前言。
 *
 * ## 为什么需要它
 *
 * CLI 自己管对话历史，但**只管它自己经手的那些**。用户可能先用内置 agent 聊
 * 了几轮再切到 Claude Code，那几轮在我们的会话文件里、不在 CLI 那侧。
 * 不带过去的话它会以为对话刚开始。
 *
 * 只在这个 ACP 会话的**第一轮**带（之后 CLI 自己记得），而且只带用户和助手的
 * 正文 —— 工具轨迹不带：那些是内置 agent 用我们的工具做的事，对 CLI 没有意义，
 * 而且会把前言撑得很长。
 */
function historyPreamble(history: Message[]): string | null {
  const lines = history
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim() !== '')
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
  if (lines.length === 0) return null
  return `（以下是这次对话之前的记录，供你参考）\n${lines.join('\n\n')}`
}

export function createAcpProvider(spec: AcpSpec, deps: AcpDeps): Provider & { dispose(): void } {
  // stderr 是 'inherit'（透传给我们的终端），所以类型上它是 null ——
  // ChildProcessWithoutNullStreams 对不上。写成精确的那个三元组
  let child: ChildProcessByStdio<Writable, Readable, null> | null = null
  let conn: acp.ClientConnection | null = null
  let ctx: acp.ClientContext | null = null
  /** 我们的 sessionId → ACP 的 ActiveSession */
  const sessions = new Map<string, acp.ActiveSession>()
  /**
   * 正在跑的那些轮次的审批落点，按 ACP 那侧的 sessionId 索引。
   *
   * 权限请求的 handler 在**连接建立时**就注册好了（onRequest 是连接级的），
   * 而「这次审批属于哪个会话」每轮不同，所以需要一张表把它找回来。
   *
   * ## 为什么是 Map 而不是一个格子
   *
   * 原来这里是 `let slot: { sessionId } | null`，每轮覆盖里面的东西。那在
   * 全局串行锁下是对的 —— 同时只可能有一轮。但锁已经改成按会话的
   * （agent-runner.ts），而 provider 实例按 (provider, 模型) 缓存、**多个会话
   * 共用一条连接**：两个会话都走 Claude Code 时会同时有两轮在跑，后开的那轮
   * 把格子覆盖掉，于是前一轮的权限请求被记到后一个会话名下 —— 用户在 B 会话
   * 看到一个 A 会话要写文件的确认框，点了之后 A 那边才动。
   *
   * 用 ACP 的 sessionId 当键而不是我们的：权限请求里带的是那一个
   * （c.params.sessionId），我们的 id 在那个载荷里不存在。
   *
   * 不需要锁 —— 主进程是单线程事件循环。
   */
  const slots: TurnSlots = new Map()

  /** 起子进程 + 握手。只在第一次对话时做（懒建）。 */
  async function ensureConnected(): Promise<acp.ClientContext> {
    if (ctx) return ctx

    // stdio: pipe/pipe/inherit —— stderr 直接透到我们的终端。
    //
    // 不捕获 stderr：那是 CLI 的日志和认证提示（「请在浏览器里登录」之类），
    // 捕获了就得自己决定显示在哪儿，而它们对排查启动失败最有用。
    // 透传的代价是它们混在我们的日志里，加了 [acp:id] 前缀也没法过滤 ——
    // 接受这个代价，比把认证提示藏起来好。
    const proc = spawn(spec.command, spec.args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ...spec.env },
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
    })
    child = proc

    // spawn 本身不抛错（ENOENT 走 error 事件），所以要在这里接一下 ——
    // 不接的话「命令不存在」会变成一个 unhandled error 事件把主进程带崩
    proc.on('error', (err) => {
      console.error(`[acp:${spec.id}] 子进程起不来：${err.message}`)
      reset()
    })
    proc.on('exit', (code, signal) => {
      // CLI 自己退了（崩溃、被杀、npx 拉包失败）。清掉状态，下一轮会重新起 ——
      // 不清的话 conn 还在，往一个死掉的 stdin 上写，请求永远不返回
      if (code !== 0) {
        console.error(`[acp:${spec.id}] 子进程退出：code=${code} signal=${signal}`)
      }
      reset()
    })

    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
    )

    const connection = acp
      .client({ name: 'smallest-agent' })
      .onRequest(acp.methods.client.session.requestPermission, async (c) => {
        // agent 要写文件 / 执行命令，转成我们的审批卡。
        //
        // **不能自动批准**（SDK 的例子那么做，但那是例子）—— 自动批准等于
        // 绕过用户对这些 CLI 权限模型的预期：他以为 Claude Code 会问他。
        // 按请求里带的 ACP sessionId 查这一轮属于我们哪个会话。
        //
        // 不能用「当前那一轮」—— 多个会话共用一条连接时同时会有几轮在跑
        // （锁按会话，见 agent-runner.ts），拿错了会把 A 的写文件确认框
        // 弹到 B 会话头上。
        const current = resolveTurnOwner(slots, c.params.sessionId)
        if (!current) {
          // 收到一个不属于任何在跑轮次的权限请求：不该发生。保守起见拒绝，
          // 而不是批准一个我们不知道归属的操作
          return { outcome: { outcome: 'cancelled' } }
        }
        const decision = await deps.requestApproval({
          sessionId: current.sessionId,
          requestId: deps.newRequestId(),
          // 工具名：ACP 的 name 是 UNSTABLE 且可能缺，缺了就用给人看的 title
          toolName: c.params.toolCall.name ?? c.params.toolCall.title ?? '(未命名操作)',
          // rawInput 是 unknown，审批卡要 Record。不是对象就包一层，
          // 让卡片至少能显示出「参数是这个」
          args:
            c.params.toolCall.rawInput && typeof c.params.toolCall.rawInput === 'object'
              ? (c.params.toolCall.rawInput as Record<string, unknown>)
              : { input: c.params.toolCall.rawInput ?? null },
        })
        const optionId = pickOption(c.params.options, decision)
        // 一个同向的选项都没有：只能报 cancelled。批准一个「拒绝」选项
        // 或反过来，都比说不清更糟
        if (!optionId) return { outcome: { outcome: 'cancelled' } }
        return { outcome: { outcome: 'selected', optionId } }
      })
      .connect(stream)

    conn = connection

    // 握手。失败要把子进程收掉 —— 否则一个连不上的 npx 会一直挂在那儿
    try {
      await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        // 不声明 fs / terminal 能力：那些 CLI 自己就有文件访问和终端，
        // 声明了等于多一条要审批的路径，而它们并不需要我们代劳。
        clientCapabilities: {},
      })
    } catch (err) {
      reset()
      throw new Error(
        `${spec.name} 握手失败：${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }

    ctx = connection.agent
    return ctx
  }

  function reset(): void {
    // 会话把手绑在这条连接上，连接没了它们也没意义
    for (const s of sessions.values()) s.dispose()
    sessions.clear()
    // 审批落点同理：连接断了那些轮次都不可能再推进，留着只会让一个
    // 迟到的权限请求匹配到一个已经死掉的会话
    slots.clear()
    conn = null
    ctx = null
    child = null
  }

  /** 拿（必要时先建）这个会话的 ACP 会话。 */
  async function ensureSession(
    req: TurnRequest,
  ): Promise<{ session: acp.ActiveSession; fresh: boolean }> {
    const existing = sessions.get(req.sessionId)
    if (existing) return { session: existing, fresh: false }

    const context = await ensureConnected()
    // cwd 必须是绝对路径（协议要求）。没有项目目录的会话用进程的 cwd ——
    // 不理想，但 session/new 没有「不给 cwd」这个选项
    const cwd = req.cwd ?? spec.cwd ?? process.cwd()
    const session = await context.buildSession(cwd).start()
    sessions.set(req.sessionId, session)
    return { session, fresh: true }
  }

  return {
    id: spec.id,

    async runTurn(req: TurnRequest): Promise<TurnResult> {
      req.token.throwIfCancelled()

      req.emit({ kind: 'notice', text: `正在连接 ${spec.name}…` })
      const { session, fresh } = await ensureSession(req)

      // 第一轮把我们这侧的历史当前言带过去，见 historyPreamble 的注释
      const preamble = fresh ? historyPreamble(req.history) : null
      const prompt = preamble ? `${preamble}\n\n---\n\n${req.question}` : req.question

      // 按 ACP 那侧的 sessionId 登记，权限请求 handler 靠它找回归属
      slots.set(session.sessionId, { sessionId: req.sessionId })
      let answer = ''

      // 取消：发 session/cancel 通知，然后等 agent 回 stopReason: 'cancelled'。
      //
      // 比内置那边的轮边界取消利落 —— 不用等下一轮 callModel 入口。
      // 协议要求客户端在取消后**继续接收**工具调用更新（agent 可能还要发几条
      // 最终更新），所以这里不能直接 return，要读到 stop 为止。
      const sendCancel = () => {
        void ctx
          ?.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId })
          // 连接可能已经断了（子进程崩了）。那时这条通知发不出去，但那一轮
          // 本来也已经结束了 —— 记一行就够，不该把它变成用户看到的错误
          .catch((err: unknown) => {
            console.error(`[acp:${spec.id}] 发取消通知失败：`, err)
          })
      }
      // 订阅而不是轮询：nextUpdate() 阻塞在「等子进程说话」上，而 CLI 正在
      // 闷头跑长工具时它一声不吭 —— 轮询要等到它下次开口才生效，
      // 而那恰恰是最想停下来的时刻。见 CancelToken.onCancel 的注释。
      // 已经取消的话 onCancel 会同步立刻回调，不会漏掉。
      const unsubscribe = req.token.onCancel(sendCancel)

      try {
        // prompt 不 await：它要等整轮跑完才 resolve，而我们要在这期间读通知流。
        // 它的结果会作为一条 stop 消息进 nextUpdate() 的队列（SDK 保证），
        // 所以下面的循环能拿到最终结果。
        //
        // catch 挂一个空处理：这个 promise 的错误由下面的循环通过抛出感知，
        // 不挂的话 Node 会报 unhandled rejection
        const pending = session.prompt(prompt)
        pending.catch(() => {})

        for (;;) {
          const msg = await session.nextUpdate()

          if (msg.kind === 'stop') {
            // 用户点了停止，且 agent 确认停了 —— 抛 Cancelled 让 runner 走
            // 取消路径（存盘 + 发 cancelled 事件，不显示成红色报错）
            if (msg.stopReason === 'cancelled' || req.token.isCancelled()) {
              throw new Cancelled()
            }
            if (msg.stopReason === 'refusal') {
              req.emit({ kind: 'notice', text: `${spec.name} 拒绝了这个请求` })
            }
            break
          }

          const u = msg.update
          switch (u.sessionUpdate) {
            case 'agent_message_chunk': {
              const text = blockText(u.content)
              answer += text
              req.emit({ kind: 'delta', text })
              break
            }
            case 'tool_call':
              // turn 填 0：ACP 没有 ReAct 圈数这个概念（见 TurnEvent 的注释）。
              // 界面按 turn 分组，0 表示「都算同一组」
              req.emit({
                kind: 'tool-call',
                turn: 0,
                name: u.name ?? u.title,
                args:
                  u.rawInput && typeof u.rawInput === 'object'
                    ? (u.rawInput as Record<string, unknown>)
                    : {},
                output: toolOutput(u.content),
              })
              break
            case 'tool_call_update':
              // 只在跑完时补一条：pending / in_progress 每次都发的话，
              // 界面上同一个工具会出现好几行
              if (u.status === 'completed' || u.status === 'failed') {
                req.emit({
                  kind: 'tool-call',
                  turn: 0,
                  name: u.name ?? u.title ?? '(工具)',
                  args: {},
                  output:
                    u.status === 'failed'
                      ? // 失败要让界面标红。ToolCallIndicator 认的是 output 里的
                        // {"error":...}（见那个组件），所以按它的形状给
                        JSON.stringify({ error: toolOutput(u.content) || '工具执行失败' })
                      : toolOutput(u.content),
                })
              }
              break
            case 'agent_thought_chunk':
              // 思考过程不进正文 —— 它不是答案。界面上的 ThinkingState 走的是
              // 另一条路（工具轨迹），这里先不接：接了要新开一条 IPC 通路，
              // 而「思考过程要不要显示」是个产品判断，不该顺手做掉
              break
            default:
              // plan / usage / mode 那些暂不处理。不打日志 —— 它们每轮好几条，
              // 会把终端刷满
              break
          }
        }

        // 存盘。CLI 自己管它那侧的历史，但我们的会话文件也要有 ——
        // 侧边栏的标题、切回来时的历史回放都靠它。
        //
        // 只存「用户问了什么 + 助手答了什么」：工具轨迹是 CLI 那侧的事，
        // 我们拿到的形状（turn 填 0、args 常常是空）写进历史文件也重建不出来。
        await req.onComplete([
          ...req.history,
          { role: 'user', content: req.question },
          { role: 'assistant', content: answer },
        ])

        // evidence 空：外部 CLI 自己管工具，我们拿不到可比对的证据，
        // runner 那边会因此跳过核查（见 TurnResult.evidence 的注释）
        return { answer, evidence: [] }
      } finally {
        unsubscribe()
        // 只删自己那一格。原来是 `slot = null`（清掉唯一那个格子），
        // 并发之后那等于把别的会话正在跑的那轮也一起抹掉 ——
        // 它的权限请求随后会查不到归属、被保守拒绝。
        slots.delete(session.sessionId)
      }
    },

    /** 关掉子进程。app 退出、或这个 provider 被从配置里删掉时调。 */
    dispose(): void {
      const proc = child
      reset()
      conn?.close()
      // SIGTERM 而不是 kill()：给 CLI 一个机会收尾（它可能正在写自己的
      // 会话文件）。它不理的话进程退出时操作系统会收掉
      proc?.kill('SIGTERM')
    },
  }
}
