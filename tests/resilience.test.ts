import { describe, it, expect, vi } from 'vitest'
import { withRetry, withFallback } from '../src/resilience'
import type { Message, ModelResult } from '../src/types'

const msgs: Message[] = [{ role: 'user', content: 'hi' }]
const ok: ModelResult = { text: 'ok', toolCalls: [] }
const noSleep = async () => {}

describe('withRetry', () => {
  it('returns on first success without retrying', async () => {
    const fn = vi.fn(async () => ok)
    const out = await withRetry(fn, { sleep: noSleep })(msgs)
    expect(out).toBe(ok)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries retryable errors then succeeds', async () => {
    let n = 0
    const fn = vi.fn(async () => {
      if (++n < 3) throw new Error('rate limit exceeded')
      return ok
    })
    const out = await withRetry(fn, { retries: 3, sleep: noSleep })(msgs)
    expect(out).toBe(ok)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry when isRetryable says no', async () => {
    const fn = vi.fn(async () => { throw new Error('bad request') })
    await expect(withRetry(fn, { sleep: noSleep, isRetryable: () => false })(msgs)).rejects.toThrow()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('throws after exhausting retries', async () => {
    const fn = vi.fn(async () => { throw new Error('timeout') })
    await expect(withRetry(fn, { retries: 2, sleep: noSleep })(msgs)).rejects.toThrow(/timeout/)
    expect(fn).toHaveBeenCalledTimes(3)
  })
})

describe('withFallback', () => {
  it('uses primary when it succeeds', async () => {
    const primary = vi.fn(async () => ok)
    const fallback = vi.fn(async (): Promise<ModelResult> => ({ text: 'fb', toolCalls: [] }))
    const out = await withFallback(primary, fallback)(msgs)
    expect(out).toBe(ok)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('falls back when primary throws, and notifies', async () => {
    const fb: ModelResult = { text: 'fb', toolCalls: [] }
    const primary = vi.fn(async (): Promise<ModelResult> => { throw new Error('down') })
    const fallback = vi.fn(async () => fb)
    const onFallback = vi.fn()
    const out = await withFallback(primary, fallback, onFallback)(msgs)
    expect(out).toBe(fb)
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(onFallback).toHaveBeenCalledOnce()
  })
})
