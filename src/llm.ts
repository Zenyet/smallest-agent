import { modelUsage } from './usage'
import { attachmentData, isTextAttachment, textAttachment } from './attachments'
// ============================================================================
// llm.ts —— 唯一直接接触 LLM SDK 的文件（「边界层」）
// ----------------------------------------------------------------------------
// 职责：把项目内部的 Message[] / ToolRegistry / Config 翻译成
// Vercel AI SDK（`ai` 包）能理解的调用，并把结果映射回内部的 ModelResult。
//
// 读这个文件能看到两件事：
//   1. toSdkMessages：内部消息协议 → SDK ModelMessage 格式的「逐形状」翻译
//      （system / user / tool-result / assistant-with-tool-calls / assistant-text
//       形状各不同，这里是「看见消息协议全貌」的最佳位置）
//   2. makeCallModel：工厂函数，根据 onText 是否存在，
//      在 streamText（Stage 4b 流式）和 generateText（Stage 0 非流式）之间切换，
//      对外暴露统一的 CallModel 签名，agent.ts 完全不感知差别。
// ============================================================================

import { generateText, streamText, tool } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenAI } from '@ai-sdk/openai'
import type {
  CallModel,
  Config,
  ContentPart,
  Message,
  ModelResult,
  ServerToolCall,
  ToolCall,
  ToolRegistry,
} from './types'

// 把内部 Message[] 转成 Vercel AI SDK v6 要求的 ModelMessage[]。
// 每种 role 对应的「形状」不一样，这是消息协议里最容易出错的地方：
//   - tool 消息需要包裹成 content 数组 + type:'tool-result' 对象
//   - assistant 消息如果带工具调用，content 必须是混合数组（文本 + tool-call 条目）
//     而不是普通字符串；纯文本 assistant 才能用字符串 content
//   - user 消息如果带多模态内容（图片/文件），content 必须是数组
export function toSdkMessages(messages: Message[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === 'system') return { role: 'system', content: m.content }

    // user 消息：检查是否有多模态内容
    if (m.role === 'user') {
      if (m.contentParts && m.contentParts.length > 0) {
        // SDK 使用 image / file 内容块，不能直接传 OpenAI 的 wire 格式。
        const contentArray: Exclude<Extract<ModelMessage, { role: 'user' }>['content'], string> = []
        if (!m.contentParts.some((part) => part.type === 'text') && m.content) {
          contentArray.push({ type: 'text', text: m.content })
        }
        for (const part of m.contentParts) {
          if (part.type === 'text') {
            contentArray.push({ type: 'text', text: part.text })
          } else if (part.type === 'file' && isTextAttachment(part)) {
            contentArray.push({ type: 'text', text: textAttachment(part) })
          } else if (part.type === 'image') {
            const data = attachmentData(part)
            contentArray.push({ type: 'image', image: data.bytes, mediaType: data.mimeType })
          } else if (part.type === 'file') {
            contentArray.push({ type: 'file', data: attachmentData(part).bytes, mediaType: part.mimeType, filename: part.filename })
          }
        }

        return { role: 'user', content: contentArray }
      }
      // 纯文本 user 消息（向后兼容）
      return { role: 'user', content: m.content }
    }

    if (m.role === 'tool') {
      // 工具结果必须用 content 数组包裹，SDK 不接受字符串形式；
      // output 包成 {type:'text'} 是 SDK v6 的要求（区别于 image 等其他类型）。
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.toolCallId!,   // ! 断言：tool 消息一定有 toolCallId
            toolName: m.name!,
            output: { type: 'text', value: m.content },
          },
        ],
      }
    }
    // assistant 分两种形状：带工具调用 vs 纯文本
    if (m.toolCalls && m.toolCalls.length) {
      // 带工具调用：content 必须是数组；文本部分（思考链）可选，
      // 用展开 + 条件数组避免插入空的 text 条目。
      return {
        role: 'assistant',
        content: [
          ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
          ...m.toolCalls.map((tc) => ({
            type: 'tool-call' as const,
            toolCallId: tc.id,
            toolName: tc.name,
            input: tc.args,
          })),
        ],
      }
    }
    // 纯文本 assistant（最终回答）：content 用字符串即可
    return { role: 'assistant', content: m.content }
  })
}

