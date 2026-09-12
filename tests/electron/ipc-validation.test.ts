import { describe, it, expect } from 'vitest'
import { validateSettingsPatch, NUMERIC_SETTINGS, BOOLEAN_SETTINGS } from '../../electron/main/settings-validate'
import { SETTING_KEYS } from '../../electron/main/config-env'

describe('validateSettingsPatch', () => {
  it('接受合法的设置对象', () => {
    const result = validateSettingsPatch({ DEEPSEEK_API_KEY: 'sk-123', ACTIVE_MODEL: 'deepseek-chat' })
    expect(result.valid.DEEPSEEK_API_KEY).toBe('sk-123')
    expect(result.valid.ACTIVE_MODEL).toBe('deepseek-chat')
    expect(result.dropped).toEqual([])
  })

  // DEEPSEEK_MODEL / DEEPSEEK_BASE_URL 不再是用户可填的键——它们是 buildEnv
  // 从「选了哪家 + 哪个模型」算出来的派生值（见 config-env.ts）。所以它们
  // 现在会被当成未知 key 丢掉，这是有意的。
  it('丢掉派生键 DEEPSEEK_MODEL / DEEPSEEK_BASE_URL', () => {
    const result = validateSettingsPatch({
      DEEPSEEK_MODEL: 'x',
      DEEPSEEK_BASE_URL: 'y',
    })
    expect(result.dropped.sort()).toEqual(['DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL'])
    expect(Object.keys(result.valid)).toEqual([])
  })

  it('记录被跳过的未知 key', () => {
    const result = validateSettingsPatch({ DEEPSEEK_API_KEY: 'sk-123', UNKNOWN_KEY: 'value' })
    expect(result.valid.DEEPSEEK_API_KEY).toBe('sk-123')
    expect('UNKNOWN_KEY' in result.valid).toBe(false)
    expect(result.dropped).toEqual(['UNKNOWN_KEY'])
  })

  it('拒绝非字符串的值', () => {
    expect(() => validateSettingsPatch({ DEEPSEEK_API_KEY: 123 })).toThrow(/必须是字符串/)
    expect(() => validateSettingsPatch({ NOTES_DIR: null })).toThrow(/必须是字符串/)
    expect(() => validateSettingsPatch({ MAX_TURNS: ['10'] })).toThrow(/必须是字符串/)
  })

  it('拒绝非对象的输入', () => {
    expect(() => validateSettingsPatch(null)).toThrow(/必须是对象/)
    expect(() => validateSettingsPatch(undefined)).toThrow(/必须是对象/)
    expect(() => validateSettingsPatch('not an object')).toThrow(/必须是对象/)
    expect(() => validateSettingsPatch(123)).toThrow(/必须是对象/)
  })

  it('去掉纯空白的值', () => {
    const result = validateSettingsPatch({ DEEPSEEK_API_KEY: '   ', ACTIVE_MODEL: '  model  ' })
    expect('DEEPSEEK_API_KEY' in result.valid).toBe(false)
    expect(result.valid.ACTIVE_MODEL).toBe('model')
  })

  it('接受空对象，返回空对象', () => {
    const result = validateSettingsPatch({})
    expect(Object.keys(result.valid)).toEqual([])
    expect(result.dropped).toEqual([])
  })

  it('trim 值的前后空白', () => {
    const result = validateSettingsPatch({ NOTES_DIR: '  /path/to/notes  ' })
    expect(result.valid.NOTES_DIR).toBe('/path/to/notes')
  })

  // 用 SETTING_KEYS 自己生成输入，而不是手抄一份清单——手抄的那份会在
  // 加字段（比如多厂商那批 key）时悄悄过期，而这条测试的意义正是
  // 「SETTING_KEYS 里的每个键都能通过验证」
  it('接受所有 SETTING_KEYS 中的字段', () => {
    // 从被测模块导出的那份清单读，不再在测试里复制一份 ——
    // 复制的那份漂过一次了（加 TEMPERATURE 时这里没跟上，红了一次）
    const numeric = NUMERIC_SETTINGS
    const boolean = BOOLEAN_SETTINGS
    const input: Record<string, string> = {}
    for (const key of SETTING_KEYS) {
      input[key] = numeric.has(key) ? '3' : boolean.has(key) ? '1' : 'value'
    }
    const result = validateSettingsPatch(input)
    expect(result.dropped).toEqual([])
    expect(Object.keys(result.valid).length).toBe(SETTING_KEYS.length)
  })

  it('拒绝数字型字段的非数字值', () => {
    expect(() => validateSettingsPatch({ MAX_TURNS: 'abc' })).toThrow(/必须是数字/)
    expect(() => validateSettingsPatch({ MAX_RETRIES: 'ten' })).toThrow(/必须是数字/)
    expect(() => validateSettingsPatch({ MAX_CONTEXT_TOKENS: '2000px' })).toThrow(/必须是数字/)
    expect(() => validateSettingsPatch({ KEEP_RECENT: 'NaN' })).toThrow(/必须是数字/)
  })

  it('接受数字型字段的合法数字', () => {
    const result = validateSettingsPatch({
      MAX_TURNS: '10',
      MAX_RETRIES: '2',
      MAX_CONTEXT_TOKENS: '2000',
      KEEP_RECENT: '6',
    })
    expect(result.valid.MAX_TURNS).toBe('10')
    expect(result.valid.MAX_RETRIES).toBe('2')
  })

  it('拒绝布尔型字段的非法值', () => {
    expect(() => validateSettingsPatch({ STREAM: 'true' })).toThrow(/只接受/)
    expect(() => validateSettingsPatch({ LLM_CACHE: 'false' })).toThrow(/只接受/)
    expect(() => validateSettingsPatch({ STREAM: 'yes' })).toThrow(/只接受/)
  })

  it('接受布尔型字段的合法值', () => {
    const result = validateSettingsPatch({ STREAM: '0', LLM_CACHE: '1' })
    expect(result.valid.STREAM).toBe('0')
    expect(result.valid.LLM_CACHE).toBe('1')
  })

  it('接受布尔型字段的空字符串', () => {
    const result = validateSettingsPatch({ STREAM: '', LLM_CACHE: '' })
    // 空字符串 trim 后为空，会被跳过
    expect('STREAM' in result.valid).toBe(false)
    expect('LLM_CACHE' in result.valid).toBe(false)
  })
})
