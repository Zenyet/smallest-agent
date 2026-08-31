import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeWebSearchTool, makeFetchUrlTool, htmlToText } from '../src/tools/web'

// 这些测试全程不联网：把 global fetch 换成桩。
// 真联网的话测试会依赖 Brave/维基是否可达、是否限流 —— 那测的就不是我们的代码了。
function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const body = handler(String(url), init)
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as Response
  })
}

afterEach(() => vi.unstubAllGlobals())

// Tool.run 的返回类型是 unknown（src/types.ts），所以这里收窄一次，
// 而不是在每个断言里各写一遍 as string
const parse = (s: unknown) => JSON.parse(String(s)) as Record<string, unknown>
const text = (s: unknown) => String(s)

describe('htmlToText', () => {
  it('去掉 script / style 的内容 —— 那不是正文', () => {
    const out = htmlToText('<p>正文</p><script>alert(1)</script><style>.a{color:red}</style>')
    expect(out).toContain('正文')
    expect(out).not.toContain('alert')
    expect(out).not.toContain('color:red')
  })

  it('块级标签换成换行，段落不粘成一行', () => {
    expect(htmlToText('<p>一</p><p>二</p>')).toBe('一\n二')
  })

  // &amp; 必须最后解：先解的话 "&amp;lt;" 会变成 "<"，
  // 而原文想表达的是字面的 "&lt;" 这五个字符
  it('&amp; 最后解，不会把转义过的实体二次解码', () => {
    expect(htmlToText('&amp;lt;')).toBe('&lt;')
  })

  it('解数字实体', () => {
    expect(htmlToText('a&#8212;b')).toBe('a—b')
    expect(htmlToText('a&#x2014;b')).toBe('a—b')
  })

  it('把三行以上空行压成一个空行', () => {
    expect(htmlToText('<p>一</p><p></p><p></p><p></p><p>二</p>')).toBe('一\n\n二')
  })
})

describe('web_search 的后端选择', () => {
  // 这条是整个降级链存在的理由：没配任何 key 时这个工具**仍然可用**，
  // 而不是变成一个永远报错的工具（模型会反复重试它，用户以为是网络问题）
  it('一个 key 都没有时走维基百科，不报错', async () => {
    let hit = ''
    stubFetch((url) => {
      hit = url
      return { query: { search: [{ title: '相对论', snippet: '由<span>爱因斯坦</span>提出' }] } }
    })
    const tool = makeWebSearchTool(() => ({}))
    const out = parse(await tool.run({ query: '相对论' }))
    expect(hit).toContain('wikipedia.org')
    expect(out.backend).toBe('wikipedia')
  })

  it('有 brave key 时优先用 brave', async () => {
    let hit = ''
    stubFetch((url) => {
      hit = url
      return { web: { results: [{ title: 't', url: 'u', description: 'd' }] } }
    })
    const tool = makeWebSearchTool(() => ({ brave: 'bk', tavily: 'tk' }))
    expect(parse(await tool.run({ query: 'q' })).backend).toBe('brave')
    expect(hit).toContain('search.brave.com')
  })

  it('只有 tavily key 时用 tavily', async () => {
    let hit = ''
    stubFetch((url) => {
      hit = url
      return { results: [{ title: 't', url: 'u', content: 'c' }] }
    })
    const tool = makeWebSearchTool(() => ({ tavily: 'tk' }))
    expect(parse(await tool.run({ query: 'q' })).backend).toBe('tavily')
    expect(hit).toContain('tavily.com')
  })

  it('空白 key 当作没配 —— 否则会拿 "  " 去请求然后 401', async () => {
    stubFetch(() => ({ query: { search: [] } }))
    const tool = makeWebSearchTool(() => ({ brave: '   ' }))
    expect(parse(await tool.run({ query: 'q' })).backend).toBe('wikipedia')
  })

  // key 是 getter 而不是值：用户可能跑起来之后才去设置里填，
  // 传值的话得重启才生效（其它设置项都是即时的）
  it('每次调用重新读 key，用户中途填的 key 立刻生效', async () => {
    stubFetch((url) =>
      url.includes('brave')
        ? { web: { results: [] } }
        : { query: { search: [] } },
    )
    let keys: { brave?: string } = {}
    const tool = makeWebSearchTool(() => keys)
    expect(parse(await tool.run({ query: 'q' })).backend).toBe('wikipedia')
    keys = { brave: 'bk' } // 用户这时候去填了 key
    expect(parse(await tool.run({ query: 'q' })).backend).toBe('brave')
  })

  // 模型该知道自己手上的搜索覆盖多大范围 —— 维基百科搜不到今天的新闻，
  // 那是覆盖面问题，不是「这件事不存在」
  it('把覆盖范围告诉模型，维基那档要说明局限', async () => {
    stubFetch(() => ({ query: { search: [] } }))
    const wiki = parse(await makeWebSearchTool(() => ({})).run({ query: 'q' }))
    expect(String(wiki.coverage)).toContain('没有新闻')

    stubFetch(() => ({ web: { results: [] } }))
    const brave = parse(await makeWebSearchTool(() => ({ brave: 'k' })).run({ query: 'q' }))
    expect(String(brave.coverage)).not.toContain('没有新闻')
  })
})

