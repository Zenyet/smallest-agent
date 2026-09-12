import { describe, it, expect, vi } from 'vitest'
import { CancelToken, withCancel, isCancelled } from '../electron/main/cancel'
import { withRetry, withFallback } from '../src/resilience'
import { withCache, type ResultCache } from '../src/cache'
import type { CallModel, ModelResult } from '../src/types'

// ============================================================================
// 「点停止无效」的真正根因：AbortSignal 没有一路传到 fetch
//
// 上一轮我在 agent 循环里加了取消检查（轮边界 + 工具之间），但那只覆盖
// 「卡在工具上」。而一轮里最长的等待是**等模型响应** —— 那是一次 HTTP 请求，
// 在 SDK 里面、在 undici 里面，我们的循环没有执行权：
//
//   withCancel 原来是 `token.throwIfCancelled(); return inner(messages)`
//                       ↑ 只拦「还没开始的」    ↑ 一进去就拦不住了
//
// 用户点停止 → 令牌置位、cancel() 返回 true → 那次请求继续跑到底。
// 这就是「点了没反应」。
//
// AbortSignal 是唯一能真正中断进行中 fetch 的机制。这一组锁的是它在整条
// 装饰链上不被丢掉，以及中止抛的错被正确分类。
// ============================================================================

const fakeResult: ModelResult = { text: 'ok', toolCalls: [] }

describe('signal 一路传到底', () => {
  it('withCancel 把令牌接成 signal 传给内层', async () => {
    const token = new CancelToken()
    let received: AbortSignal | undefined
    const inner: CallModel = async (_m, signal) => {
      received = signal
      return fakeResult
    }

    await withCancel(inner, token)([{ role: 'user', content: 'q' }])

    expect(received).toBeInstanceOf(AbortSignal)
    expect(received!.aborted).toBe(false)
  })

  it('取消之后拿到的 signal 已经是 aborted 的', async () => {
    const token = new CancelToken()
    token.cancel()
    // 已取消时 withCancel 的前置检查会先抛，所以直接测 token.signal()
    expect(token.signal().aborted).toBe(true)
  })

  it('请求飞在半空时取消 —— signal 当场 abort', async () => {
    const token = new CancelToken()
    let signalDuringFlight: AbortSignal | undefined
    let abortedDuringFlight = false

    const inner: CallModel = async (_m, signal) => {
      signalDuringFlight = signal
      // 模拟「请求已经发出去了」：这时用户点停止
      token.cancel()
      abortedDuringFlight = signal!.aborted
      return fakeResult
    }

    await withCancel(inner, token)([{ role: 'user', content: 'q' }])

    // 关键断言：不是「下一轮才发现」，而是同一个 signal 当场变成 aborted。
    // 这正是原来做不到的事 —— 那次请求会一直跑到底
    expect(signalDuringFlight).toBeDefined()
    expect(abortedDuringFlight).toBe(true)
  })

  // ## 装饰链上漏任何一层都会让「停止」失效
  //
  // 真实的链是 withCancel(withFallback(withCache(withRetry(makeCallModel))))。
  // 每一层都是 `async (messages) => inner(messages)` 的形状 —— 不显式透传
  // signal 的话，它在那一层就被丢掉了，底下的 fetch 拿不到。
  it('穿过 retry / cache / fallback 三层还在', async () => {
    const token = new CancelToken()
    let received: AbortSignal | undefined
    const base: CallModel = async (_m, signal) => {
      received = signal
      return fakeResult
    }

    const cache: ResultCache = {
      get: async () => undefined,
      set: async () => {},
    }

    const chain = withCancel(
      withFallback(withCache(withRetry(base), cache, 'k'), base),
      token,
    )
    await chain([{ role: 'user', content: 'q' }])

    expect(received).toBeInstanceOf(AbortSignal)
  })

  it('withRetry 单层透传', async () => {
    let received: AbortSignal | undefined
    const base: CallModel = async (_m, signal) => {
      received = signal
      return fakeResult
    }
    const sig = new AbortController().signal
    await withRetry(base)([{ role: 'user', content: 'q' }], sig)
    expect(received).toBe(sig)
  })

  it('withCache 单层透传（未命中时）', async () => {
    let received: AbortSignal | undefined
    const base: CallModel = async (_m, signal) => {
      received = signal
      return fakeResult
    }
    const cache: ResultCache = { get: async () => undefined, set: async () => {} }
    const sig = new AbortController().signal
    await withCache(base, cache, 'k')([{ role: 'user', content: 'q' }], sig)
    expect(received).toBe(sig)
  })

  it('withFallback 单层透传', async () => {
    let received: AbortSignal | undefined
    const base: CallModel = async (_m, signal) => {
      received = signal
      return fakeResult
    }
    const sig = new AbortController().signal
    await withFallback(base, base)([{ role: 'user', content: 'q' }], sig)
    expect(received).toBe(sig)
  })
})

