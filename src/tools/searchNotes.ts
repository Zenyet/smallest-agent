// ============================================================================
// tools/searchNotes.ts —— 把「向量检索」包装成 agent 工具（search_notes）
// ----------------------------------------------------------------------------
// 这是 RAG 系统的对外接口：把 Stage 1 实现的向量检索能力注册进 ToolRegistry，
// 让 agent 循环能像调任何其他工具一样触发语义检索。
// 核心示范：RAG 并不是一个独立系统，只是「注册表里多了一个工具」。
// agent.ts 的循环不用改一行，就自动获得了检索增强能力。
// ============================================================================

import { z } from 'zod'
import type { Tool } from '../types'
import type { VectorStore } from '../rag/store'
import type { Embedder } from '../rag/embed'
import { searchNotes } from '../rag/index'

// 工厂函数：接收向量库和嵌入函数作为依赖，返回一个符合 Tool 接口的对象。
// 用工厂而不是直接导出对象，是为了让调用方在运行时注入具体实现（方便测试和替换）。
export function makeSearchNotesTool(deps: { store: VectorStore; embed: Embedder }): Tool {
  return {
    name: 'search_notes',
    description: '在用户的笔记库里做语义检索。需要引用笔记内容、或回答与已有笔记相关的问题时调用。',
    // zod schema 双重用途：让模型知道参数结构（序列化进 system prompt），也在运行时校验输入。
    parameters: z.object({
      query: z.string().describe('检索用的自然语言查询'),
      k: z.number().int().positive().optional().describe('返回片段数，默认 4'),
    }),
    run: async (args: { query: string; k?: number }) =>
      // k 未传时默认取 4：够覆盖不同角度的笔记片段，又不至于撑爆上下文窗口。
      searchNotes(deps.store, deps.embed, args.query, args.k ?? 4),
  }
}
