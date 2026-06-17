// ============================================================================
// rag/chunk.ts —— 段落感知文本切块（RAG 第一步）
// ----------------------------------------------------------------------------
// 向量化之前必须先把原文切成大小适中的片段（chunk）。
// 切太大：一个向量平均了太多语义，检索时难以精准命中。
// 切太小：上下文碎片化，模型看到的片段缺乏连贯性，生成质量下降。
// 默认 maxChars=500 是权衡点，调用方可按需覆盖。
// ============================================================================

// 以空行为段落边界切块，尽量保持段落完整；超大段落才按字符数硬切。
export function chunkText(text: string, maxChars = 500): string[] {
  // 按「一个或多个空行」分段——这是 Markdown / 纯文本笔记最自然的语义边界。
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  const chunks: string[] = []
  let current = ''

  for (const para of paragraphs) {
    // +2 是段落之间 '\n\n' 的长度，保证拼接后不超限。
    if (current && current.length + para.length + 2 > maxChars) {
      // 当前积累的内容已经装不下这个段落了，先把 current 落盘，重新开始。
      chunks.push(current)
      current = ''
    }
    if (para.length > maxChars) {
      // 单段落本身超限（如长代码块），只能硬切——语义边界让位于大小限制。
      if (current) {
        chunks.push(current)
        current = ''
      }
      for (let i = 0; i < para.length; i += maxChars) {
        chunks.push(para.slice(i, i + maxChars))
      }
      continue
    }
    // 正常情况：把段落追加进 current，段落间用空行分隔以保留原始结构。
    current = current ? `${current}\n\n${para}` : para
  }

  // 循环结束后 current 可能还有剩余（最后一批没触发 push），在这里落盘。
  if (current) chunks.push(current)
  return chunks
}
