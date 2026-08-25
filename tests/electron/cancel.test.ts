import { describe, it, expect } from 'vitest'
import { CancelToken, Cancelled, isCancelled, withCancel } from '../../electron/main/cancel'
import type { CallModel, Message, ModelResult } from '../../src/types'

const NO_TOOLS: ModelResult = { text: 'ok', toolCalls: [] }

function fakeCallModel(calls: Message[][] = []): CallModel {
  return async (messages) => {
    calls.push(messages)
    return NO_TOOLS
  }
}

describe('CancelToken', () => {
  it('新建的令牌未取消', () => {
    expect(new CancelToken().isCancelled()).toBe(false)
  })

  it('cancel() 之后已取消', () => {
    const t = new CancelToken()
    t.cancel()
    expect(t.isCancelled()).toBe(true)
  })

  it('多次 cancel() 无害', () => {
    const t = new CancelToken()
    t.cancel()
    t.cancel()
    expect(t.isCancelled()).toBe(true)
  })

  it('throwIfCancelled 未取消时不抛', () => {
    expect(() => new CancelToken().throwIfCancelled()).not.toThrow()
  })

  it('throwIfCancelled 已取消时抛 Cancelled', () => {
    const t = new CancelToken()
    t.cancel()
    expect(() => t.throwIfCancelled()).toThrow(Cancelled)
  })
})

describe('isCancelled', () => {
  it('认 Cancelled', () => {
    expect(isCancelled(new Cancelled())).toBe(true)
  })

  // 这条是这个模块存在独立错误类型的理由：真错误不能被当成用户取消，
  // 否则网络挂了会静默变成「已停止」，用户以为是自己点的
  it('不认普通 Error', () => {
    expect(isCancelled(new Error('网络挂了'))).toBe(false)
  })

  it('不认长得像的字符串', () => {
    expect(isCancelled(new Error('已取消'))).toBe(false)
    expect(isCancelled('Cancelled')).toBe(false)
  })

  it('不认 undefined / null', () => {
    expect(isCancelled(undefined)).toBe(false)
    expect(isCancelled(null)).toBe(false)
  })

  // 错误经过几层包装后顶层可能看不出是取消 —— 顺着 cause 链找
  it('认包在 cause 链里的 Cancelled', () => {
    const wrapped = new Error('调用模型失败', { cause: new Cancelled() })
    expect(isCancelled(wrapped)).toBe(true)
  })

  it('cause 链里没有 Cancelled 时不误判', () => {
    const wrapped = new Error('外层', { cause: new Error('内层') })
    expect(isCancelled(wrapped)).toBe(false)
  })

  // 自引用的 cause 不该让遍历死循环
  it('自引用 cause 不死循环', () => {
    const err = new Error('自引用') as Error & { cause?: unknown }
    err.cause = err
    expect(isCancelled(err)).toBe(false)
  })
})

describe('withCancel', () => {
  it('未取消时透传给内层', async () => {
    const calls: Message[][] = []
    const wrapped = withCancel(fakeCallModel(calls), new CancelToken())
    const result = await wrapped([{ role: 'user', content: 'hi' }])
    expect(result).toEqual(NO_TOOLS)
    expect(calls).toHaveLength(1)
  })

  // 关键行为：取消后内层一次都不该被调到。ReAct 循环每轮第一件事就是
  // callModel，所以「入口拦住」等于「循环停在轮边界」
  it('已取消时抛 Cancelled 且不调内层', async () => {
    const calls: Message[][] = []
    const token = new CancelToken()
    token.cancel()
    const wrapped = withCancel(fakeCallModel(calls), token)
    await expect(wrapped([{ role: 'user', content: 'hi' }])).rejects.toThrow(Cancelled)
    expect(calls).toHaveLength(0)
  })

  it('跑到一半取消：下一轮入口停下', async () => {
    const calls: Message[][] = []
    const token = new CancelToken()
    const wrapped = withCancel(fakeCallModel(calls), token)
    await wrapped([{ role: 'user', content: '第一轮' }])
    token.cancel()
    await expect(wrapped([{ role: 'user', content: '第二轮' }])).rejects.toThrow(Cancelled)
    expect(calls).toHaveLength(1)
  })
})
