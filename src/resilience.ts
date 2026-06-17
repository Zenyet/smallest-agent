// ============================================================================
// resilience.ts —— 韧性包装：限流重试 + 备用模型降级
// ----------------------------------------------------------------------------
// Stage 4a 加入的两个「callModel 纯包装」：
//   • withRetry：遇到 429（被限流）、5xx（服务端错误）、超时等可恢复错误时，
//     按指数退避自动重试，最终仍失败才向上抛。
//   • withFallback：主模型失败时无缝切换到备用模型，让调用方无感知。
//
// 两者都是「高阶函数」：接受一个 CallModel 返回另一个 CallModel，可自由嵌套。
// agent.ts 的 runAgent 里注入的 callModel 可以是 withCache(withRetry(raw))
// 这样的套娃，循环本身完全不感知这些层。
// ============================================================================

import type { CallModel } from './types'

// withRetry 的可配置项，全部可选——测试时注入 sleep 能让重试不真正等待。
export interface RetryOptions {
  retries?: number       // 最大重试次数，默认 2（即最多调 3 次）
  baseDelayMs?: number   // 第一次重试等多少毫秒，默认 300
  isRetryable?: (err: unknown) => boolean  // 判断这个错误是否值得重试
  sleep?: (ms: number) => Promise<void>    // 可注入，便于测试跳过真实等待
}

// 判断一个错误是否「值得重试」：429 限流、5xx 服务端错误、网络超时/连接失败。
// 4xx（除 429 外）通常是请求本身有问题，重试没意义，不在这里处理。
function defaultRetryable(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; message?: string }
  const code = String(e?.statusCode ?? e?.status ?? '')
  const msg = String(e?.message ?? err)
  return code === '429' || /^5\d\d$/.test(code) || /rate.?limit|timeout|ECONN|ETIMEDOUT|fetch failed/i.test(msg)
}

// 给任意 callModel 套上指数退避重试逻辑。
// attempt 从 0 开始，每次等 baseDelayMs * 2^attempt 毫秒（0ms、300ms、600ms …），
// 这就是「指数退避」：错误越多等越久，避免持续轰炸限速中的 API。
export function withRetry(callModel: CallModel, opts: RetryOptions = {}): CallModel {
  const retries = opts.retries ?? 2
  const baseDelayMs = opts.baseDelayMs ?? 300
  const isRetryable = opts.isRetryable ?? defaultRetryable
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  return async (messages) => {
    let lastErr: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await callModel(messages)
      } catch (err) {
        lastErr = err
        // 已经是最后一次机会，或者这个错误根本不值得重试：直接向上抛，
        // 不再 sleep，避免不必要等待。
        if (attempt === retries || !isRetryable(err)) throw err
        await sleep(baseDelayMs * 2 ** attempt)
      }
    }
    // 循环结束但没有正常返回（TS 需要此行，实际运行不到——上面会先 throw）。
    throw lastErr
  }
}

// 给主模型套一层「保底」：任何错误都转向 fallback。
// 不同于 withRetry（同一模型重试），这里是换一个模型——
// 典型场景：主力用 claude-opus，fallback 用 claude-haiku，成本 vs 可用性的平衡。
// onFallback 回调可用于打日志或告警，让运维知道主模型在降级运行。
export function withFallback(
  primary: CallModel,
  fallback: CallModel,
  onFallback?: (err: unknown) => void,
): CallModel {
  return async (messages) => {
    try {
      return await primary(messages)
    } catch (err) {
      onFallback?.(err)
      // 注意：fallback 的错误不再捕获，会直接向上抛——两级都失败才算真正失败。
      return await fallback(messages)
    }
  }
}
