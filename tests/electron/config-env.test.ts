import { describe, it, expect } from 'vitest'
import { buildEnv } from '../../electron/main/config-env'
import { loadConfig } from '../../src/config'

const paths = { sessionsDir: '/data/sessions', cacheDir: '/data/cache' }

describe('buildEnv', () => {
  it('用户设置覆盖 process.env', () => {
    const env = buildEnv({ NOTES_DIR: 'from-env' }, { NOTES_DIR: 'from-settings' }, paths)
    expect(env.NOTES_DIR).toBe('from-settings')
  })

  it('保留未被设置覆盖的 base 变量（PATH 之类子进程要用）', () => {
    const env = buildEnv({ PATH: '/usr/bin' }, {}, paths)
    expect(env.PATH).toBe('/usr/bin')
  })

  it('忽略空字符串设置项，避免把 NOTES_DIR 覆盖成空值', () => {
    const env = buildEnv({ NOTES_DIR: '/real/notes' }, { NOTES_DIR: '' }, paths)
    expect(env.NOTES_DIR).toBe('/real/notes')
  })

  it('目录由 paths 强制指定，用户设置改不了', () => {
    const env = buildEnv({}, { SESSIONS_DIR: '/hacked' } as never, paths)
    expect(env.SESSIONS_DIR).toBe('/data/sessions')
    expect(env.LLM_CACHE_DIR).toBe('/data/cache')
  })

  it('产物能直接喂给 loadConfig（这是它唯一的用途）', () => {
    const env = buildEnv({}, { DEEPSEEK_API_KEY: 'k' }, paths)
    const config = loadConfig(env)
    expect(config.apiKey).toBe('k')
    expect(config.sessionsDir).toBe('/data/sessions')
    expect(config.cacheDir).toBe('/data/cache')
  })

  // --- 多厂商：厂商选择解析成 src/config.ts 认识的三个名字 ---
  //
  // 这是「不碰 src/ 也能支持多厂商」的落点：loadConfig 只认 DEEPSEEK_* 的
  // 值，不检查它们是不是真的来自 DeepSeek（见 config-env.ts 文件头）。

  it('没选厂商时走 DeepSeek——老配置（只有一把 DEEPSEEK_API_KEY）行为不变', () => {
    const env = buildEnv({}, { DEEPSEEK_API_KEY: 'sk-ds' }, paths)
    expect(env.DEEPSEEK_API_KEY).toBe('sk-ds')
    expect(env.DEEPSEEK_BASE_URL).toBe('https://api.deepseek.com/v1')
    expect(env.DEEPSEEK_MODEL).toBe('deepseek-chat')
  })

  it('选了别家时，三个 DEEPSEEK_* 填的是那家的值', () => {
    const env = buildEnv(
      {},
      { ACTIVE_VENDOR: 'anthropic', ACTIVE_MODEL: 'claude-opus-5', ANTHROPIC_API_KEY: 'sk-ant' },
      paths,
    )
    expect(env.DEEPSEEK_API_KEY).toBe('sk-ant')
    expect(env.DEEPSEEK_BASE_URL).toBe('https://api.anthropic.com/v1')
    expect(env.DEEPSEEK_MODEL).toBe('claude-opus-5')
  })

  // 别家的原始 key 也会被写进 env（它在 SETTING_KEYS 里），但不能覆盖掉
  // 解析结果——所以解析必须放在遍历之后
  it('厂商原始 key 不会覆盖掉解析出来的 DEEPSEEK_API_KEY', () => {
    const env = buildEnv(
      {},
      { ACTIVE_VENDOR: 'anthropic', ACTIVE_MODEL: 'claude-opus-5', ANTHROPIC_API_KEY: 'sk-ant', DEEPSEEK_API_KEY: 'sk-old' },
      paths,
    )
    expect(env.DEEPSEEK_API_KEY).toBe('sk-ant')
  })

  it('自定义端点解析出用户填的地址和模型', () => {
    const env = buildEnv(
      {},
      {
        ACTIVE_VENDOR: 'custom',
        ACTIVE_MODEL: 'llama3',
        CUSTOM_BASE_URL: 'http://localhost:11434/v1',
        CUSTOM_MODELS: 'llama3',
      },
      paths,
    )
    expect(env.DEEPSEEK_BASE_URL).toBe('http://localhost:11434/v1')
    expect(env.DEEPSEEK_MODEL).toBe('llama3')
    // 本地服务通常不校验 authorization
    expect(env.DEEPSEEK_API_KEY).toBe('')
  })

  // 解析不出来时不抛错：loadConfig 会因为 DEEPSEEK_API_KEY 缺失而报出
  // 「填了才能跑」这条既有路径，用户看到的是同一句提示，不是新错误码
  it('没配 key 时不抛错，交给 loadConfig 报既有的缺 key 错误', () => {
    expect(() => buildEnv({}, { ACTIVE_VENDOR: 'anthropic' }, paths)).not.toThrow()
    const env = buildEnv({}, { ACTIVE_VENDOR: 'anthropic' }, paths)
    expect(() => loadConfig(env)).toThrow(/DEEPSEEK_API_KEY/)
  })
})
