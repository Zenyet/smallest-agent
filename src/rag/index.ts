// ============================================================================
// rag/index.ts —— RAG 的总装配：索引构建 + 语义检索
// ----------------------------------------------------------------------------
// RAG（Retrieval-Augmented Generation）流程分两步：
//   1. 离线（buildNotesIndex）：读文档 → 切块 → embed → 存向量库。
//   2. 在线（searchNotes）：embed 查询 → 余弦相似度 → 取 top-k 相关片段。
//
// 检索到的片段会被拼进 system prompt 或 user message，让模型"看着"私有知识回答，
// 而不用把整份笔记全塞进 context（节省 token，也避免超长输入）。
// ============================================================================

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chunkText } from './chunk'
import { createStore, type StoredChunk, type VectorStore } from './store'
import type { Embedder } from './embed'

// 读取 notesDir 下所有 .md 文件，切块后 embed，返回可检索的向量库。
// 每次应用启动时调用一次；后续查询只走 searchNotes，不重复读盘/推理。
export async function buildNotesIndex(opts: {
  notesDir: string
  embed: Embedder
  maxChars?: number
}): Promise<VectorStore> {
  const { notesDir, embed, maxChars } = opts
  const entries = await readdir(notesDir)
  // sort() 保证多文件时处理顺序确定，方便 debug / 测试复现。
  const mdFiles = entries.filter((f) => f.endsWith('.md')).sort()

  // pieces 把「文本块 + 来源文件名」打包在一起，后续能在搜索结果里显示出处。
  const pieces: { text: string; source: string }[] = []
  for (const file of mdFiles) {
    const content = await readFile(join(notesDir, file), 'utf8')
    for (const chunk of chunkText(content, maxChars)) {
      pieces.push({ text: chunk, source: file })
    }
  }

  // 一次性批量 embed：transformer 推理对批次有优化，比逐条 embed 快很多。
  const vectors = await embed(pieces.map((p) => p.text))
  const stored: StoredChunk[] = pieces.map((p, i) => ({
    text: p.text,
    source: p.source,
    vector: vectors[i],
  }))
  return createStore(stored)
}

// 单次检索的结果结构，hits 按相似度降序排列。
export interface SearchNotesResult {
  query: string
  hits: { source: string; score: number; text: string }[]
}

// 把用户查询 embed 成向量，在向量库中取 top-k 最相似片段。
// k 默认 4：通常 2-5 条片段足以给模型提供上下文，太多反而噪声增加。
export async function searchNotes(
  store: VectorStore,
  embed: Embedder,
  query: string,
  k = 4,
): Promise<SearchNotesResult> {
  // embed 返回数组，[0] 取第一条（查询只有一条文本）。
  const [queryVector] = await embed([query])
  const hits = store.search(queryVector, k).map((h) => ({
    source: h.source,
    // toFixed(4) 让分数在日志/UI 里可读，原始浮点数过长没意义。
    score: Number(h.score.toFixed(4)),
    text: h.text,
  }))
  return { query, hits }
}
