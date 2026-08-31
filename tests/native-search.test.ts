import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config'
import { buildEnv } from '../electron/main/config-env'

const paths = { sessionsDir: '/s', cacheDir: '/c' }

// 走完整条链路：设置 → buildEnv（序列化进 env）→ loadConfig（解回来）。
// 中间那次 JSON 往返是这条链最容易断的地方 —— env 只能装字符串，
// 而 nativeSearch 是个带 kind 的联合类型。
const roundTrip = (vendor: string, model: string) =>
  loadConfig(
    buildEnv(
      {},
      { ACTIVE_VENDOR: vendor, ACTIVE_MODEL: model, ZHIPU_API_KEY: 'k', DASHSCOPE_API_KEY: 'k', DEEPSEEK_API_KEY: 'k' },
      paths,
    ),
  )

describe('厂商自带搜索：设置 → env → Config', () => {
  // 智谱在 OpenAI 兼容层上支持搜索：tools 数组里加一项
  it('智谱带 tool-type 形状的开关', () => {
    expect(roundTrip('glm', 'glm-4.6').nativeSearch).toEqual({
      kind: 'tool-type',
      toolType: 'web_search',
    })
  })

  // 通义是另一种形状：请求体里一个布尔
  it('通义带 enable-flag 形状的开关', () => {
    expect(roundTrip('qwen', 'qwen3-max').nativeSearch).toEqual({ kind: 'enable-flag' })
  })

  // 其余七家的搜索只在各家原生 API 上（Responses API / google_search /
  // Anthropic 的 web_search），OpenAI 兼容层拿不到 —— 所以是 undefined，
  // 那些会话用我们自己的 web_search
  // DeepSeek 的搜索确实在 Responses API 上 —— 所以这家**走那条协议**，
  // 而不是「没有搜索」。原来这条断言 nativeSearch 是 undefined，
  // 那是「我们只走 chat/completions」时代的结论
  it('DeepSeek 走 Responses API，服务端搜索打开', () => {
    const c = roundTrip('deepseek', 'deepseek-chat')
    expect(c.protocol).toBe('responses')
    expect(c.nativeSearch).toEqual({ kind: 'tool-type', toolType: 'web_search' })
  })

  it('OpenAI 同理', () => {
    const c = loadConfig(
      buildEnv({}, { ACTIVE_VENDOR: 'openai', ACTIVE_MODEL: 'gpt-5.2', OPENAI_API_KEY: 'k' }, paths),
    )
    expect(c.protocol).toBe('responses')
  })

  // 其余几家仍然走 chat/completions
  it('智谱走 chat（它的搜索在兼容层上就能开）', () => {
    expect(roundTrip('glm', 'glm-4.6').protocol).toBe('chat')
  })

  it('Anthropic 没有（原生 API 有，但兼容层不透传）', () => {
    expect(
      loadConfig(
        buildEnv({}, { ACTIVE_VENDOR: 'anthropic', ACTIVE_MODEL: 'claude-opus-5', ANTHROPIC_API_KEY: 'k' }, paths),
      ).nativeSearch,
    ).toBeUndefined()
  })

  // kind==='none' 不写进 env：省掉一次没意义的解析，env 里也少一项噪音
  it('没有自带搜索时 env 里根本不写这一项', () => {
    // 换一家真的没有的：Anthropic 的搜索在它自己的原生 API 上，
    // 而我们走的是它的 OpenAI 兼容层
    const env = buildEnv(
      {},
      { ACTIVE_VENDOR: 'anthropic', ACTIVE_MODEL: 'claude-opus-5', ANTHROPIC_API_KEY: 'k' },
      paths,
    )
    expect(env.NATIVE_SEARCH).toBeUndefined()
  })

  // 'chat' 是默认值，写进 env 只是多一项噪音
  it('走 chat 的厂商不写 LLM_PROTOCOL', () => {
    const env = buildEnv({}, { ACTIVE_VENDOR: 'glm', ACTIVE_MODEL: 'glm-4.6', ZHIPU_API_KEY: 'k' }, paths)
    expect(env.LLM_PROTOCOL).toBeUndefined()
  })

  it('走 responses 的厂商写进去', () => {
    const env = buildEnv(
      {},
      { ACTIVE_VENDOR: 'deepseek', ACTIVE_MODEL: 'deepseek-chat', DEEPSEEK_API_KEY: 'k' },
      paths,
    )
    expect(env.LLM_PROTOCOL).toBe('responses')
  })

  it('认不出的协议值落回 chat，不让应用起不来', () => {
    expect(loadConfig({ DEEPSEEK_API_KEY: 'k', LLM_PROTOCOL: '乱写' }).protocol).toBe('chat')
  })
})

describe('NATIVE_SEARCH 解析的健壮性', () => {
  const base = { DEEPSEEK_API_KEY: 'k' }

  // 这一项是可选增强（少了只是用不上厂商自带搜索，我们自己那个还在），
  // 而抛错会让整个应用起不来 —— 手改坏一个 JSON 不该是启动失败的理由
  it('坏 JSON 当成没有，不抛错', () => {
    expect(loadConfig({ ...base, NATIVE_SEARCH: '{不是 json' }).nativeSearch).toBeUndefined()
  })

  it('认不出的 kind 当成没有', () => {
    expect(loadConfig({ ...base, NATIVE_SEARCH: '{"kind":"乱写"}' }).nativeSearch).toBeUndefined()
  })

  it('null 当成没有', () => {
    expect(loadConfig({ ...base, NATIVE_SEARCH: 'null' }).nativeSearch).toBeUndefined()
  })

  it('合法值能解出来', () => {
    expect(loadConfig({ ...base, NATIVE_SEARCH: '{"kind":"enable-flag"}' }).nativeSearch).toEqual({
      kind: 'enable-flag',
    })
  })

  // CLI 不写这一项（它没有厂商选择，直接读 DEEPSEEK_* 环境变量）
  it('CLI 那条路（不设这个变量）是 undefined，不是崩', () => {
    expect(loadConfig(base).nativeSearch).toBeUndefined()
  })
})
