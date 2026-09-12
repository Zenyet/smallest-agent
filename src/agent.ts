// ============================================================================
// agent.ts —— 整个项目的「心脏」：一个手写的 ReAct 循环
// ----------------------------------------------------------------------------
// ReAct = Reasoning + Acting：想一步 → 做一步(调工具) → 看结果 → 再想，反复，
// 直到模型不再要调工具、给出最终答案。
//
// 这个文件从 Stage 0 到 Stage 5 几乎没动过——RAG / 记忆 / MCP / 缓存 / 评估
// 全是「在这个循环周围加东西」，循环本身一直是这 20 来行。
//
// 注：注释密度比生产代码高，是为了「边读边学」；真实项目里注释应只解释
// 「为什么 / 不直观的点」，不会像这样逐处说明。
// ============================================================================

import type { Config, ContentPart, Message, ModelResult, ToolRegistry } from './types'
import { userMessage } from './attachments'
import { runTool } from './tools/index'

// 每一轮的快照，给外部观察用（cli 拿它打印 trace、eval 拿它收集证据）。
export interface TurnInfo {
  turn: number
  result: ModelResult // 这一轮模型的输出（文本 + 想调的工具）
  toolResults: { name: string; args: Record<string, unknown>; output: string }[] // 这一轮实际跑了哪些工具及其结果
}

// runAgent 的「依赖」。前 3 个是核心；后 4 个是后面阶段加的可选「钩子」，
// 不传就退化成 Stage 0 的纯循环——这就是为什么加了它们也没破坏旧测试。
export interface AgentDeps {
  callModel: (messages: Message[]) => Promise<ModelResult> // 怎么调模型（注入，所以测试能塞假模型、cli 能套缓存/重试）
  tools: ToolRegistry // 有哪些工具可调
  config: Pick<Config, 'systemPrompt' | 'maxTurns'> // 系统提示 + 防死循环上限
  onTurn?: (info: TurnInfo) => void // 每轮回调：打印 trace / 收集证据
  history?: Message[] // Stage 2：上次会话的历史（记忆）
  attachments?: ContentPart[]
  compact?: (messages: Message[]) => Promise<Message[]> // Stage 2：开局压缩过长历史
  onComplete?: (messages: Message[]) => void | Promise<void> // Stage 2：跑完把完整消息存回去
  /**
   * 取消令牌。传了的话循环在每轮开始和每个工具之前查它，已取消就抛。
   *
   * ## 为什么必须在循环里查
   *
   * callModel 外面已经套了 withCancel（electron/main/cancel.ts），那能在
   * 「准备调模型」时拦住。但它拦不住工具：工具执行不经过 callModel。
   * 用户点停止时如果 agent 卡在一个慢工具上（web_search 拉不动、
   * read_file 读大文件），那一轮要一直跑到工具返回、下一次 callModel
   * 入口才看见取消标志 —— 而用户按停止正是因为等不及它跑完。
   *
   * ## 为什么是结构类型而不是 import CancelToken
   *
   * src/ 是核心，electron/ 是它的一层壳 —— 依赖方向只能是
   * electron → src。为了一个取消检查把方向倒过来，会让 CLI（也用 runAgent）
   * 莫名依赖上 Electron 那侧的模块。这里只需要「能问它取消了没」，
   * 声明成结构类型就够，CancelToken 天然满足。
   */
  token?: { throwIfCancelled(): void }
}

export async function runAgent(userInput: string, deps: AgentDeps): Promise<string> {
  const { callModel, tools, config, onTurn, history, compact, onComplete, token } = deps

  // 上下文 = 系统提示 +（可选）历史 + 本轮用户问题。
  // messages 这个数组就是 agent 的「工作台/短期记忆」，整个循环都在往里加东西。
  let messages: Message[] = [
    { role: 'system', content: config.systemPrompt },
    ...(history ?? []), // 没有历史就是空（Stage 0 行为）
    userMessage(userInput, deps.attachments),
  ]

  if (compact) messages = await compact(messages) // Stage 2：太长就先摘要压缩，再进循环

  // ===== ReAct 循环本体 =====
  // turn/maxTurns 只是「最多转几圈」的保险，防止模型无限调工具卡死。
  for (let turn = 1; turn <= config.maxTurns; turn++) {
    // 每轮开头查一次取消 —— 在 callModel 之前。
    //
    // withCancel 已经套在 callModel 外面（builtin.ts），那里也会查。
    // 但「准备进入下一轮」和「调模型」之间可能有几百毫秒（压缩、装配提示），
    // 在这里多查一次能让停止更快响应。不传 token 的话这是空操作。
    token?.throwIfCancelled()

    // 【Reasoning 想】问模型：看了目前的 messages，你下一步干嘛？
    const result = await callModel(messages)

    // 把模型这轮的输出记进 messages（可能是最终文本，也可能是「我要调这些工具」）。
    messages.push({
      role: 'assistant',
      content: result.text,
      ...(result.usage ? { usage: result.usage } : {}),
      toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
      timestamp: Date.now(),
    })

    // 服务端已经跑完的工具（DeepSeek / OpenAI 的 web_search）先垫进来。
    //
    // 它们不进下面那个执行循环 —— 已经跑完了，再跑一次既没意义、本地也
    // 没有这个工具。但要进 toolResults，否则 onTurn 报告不出去，
    // 界面上「联网搜索了」这件事完全看不见。
    //
    // output 序列化成字符串：TurnInfo.toolResults 的 output 是 string
    // （本地工具那条路上是 runTool 的 JSON 返回值），两边形状要一致，
    // 否则消费方（trace 打印、UI 卡片）得分两种情况处理。
    const toolResults: TurnInfo['toolResults'] = (result.serverToolCalls ?? []).map((c) => ({
      name: c.name,
      args: c.args,
      output: typeof c.output === 'string' ? c.output : JSON.stringify(c.output),
    }))

    // 【出口】模型没要调工具 = 它觉得能直接回答了 → 返回，循环结束。
    if (result.toolCalls.length === 0) {
      onTurn?.({ turn, result, toolResults })
      await onComplete?.(messages) // Stage 2：把这次完整对话存回会话文件
      return result.text
    }

    // 【Act 做 + Observation 看结果】模型要调工具：逐个执行，把结果作为 'tool'
    // 消息喂回 messages。关键就在这——下一圈顶部的 callModel 会带着「工具结果」
    // 再问一次，模型于是能基于真实数据继续推理。这就是 messages「滚雪球」的地方。
    for (const call of result.toolCalls) {
      // 工具之间也查一次：一轮里要调 5 个工具、第 1 个就卡住时，不查的话
      // 要等它跑完才看见取消。现在每个工具开始前都查，最坏情况是「当前
      // 这个工具跑完」（几秒），不是「这一轮所有工具跑完」（可能几十秒）。
      token?.throwIfCancelled()
      const output = await runTool(tools, call.name, call.args)
      messages.push({ role: 'tool', content: output, toolCallId: call.id, name: call.name })
      toolResults.push({ name: call.name, args: call.args, output })
    }
    onTurn?.({ turn, result, toolResults })
    // 循环回到顶部，带着新增的工具结果再问模型 → 这就是 ReAct 的「再想一步」
  }

  // 转满 maxTurns 还没收尾 = 大概率模型陷在反复调工具里，主动报错而不是无限跑。
  throw new Error(`Agent exceeded maxTurns (${config.maxTurns}) without finishing`)
}
