// ============================================================================
// tools/web.rs —— 上网：搜索 + 抓网页
// ----------------------------------------------------------------------------
// 两个工具，分工明确：
//   • `web_search` 拿关键词换一批「标题 + 链接 + 摘要」
//   • `fetch_url`  把某个链接的正文抓下来
//
// 模型的典型用法是先搜再抓，所以两个都要有 —— 只给搜索，它拿到的是
// 一堆摘要，答不了细节；只给抓取，它发现不了新链接。
//
// ## 关于搜索后端：实测记录（重要，别照抄旧结论）
//
// 原计划是抓 DuckDuckGo 的 HTML 端点（`html.duckduckgo.com/html/`），
// 那是这类工具的常规做法。**实测已经不通了**：2026-08 我试了 GET / POST、
// 浏览器 UA / curl UA、以及 `lite.duckduckgo.com`，
// 全部返回 **HTTP 202 + 一个挑战页**，结果条数为 0。
// 公共 SearXNG 实例同样不可靠（实测 429 / 403 / 连接超时）。
//
// 所以搜索做成**可插拔的后端**，按可用性降级：
//
//   1. 用户配了 Brave / Tavily 的 key → 用它。结果质量最好，
//      这也是同类软件的主流做法
//   2. 没配 → 用 Wikipedia 的搜索 API。keyless、稳定、无速率问题
//      （实测 200 + 正常结果），但**只覆盖百科内容**
//
// 第 2 档不是「完整的网络搜索」，这一点在工具描述里对模型讲明白了 ——
// 让它知道自己拿到的是什么，比给它一个假装万能的工具好。
// 而 `fetch_url` 不受影响：任何 URL 都能抓（实测正常），
// 所以「用户给个链接、agent 去读」这条主线在没有 key 的情况下也是通的。
//
// ## 关于「模型自带搜索」
//
// DeepSeek 等厂商在 **Responses API** 上提供了内置搜索。这个 app 走的是
// OpenAI 兼容的 `chat/completions`，两者是不同的协议形状，而且各家的
// 内置搜索参数互不相同 —— 用它就得为每家写一套，正好是 vendors.rs
// 那条「一套兼容端点覆盖所有厂商」取舍的反面。
// 自己实现的这套对九家厂商一视同仁，所以先走这条。
// ============================================================================

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use async_trait::async_trait;
use serde_json::{Value, json};

use crate::types::{Args, Tool, ToolRegistry};

/// 设置键：Brave Search 的 key。配了就优先用。
pub const BRAVE_KEY: &str = "BRAVE_API_KEY";
/// 设置键：Tavily 的 key。
pub const TAVILY_KEY: &str = "TAVILY_API_KEY";

/// 网络请求超时。比命令执行短得多 —— 一个网页请求超过这个数
/// 基本就是连不上，继续等没有意义。
const TIMEOUT: Duration = Duration::from_secs(20);

/// 抓回来的正文上限。整篇塞给模型会爆上下文。
const MAX_TEXT: usize = 48 * 1024;

/// 默认返回几条搜索结果。
const DEFAULT_RESULTS: usize = 5;

/// 装成浏览器。不少站点对无 UA 的请求直接拒绝。
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
                  AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(UA)
        .build()
        .context("建 HTTP 客户端失败")
}

/// 搜索后端的凭据。由 UI 从设置里读出来传进来。
#[derive(Debug, Clone, Default)]
pub struct SearchKeys {
    pub brave: String,
    pub tavily: String,
}

impl SearchKeys {
    pub fn from_settings(get: &dyn Fn(&str) -> Option<String>) -> Self {
        let v = |k: &str| get(k).unwrap_or_default().trim().to_string();
        Self {
            brave: v(BRAVE_KEY),
            tavily: v(TAVILY_KEY),
        }
    }
    /// 有没有配置质量更好的后端。工具描述会据此变化 ——
    /// 模型该知道自己手上的搜索能覆盖多大范围。
    pub fn has_real_search(&self) -> bool {
        !self.brave.is_empty() || !self.tavily.is_empty()
    }
}

