// 请求级装配的一半：把 callModel 逐层包上 retry / cache / fallback。
// 顺序和 cli.ts 完全一致 —— withRetry 在最内层（先重试），withCache 包住它
// （命中缓存就完全不进重试逻辑），withFallback 在最外层（主模型整体失败才切备用）。
//
// 为什么这层必须是「请求级」而不是启动时建一次：makeCallModel 把 onText 闭包进去了，
// 全局只建一个的话，所有会话的 token 流会涌向同一个回调，没法按 sessionId 路由。
import { makeCallModel } from '../../src/llm'
import { withRetry, withFallback } from '../../src/resilience'
import { createDiskCache, withCache } from '../../src/cache'
import type { CallModel, Config, ToolRegistry } from '../../src/types'

export function buildCallModel(
  config: Config,
  registry: ToolRegistry,
  onText: (delta: string) => void,
  onCacheHit: () => void,
): CallModel {
  const cache = config.cacheEnabled ? createDiskCache(config.cacheDir) : undefined

  const build = (model: string): CallModel => {
    let cm: CallModel = withRetry(
      makeCallModel({ ...config, model }, registry, config.stream ? onText : undefined),
      { retries: config.maxRetries },
    )
    if (cache) cm = withCache(cm, cache, model, onCacheHit)
    return cm
  }

  const primary = build(config.model)
  // 主备相同就不必套 withFallback，省一层 try/catch
  return config.fallbackModel === config.model
    ? primary
    : withFallback(primary, build(config.fallbackModel), () => {})
}
