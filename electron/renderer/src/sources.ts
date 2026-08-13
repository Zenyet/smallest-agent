// 从 search_notes 工具的输出里解析出「来源列表」，喂给 SourceList 渲染 Context Cards。
//
// search_notes 成功时的 output 是 SearchNotesResult 的 JSON 序列化（见 src/rag/index.ts）：
//   { query: string, hits: { source: string; score: number; text: string }[] }
// 失败时 runTool（src/tools/index.ts）把异常包成 { error: string } 返回，形状完全不同，
// 且模型可能幻觉出参数导致工具报错、或输出被截断成非法 JSON。
//
// 这里必须彻底防御：JSON.parse 可能抛，字段可能缺失、类型不对、或压根不是数组。
// 单个工具调用解析失败只能丢弃那一条，不能让 parseSources 抛出而拖垮整条消息的渲染
// （一条消息可能挂了好几个 turn 的工具调用，一个坏的不该连累其它好的）。
import type { ToolCallEvent } from '../../shared/channels'

export interface SourceHit {
  source: string
  score: number
  chars: number // 从命中片段的文本长度派生，不是工具输出自带的字段
}

// 解析单次 search_notes 调用的 output。任何形状不对都返回空数组，不抛。
function parseHits(output: string): SourceHit[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return []
  }

  if (typeof parsed !== 'object' || parsed === null) return []
  const hits = (parsed as { hits?: unknown }).hits
  if (!Array.isArray(hits)) return []

  const result: SourceHit[] = []
  for (const hit of hits) {
    if (typeof hit !== 'object' || hit === null) continue
    const { source, score, text } = hit as Record<string, unknown>
    // 三个字段类型都要对得上才认为是一条合法命中，否则跳过（不是抛错）
    if (typeof source !== 'string' || typeof score !== 'number' || typeof text !== 'string') {
      continue
    }
    result.push({ source, score, chars: text.length })
  }
  return result
}

// 只看 search_notes 的调用 —— 其它工具（如 get_weather）的输出即使碰巧有同名字段，
// 也不该被当成「来源」。多个 turn 都调用过 search_notes 时，命中按调用顺序拼接，不去重：
// 同一份笔记在不同轮次以不同片段/相似度命中是正常现象，去重反而会丢信息。
//
// 诚实说明其局限：这里返回的是「本轮所有 search_notes 调用检索到的片段」，
// 不是「模型答案实际引用了哪些片段」——比如模型用更好的查询词重新搜索后，
// 第一次检索（被放弃的那次）命中的片段依然会出现在这里。要做到真正的
// 引用追踪，需要模型在生成答案时显式标注用了哪些片段（citation），
// 而目前的 pipeline 没有这个数据。SourceList 的文案必须如实反映
// 这是「本轮检索到的」而不是「答案引用的」，直到有引用追踪数据为止。
export function parseSources(toolEvents: ToolCallEvent[]): SourceHit[] {
  const hits: SourceHit[] = []
  for (const event of toolEvents) {
    if (event.toolName !== 'search_notes') continue
    hits.push(...parseHits(event.output))
  }
  return hits
}