// ============================================================================
// HTML → 正文
// ============================================================================

/// 从 HTML 里抽出可读文本。
///
/// 手写而不是引一个 HTML 解析库：这一步不需要正确的 DOM，只需要
/// 「去标签、去脚本样式、合空白」。引 scraper/html5ever 会带来一串
/// 传递依赖，而它们的解析正确性在这里换不来什么 —— 我们不查询选择器。
///
/// 顺序很重要：**先整块删掉 script/style**，再删标签。反过来的话
/// 脚本正文会作为「标签之间的文本」留下来，得到一堆 JS 代码。
pub fn html_to_text(html: &str) -> String {
    let mut s = String::with_capacity(html.len() / 2);
    let bytes = html.as_bytes();
    let lower = html.to_ascii_lowercase();
    let mut i = 0usize;

    while i < bytes.len() {
        if bytes[i] == b'<' {
            // script / style / noscript：整块跳过，包括里面的内容
            let mut skipped = false;
            for tag in ["script", "style", "noscript", "svg", "head"] {
                let open = format!("<{tag}");
                if lower[i..].starts_with(&open) {
                    let close = format!("</{tag}>");
                    match lower[i..].find(&close) {
                        Some(off) => i += off + close.len(),
                        // 没有闭合标签：剩下的全丢掉，比把半个脚本当正文好
                        None => i = bytes.len(),
                    }
                    skipped = true;
                    break;
                }
            }
            if skipped {
                continue;
            }
            // 普通标签：跳到 '>'。块级标签补一个换行，
            // 否则段落会全部粘成一行
            let is_block = ["</p", "<br", "</div", "</li", "</tr", "</h1", "</h2", "</h3"]
                .iter()
                .any(|t| lower[i..].starts_with(t));
            match html[i..].find('>') {
                Some(off) => i += off + 1,
                None => break,
            }
            if is_block {
                s.push('\n');
            }
            continue;
        }
        let ch = html[i..].chars().next().unwrap_or(' ');
        s.push(ch);
        i += ch.len_utf8();
    }

    decode_entities(&collapse_whitespace(&s))
}

/// 合并连续空白，但保留段落分隔。
fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blank_run = 0;
    for line in s.lines() {
        let t = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if t.is_empty() {
            blank_run += 1;
            // 最多留一个空行 —— 网页里常有几十行空白
            if blank_run <= 1 && !out.is_empty() {
                out.push('\n');
            }
            continue;
        }
        blank_run = 0;
        out.push_str(&t);
        out.push('\n');
    }
    out.trim().to_string()
}

/// 解常见的 HTML 实体。
///
/// 只做最常见的这几个 —— 全量实体表有两千多条，而正文里几乎只会
/// 遇到这些。数字实体（&#39;）一并处理，它在引号上很常见。
fn decode_entities(s: &str) -> String {
    let mut out = s
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–")
        .replace("&hellip;", "…");
    // 剩下的数字实体统一转
    while let Some(start) = out.find("&#") {
        let Some(end) = out[start..].find(';').map(|e| start + e) else {
            break;
        };
        let body = out[start + 2..end].to_string();
        let cp = if let Some(hex) = body.strip_prefix('x').or(body.strip_prefix('X')) {
            u32::from_str_radix(hex, 16).ok()
        } else {
            body.parse::<u32>().ok()
        };
        match cp.and_then(char::from_u32) {
            Some(c) => out.replace_range(start..=end, &c.to_string()),
            // 解不出来就把 & 换掉，避免死循环
            None => out.replace_range(start..start + 1, "&#38;"),
        }
    }
    out
}

fn truncate(s: &str, max: usize) -> (String, bool) {
    if s.len() <= max {
        return (s.to_string(), false);
    }
    let end = (0..=max)
        .rev()
        .find(|i| s.is_char_boundary(*i))
        .unwrap_or(0);
    (s[..end].to_string(), true)
}

// ============================================================================
// web_search
// ============================================================================

pub struct WebSearch {
    pub keys: SearchKeys,
}

