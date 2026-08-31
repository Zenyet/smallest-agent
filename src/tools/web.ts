// ============================================================================
// web.ts —— 联网能力：web_search + fetch_url
// ----------------------------------------------------------------------------
// 移植自 rs/core/src/tools/web.rs（那边是基准）。
//
// ## 为什么是「搜索」和「取正文」两个工具，不是一个
//
// 搜索结果的 snippet 只有一两句话，回答「X 是什么时候发布的」够用，回答
// 「X 的第三条限制是什么」不够 —— 后者要正文。合成一个工具的话模型没法
// 表达「我只要列表」和「我要这一篇的全文」的区别，只能每次都把正文拉回来，
// 而一篇网页的正文动辄几万字，几条结果就撑爆上下文。
//
// 分成两个，模型自己决定要不要深入：先搜，看 snippet，觉得哪条相关再 fetch。
//
// ## 搜索后端：三档降级，最后一档不要 key
//
//   Brave（有 BRAVE_API_KEY 就用）→ Tavily（有 TAVILY_API_KEY）→ 维基百科
//
// 顺序是「结果质量」排的：Brave 是通用网页索引；Tavily 是给 LLM 调优过的
// 搜索（snippet 更长、更像答案），但索引面窄一些；维基百科只有百科条目。
//
// 最后一档**故意选了不需要 key 的**。不然没配 key 的用户看到的是
// 「web_search 报错：缺少 API key」—— 一个永远失败的工具比没有这个工具更糟，
// 模型会反复重试它，用户还以为是网络问题。有了维基百科兜底，这个工具
// 在零配置下也能回答「相对论是谁提出的」这类问题，只是覆盖面窄。
//
// 这也是为什么后端选择不作为参数暴露给模型：模型无从知道用户配了哪把 key，
// 让它选只会选到没配的那个。由代码按可用性决定，模型只管提问。
//
// ## fetch_url 为什么要截断，以及为什么把截断这件事告诉模型
//
// 网页正文没有上限，而上下文有。截断是必须的；但**不告诉模型截断了**会
// 让它把「文章到这里就没了」当成事实 —— 比如读一份 changelog 只读到一半，
// 它会说「最新版本是 3.2」而其实下面还有 4.0。所以返回值里带 truncated
// 标记和原始长度，让模型知道自己看到的是残缺的。
// ============================================================================

import { z } from 'zod'
import type { Tool } from '../types'

/** 搜索后端的凭据。由上层从设置里读出来传进来 —— 这个模块不碰 process.env，
 *  否则测试要靠改环境变量才能跑，而那是全局状态。 */
export interface WebSearchKeys {
  brave?: string
  tavily?: string
}

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

/** 单次搜索返回几条。5 条够覆盖不同角度，又不至于让 snippet 占满上下文。 */
const DEFAULT_RESULTS = 5
/** 上限：再多模型也读不完，只是烧 token。 */
const MAX_RESULTS = 10
/** fetch_url 默认取多少字符。约等于 15k token，留得下后续推理的余量。 */
const DEFAULT_MAX_CHARS = 60_000
/** 单次 fetch 的硬上限，防止模型传个巨大的 max_chars 把上下文顶爆。 */
const HARD_MAX_CHARS = 200_000
/** 网络超时。搜索和取页面都不该让整轮对话卡死。 */
const TIMEOUT_MS = 15_000

/** 带超时的 fetch。AbortSignal.timeout 在 Node 18+ 和浏览器里都有。 */
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
}

// --- 三个后端 ---

async function searchBrave(key: string, query: string, n: number): Promise<SearchHit[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`
  const res = await fetchWithTimeout(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
  })
  if (!res.ok) throw new Error(`Brave 搜索失败：HTTP ${res.status}`)
  const json = (await res.json()) as { web?: { results?: unknown[] } }
  return (json.web?.results ?? []).slice(0, n).map((r) => {
    const o = r as Record<string, unknown>
    return {
      title: typeof o.title === 'string' ? o.title : '',
      url: typeof o.url === 'string' ? o.url : '',
      // Brave 把摘要放在 description
      snippet: htmlToText(typeof o.description === 'string' ? o.description : ''),
    }
  })
}

async function searchTavily(key: string, query: string, n: number): Promise<SearchHit[]> {
  const res = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: n, search_depth: 'basic' }),
  })
  if (!res.ok) throw new Error(`Tavily 搜索失败：HTTP ${res.status}`)
  const json = (await res.json()) as { results?: unknown[] }
  return (json.results ?? []).slice(0, n).map((r) => {
    const o = r as Record<string, unknown>
    return {
      title: typeof o.title === 'string' ? o.title : '',
      url: typeof o.url === 'string' ? o.url : '',
      // Tavily 把摘要放在 content（比 Brave 的 description 长，是给 LLM 调过的）
      snippet: typeof o.content === 'string' ? o.content : '',
    }
  })
}

/**
 * 维基百科兜底。不需要 key —— 这是「零配置下这个工具仍然可用」的保证，
 * 见文件头。
 *
 * 用中文站：这个应用的界面和用户提问都是中文，中文站的条目命中率更高。
 * 找不到时维基自己会返回空列表，不是错误。
 */
async function searchWikipedia(query: string, n: number): Promise<SearchHit[]> {
  const url =
    `https://zh.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*` +
    `&srsearch=${encodeURIComponent(query)}&srlimit=${n}`
  const res = await fetchWithTimeout(url, {
    // 维基要求带 User-Agent，不带会被限流
    headers: { 'User-Agent': 'smallest-agent/0.1 (https://github.com/local)' },
  })
  if (!res.ok) throw new Error(`维基百科搜索失败：HTTP ${res.status}`)
  const json = (await res.json()) as { query?: { search?: unknown[] } }
  return (json.query?.search ?? []).slice(0, n).map((r) => {
    const o = r as Record<string, unknown>
    const title = typeof o.title === 'string' ? o.title : ''
    return {
      title,
      url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      // 维基的 snippet 里带 <span class="searchmatch"> 高亮标签，得去掉
      snippet: htmlToText(typeof o.snippet === 'string' ? o.snippet : ''),
    }
  })
}