describe('中止不该被当成可重试的故障', () => {
  /** 造一个 AbortError —— fetch 被中断时抛的就是这个形状。 */
  function abortError(): Error {
    const err = new Error('This operation was aborted')
    err.name = 'AbortError'
    return err
  }

  // ## 这是个真实的坑
  //
  // AbortError 的 message 是 "This operation was aborted" —— 而
  // defaultRetryable 里那条正则匹配 /timeout|ECONN|fetch failed/，
  // 加上 SDK 有时把它包成 "fetch failed"。误判成网络抖动的话，取消会触发
  // 退避重试：用户点了停止还要等好几秒，而且每次重试都是一次真实的
  // API 调用（花钱）。
  it('withRetry 不重试 AbortError', async () => {
    let calls = 0
    const base: CallModel = async () => {
      calls += 1
      throw abortError()
    }
    const sleep = vi.fn(async () => {})

    await expect(
      withRetry(base, { retries: 3, sleep })([{ role: 'user', content: 'q' }]),
    ).rejects.toThrow(/aborted/)

    // 只调了一次 —— 没有重试
    expect(calls).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  // 反面：真的网络抖动仍然要重试。不能为了修取消把重试整个废掉
  it('真故障照常重试', async () => {
    let calls = 0
    const base: CallModel = async () => {
      calls += 1
      if (calls < 3) throw new Error('fetch failed')
      return fakeResult
    }
    const r = await withRetry(base, { retries: 3, sleep: async () => {} })([
      { role: 'user', content: 'q' },
    ])
    expect(r).toEqual(fakeResult)
    expect(calls).toBe(3)
  })

  // ## 同一个坑的另一个入口
  //
  // 不判的话：主模型被 abort → withFallback 当成「主模型失败」→ 换备用模型
  // 再打一次。取消反而**多**发一次请求，用户点了停止却又等来一次完整回答。
  it('withFallback 不因中止而降级', async () => {
    let fallbackCalled = false
    const primary: CallModel = async () => {
      throw abortError()
    }
    const fallback: CallModel = async () => {
      fallbackCalled = true
      return fakeResult
    }

    await expect(
      withFallback(primary, fallback)([{ role: 'user', content: 'q' }]),
    ).rejects.toThrow(/aborted/)
    expect(fallbackCalled).toBe(false)
  })

  it('signal 已 aborted 时也不降级（另一条判据）', async () => {
    let fallbackCalled = false
    const controller = new AbortController()
    controller.abort()
    const primary: CallModel = async () => {
      throw new Error('some other failure')
    }
    const fallback: CallModel = async () => {
      fallbackCalled = true
      return fakeResult
    }

    await expect(
      withFallback(primary, fallback)([{ role: 'user', content: 'q' }], controller.signal),
    ).rejects.toThrow()
    expect(fallbackCalled).toBe(false)
  })

  it('真故障照常降级', async () => {
    let fallbackCalled = false
    const primary: CallModel = async () => {
      throw new Error('model exploded')
    }
    const fallback: CallModel = async () => {
      fallbackCalled = true
      return fakeResult
    }
    const r = await withFallback(primary, fallback)([{ role: 'user', content: 'q' }])
    expect(r).toEqual(fakeResult)
    expect(fallbackCalled).toBe(true)
  })
})

describe('中止抛的错要被认成「取消」而不是「故障」', () => {
  // ## 这是最后一环，漏了整条修复就白做
  //
  // signal 成功中断了请求（好事），但 isCancelled() 只认
  // `instanceof Cancelled` —— 而 abort 抛的是 DOMException/AbortError，
  // 不是我们的类。于是 agent-runner 的 catch 走 else 分支 → emit.error
  // → 用户点停止，屏幕上出现一条红色「出错了」。
  //
  // 他会以为自己弄坏了什么，而这本来就是他要的结果。
  it('AbortError 被认成取消', () => {
    const err = new Error('This operation was aborted')
    err.name = 'AbortError'
    expect(isCancelled(err)).toBe(true)
  })

  it('包在 cause 链里的 AbortError 也认得出来', () => {
    const inner = new Error('aborted')
    inner.name = 'AbortError'
    expect(isCancelled(new Error('模型调用失败', { cause: inner }))).toBe(true)
  })

  // 反面：不能放松成比 message。那会把用户数据里带「aborted」的真故障
  // 误判成取消 —— 那时该显示红色报错，而我们会静默当成「用户停了」
  it('只是 message 里有 abort 字样的真故障不算取消', () => {
    expect(isCancelled(new Error('request aborted by upstream proxy'))).toBe(false)
  })

  it('普通故障不算取消', () => {
    expect(isCancelled(new Error('fetch failed'))).toBe(false)
    expect(isCancelled(null)).toBe(false)
  })
})
