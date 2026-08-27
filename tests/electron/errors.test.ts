import { describe, it, expect } from 'vitest'
import { toErrorEvent } from '../../electron/main/errors'

describe('toErrorEvent', () => {
  it('缺 API key（loadConfig 抛的原话）', () => {
    const e = toErrorEvent('s1', new Error('Missing DEEPSEEK_API_KEY（把 .env.example 复制成 .env 并填好）'))
    expect(e.code).toBe('API_KEY_MISSING')
    expect(e.sessionId).toBe('s1')
  })

  it('转满上限（agent.ts 抛的原话）', () => {
    const e = toErrorEvent('s1', new Error('Agent exceeded maxTurns (10) without finishing'))
    expect(e.code).toBe('MAX_TURNS')
  })

  it('HTTP 状态码类错误归为模型调用失败', () => {
    expect(toErrorEvent('s1', new Error('429 Too Many Requests')).code).toBe('MODEL_ERROR')
    expect(toErrorEvent('s1', new Error('fetch failed')).code).toBe('MODEL_ERROR')
  })

  it('认不出来的归 UNKNOWN，但消息原样保留', () => {
    const e = toErrorEvent('s1', new Error('something weird'))
    expect(e.code).toBe('UNKNOWN')
    expect(e.message).toBe('something weird')
  })

  it('非 Error 抛出物也能处理', () => {
    expect(toErrorEvent('s1', 'plain string').message).toBe('plain string')
  })
})

// ## 这一组锁的是「报错说不出下一步」
//
// AI SDK 的流式路径不会因为 API 调用失败而 reject —— 失败是异步发生的，
// `await result.text` 抛的是 NoOutputGeneratedError，消息只有一句
// 「No output generated. Check the stream for errors.」，而且构造时没传
// cause（核对过 ai@6.0.205 的 index.mjs:7142），顺 cause 链也找不到真因。
//
// 用户看到的是「出错了 / No output generated」，对排查毫无帮助。
describe('AI SDK 的 No output generated', () => {
  it('归到 MODEL_ERROR，不是 UNKNOWN', () => {
    const e = toErrorEvent('s1', new Error('No output generated. Check the stream for errors.'))
    expect(e.code).toBe('MODEL_ERROR')
  })

  it('换成一句说得出下一步的话', () => {
    const e = toErrorEvent('s1', new Error('No output generated. Check the stream for errors.'))
    expect(e.message).not.toMatch(/No output generated/)
    // 三个常见原因都要点到，尤其「模型不属于所选厂商」——
    // 那正是这次实际撞到的那个
    expect(e.message).toMatch(/API Key/)
    expect(e.message).toMatch(/额度/)
    expect(e.message).toMatch(/不属于所选厂商/)
  })

  it('别的错误消息原样保留，不要顺手改写', () => {
    const e = toErrorEvent('s1', new Error('fetch failed'))
    expect(e.message).toBe('fetch failed')
  })
})
