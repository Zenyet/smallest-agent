// ============================================================================
// types.ts —— 全项目共享的「词汇表」
// ----------------------------------------------------------------------------
// 这里定义的类型就是整个 agent 系统的「通用语言」：
//   - 消息协议（Role / Message / ToolCall）：agent.ts、llm.ts、trace.ts 都用这套
//   - 模型出口（ModelResult）：callModel 每次调用返回的统一结构
//   - 工具系统（Tool / ToolRegistry）：工具注册 + llm.ts 里转成 SDK 格式
//   - 顶层配置（Config）：环境变量驱动，贯穿各阶段
//   - callModel 类型别名（CallModel）：让 agent.ts 只依赖这个签名，方便测试注入假实现
// ============================================================================

// 消息的「发言角色」：系统指令、用户、AI、工具结果 四种。
// 注意 'tool' 在 ReAct 循环里专门用来把工具执行结果喂回模型。
export type Role = 'system' | 'user' | 'assistant' | 'tool'

// 模型在 assistant 消息里「声明要调用某个工具」时附带的信息。
// id 由模型生成，必须和后续 tool 消息里的 toolCallId 对上，
// 模型才能把「调用请求」和「调用结果」关联起来。
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

// 整个 agent 循环里流转的「消息」单元。
// 一条消息对应 LLM 消息协议中的一个 turn，不同 role 用到的字段不同：
//   - assistant (带工具调用)  → toolCalls 有值
//   - tool (工具结果)         → toolCallId + name 有值，与 ToolCall.id 对应
//   - system / user / assistant (纯文本) → 只用 content
export interface Message {
  role: Role
  content: string
  toolCalls?: ToolCall[]   // 仅出现在"请求调用工具"的 assistant 消息上
  toolCallId?: string      // 仅出现在 tool 消息上（回答的是哪个 call）
  name?: string            // 工具名，仅出现在 tool 消息上
}

// callModel 每次调用的返回值：文本回答 + 这轮想调的工具列表（可能为空）。
// agent.ts 根据 toolCalls.length 判断「继续循环」还是「终止返回 text」。
export interface ModelResult {
  text: string
  toolCalls: ToolCall[]
}

// callModel 的函数签名别名。
// agent.ts 只依赖这个签名而不引入 llm.ts，所以测试时可以直接注入一个
// 返回固定 ModelResult 的假函数，不需要真正调 API。
export type CallModel = (messages: Message[]) => Promise<ModelResult>

// 单个工具的描述 + 执行函数。
// parameters 是 zod schema，在 llm.ts 里会被转成模型能理解的 JSON Schema 格式
// （通过 AI SDK 的 tool() 包装）。
export interface Tool {
  name: string
  description: string
  parameters: unknown      // 一个 zod schema；在 llm.ts 里转成模型的 tool 定义
  run: (args: any) => unknown | Promise<unknown>
}

// 工具注册表：name → Tool。agent 循环里通过工具名直接查找并执行。
export type ToolRegistry = Record<string, Tool>

// 整个项目的运行时配置，由 config.ts 从环境变量读取并填默认值。
// 各字段分属不同阶段：
//   Stage 0  → apiKey / baseURL / model / temperature / maxTurns / systemPrompt
//   Stage 3+ → embeddingModel / notesDir / hfEndpoint / localModelPath (RAG)
//   Stage 2  → sessionId / sessionsDir / maxContextTokens / keepRecent (记忆)
//   Stage 4+ → fallbackModel / maxRetries (重试/降级)
//   Stage 4b → cacheEnabled / cacheDir / stream (缓存 + 流式)
export interface Config {
  apiKey: string
  baseURL: string
  model: string
  temperature: number
  maxTurns: number
  systemPrompt: string
  embeddingModel: string
  notesDir: string
  hfEndpoint?: string        // HuggingFace 下载源；国内连不上官方时设为镜像 https://hf-mirror.com
  localModelPath?: string    // 本地模型目录；设了就离线加载、不走网络
  sessionId: string          // 会话标识；不同 id 互不干扰
  sessionsDir: string        // 会话 JSON 文件目录
  maxContextTokens: number   // 历史超过这个估算 token 数就压缩
  keepRecent: number         // 压缩时保留的最近消息条数
  fallbackModel: string      // 主模型连续失败时切到的备用模型
  maxRetries: number         // 瞬时错误的额外重试次数
  cacheEnabled: boolean      // 是否启用 LLM 结果磁盘缓存
  cacheDir: string           // 缓存目录
  stream: boolean            // 是否流式打印最终答案
}