// makeCallModel：工厂函数，返回符合 CallModel 签名的闭包。
// 把 provider 初始化、工具注册、流式/非流式分支全部封装在这里，
// 调用方（agent.ts）只看到「给 messages，拿 ModelResult」。
//
// onText 是流式回调（每到一个文字 delta 就触发），由 cli.ts 传入以实时打印；
// 不传则走非流式的 generateText，Stage 0 默认行为。
/**
 * Responses API 路径的 CallModel。
 *
 * ## 为什么它和下面那条路共用 streamText / generateText
 *
 * 协议的差异（端点、请求体、响应形状）全被 SDK 的 model 对象吃掉了 ——
 * `provider.responses(id)` 返回的东西和 `provider(id)` 一样满足
 * LanguageModel 接口。所以上层的调用方式完全相同，我们只是换了个 model
 * 传进去。这正是「只做映射」的意思。
 *
 * ## 服务端工具和我们自己的工具并存
 *
 * 服务端搜索在 DeepSeek/OpenAI 那边跑完、结果直接进响应；registry 里那些
 * 是我们本地执行的（模型说要调，我们跑完回传一轮）。前者由 fetch 钩子
 * 追加进请求体，后者走这里的 sdkTools —— 两条路各自加各自的，
 * **谁都不覆盖谁**。覆盖掉的话 agent 会突然失去文件、技能、笔记检索。
 */
function makeResponsesCallModel(
  model: any,
  config: Config,
  registry: ToolRegistry,
  onText?: (delta: string) => void,
): CallModel {
  // 只装我们自己的工具。服务端搜索不在这里 —— 它是在 fetch 钩子里
  // 直接改请求体加进去的，见上面那段注释
  const sdkTools = Object.fromEntries(
    Object.values(registry).map((t) => [
      t.name,
      tool({ description: t.description, inputSchema: t.parameters as any }),
    ]),
  )

  // 只保留「要我们本地跑」的那些。
  //
  // 判据用 SDK 给的 providerExecuted 标记，不按名字硬编码 —— 原来这里写的是
  // `!== 'web_search'`，那既漏（厂商加了别的服务端工具就挡不住）又误伤
  // （用户真在本地注册一个叫 web_search 的工具就被吃掉了）。
  const mapToolCalls = (toolCalls: any[]): ToolCall[] =>
    toolCalls
      .filter((tc) => !tc.providerExecuted)
      .map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        args: (tc.input ?? {}) as Record<string, unknown>,
      }))

  // 服务端已经跑完的那些。循环不碰它们，但要报告出去 —— 否则界面上
  // 「联网搜索了」这件事完全看不见（用户看到的是凭空多出来的时效性答案）。
  const mapServerCalls = (toolResults: any[]): ServerToolCall[] =>
    toolResults
      .filter((tr) => tr.providerExecuted)
      .map((tr) => ({
        name: tr.toolName,
        args: (tr.input ?? {}) as Record<string, unknown>,
        // **result 而不是 output**：本地工具那条路上 SDK 给的字段叫 output，
        // 但服务端执行的这条给的是 result（见 @ai-sdk/openai 的
        // convertToLanguageModelV2 里 web_search_call 那个分支）。
        // 读错的话这里恒为 undefined —— 卡片能出来但里面是空的。
        output: tr.result ?? tr.output,
      }))

  return async (messages: Message[], signal?: AbortSignal): Promise<ModelResult> => {
    const sdkMessages = toSdkMessages(messages)
    if (onText) {
      const result = streamText({
        model,
        temperature: config.temperature,
        messages: sdkMessages,
        tools: sdkTools as never,
        // 见下面非流式那处的注释 —— 两条路都要给，漏一条就有一半请求停不掉
        abortSignal: signal,
      })
      for await (const delta of result.textStream) onText(delta)
      const server = mapServerCalls(await result.toolResults)
      return {
        usage: modelUsage(await result.totalUsage, config.model),
        text: await result.text,
        toolCalls: mapToolCalls(await result.toolCalls),
        ...(server.length > 0 ? { serverToolCalls: server } : {}),
      }
    }
    const result = await generateText({
      model,
      temperature: config.temperature,
      messages: sdkMessages,
      tools: sdkTools as never,
      // SDK 把它一路传到 fetch。这是唯一能真正中断进行中请求的机制 ——
      // 不给的话用户点停止只能等这次请求自己跑完（见 types.ts 的
      // CallModel 注释）
      abortSignal: signal,
    })
    const server = mapServerCalls(result.toolResults)
    return {
      usage: modelUsage(result.totalUsage, config.model),
      text: result.text ?? '',
      toolCalls: mapToolCalls(result.toolCalls),
      ...(server.length > 0 ? { serverToolCalls: server } : {}),
    }
  }
}

