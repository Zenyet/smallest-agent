import { describe, it, expect, vi } from 'vitest'
import { applySettingsUpdate, createSettingsStatus, validateSettingsUpdate } from '../../electron/main/settings-update'
import { checkConnection } from '../../electron/main/connection-check'
import { createFactEdits } from '../../electron/main/fact-edits'
import type { Config, ModelResult, Message } from '../../src/types'
import type { Fact } from '../../src/memory/facts'

describe('settings transactions', () => {
  it('unsets only explicit known fields and preserves unrelated credentials', () => {
    const { valid, unset } = validateSettingsUpdate({ STREAM: '0' }, ['DEEPSEEK_API_KEY'])
    expect(applySettingsUpdate({ DEEPSEEK_API_KEY: 'old', ANTHROPIC_API_KEY: 'keep' }, valid, unset)).toEqual({ ANTHROPIC_API_KEY: 'keep', STREAM: '0' })
    expect(() => validateSettingsUpdate({}, ['UNKNOWN'])).toThrow()
    expect(() => validateSettingsUpdate({ STREAM: '1' }, ['STREAM'])).toThrow()
  })
  it('rejects invalid numerical bounds and fractional counts before persistence', () => {
    for (const patch of [{ MAX_TURNS: '-1' }, { MAX_RETRIES: '1.5' }, { TEMPERATURE: '3' }]) expect(() => validateSettingsUpdate(patch)).toThrow()
    expect(validateSettingsUpdate({ MAX_RETRIES: '0', TEMPERATURE: '0.7' }).valid).toEqual({ MAX_RETRIES: '0', TEMPERATURE: '0.7' })
  })
  it('pending state follows the startup values, persists after saving and clears on revert', () => {
    const status = createSettingsStatus({ NOTES_DIR: '/environment' }, { NOTES_DIR: '/old' })
    expect(status({ NOTES_DIR: '/new' }).pendingKeys).toEqual(['NOTES_DIR'])
    expect(status({ NOTES_DIR: '/new' }).pendingKeys).toEqual(['NOTES_DIR'])
    expect(status({ NOTES_DIR: '/old' }).pendingKeys).toEqual([])
    expect(status({}).pendingKeys).toEqual(['NOTES_DIR'])
    expect(status({}).inheritedKeys).toContain('NOTES_DIR')
    expect(createSettingsStatus({}, {})({ HF_ENDPOINT: 'https://mirror.example' }).pendingKeys).toEqual(['HF_ENDPOINT'])
  })
})

describe('connection checks', () => {
  it('checks the requested vendor with no history or tools and does not mutate settings', async () => {
    const settings = { ANTHROPIC_API_KEY: 'test-key', ACTIVE_VENDOR: 'deepseek', ACTIVE_MODEL: 'deepseek-chat' }
    const call = vi.fn(async (_messages: Message[]) => ({ text: 'OK', toolCalls: [] }) as ModelResult)
    const configs: Config[] = []
    const result = await checkConnection('anthropic', settings, config => { configs.push(config); return call })
    expect(result.ok).toBe(true)
    expect(configs[0].baseURL).toContain('anthropic.com')
    expect(configs[0].nativeSearch).toEqual({ kind: 'none' })
    expect(call.mock.calls[0][0]).toEqual([{ role: 'user', content: 'Reply with OK only.' }])
    expect(settings.ACTIVE_VENDOR).toBe('deepseek')
  })
  it('supports a local endpoint without an API key', async () => {
    const result = await checkConnection('custom', { CUSTOM_BASE_URL: 'http://localhost:11434/v1', CUSTOM_MODELS: 'demo' }, () => async () => ({ text: 'OK', toolCalls: [] }))
    expect(result.ok).toBe(true)
    expect(result.model).toBe('demo')
  })
  it('sanitizes remote errors and never presents an error as a successful connection', async () => {
    const result = await checkConnection('anthropic', { ANTHROPIC_API_KEY: 'private' }, () => async () => { throw { statusCode: 401, message: 'Authorization: private' } })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('认证')
    expect(result.message).not.toContain('private')
  })
  it('aborts a slow request and reports timeout', async () => {
    const result = await checkConnection('anthropic', { ANTHROPIC_API_KEY: 'test' }, () => async (_, signal) => new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('abort')))), 5)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('超时')
  })
})

describe('memory edit recovery', () => {
  const setup = () => {
    let facts: Fact[] = [{ key: 'preference', value: 'old', scope: 'global', updatedAt: 1, sourceSessionId: 'origin' }]
    const remember = vi.fn((input: { key: string; value: string; scope: Fact['scope']; sessionId?: string }) => {
      facts = [...facts.filter(f => f.key !== input.key || f.scope !== input.scope), { ...input, sourceSessionId: input.sessionId, updatedAt: 2 }]
      return facts
    })
    const edits = createFactEdits({ read: () => facts, remember, forget: (key, scope) => { facts = facts.filter(f => f.key !== key || f.scope !== scope); return facts } })
    return { edits, remember, replace: (next: Fact[]) => { facts = next } }
  }
  it('restores only a removed record and preserves its origin', () => {
    const { edits } = setup()
    expect(edits.forget('preference', 'global', 1)).toEqual([])
    expect(edits.restore('preference', 'global')[0].sourceSessionId).toBe('origin')
    expect(() => edits.restore('preference', 'global')).toThrow('无法撤销')
  })
  it('does not overwrite a newly recreated memory on undo', () => {
    const { edits, replace, remember } = setup()
    edits.forget('preference', 'global', 1)
    replace([{ key: 'preference', scope: 'global', value: 'new', updatedAt: 2 }])
    expect(() => edits.restore('preference', 'global')).toThrow('未覆盖')
    expect(remember).not.toHaveBeenCalled()
  })
  it('rejects stale deletion and editing a removed memory', () => {
    const { edits } = setup()
    expect(() => edits.forget('preference', 'global', 0)).toThrow('已更新')
    edits.forget('preference', 'global', 1)
    expect(() => edits.update('preference', 'global', 'edited')).toThrow('已被移除')
  })
})