describe('web_search 的结果整形', () => {
  it('三个后端的字段名不同，都归一成 title/url/snippet', async () => {
    stubFetch(() => ({ results: [{ title: 'T', url: 'U', content: 'C' }] }))
    const out = parse(await makeWebSearchTool(() => ({ tavily: 'k' })).run({ query: 'q' }))
    expect(out.results).toEqual([{ title: 'T', url: 'U', snippet: 'C' }])
  })

  it('维基的 snippet 带高亮标签，要洗成纯文本', async () => {
    stubFetch(() => ({
      query: { search: [{ title: '爱因斯坦', snippet: '<span class="searchmatch">相对论</span>的提出者' }] },
    }))
    const out = parse(await makeWebSearchTool(() => ({})).run({ query: 'q' }))
    const hits = out.results as { snippet: string; url: string }[]
    expect(hits[0].snippet).toBe('相对论 的提出者')
    // 维基不给 url，要自己按标题拼
    expect(hits[0].url).toContain('/wiki/')
  })

  it('max_results 有上限 —— 再多模型也读不完，只是烧 token', async () => {
    let asked = ''
    stubFetch((url) => {
      asked = url
      return { web: { results: [] } }
    })
    await makeWebSearchTool(() => ({ brave: 'k' })).run({ query: 'q', max_results: 999 })
    expect(asked).toContain('count=10')
  })

  it('后端返回缺字段的条目时不炸，给空串', async () => {
    stubFetch(() => ({ web: { results: [{}] } }))
    const out = parse(await makeWebSearchTool(() => ({ brave: 'k' })).run({ query: 'q' }))
    expect(out.results).toEqual([{ title: '', url: '', snippet: '' }])
  })
})

describe('fetch_url', () => {
  // 这条是安全边界：file:// 能读本地文件，那就绕过了文件沙箱那一层
  // （electron/main/fs-tools.ts）。一个「取网页」的工具不该成为
  // 读 ~/.ssh/id_rsa 的旁路。
  it('拒绝 file://，不去读本地文件', async () => {
    let called = false
    stubFetch(() => {
      called = true
      return ''
    })
    const out = text(await makeFetchUrlTool().run({ url: 'file:///Users/me/.ssh/id_rsa' }))
    expect(out).toContain('只支持 http(s)')
    expect(called).toBe(false)
  })

  it('URL 格式不对时直说，不抛异常', async () => {
    const out = text(await makeFetchUrlTool().run({ url: '不是个网址' }))
    expect(out).toContain('格式不对')
  })

  // 不告诉模型截断了，它会把「读到这里」当成「文章到这里结束」——
  // 读 changelog 只读到一半会说「最新版本是 3.2」而下面还有 4.0
  it('截断时标出来，并给出原始长度', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'x'.repeat(500),
    }) as unknown as Response)
    const out = parse(await makeFetchUrlTool().run({ url: 'https://e.com', max_chars: 100 }))
    expect(out.truncated).toBe(true)
    expect(out.total_chars).toBe(500)
    expect(String(out.content)).toHaveLength(100)
  })

  it('没截断时标 false', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => '短',
    }) as unknown as Response)
    const out = parse(await makeFetchUrlTool().run({ url: 'https://e.com' }))
    expect(out.truncated).toBe(false)
  })

  it('HTML 转纯文本，非 HTML 原样给 —— 转了会破坏 JSON 结构', async () => {
    vi.stubGlobal('fetch', async (url: string | URL) => ({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': String(url).includes('json') ? 'application/json' : 'text/html',
      }),
      text: async () => (String(url).includes('json') ? '{"a":1}' : '<p>正文</p>'),
    }) as unknown as Response)

    const html = parse(await makeFetchUrlTool().run({ url: 'https://e.com/page' }))
    expect(html.content).toBe('正文')
    const json = parse(await makeFetchUrlTool().run({ url: 'https://e.com/json' }))
    expect(json.content).toBe('{"a":1}')
  })

  it('HTTP 错误码时给一句人能读懂的话', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 404,
      headers: new Headers(),
      text: async () => '',
    }) as unknown as Response)
    expect(text(await makeFetchUrlTool().run({ url: 'https://e.com' }))).toContain('404')
  })
})
