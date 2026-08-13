import { describe, it, expect } from 'vitest'
import { buildEnv } from '../../electron/main/config-env'
import { loadConfig } from '../../src/config'

const paths = { sessionsDir: '/data/sessions', cacheDir: '/data/cache' }

describe('buildEnv', () => {
  it('用户设置覆盖 process.env', () => {
    const env = buildEnv({ DEEPSEEK_MODEL: 'from-env' }, { DEEPSEEK_MODEL: 'from-settings' }, paths)
    expect(env.DEEPSEEK_MODEL).toBe('from-settings')
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
    const env = buildEnv({}, { DEEPSEEK_API_KEY: 'k', DEEPSEEK_MODEL: 'deepseek-chat' }, paths)
    const config = loadConfig(env)
    expect(config.apiKey).toBe('k')
    expect(config.sessionsDir).toBe('/data/sessions')
    expect(config.cacheDir).toBe('/data/cache')
  })
})