impl WebSearch {
    async fn brave(&self, q: &str, n: usize) -> Result<Vec<Value>> {
        let resp = client()?
            .get("https://api.search.brave.com/res/v1/web/search")
            .query(&[("q", q), ("count", &n.to_string())])
            .header("Accept", "application/json")
            .header("X-Subscription-Token", &self.keys.brave)
            .send()
            .await
            .context("请求 Brave Search 失败")?;
        if !resp.status().is_success() {
            bail!("Brave Search 返回 {}", resp.status());
        }
        let v: Value = resp.json().await.context("解析 Brave 响应失败")?;
        Ok(v["web"]["results"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .take(n)
            .map(|r| {
                json!({
                    "title": r["title"].as_str().unwrap_or(""),
                    "url": r["url"].as_str().unwrap_or(""),
                    "snippet": r["description"].as_str().unwrap_or(""),
                })
            })
            .collect())
    }

    async fn tavily(&self, q: &str, n: usize) -> Result<Vec<Value>> {
        let resp = client()?
            .post("https://api.tavily.com/search")
            .json(&json!({
                "api_key": self.keys.tavily,
                "query": q,
                "max_results": n,
            }))
            .send()
            .await
            .context("请求 Tavily 失败")?;
        if !resp.status().is_success() {
            bail!("Tavily 返回 {}", resp.status());
        }
        let v: Value = resp.json().await.context("解析 Tavily 响应失败")?;
        Ok(v["results"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .take(n)
            .map(|r| {
                json!({
                    "title": r["title"].as_str().unwrap_or(""),
                    "url": r["url"].as_str().unwrap_or(""),
                    "snippet": r["content"].as_str().unwrap_or(""),
                })
            })
            .collect())
    }

    /// 兜底后端：Wikipedia。
    ///
    /// 覆盖面窄，但**不需要 key 且实测稳定**。选它而不是继续抓某个
    /// 搜索引擎的 HTML，是因为后者已经被挡（见文件头的实测记录），
    /// 而一个「有时候能用」的搜索比没有更糟 —— 模型没法判断
    /// 空结果是「没搜到」还是「被挡了」。
    async fn wikipedia(&self, q: &str, n: usize) -> Result<Vec<Value>> {
        let resp = client()?
            .get("https://en.wikipedia.org/w/api.php")
            .query(&[
                ("action", "query"),
                ("list", "search"),
                ("srsearch", q),
                ("format", "json"),
                ("srlimit", &n.to_string()),
            ])
            .send()
            .await
            .context("请求 Wikipedia 失败")?;
        let v: Value = resp.json().await.context("解析 Wikipedia 响应失败")?;
        Ok(v["query"]["search"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .take(n)
            .map(|r| {
                let title = r["title"].as_str().unwrap_or("");
                json!({
                    "title": title,
                    "url": format!(
                        "https://en.wikipedia.org/wiki/{}",
                        title.replace(' ', "_")
                    ),
                    // snippet 里带 HTML 高亮标签，去掉
                    "snippet": html_to_text(r["snippet"].as_str().unwrap_or("")),
                })
            })
            .collect())
    }
}

#[async_trait]
impl Tool for WebSearch {
    fn name(&self) -> &str {
        "web_search"
    }
    fn description(&self) -> &str {
        // 描述随后端变化：模型必须知道自己拿到的是什么范围的结果，
        // 否则它会拿百科结果去回答「今天的新闻」
        if self.keys.has_real_search() {
            "在互联网上搜索，返回标题、链接和摘要。\
             要了解某条结果的细节时，用 fetch_url 抓它的正文。"
        } else {
            "搜索**维基百科**（当前没有配置通用搜索引擎的 API Key，\
             所以只能搜到百科条目，搜不到新闻、论坛、文档站）。\
             如果用户给了具体网址，直接用 fetch_url 抓取，不要用这个工具。"
        }
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "搜索关键词" },
                "count": {
                    "type": "integer",
                    "description": "返回几条，默认 5，最多 10"
                }
            },
            "required": ["query"]
        })
    }

    async fn run(&self, args: &Args) -> Result<Value> {
        let q = args
            .get("query")
            .and_then(|v| v.as_str())
            .context("缺少参数 query")?
            .trim()
            .to_string();
        if q.is_empty() {
            bail!("query 不能为空");
        }
        let n = args
            .get("count")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_RESULTS as u64)
            .clamp(1, 10) as usize;

        // 按质量降级。上一档失败时**继续往下试**而不是直接报错 ——
        // key 过期、额度用完这类情况下，退回百科比整轮失败有用。
        let mut errors: Vec<String> = Vec::new();
        if !self.keys.brave.is_empty() {
            match self.brave(&q, n).await {
                Ok(r) if !r.is_empty() => {
                    return Ok(json!({ "source": "brave", "results": r }));
                }
                Ok(_) => errors.push("brave: 没有结果".into()),
                Err(e) => errors.push(format!("brave: {e:#}")),
            }
        }
        if !self.keys.tavily.is_empty() {
            match self.tavily(&q, n).await {
                Ok(r) if !r.is_empty() => {
                    return Ok(json!({ "source": "tavily", "results": r }));
                }
                Ok(_) => errors.push("tavily: 没有结果".into()),
                Err(e) => errors.push(format!("tavily: {e:#}")),
            }
        }
        match self.wikipedia(&q, n).await {
            Ok(r) => Ok(json!({
                "source": "wikipedia",
                "results": r,
                // 把降级这件事**告诉模型**，它才能在答案里说明局限，
                // 而不是把百科结果当成全网结果
                "note": if self.keys.has_real_search() && !errors.is_empty() {
                    format!("已降级到维基百科（{}）", errors.join("；"))
                } else {
                    "结果仅来自维基百科。配置 BRAVE_API_KEY 或 TAVILY_API_KEY 可搜索全网。".into()
                },
            })),
            Err(e) => {
                errors.push(format!("wikipedia: {e:#}"));
                bail!("所有搜索后端都失败了：{}", errors.join("；"))
            }
        }
    }
}

