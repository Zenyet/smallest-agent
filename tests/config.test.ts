import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config'

describe('loadConfig', () => {
  it('throws when DEEPSEEK_API_KEY missing', () => {
    expect(() => loadConfig({})).toThrow(/DEEPSEEK_API_KEY/)
  })

  it('applies sensible defaults', () => {
    const c = loadConfig({ DEEPSEEK_API_KEY: 'k' })
    expect(c.baseURL).toBe('https://api.deepseek.com/v1')
    expect(c.model).toBe('deepseek-chat')
    expect(c.temperature).toBe(0)
    expect(c.maxTurns).toBe(10)
    expect(c.systemPrompt.length).toBeGreaterThan(0)
    expect(c.embeddingModel).toBe('Xenova/multilingual-e5-small')
    expect(c.notesDir).toBe('./notes')
    expect(c.sessionId).toBe('default')
    expect(c.sessionsDir).toBe('./.sessions')
    expect(c.maxContextTokens).toBe(2000)
    expect(c.keepRecent).toBe(6)
    expect(c.fallbackModel).toBe('deepseek-chat')
    expect(c.maxRetries).toBe(2)
    expect(c.cacheEnabled).toBe(true)
    expect(c.cacheDir).toBe('./.llm-cache')
    expect(c.stream).toBe(true)
    expect(c.systemPrompt).toContain('来源')
  })

  it('reads overrides from env', () => {
    const c = loadConfig({
      DEEPSEEK_API_KEY: 'k',
      DEEPSEEK_MODEL: 'deepseek-reasoner',
      TEMPERATURE: '0.7',
      MAX_TURNS: '3',
    })
    expect(c.model).toBe('deepseek-reasoner')
    expect(c.temperature).toBe(0.7)
    expect(c.maxTurns).toBe(3)
  })

  it('throws a clear error for non-numeric TEMPERATURE', () => {
    expect(() => loadConfig({ DEEPSEEK_API_KEY: 'k', TEMPERATURE: 'abc' })).toThrow(/TEMPERATURE/)
  })

  it('throws a clear error for non-numeric MAX_TURNS', () => {
    expect(() => loadConfig({ DEEPSEEK_API_KEY: 'k', MAX_TURNS: 'abc' })).toThrow(/MAX_TURNS/)
  })
})
