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

/**
 * 多模态内容：文本、图片、文件（PDF 等）。
 * 用于 user 消息的 content 字段（可选：不传时使用旧的 string content）。
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      /** base64 编码的图片数据，格式：data:image/png;base64,... */
      data: string
      /** 可选的文件名（用于 UI 显示） */
      filename?: string
      /** 分析细节级别：auto（自动）、low（低分辨率）、high（高分辨率） */
      detail?: 'auto' | 'low' | 'high'
    }
  | {
      type: 'file'
      /** base64 编码的文件数据 */
      data: string
      /** MIME 类型，如 'application/pdf' */
      mimeType: string
      /** 文件名 */
      filename: string
    }

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
//   - user (多模态)           → contentParts 有值（图片 + 文件）
export interface TokenUsage {
  vendorId?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  reasoningTokens?: number
  contextTokens?: number
  localCacheHit?: boolean
}

export interface Message {
  usage?: TokenUsage
  usages?: TokenUsage[] // completed calls retained when a desktop turn is interrupted
  role: Role
  /**
   * 纯文本内容（向后兼容）。
   * 多模态消息（user 带图片/文件）时这个字段仍然保留文本部分。
   */
  content: string
  /**
   * 多模态内容数组（可选）。
   * 当 user 消息包含图片或文件时使用。
   */
  contentParts?: ContentPart[]
  toolCalls?: ToolCall[]   // 仅出现在"请求调用工具"的 assistant 消息上
  toolCallId?: string      // 仅出现在 tool 消息上（回答的是哪个 call）
  name?: string            // 工具名，仅出现在 tool 消息上
  /**
   * 这条消息发生的时刻（Date.now()）。
   *
   * 可选，因为**旧会话文件里没有这个字段** —— 那些消息我们确实不知道它们
   * 是什么时候发生的，界面上就不显示时间，而不是拿存盘时刻冒充（那会把
   * 三天前的提问标成「今天 14:32」，比不显示更糟）。
   *
   * 在消息**创建时**打戳，不在存盘时补：存盘发生在一轮结束，用它当时刻的话，
   * 用户 14:00 发的问题会被标成 14:05（模型答完的时刻）。
   */
  timestamp?: number
}

// callModel 每次调用的返回值：文本回答 + 这轮想调的工具列表（可能为空）。
// agent.ts 根据 toolCalls.length 判断「继续循环」还是「终止返回 text」。
export interface ModelResult {
  usage?: TokenUsage
  text: string
  toolCalls: ToolCall[]
  /**
   * 厂商**在服务端跑完**的工具（DeepSeek / OpenAI 的 web_search）。
   *
   * ## 为什么和 toolCalls 分开
   *
   * toolCalls 的语义是「模型要我们去跑这些」—— agent 循环会逐个执行、
   * 把结果回传。而这些是**已经跑完的**：模型调它、服务端执行、结果直接
   * 进了响应。混进 toolCalls 的话循环会拿 `web_search` 去本地注册表里查，
   * 查不到就返回 `{"error":"unknown tool"}` 喂回模型 —— 模型会以为
   * 搜索失败了。
   *
   * 分开之后循环不碰它们，但 onTurn 仍然报告出去，所以界面上看得见
   * 「联网搜索了」这件事。这正是加这个字段的理由。
   */
  serverToolCalls?: ServerToolCall[]
}

/** 服务端执行完的一次工具调用。 */
export interface ServerToolCall {
  name: string
  args: Record<string, unknown>
  /** 结果。SDK 给什么就是什么（可能是结构化对象），序列化交给上层。 */
  output: unknown
}

// callModel 的函数签名别名。
// agent.ts 只依赖这个签名而不引入 llm.ts，所以测试时可以直接注入一个
// 返回固定 ModelResult 的假函数，不需要真正调 API。
/**
 * signal：中断进行中的那次 HTTP 请求。
 *
 * 为什么它必须一路传到这儿：一轮里最长的等待是「等模型响应」，而那是一次
 * HTTP 请求 —— 在 SDK 里面、在 undici 里面，我们的循环没有执行权。轮询查
 * 不到它，回调也没有能打断它的手段。AbortSignal 是唯一能真正中断
 * 进行中的 fetch 的机制。
 *
 * 不传就是「不可中断」（CLI 那条路、测试里的假实现都不传）。
 */
export type CallModel = (
  messages: Message[],
  signal?: AbortSignal,
) => Promise<ModelResult>

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
  /**
   * 每轮结束后自动抽取值得记住的事实。不填 = 开。
   *
   * 关掉之后记忆只靠模型主动调 remember —— 那条路零成本但会漏
   * （见 src/memory/extract.ts 的文件头）。留这个开关是因为它每轮多一次
   * 模型调用，用量敏感的场景该能关掉。
   */
  autoExtractFacts?: boolean
  /**
   * 这家厂商自带的联网搜索怎么开。不填 = 没有（用我们自己的 web_search）。
   *
   * ## 为什么是「怎么开」而不是「有没有」
   *
   * 各家的形状不一样：智谱是往 tools 数组里加一项 `{type:'web_search'}`，
   * 阿里是请求体里一个布尔 `enable_search: true`。所以存的是开关的**形状**，
   * 由 llm.ts 在构造请求时翻译成对应的字段。
   *
   * ## 为什么绝大多数厂商是「没有」
   *
   * 厂商基本都有搜索，但多数只在各家的**原生 API** 上（OpenAI/DeepSeek 在
   * Responses API、Gemini 的 google_search、Anthropic 的 web_search）——
   * 而这个 app 走的是 OpenAI 兼容的 chat/completions，那是另一套协议形状。
   * 兼容层上就能用的目前只有智谱和通义两家，见 electron/main/vendors.ts
   * 里逐家的标注。
   *
   * CLI 不设置这个字段（它没有厂商选择，直接读 DEEPSEEK_* 环境变量），
   * 所以是可选的。
   */
  nativeSearch?: NativeSearch
  /**
   * 走哪套协议：OpenAI 兼容的 chat/completions，还是 Responses API。
   *
   * 不填 = 'chat'。CLI 不设置这一项（它没有厂商选择），所以是可选的。
   *
   * 为什么这是独立的一维而不是 nativeSearch 的一个变体：见
   * electron/main/vendors.ts 里 Protocol 的注释 —— Responses API 换的是
   * 端点、请求体、响应形状三样，不是「换个开关」。
   */
  protocol?: 'chat' | 'responses'
  /**
   * 替换底层的 fetch。**只给测试用**，生产路径不设置（SDK 用全局 fetch）。
   *
   * 存在的理由：验证「取消能真的中断进行中的请求」需要拿到 SDK 交给 fetch
   * 的那个 `init.signal`。没有这个注入口，就只能逐层单测「这一层把 signal
   * 传给了下一层」—— 而那正是漏掉真问题的方式：每层都对，链子还是断的。
   */
  fetch?: typeof fetch
}

/**
 * 厂商自带搜索的开关形状。
 *
 * 和 electron/main/vendors.ts 里的同名类型保持一致 —— 那边是厂商目录
 * （九家逐一标注），这里是 llm.ts 构造请求时要认的形状。
 */
export type NativeSearch =
  | { kind: 'none' }
  /** 请求体里一个布尔：`enable_search: true`（阿里通义） */
  | { kind: 'enable-flag' }
  /** tools 数组里加一项 `{ type: toolType }`（智谱、OpenRouter） */
  | { kind: 'tool-type'; toolType: string }
  /** tools 数组里加一项 builtin_function（月之暗面那种形状） */
  | { kind: 'builtin-function'; name: string }