/**
 * HTML → 纯文本。
 *
 * 不引 DOM 解析库：这里的目标不是「正确渲染」而是「把字读出来」，而
 * script/style 去掉 + 标签去掉 + 实体解码这三步就够了。引一个解析器
 * 要多一个依赖，还要在主进程里跑，不值。
 */
export function htmlToText(html: string): string {
  const stripped = html
    // script/style 的内容不是正文，且里面的代码会被当成文字读出来
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    // 块级标签换成换行，否则段落会全部粘成一行
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  const decoded = stripped
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    // 数字实体（&#8212; 这类）。放在具名实体之后
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    // &amp; **最后**解：先解的话 "&amp;lt;" 会变成 "<"，而原文想表达的是字面的 "&lt;"
    .replace(/&amp;/g, '&')

  return decoded
    .split('\n')
    // 每行内部的连续空白压成一个空格
    .map((line) => line.split(/\s+/).filter(Boolean).join(' '))
    .join('\n')
    // 三行以上的空行压成一个空行：网页里大量空标签会留下几十行空白
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 搜索工具。
 *
 * keys 是个函数而不是值：用户可能在应用运行期间才去设置里填 key，
 * 传值的话这个工具会一直拿着启动那一刻的空 key。
 */
export function makeWebSearchTool(keys: () => WebSearchKeys): Tool {
  return {
    name: 'web_search',
    description:
      '联网搜索，返回标题、链接和摘要。需要时效性信息（新闻、版本号、价格、' +
      '今天发生的事）或自己不确定的事实时调用。只给摘要；要读某条的正文用 fetch_url。',
    parameters: z.object({
      query: z.string().describe('搜索关键词'),
      max_results: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`返回几条，默认 ${DEFAULT_RESULTS}，最多 ${MAX_RESULTS}`),
    }),
    run: async (args: { query: string; max_results?: number }) => {
      const n = Math.min(args.max_results ?? DEFAULT_RESULTS, MAX_RESULTS)
      const k = keys()

      // 后端按结果质量降级，最后一档不要 key。见文件头
      let hits: SearchHit[]
      let backend: string
      if (k.brave?.trim()) {
        hits = await searchBrave(k.brave.trim(), args.query, n)
        backend = 'brave'
      } else if (k.tavily?.trim()) {
        hits = await searchTavily(k.tavily.trim(), args.query, n)
        backend = 'tavily'
      } else {
        hits = await searchWikipedia(args.query, n)
        backend = 'wikipedia'
      }

      return JSON.stringify(
        {
          // 把用了哪个后端告诉模型：维基百科只有百科条目，模型该知道
          // 「没搜到今天的新闻」是覆盖面的问题，不是这件事不存在
          backend,
          coverage:
            backend === 'wikipedia'
              ? '只有维基百科条目，没有新闻和时效性内容。用户可在设置里填 Brave 或 Tavily 的 key 换成通用网页搜索。'
              : '通用网页搜索',
          results: hits,
        },
        null,
        2,
      )
    },
  }
}

/** 取网页正文。 */
export function makeFetchUrlTool(): Tool {
  return {
    name: 'fetch_url',
    description:
      '取一个网页的正文（HTML 会转成纯文本）。用于读 web_search 返回的某条链接，' +
      '或用户直接给了链接的时候。内容过长会截断，返回值里会说明。',
    parameters: z.object({
      url: z.string().describe('要读的完整 URL，带 http(s):// 前缀'),
      max_chars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`最多取多少字符，默认 ${DEFAULT_MAX_CHARS}`),
    }),
    run: async (args: { url: string; max_chars?: number }) => {
      // 只允许 http(s)：file:// 能读本地文件，那会绕过文件沙箱那一层
      // （见 electron/main/fs-tools.ts）—— 一个「取网页」的工具不该成为
      // 读 ~/.ssh/id_rsa 的旁路。
      let parsed: URL
      try {
        parsed = new URL(args.url)
      } catch {
        return `URL 格式不对：${args.url}`
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return `只支持 http(s)，拒绝 ${parsed.protocol}//（这个工具不读本地文件）`
      }

      const limit = Math.min(args.max_chars ?? DEFAULT_MAX_CHARS, HARD_MAX_CHARS)
      const res = await fetchWithTimeout(parsed.toString(), {
        headers: { 'User-Agent': 'smallest-agent/0.1' },
      })
      if (!res.ok) return `取不到 ${parsed.toString()}：HTTP ${res.status}`

      const raw = await res.text()
      const type = res.headers.get('content-type') ?? ''
      // 只有 HTML 才需要转；JSON / 纯文本直接用，转了反而会把结构破坏掉
      const text = type.includes('html') ? htmlToText(raw) : raw.trim()

      const truncated = text.length > limit
      return JSON.stringify(
        {
          url: parsed.toString(),
          // 截断这件事必须告诉模型，否则它会把「读到这里」当成「文章到这里结束」。
          // 见文件头
          truncated,
          total_chars: text.length,
          content: truncated ? text.slice(0, limit) : text,
        },
        null,
        2,
      )
    },
  }
}
