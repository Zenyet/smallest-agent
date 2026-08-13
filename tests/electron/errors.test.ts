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
