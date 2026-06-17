// ============================================================================
// embed.ts —— 唯一碰 embedding 模型的文件
// ----------------------------------------------------------------------------
// 职责：把一批文本字符串变成语义向量（number[][]）。
// 使用 @huggingface/transformers（浏览器/Node 均可跑的 ONNX 推理库），
// 本地跑小模型，不需要调任何远程 embedding API，离网也能用。
//
// 在 RAG 流程里：makeEmbedder() 在应用启动时调用一次（模型加载较慢），
// 返回的 Embedder 函数在 buildNotesIndex 和 searchNotes 里反复复用。
// ============================================================================

import { resolve } from 'node:path'
import { pipeline, env } from '@huggingface/transformers'
import type { Config } from '../types'

// 对外暴露的 embedding 函数签名：一批文本 → 一批向量（向量维度由模型决定）。
export type Embedder = (texts: string[]) => Promise<number[][]>

export async function makeEmbedder(config: Config): Promise<Embedder> {
  // 国内连不上 huggingface.co 时，把下载源换成镜像（如 https://hf-mirror.com）
  if (config.hfEndpoint) {
    env.remoteHost = config.hfEndpoint
  }
  // 模型文件已手动下到本地目录时：离线加载，完全不走网络
  if (config.localModelPath) {
    env.allowRemoteModels = false
    env.localModelPath = resolve(config.localModelPath)
  }
  // dtype 'q8' 固定加载 onnx/model_quantized.onnx（体积小，语义检索够用）
  const extractor = await pipeline('feature-extraction', config.embeddingModel, { dtype: 'q8' })
  return async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return []
    // pooling:'mean' = 把 token 级向量平均成一条句子向量；normalize:true = L2 归一化，
    // 使后续余弦相似度可直接用点积代替（向量长度均为 1）。
    const output = await extractor(texts, { pooling: 'mean', normalize: true })
    return output.tolist() as number[][]
  }
}
