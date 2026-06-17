// ============================================================================
// rag/store.ts —— 最小内存向量库（RAG 的检索层）
// ----------------------------------------------------------------------------
// 把所有片段的向量全部存在内存数组里，查询时对每个片段算余弦相似度，
// 按分降序取 top-k。这是「暴力全扫描」实现，适合笔记量不大的场景。
//
// 换 pgvector / Pinecone 等生产级向量库只需替换这一个文件——
// VectorStore 接口（size + search）不变，agent 和 RAG 上层代码无需改动。
// 这就是「接口隔离」给未来扩展留的门。
// ============================================================================

import { cosineSimilarity } from './similarity'

// 写入时存储的单元：原文片段 + 来源标识 + 向量。
export interface StoredChunk {
  text: string
  source: string // 来源文件名或标识符，检索命中后用来告知模型「这段话出自哪里」
  vector: number[]
}

// 单条检索结果：把 vector 去掉，加上相似度分数（模型不需要看向量本身）。
export interface SearchHit {
  text: string
  source: string
  score: number // 余弦相似度，越接近 1 越相关
}

// 对外暴露的向量库接口。只定义「查多少条 / 存了多少条」，不暴露内部存储细节——
// 换底层实现时，只要满足这两个签名，调用方代码零改动。
export interface VectorStore {
  size: number
  search(queryVector: number[], k: number): SearchHit[]
}

// 工厂函数：接收预先计算好向量的片段列表，返回一个符合 VectorStore 接口的对象。
// 向量在传入前已经算好（见 rag/index.ts），search 时不再调用嵌入模型，纯内存计算。
export function createStore(chunks: StoredChunk[]): VectorStore {
  return {
    size: chunks.length,
    search(queryVector: number[], k: number): SearchHit[] {
      return chunks
        // 对全量片段逐一算余弦，O(n) 暴力扫描——片段数少时完全够用。
        .map((c) => ({
          text: c.text,
          source: c.source,
          score: cosineSimilarity(queryVector, c.vector),
        }))
        // 降序排列：分数最高（最相关）的排前面。
        .sort((a, b) => b.score - a.score)
        // 取前 k 条返回，丢弃剩余——k 由调用方（search_notes 工具）决定。
        .slice(0, k)
    },
  }
}