// ============================================================================
// fetch_url
// ============================================================================

pub struct FetchUrl;

#[async_trait]
impl Tool for FetchUrl {
    fn name(&self) -> &str {
        "fetch_url"
    }
    fn description(&self) -> &str {
        "抓取一个网页并返回它的正文文本（已去掉 HTML 标签、脚本和样式）。\
         用户给了网址、或者你从 web_search 拿到了链接想看细节时用它。"
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "完整网址，含 http:// 或 https://" }
            },
            "required": ["url"]
        })
    }

    async fn run(&self, args: &Args) -> Result<Value> {
        let raw = args
            .get("url")
            .and_then(|v| v.as_str())
            .context("缺少参数 url")?
            .trim()
            .to_string();

        // 只放行 http(s)。不挡的话 `file:///etc/passwd` 会变成一个
        // 绕过文件沙盒的口子 —— 这个工具不受 Workspace 管辖。
        let parsed = url::Url::parse(&raw).with_context(|| format!("这不是一个合法网址：{raw}"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            bail!("只支持 http/https，拿到的是 {}", parsed.scheme());
        }

        let resp = client()?
            .get(parsed.clone())
            .send()
            .await
            .with_context(|| format!("请求失败：{raw}"))?;
        let status = resp.status();
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        // 非 HTML（PDF、图片、zip）直接说清楚，不要硬当文本解析 ——
        // 那会给模型一堆二进制垃圾
        let is_texty = content_type.is_empty()
            || content_type.contains("text/")
            || content_type.contains("json")
            || content_type.contains("xml");
        if !is_texty {
            return Ok(json!({
                "url": raw,
                "status": status.as_u16(),
                "error": format!("这个地址返回的是 {content_type}，不是网页文本，读不了"),
            }));
        }

        let body = resp.text().await.with_context(|| format!("读取响应失败：{raw}"))?;
        let text = if content_type.contains("json") {
            body
        } else {
            html_to_text(&body)
        };
        let (text, truncated) = truncate(&text, MAX_TEXT);

        Ok(json!({
            "url": raw,
            "status": status.as_u16(),
            "content": text,
            "truncated": truncated,
        }))
    }
}