export function makeCallModel(
  config: Config,
  registry: ToolRegistry,
  onText?: (delta: string) => void,
): CallModel {
  // createOpenAICompatible：DeepSeek 与 OpenAI API 格式兼容，
  // 通过 baseURL 切换到 DeepSeek 端点即可复用 OpenAI SDK 协议。
  // ## 两条协议路径
  //
  // Responses API（DeepSeek / OpenAI）和 chat/completions（其余几家）是
  // **不同的协议**：端点不同（`/responses` vs `/chat/completions`）、
  // 请求体不同（`input` vs `messages`）、响应形状不同（output 数组里的
  // `message` / `function_call` / `web_search_call` 几种 item）。
  //
  // 好在这两套 SDK 都实现了，我们只做映射 —— 按厂商选一条，不用自己解协议。
  //
  // 为什么值得分这一条路：DeepSeek / OpenAI 的**服务端联网搜索只在
  // Responses API 上**。走 chat/completions 的话那个能力根本够不着，
  // 用户配了 key 也用不上，只能退到我们自己那套（没配 Brave/Tavily 时
  // 是维基百科兜底）。
  if (config.protocol === 'responses') {
    // 服务端搜索靠**改请求体**加，不是用 SDK 的 provider.tools.webSearch()。
    //
    // 原因：那个工厂产出的是 `provider-defined` 类型的工具，而 ai@6 和
    // @ai-sdk/openai@2 之间走的是 v2 兼容桥，那座桥不认这个类型
    // （实测报 "Unsupported tool type: provider-defined"）。
    //
    // 而请求体本身就是普通 JSON，往 tools 数组里追加一项 `{type:'web_search'}`
    // 是协议层面的事，和 SDK 的类型系统无关 —— 这和 chat 那条路上用
    // transformRequestBody 塞 enable_search 是同一个手法。
    const wantsSearch = Boolean(config.nativeSearch && config.nativeSearch.kind !== 'none')
    const provider = createOpenAI({
      // baseURL 可配，所以同一份实现能指向 DeepSeek 或 OpenAI
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      fetch: wantsSearch
        ? async (input, init) => {
            if (!init?.body || typeof init.body !== 'string') return fetch(input, init)
            const body = JSON.parse(init.body) as Record<string, unknown>
            // **追加**而不是覆盖：body.tools 里已经有我们自己的工具
            // （文件、技能、笔记检索），覆盖掉的话 agent 会突然失去它们
            const tools = Array.isArray(body.tools) ? body.tools : []
            body.tools = [...tools, { type: 'web_search' }]
            // 要来源，否则响应里的 web_search_call 只有 {id, status, action}，
            // action.queries 里是内部 id 而不是真正的搜索词 —— 卡片上就没有
            // 任何可读内容。
            //
            // SDK 自己在用 provider.tools.webSearch() 注册时会加这一项，
            // 但我们是直接改请求体（那条路走不通，见上面），所以得自己加。
            const include = Array.isArray(body.include) ? body.include : []
            if (!include.includes('web_search_call.action.sources')) {
              body.include = [...include, 'web_search_call.action.sources']
            }
            const res = await fetch(input, { ...init, body: JSON.stringify(body) })

            // 响应也要过一手：DeepSeek 给的是 `action.queries`（复数数组），
            // 而 SDK 的 schema 只认 `action.query`（单数）—— 不补的话那个
            // 字段被丢掉，卡片能出来但搜索词是空的。
            //
            // 只动这一个字段，其余原样透传。流式响应（SSE）不碰 ——
            // 它不是一个完整 JSON，改不了，而流式下这个信息本来就是
            // 逐事件到达的。
            const type = res.headers.get('content-type') ?? ''
            if (!type.includes('application/json')) return res
            const json = (await res.json()) as { output?: unknown[] }
            if (Array.isArray(json.output)) {
              for (const item of json.output as Record<string, any>[]) {
                if (item?.type !== 'web_search_call') continue
                const action = item.action
                if (!action || action.query != null) continue
                const queries = Array.isArray(action.queries) ? action.queries : []
                // 末尾那条 `ws_call_id=...` 是内部标识，不是用户搜的词
                const real = queries.filter(
                  (q: unknown) => typeof q === 'string' && !q.startsWith('ws_call_id='),
                )
                if (real.length > 0) action.query = real.join('、')
              }
            }
            return new Response(JSON.stringify(json), {
              status: res.status,
              statusText: res.statusText,
              headers: res.headers,
            })
          }
        : undefined,
    })
    return makeResponsesCallModel(provider.responses(config.model), config, registry, onText)
  }

  const provider = createOpenAICompatible({
    // Request the final usage chunk; compatible APIs otherwise omit stream usage.
    includeUsage: true,
    name: 'deepseek',
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    // 测试注入口。生产路径上是 undefined —— SDK 用全局 fetch。
    //
    // 为什么需要它：「取消能不能真的中断进行中的请求」这件事，只有在
    // **拿到 SDK 交给 fetch 的那个 init.signal** 时才能验证。没有这个口子
    // 就只能逐层单测「我把 signal 传给了下一层」，而那恰恰是我连着三轮
    // 漏掉真问题的原因 —— 每层都对，链子还是断的。
    fetch: config.fetch,
    // 厂商自带的联网搜索：把开关塞进请求体。
    //
    // ## 为什么走 transformRequestBody 而不是别的口子
    //
    // 这些字段不在 OpenAI 的标准形状里（`enable_search` 是阿里的，
    // tools 数组里放 `{type:'web_search'}` 是智谱的），SDK 的类型化参数
    // 表达不了。transformRequestBody 拿到的是**发出去之前的最终 body**，
    // 正好是加这类非标字段的地方 —— 官方给的就是这个用途
    // （"useful for proxy providers that may require a different request format"）。
    //
    // ## 这是「一把 key 就能用」的落点
    //
    // 用户配了模型的 key，搜索就能用了，不用再去注册 Brave/Tavily。
    // 代价是只有兼容层支持的那两家有（智谱、通义），见 Config.nativeSearch。
    transformRequestBody: (body) => {
      const ns = config.nativeSearch
      if (!ns || ns.kind === 'none') return body
      if (ns.kind === 'enable-flag') {
        // 阿里 DashScope：请求体里一个布尔
        return { ...body, enable_search: true }
      }
      // 余下两种都是往 tools 数组里追加一项。
      //
      // **追加**而不是覆盖：body.tools 里已经有我们自己的工具（文件、技能、
      // 笔记检索），覆盖掉的话 agent 会突然失去那些能力 —— rs 侧有一条
      // 测试专门锁这个（wire.rs 的 native_search_coexists_with_our_own_tools）。
      const extra =
        ns.kind === 'tool-type'
          ? { type: ns.toolType }
          : { type: 'builtin_function', function: { name: ns.name } }
      const tools = Array.isArray(body.tools) ? [...body.tools, extra] : [extra]
      return { ...body, tools }
    },
  })
  const model = provider(config.model)

  // 把内部 ToolRegistry 转成 SDK 认识的 tools 对象。
  // tool() 包装器会把 zod schema（parameters）转成模型可读的 JSON Schema，
  // 这也是为什么 Tool.parameters 的类型是 unknown 而不是 ZodSchema——
  // 类型在这里被 as any 抹掉交给 SDK 处理。
  const sdkTools = Object.fromEntries(
    Object.values(registry).map((t) => [
      t.name,
      tool({ description: t.description, inputSchema: t.parameters as any }),
    ]),
  )

  // 把 SDK 返回的工具调用结构映射回内部 ToolCall 类型。
  // 字段名不同：SDK 用 toolCallId/toolName/input，内部用 id/name/args。
  const mapToolCalls = (toolCalls: any[]): ToolCall[] =>
    toolCalls.map((tc) => ({
      id: tc.toolCallId,
      name: tc.toolName,
      args: (tc.input ?? {}) as Record<string, unknown>,
    }))

  return async (messages: Message[], signal?: AbortSignal): Promise<ModelResult> => {
    const sdkMessages = toSdkMessages(messages)
    if (onText) {
      // 流式路径（Stage 4b）：streamText 返回异步迭代器，
      // 每个 delta 触发 onText 回调让 CLI 实时打印，
      // 再 await result.text / result.toolCalls 拿最终完整值。
      // 注：流式时模型「思考」和「工具调用声明」不会通过 textStream 流出，
      // 所以工具调用不会重复——textStream 只吐纯文本 token。
      //
      // abortSignal 交给 SDK：它一路传到 fetch。用户点停止时这次请求会
      // 立刻被中断，而不是跑到底 —— 流式回答的绝大部分时间都在这个
      // for await 里，不给 signal 的话「停止」在这儿完全没有着力点。
      const result = streamText({
        model,
        temperature: config.temperature,
        messages: sdkMessages,
        tools: sdkTools,
        abortSignal: signal,
      })
      for await (const delta of result.textStream) onText(delta)
      return { usage: modelUsage(await result.totalUsage, config.model),
        text: await result.text, toolCalls: mapToolCalls(await result.toolCalls) }
    }
    // 非流式路径（Stage 0 默认）：generateText 一次性返回完整结果
    const result = await generateText({
      model,
      temperature: config.temperature,
      messages: sdkMessages,
      tools: sdkTools,
      abortSignal: signal,
    })
    // result.text 在纯工具调用轮次可能是 undefined（模型只输出工具调用，没有文字），
    // 用 ?? '' 保证 ModelResult.text 永远是字符串，agent.ts 无需空判断。
    return { usage: modelUsage(result.totalUsage, config.model),
      text: result.text ?? '', toolCalls: mapToolCalls(result.toolCalls) }
  }
}
