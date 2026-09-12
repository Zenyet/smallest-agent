import type { TokenUsage } from './types'

/** Missing fields remain unknown; cache-read and reasoning tokens are subsets. */
export function modelUsage(raw: unknown, model: string): TokenUsage {
  const u = (raw ?? {}) as Record<string, any>
  const valid = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
  return {
    model, contextTokens: valid(u.inputTokens), inputTokens: valid(u.inputTokens), outputTokens: valid(u.outputTokens),
    totalTokens: valid(u.totalTokens),
    cacheReadTokens: valid(u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens),
    reasoningTokens: valid(u.outputTokenDetails?.reasoningTokens ?? u.reasoningTokens),
  }
}
export function summarizeUsage(records: TokenUsage[]) {
  const sum = (key: 'inputTokens' | 'outputTokens' | 'totalTokens' | 'cacheReadTokens' | 'reasoningTokens') => {
    const values = records.map(r => r[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    return values.length ? values.reduce((a, b) => a + b, 0) : undefined
  }
  return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'), cacheReadTokens: sum('cacheReadTokens'), reasoningTokens: sum('reasoningTokens'), localHits: records.filter(r => r.localCacheHit).length, requests: records.length, partial: records.some(r => r.inputTokens == null || r.outputTokens == null) }
}