pub fn register(registry: &mut ToolRegistry, keys: SearchKeys) {
    registry.insert("web_search".into(), Arc::new(WebSearch { keys }));
    registry.insert("fetch_url".into(), Arc::new(FetchUrl));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;

    #[test]
    fn strips_tags_and_drops_script_bodies() {
        // 顺序错了的话脚本正文会作为「标签之间的文本」留下来
        let html = r#"<html><head><style>.a{color:red}</style></head>
            <body><script>var x = "不该出现";</script>
            <p>第一段</p><p>第二段</p></body></html>"#;
        let text = html_to_text(html);
        assert!(text.contains("第一段"), "{text}");
        assert!(text.contains("第二段"), "{text}");
        assert!(!text.contains("不该出现"), "脚本正文泄漏了：{text}");
        assert!(!text.contains("color:red"), "样式泄漏了：{text}");
    }

    #[test]
    fn block_tags_become_line_breaks() {
        // 不补换行的话整页粘成一行，模型读起来像一坨
        let text = html_to_text("<p>a</p><p>b</p>");
        assert!(text.contains('\n'), "段落该分行：{text:?}");
    }

    #[test]
    fn decodes_entities() {
        let text = html_to_text("<p>a &amp; b &#39;c&#39; &nbsp;&lt;d&gt;</p>");
        assert!(text.contains("a & b 'c'"), "{text}");
        assert!(text.contains("<d>"), "{text}");
    }

    #[test]
    fn unterminated_script_does_not_leak() {
        // 缺闭合标签是真实网页里会遇到的，不能因此把 JS 当正文
        let text = html_to_text("<p>ok</p><script>var secret=1;");
        assert!(text.contains("ok"));
        assert!(!text.contains("secret"), "{text}");
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        // 切在多字节字符中间会 panic
        let s = "中".repeat(100);
        let (out, t) = truncate(&s, 50);
        assert!(t);
        assert!(out.len() <= 50);
    }

    #[tokio::test]
    async fn fetch_url_rejects_non_http_schemes() {
        // file:// 会绕过文件沙盒 —— 这个工具不受 Workspace 管
        let t = FetchUrl;
        let mut m = Map::new();
        m.insert("url".into(), json!("file:///etc/passwd"));
        let err = t.run(&m).await.expect_err("该拒绝");
        assert!(err.to_string().contains("http"), "{err}");
    }

    #[tokio::test]
    async fn fetch_url_rejects_garbage() {
        let t = FetchUrl;
        let mut m = Map::new();
        m.insert("url".into(), json!("not a url"));
        assert!(t.run(&m).await.is_err());
    }

    #[test]
    fn description_tells_the_model_when_search_is_limited() {
        // 模型必须知道自己手上的搜索只覆盖百科，否则会拿它答新闻
        let limited = WebSearch { keys: SearchKeys::default() };
        assert!(limited.description().contains("维基百科"));

        let full = WebSearch {
            keys: SearchKeys { brave: "k".into(), tavily: String::new() },
        };
        assert!(full.description().contains("互联网"));
        assert!(full.keys.has_real_search());
    }

    #[test]
    fn keys_read_from_settings_and_ignore_blanks() {
        let keys = SearchKeys::from_settings(&|k| match k {
            BRAVE_KEY => Some("  ".into()),
            TAVILY_KEY => Some(" tv-1 ".into()),
            _ => None,
        });
        // 空白不算配了 —— 否则会拿一把空 key 去请求然后失败
        assert_eq!(keys.brave, "");
        assert_eq!(keys.tavily, "tv-1");
        assert!(keys.has_real_search());
    }

    #[test]
    fn web_tools_are_read_only_so_they_skip_approval() {
        // 搜索和抓网页不改任何东西，每次都要用户点一下会让 agent 没法用
        assert!(!crate::approval::needs_approval("web_search"));
        assert!(!crate::approval::needs_approval("fetch_url"));
    }
}
