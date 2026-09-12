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
  const e = err as { statusCode?: number; status?: number; message?: string; name?: string }

  // ## 中止不可重试
  //
  // 用户点停止时那次 fetch 被 abort，抛出的是 AbortError。它的 message
  // （"This operation was aborted" / "The user aborted a request"）会被下面
  // 那条 /timeout|ECONN|fetch failed/ 正则**误判成网络抖动** —— 于是取消
  // 触发退避重试，反复重打 2 次才放弃。用户点了停止还要等好几秒，
  // 而且每次重试都是一次真实的 API 调用（花钱）。
  //
  // 这正是 cancel.ts 里 withCancel 那段注释警告过的事，只不过那里说的是
  // 装饰顺序；signal 一路传下来之后，同一个坑换了个入口出现。
  //
  // 认两处：AbortError 是 fetch/undici 的名字，Cancelled 是我们自己那个
  // （顺 cause 链的判断在 electron/main/cancel.ts，这里只看名字 ——
  //  src/ 不该依赖 electron/）。
  const name = String(e?.name ?? '')
  if (name === 'AbortError' || name === 'Cancelled' || name === 'TimeoutError') return false

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
  // signal 要透传下去：这一层是装饰器，不透的话内层拿不到，
  // 那次 HTTP 请求就中断不了（整条链上漏任何一层都会让「停止」失效）。
  return async (messages, signal) => {
    let lastErr: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await callModel(messages, signal)
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
  return async (messages, signal) => {
    try {
      return await primary(messages, signal)
    } catch (err) {
      // ## 中止不降级
      //
      // 不判这一下的话，用户点停止 → 主模型那次 fetch 被 abort → 这里当成
      // 「主模型失败」→ 换备用模型再打一次。取消反而**多**发一次请求，
      // 而且那次还会跑到底（signal 已经 aborted，但如果它是新建的
      // controller 就拦不住）。用户点了停止，结果又等来一次完整回答。
      //
      // 和 withRetry 里那段是同一个坑的两个入口。
      if (signal?.aborted || isAbortLike(err)) throw err
      onFallback?.(err)
      // 注意：fallback 的错误不再捕获，会直接向上抛——两级都失败才算真正失败。
      return await fallback(messages, signal)
    }
  }
}

/**
 * 这个错误是「被中止」吗。
 *
 * 只看 name，不顺 cause 链 —— 顺链的那份判断在 electron/main/cancel.ts
 * 的 isCancelled()，而 src/ 不该依赖 electron/（依赖方向是 electron → src）。
 * 这里够用：SDK 和 undici 抛的 AbortError 都是顶层的。
 */
function isAbortLike(err: unknown): boolean {
  const name = String((err as { name?: string })?.name ?? '')
  return name === 'AbortError' || name === 'Cancelled'
}
