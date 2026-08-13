import { describe, it, expect } from 'vitest'
import {
  detectClaudeConfig,
  detectCodexConfig,
  detectGeminiConfig,
  extractClaudeSecret,
  extractCodexSecret,
} from '../../electron/main/provider-detect'

describe('detectClaudeConfig', () => {
  it('返回 null 当文件不存在', () => {
    expect(detectClaudeConfig(null)).toBeNull()
  })

  it('返回 null 当 JSON 格式错误', () => {
    expect(detectClaudeConfig('not json')).toBeNull()
  })

  it('检测到可用配置（有 ANTHROPIC_AUTH_TOKEN）', () => {
    const content = JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-test123', ANTHROPIC_BASE_URL: 'https://api.example.com' },
      model: 'opus',
    })
    const result = detectClaudeConfig(content)
    expect(result).toEqual({
      provider: 'claude',
      available: true,
      model: 'opus',
      baseUrl: 'https://api.example.com',
    })
  })

  it('检测到不可用配置（token 为空）', () => {
    const content = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: '' } })
    const result = detectClaudeConfig(content)
    expect(result).toEqual({
      provider: 'claude',
      available: false,
      reason: '配置文件存在，但未找到 ANTHROPIC_AUTH_TOKEN',
    })
  })

  it('检测到不可用配置（没有 token 字段）', () => {
    const content = JSON.stringify({ env: {} })
    const result = detectClaudeConfig(content)
    expect(result).toEqual({
      provider: 'claude',
      available: false,
      reason: '配置文件存在，但未找到 ANTHROPIC_AUTH_TOKEN',
    })
  })
})

describe('extractClaudeSecret', () => {
  it('返回 null 当文件不存在', () => {
    expect(extractClaudeSecret(null)).toBeNull()
  })

  it('返回 null 当 JSON 格式错误', () => {
    expect(extractClaudeSecret('not json')).toBeNull()
  })

  it('提取密钥和配置', () => {
    const content = JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: '  sk-test123  ', ANTHROPIC_BASE_URL: '  https://api.example.com  ' },
      model: '  opus  ',
    })
    const result = extractClaudeSecret(content)
    expect(result).toEqual({
      apiKey: 'sk-test123',
      baseUrl: 'https://api.example.com',
      model: 'opus',
    })
  })

  it('返回 null 当 token 为空', () => {
    const content = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: '' } })
    expect(extractClaudeSecret(content)).toBeNull()
  })
})

describe('detectCodexConfig', () => {
  it('返回 null 当 auth.json 不存在', () => {
    expect(detectCodexConfig(null, null)).toBeNull()
  })

  it('返回 null 当 auth.json 格式错误', () => {
    expect(detectCodexConfig('not json', null)).toBeNull()
  })

  it('检测到 OAuth 登录态（不可用）', () => {
    const authContent = JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null })
    const configContent = 'model = "gpt-4"'
    const result = detectCodexConfig(authContent, configContent)
    expect(result).toEqual({
      provider: 'codex',
      available: false,
      reason: 'OAuth 登录态（ChatGPT），access_token 不能当通用 API key 用',
      model: 'gpt-4',
    })
  })

  it('检测到可用配置（auth_mode 不是 chatgpt 且有 key）', () => {
    const authContent = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test123' })
    const configContent = 'model = "gpt-4"'
    const result = detectCodexConfig(authContent, configContent)
    expect(result).toEqual({
      provider: 'codex',
      available: true,
      model: 'gpt-4',
    })
  })

  it('检测到不可用配置（key 为空）', () => {
    const authContent = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: '' })
    const result = detectCodexConfig(authContent, null)
    expect(result).toEqual({
      provider: 'codex',
      available: false,
      reason: 'auth.json 存在，但 OPENAI_API_KEY 为空或 null',
      model: undefined,
    })
  })

  it('从 config.toml 提取 model（顶层键）', () => {
    const authContent = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' })
    const configContent = `
model = "gpt-4o"
some_other_key = "value"

[projects."/path/to/project"]
model = "should-not-match"
`
    const result = detectCodexConfig(authContent, configContent)
    expect(result?.model).toBe('gpt-4o')
  })

  it('config.toml 不存在时 model 为 undefined', () => {
    const authContent = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' })
    const result = detectCodexConfig(authContent, null)
    expect(result?.model).toBeUndefined()
  })
})

describe('extractCodexSecret', () => {
  it('返回 null 当 auth.json 不存在', () => {
    expect(extractCodexSecret(null, null)).toBeNull()
  })

  it('返回 null 当 auth.json 格式错误', () => {
    expect(extractCodexSecret('not json', null)).toBeNull()
  })

  it('提取密钥和 model', () => {
    const authContent = JSON.stringify({ OPENAI_API_KEY: '  sk-test123  ' })
    const configContent = 'model = "gpt-4"'
    const result = extractCodexSecret(authContent, configContent)
    expect(result).toEqual({
      apiKey: 'sk-test123',
      model: 'gpt-4',
    })
  })

  it('返回 null 当 key 为空', () => {
    const authContent = JSON.stringify({ OPENAI_API_KEY: '' })
    expect(extractCodexSecret(authContent, null)).toBeNull()
  })
})

describe('detectGeminiConfig', () => {
  it('返回 null 当文件不存在', () => {
    expect(detectGeminiConfig(null)).toBeNull()
  })

  it('返回 null 当 JSON 格式错误', () => {
    expect(detectGeminiConfig('not json')).toBeNull()
  })

  it('检测到但标记为不可用（settings.json 不存密钥）', () => {
    const content = JSON.stringify({ theme: 'Default', selectedAuthType: 'gemini-api-key' })
    const result = detectGeminiConfig(content)
    expect(result).toEqual({
      provider: 'gemini',
      available: false,
      reason: 'settings.json 不存储密钥，无法导入',
    })
  })
})
