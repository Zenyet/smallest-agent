import { describe, it, expect } from 'vitest'
import { makeCallModel } from '../src/llm'
import { loadConfig } from '../src/config'
import type { NativeSearch, ToolRegistry } from '../src/types'

// 这一组验的是**发出去的请求体长什么样**。
//
// 不 mock SDK 内部，而是拦最外层的 fetch —— 那是真正出网的那一步，
// 拦在那里看到的 body 就是厂商会收到的 body。mock 更里面的层会让测试
// 通过但真实请求仍然是错的。
function captureBody(nativeSearch: NativeSearch | undefined, registry: ToolRegistry = {}) {
  let captured: Record<string, unknown> | undefined
  const config = {
    ...loadConfig({ DEEPSEEK_API_KEY: 'k' }),
    ...(nativeSearch ? { nativeSearch } : {}),
  }
  const call = makeCallModel(config, registry)
  const fakeFetch = async (_url: string, init?: { body?: string }) => {
    captured = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
    // 回一个最小的合法 chat/completions 响应，让 SDK 能解析完
    return new Response(
      JSON.stringify({
        id: '1',
        object: 'chat.completion',
        created: 0,
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return { call, fakeFetch, body: () => captured }
}

// makeCallModel 内部自己建 provider，没法从外面塞 fetch —— 所以用
// globalThis.fetch 这个口子。SDK 默认走的就是它。
async function runWith(nativeSearch: NativeSearch | undefined, registry: ToolRegistry = {}) {
  const { call, fakeFetch, body } = captureBody(nativeSearch, registry)
  const original = globalThis.fetch
  globalThis.fetch = fakeFetch as unknown as typeof fetch
  try {
    await call([{ role: 'user', content: 'hi' }])
  } finally {
    globalThis.fetch = original
  }
  return body()
}

describe('厂商自带搜索：请求体形状', () => {
  // 阿里 DashScope：请求体里一个布尔
  it('enable-flag 塞一个 enable_search: true', async () => {
    const body = await runWith({ kind: 'enable-flag' })
    expect(body?.enable_search).toBe(true)
  })

  // 智谱：tools 数组里加一项
  it('tool-type 往 tools 数组里加一项 {type}', async () => {
    const body = await runWith({ kind: 'tool-type', toolType: 'web_search' })
    const tools = body?.tools as { type: string }[]
    expect(tools).toEqual([{ type: 'web_search' }])
  })

  it('builtin-function 的形状', async () => {
    const body = await runWith({ kind: 'builtin-function', name: '$web_search' })
    const tools = body?.tools as { type: string; function: { name: string } }[]
    expect(tools[0]).toEqual({ type: 'builtin_function', function: { name: '$web_search' } })
  })

  it('没有自带搜索时请求体不变', async () => {
    const body = await runWith(undefined)
    expect(body?.enable_search).toBeUndefined()
    expect(body?.tools).toBeUndefined()
  })

  it('kind==="none" 也不动请求体', async () => {
    const body = await runWith({ kind: 'none' })
    expect(body?.enable_search).toBeUndefined()
    expect(body?.tools).toBeUndefined()
  })

  // ## 这一条是最容易写错的地方
  //
  // 自带搜索是**追加**在我们的工具之后，不是覆盖。覆盖的话 agent 会突然
  // 失去文件、技能、笔记检索那些能力，而症状是「模型说它做不到」——
  // 看不出是请求体被改坏了。rs 侧也有一条测试专门锁这个
  // （wire.rs 的 native_search_coexists_with_our_own_tools）。
  it('自带搜索是追加，不挤掉我们自己的工具', async () => {
    const registry: ToolRegistry = {
      my_tool: {
        name: 'my_tool',
        description: 'd',
        parameters: undefined,
        run: async () => 'x',
      },
    }
    const body = await runWith({ kind: 'tool-type', toolType: 'web_search' }, registry)
    const tools = body?.tools as { type: string }[]
    expect(tools).toHaveLength(2)
    // 我们的工具是 function 型，自带那个是 type 型，两者并存
    expect(tools.some((t) => t.type === 'function')).toBe(true)
    expect(tools.some((t) => t.type === 'web_search')).toBe(true)
  })
})
