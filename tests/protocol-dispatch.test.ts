import { describe, it, expect } from 'vitest'
import { makeCallModel } from '../src/llm'
import { loadConfig } from '../src/config'
import type { ToolRegistry } from '../src/types'

// 这一组验的是「按厂商走哪条协议路径」。
//
// 拦最外层的 fetch：那是真正出网的那一步，看到的 URL 和 body 就是厂商
// 会收到的。mock 更里面的层会让测试通过但真实请求仍然是错的。
async function capture(
  over: Partial<ReturnType<typeof loadConfig>>,
  registry: ToolRegistry = {},
) {
  let url = ''
  let body: Record<string, unknown> | undefined
  const config = { ...loadConfig({ DEEPSEEK_API_KEY: 'k' }), ...over }
  const call = makeCallModel(config, registry)

  const original = globalThis.fetch
  globalThis.fetch = (async (u: string | URL, init?: { body?: string }) => {
    url = String(u)
    body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
    // Responses API 和 chat/completions 的响应形状不同，各回各的最小合法体
    const isResponses = url.includes('/responses')
    return new Response(
      JSON.stringify(
        isResponses
          ? {
              id: 'r1',
              object: 'response',
              created_at: 0,
              model: 'm',
              status: 'completed',
              output: [
                {
                  type: 'message',
                  id: 'm1',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'ok', annotations: [] }],
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            }
          : {
              id: '1',
              object: 'chat.completion',
              created: 0,
              model: 'm',
              choices: [
                { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
      ),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  try {
    await call([{ role: 'user', content: 'hi' }])
  } finally {
    globalThis.fetch = original
  }
  return { url, body }
}

describe('协议分派', () => {
  // ## 这是这次改动的核心
  //
  // DeepSeek / OpenAI 的服务端联网搜索**只在 Responses API 上**。走
  // chat/completions 的话那个能力根本够不着 —— 用户配了 key 也用不上，
  // 只能退到我们自己那套（没配 Brave/Tavily 时是维基百科兜底）。
  it("protocol='responses' 打到 /responses 端点", async () => {
    const { url } = await capture({ protocol: 'responses' })
    expect(url).toContain('/responses')
    expect(url).not.toContain('/chat/completions')
  })

  it("protocol='chat' 打到 /chat/completions", async () => {
    const { url } = await capture({ protocol: 'chat' })
    expect(url).toContain('/chat/completions')
  })

  it('不填协议时走 chat（绝大多数厂商）', async () => {
    const { url } = await capture({ protocol: undefined })
    expect(url).toContain('/chat/completions')
  })

  // baseURL 可配是这件事能成的前提：同一份 Responses 实现能指向
  // DeepSeek 或 OpenAI，不用为每家写一套
  it('responses 路径尊重 baseURL，能指向 DeepSeek', async () => {
    const { url } = await capture({
      protocol: 'responses',
      baseURL: 'https://api.deepseek.com/v1',
    })
    expect(url).toContain('api.deepseek.com')
  })
})

describe('responses 路径上的服务端搜索', () => {
  it('有 nativeSearch 时请求体里带 web_search 工具', async () => {
    const { body } = await capture({
      protocol: 'responses',
      nativeSearch: { kind: 'tool-type', toolType: 'web_search' },
    })
    const tools = (body?.tools ?? []) as { type: string }[]
    expect(tools.some((t) => t.type === 'web_search')).toBe(true)
  })

  it('没有 nativeSearch 时不带', async () => {
    const { body } = await capture({ protocol: 'responses', nativeSearch: undefined })
    const tools = (body?.tools ?? []) as { type: string }[]
    expect(tools.some((t) => t.type === 'web_search')).toBe(false)
  })

  // 服务端搜索是**追加**在我们的工具之后。覆盖掉的话 agent 会突然失去
  // 文件、技能、笔记检索那些能力，而症状是「模型说它做不到」——
  // 看不出是请求体被改坏了
  it('服务端搜索和我们自己的工具并存', async () => {
    const registry: ToolRegistry = {
      my_tool: { name: 'my_tool', description: 'd', parameters: undefined, run: async () => 'x' },
    }
    const { body } = await capture(
      { protocol: 'responses', nativeSearch: { kind: 'tool-type', toolType: 'web_search' } },
      registry,
    )
    const tools = (body?.tools ?? []) as { type: string; name?: string }[]
    expect(tools.some((t) => t.type === 'web_search')).toBe(true)
    expect(tools.some((t) => t.name === 'my_tool')).toBe(true)
  })
})

describe('服务端搜索的结果要能到界面', () => {
  // ## 这一组锁的是「卡片出不来 / 出来是空的」
  //
  // 实测 DeepSeek 的响应：web_search_call 这个 item 只有
  // {type, id, status, action}，**没有 output 字段**。而 SDK 把它转成
  // tool-result 时用的字段名是 `result`。读错的话恒为 undefined。
  it('从 SDK 的 result 字段读服务端结果，不是 output', async () => {
    let captured: unknown
    const config = {
      ...loadConfig({ DEEPSEEK_API_KEY: 'k' }),
      protocol: 'responses' as const,
      nativeSearch: { kind: 'tool-type' as const, toolType: 'web_search' },
    }
    const call = makeCallModel(config, {})
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'r1',
          object: 'response',
          created_at: 0,
          model: 'm',
          status: 'completed',
          output: [
            {
              type: 'web_search_call',
              id: 'ws1',
              status: 'completed',
              action: { type: 'search', query: '今天新闻' },
            },
            {
              type: 'message',
              id: 'm1',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: '答案', annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
    try {
      captured = await call([{ role: 'user', content: 'hi' }])
    } finally {
      globalThis.fetch = original
    }
    const r = captured as { serverToolCalls?: { name: string; output: unknown }[] }
    expect(r.serverToolCalls).toHaveLength(1)
    expect(r.serverToolCalls![0].name).toBe('web_search')
    // 关键：output 不能是 undefined —— 那正是卡片空着的症状
    expect(r.serverToolCalls![0].output).toBeDefined()
  })

  // 请求体要带 include，否则响应里 action.queries 全是内部 id
  it('请求体带上 web_search_call.action.sources', async () => {
    const { body } = await capture({
      protocol: 'responses',
      nativeSearch: { kind: 'tool-type', toolType: 'web_search' },
    })
    expect(body?.include).toContain('web_search_call.action.sources')
  })
})
