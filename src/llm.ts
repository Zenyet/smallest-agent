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
import type { ModelMessage } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { CallModel, Config, Message, ModelResult, ToolCall, ToolRegistry } from './types'

// 把内部 Message[] 转成 Vercel AI SDK v6 要求的 ModelMessage[]。
// 每种 role 对应的「形状」不一样，这是消息协议里最容易出错的地方：
//   - tool 消息需要包裹成 content 数组 + type:'tool-result' 对象
//   - assistant 消息如果带工具调用，content 必须是混合数组（文本 + tool-call 条目）
//     而不是普通字符串；纯文本 assistant 才能用字符串 content
function toSdkMessages(messages: Message[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === 'system') return { role: 'system', content: m.content }
    if (m.role === 'user') return { role: 'user', content: m.content }
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
export function makeCallModel(
  config: Config,
  registry: ToolRegistry,
  onText?: (delta: string) => void,
): CallModel {
  // createOpenAICompatible：DeepSeek 与 OpenAI API 格式兼容，
  // 通过 baseURL 切换到 DeepSeek 端点即可复用 OpenAI SDK 协议。
  const provider = createOpenAICompatible({
    name: 'deepseek',
    baseURL: config.baseURL,
    apiKey: config.apiKey,
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

  return async (messages: Message[]): Promise<ModelResult> => {
    const sdkMessages = toSdkMessages(messages)
    if (onText) {
      // 流式路径（Stage 4b）：streamText 返回异步迭代器，
      // 每个 delta 触发 onText 回调让 CLI 实时打印，
      // 再 await result.text / result.toolCalls 拿最终完整值。
      // 注：流式时模型「思考」和「工具调用声明」不会通过 textStream 流出，
      // 所以工具调用不会重复——textStream 只吐纯文本 token。
      const result = streamText({
        model,
        temperature: config.temperature,
        messages: sdkMessages,
        tools: sdkTools,
      })
      for await (const delta of result.textStream) onText(delta)
      return { text: await result.text, toolCalls: mapToolCalls(await result.toolCalls) }
    }
    // 非流式路径（Stage 0 默认）：generateText 一次性返回完整结果
    const result = await generateText({
      model,
      temperature: config.temperature,
      messages: sdkMessages,
      tools: sdkTools,
    })
    // result.text 在纯工具调用轮次可能是 undefined（模型只输出工具调用，没有文字），
    // 用 ?? '' 保证 ModelResult.text 永远是字符串，agent.ts 无需空判断。
    return { text: result.text ?? '', toolCalls: mapToolCalls(result.toolCalls) }
  }
}
