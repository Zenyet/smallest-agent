// ============================================================================
// memory.rs —— 跨会话记忆：会话落盘 + 超预算时摘要压缩
//              （对应 TS 版 src/memory/{store,compact,summarize}.ts 三个文件）
// ----------------------------------------------------------------------------
// 合成一个文件是因为三者是同一件事的三层，加起来 144 行 TS，分开反而要来回跳：
//   • SessionStore  ← store.ts      每个 sessionId 一个 JSON 文件
//   • compact_messages ← compact.ts 滑动窗口 + 摘要，超 token 预算才触发
//   • Summarizer    ← summarize.ts  compact 所需摘要函数的真实实现（要调模型）
//
// 在 agent 循环里的位置：上层用 store.load() 在 run_agent 前注入 history，
// compact 作为可选钩子在进循环前调用，on_complete 回调把更新后的消息写回。
// 循环本体一行没改 —— 这是「在循环周围加东西」的典型例子。
// ============================================================================

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context as _, Result};
use async_trait::async_trait;

use crate::agent::{Compact, OnComplete};
use crate::types::{CallModel, Message};

// ============================================================================
// 会话存储
// ============================================================================

/// 一个会话在列表里的元信息。
///
/// TS 版把 list/delete 放在 Electron 层（`electron/main/sessions.ts`），理由是
/// 「会话列表是桌面端才需要的能力，src/ 不动」。这边不这么分：core 是库，
/// 列出自己管的文件是它分内的事，而且 CLI 也能用上（比如 `--list`）。
#[derive(Debug, Clone, PartialEq)]
pub struct SessionMeta {
    pub id: String,
    /// 取第一条 user 消息的前 30 字，空白折叠成单空格
    pub title: String,
    /// 文件修改时间的毫秒时间戳，用来排序
    pub updated_at: u128,
}

/// 标题最大长度，与 TS 版 TITLE_MAX 一致。
const TITLE_MAX: usize = 30;

/// 从消息列表推标题。
///
/// 折叠所有空白（含换行）：多行输入不折叠会把侧边栏撑变形。
pub fn session_title(messages: &[Message]) -> String {
    let Some(first) = messages.iter().find(|m| matches!(m, Message::User { .. })) else {
        return "新会话".to_string();
    };
    let flat = first
        .content()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    // 按字符截断而不是字节 —— 中文一个字 3 字节，按字节切会切出半个字符
    let title: String = flat.chars().take(TITLE_MAX).collect();
    if title.is_empty() {
        "新会话".to_string()
    } else {
        title
    }
}

/// 会话存储的接口。抽 trait 是为了将来能换成 sqlite / redis 而不动调用方
/// （TS 那边同样理由抽的 SessionStore 接口）。
#[async_trait]
pub trait SessionStore: Send + Sync {
    async fn load(&self, session_id: &str) -> Result<Vec<Message>>;
    async fn save(&self, session_id: &str, messages: &[Message]) -> Result<()>;
    /// 按更新时间倒序列出所有会话。目录不存在时返回空列表而不是报错。
    async fn list(&self) -> Result<Vec<SessionMeta>>;
    /// 删除。文件本来就不在（重复点删除）不算错误。
    async fn delete(&self, session_id: &str) -> Result<()>;
}

/// 生成新会话 id。
///
/// 前缀是时间戳所以 id 可按创建时间排序，后缀是进程内自增计数器。
/// **计数器不能换成随机后缀**：随机只能让碰撞「不太可能」，而「同一毫秒内
/// 连点两次新对话」正好是同一进程内的场景 —— 两个会话条目指向同一个文件，
/// 先写入的历史会被后一个静默继承。计数器从构造上排除这种情况。
pub fn new_session_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // 36 进制让 id 短一些，字符集天然满足 safe_id 规则
    format!("s{}-{}", to_base36(millis), to_base36(n as u128))
}

fn to_base36(mut n: u128) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("base36 数字集是 ASCII")
}

/// 把 sessionId 里的非安全字符替换成 '_'。
///
/// 路径穿越防护：没有这一步，`SESSION_ID=../../etc/passwd` 就能跳出会话目录
/// 读写任意文件。与 TS 版 `id.replace(/[^a-zA-Z0-9_-]/g, '_')` 等价。
fn safe_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 每个会话一个 JSON 文件的存储。
///
/// 为什么用磁盘而不是内存：每次跑都是全新进程，内存在退出时全丢；
/// JSON 文件最简单、可 git 追踪、人肉可读。
pub struct JsonSessionStore {
    base_dir: PathBuf,
}

impl JsonSessionStore {
    pub fn new(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref();
        // 转绝对路径，避免工作目录变化时路径语义改变
        let base_dir = if dir.is_absolute() {
            dir.to_path_buf()
        } else {
            std::env::current_dir()
                .context("取当前工作目录失败")?
                .join(dir)
        };
        Ok(Self { base_dir })
    }

    fn file_for(&self, id: &str) -> PathBuf {
        self.base_dir.join(format!("{}.json", safe_id(id)))
    }
}

#[async_trait]
impl SessionStore for JsonSessionStore {
    async fn load(&self, session_id: &str) -> Result<Vec<Message>> {
        let file = self.file_for(session_id);
        // 走 runtime:: 而不是直接 tokio::fs —— 见 runtime.rs 里「文件 IO」那段
        match crate::runtime::read_file(file.clone()).await {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .with_context(|| format!("会话文件不是合法 JSON：{}", file.display())),
            // 文件不存在 = 新会话，返回空历史，不报错
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => {
                Err(anyhow::Error::new(e).context(format!("读会话文件失败：{}", file.display())))
            }
        }
    }

    async fn save(&self, session_id: &str, messages: &[Message]) -> Result<()> {
        crate::runtime::create_dir_all(self.base_dir.clone())
            .await
            .with_context(|| format!("建会话目录失败：{}", self.base_dir.display()))?;
        // 缩进 2 空格，与 TS 的 JSON.stringify(messages, null, 2) 一致 ——
        // 会话文件是给人看的，紧凑格式没法 diff
        let json = serde_json::to_vec_pretty(messages).context("序列化会话失败")?;
        let file = self.file_for(session_id);
        crate::runtime::write_file(file.clone(), json)
            .await
            .with_context(|| format!("写会话文件失败：{}", file.display()))
    }

    async fn list(&self) -> Result<Vec<SessionMeta>> {
        let dir = self.base_dir.clone();
        // 目录遍历 + 逐个读文件都要 tokio，整段搬进专用运行时一次搞定，
        // 比每个文件各 spawn 一次省得多。
        let mut metas = crate::runtime::spawn(async move {
            let mut out: Vec<SessionMeta> = Vec::new();
            let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
                // 目录不存在 = 还没有任何会话（首次启动）
                return out;
            };
            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                // 单个文件坏了就跳过，不要让整个列表打不开
                let Ok(bytes) = tokio::fs::read(&path).await else {
                    continue;
                };
                let Ok(messages) = serde_json::from_slice::<Vec<Message>>(&bytes) else {
                    continue;
                };
                let updated_at = entry
                    .metadata()
                    .await
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                out.push(SessionMeta {
                    id: id.to_string(),
                    title: session_title(&messages),
                    updated_at,
                });
            }
            out
        })
        .await?;
        // 最近更新的排前面
        // 倒序：Reverse 比 sort_by 的闭包更直白，clippy 也更满意
        metas.sort_by_key(|m| std::cmp::Reverse(m.updated_at));
        Ok(metas)
    }

    async fn delete(&self, session_id: &str) -> Result<()> {
        let file = self.file_for(session_id);
        match crate::runtime::spawn(async move { tokio::fs::remove_file(file).await }).await? {
            Ok(()) => Ok(()),
            // 文件本来就不在（重复点删除）—— 结果一致，不必报错
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(anyhow::Error::new(e).context("删除会话文件失败")),
        }
    }
}

// ============================================================================
// token 估算
// ============================================================================

/// 粗略估算 token 数：CJK 约 1 token/字，其它约 4 字符/token。
///
/// 够用即可，真实系统会用分词器。对外暴露是为了让上层能打印「当前上下文占用」。
pub fn estimate_tokens(messages: &[Message]) -> usize {
    messages
        .iter()
        .map(|m| {
            let content = m.content();
            let cjk = content.chars().filter(|c| is_cjk(*c)).count();
            let other = content.chars().count() - cjk;
            // div_ceil 对应 TS 的 Math.ceil(other / 4)
            cjk + other.div_ceil(4)
        })
        .sum()
}

/// 是否算作 CJK（1 token/字）。
///
/// 对应 TS 版那个字符类 `/[一-鿿㐀-䶿　-〿＀-￯]/`：
/// 统一表意文字、扩展 A、CJK 标点、全角字符。
fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{4E00}'..='\u{9FFF}'   // 统一表意文字
        | '\u{3400}'..='\u{4DBF}' // 扩展 A
        | '\u{3000}'..='\u{303F}' // CJK 标点
        | '\u{FF00}'..='\u{FFEF}' // 全角/半角形式
    )
}

// ============================================================================
// 上下文压缩
// ============================================================================

/// 摘要函数的接口。
///
/// compact 只依赖这个 trait，对「摘要用哪个模型」一无所知 ——
/// 测试塞个返回固定字符串的实现就能跑，不联网。
#[async_trait]
pub trait Summarize: Send + Sync {
    async fn summarize(&self, messages: &[Message]) -> Result<String>;
}

/// 压缩参数。
pub struct CompactOptions {
    /// 超过这个估算 token 数才压缩
    pub max_tokens: usize,
    /// 保留最近多少条原文
    pub keep_recent: usize,
    pub summarize: Arc<dyn Summarize>,
}

/// 滑动窗口 + 摘要：保留 system + 最近 K 条，更老的喂给模型摘成一条。
///
/// 问题背景：跨会话记忆会让 messages 越来越长，超过模型 context window
/// 就会报错或被静默截断。
pub async fn compact_messages(
    messages: Vec<Message>,
    opts: &CompactOptions,
) -> Result<Vec<Message>> {
    // 未超预算直接返回，不触发摘要（省一次模型调用）
    if estimate_tokens(&messages) <= opts.max_tokens {
        return Ok(messages);
    }

    // system prompt 必须始终留在最前，不能被压进摘要
    let has_system = matches!(messages.first(), Some(Message::System { .. }));
    let split_at = if has_system { 1 } else { 0 };
    let (system, rest) = messages.split_at(split_at);

    // recent = 最新的 keep_recent 条，原文保留，给模型充足的近期上下文
    let mut recent_start = rest.len().saturating_sub(opts.keep_recent);
    // 丢掉开头悬空的 tool 结果：它对应的 assistant(tool_calls) 已经被摘进 older，
    // 否则保留窗口会以孤立的 tool 消息开头，被 OpenAI 兼容 API 拒绝。
    while recent_start < rest.len() && matches!(rest[recent_start], Message::Tool { .. }) {
        recent_start += 1;
    }

    // older 为空说明历史全在 recent 窗口里，无可压缩
    if recent_start == 0 {
        return Ok(messages);
    }

    let older = &rest[..recent_start];
    let summary = opts
        .summarize
        .summarize(older)
        .await
        .context("摘要历史消息失败")?;

    // 摘要用 role:user 而不是 system：这样它能通过持久化时的「过滤掉 system」，
    // 重载时也不会和真正的 system prompt 重复。
    let summary_msg = Message::User {
        content: format!("【之前对话摘要】\n{summary}"),
    };

    let mut out = Vec::with_capacity(1 + system.len() + rest.len() - recent_start);
    out.extend_from_slice(system);
    out.push(summary_msg);
    out.extend_from_slice(&rest[recent_start..]);
    Ok(out)
}

// ============================================================================
// 摘要的真实实现
// ============================================================================

const SUMMARY_PROMPT: &str = "你是对话摘要器。把下面的对话压成简洁中文要点，保留关键事实、决定、用户偏好；只输出摘要文本，不要调用工具。";

/// 用模型做摘要。
///
/// 注入 CallModel 而不是硬编码，所以能复用上层已经套好的缓存 / 重试 / 降级
/// 那一整摞装饰器 —— 摘要也是模型调用，一样需要重试。
pub struct ModelSummarizer {
    call_model: Arc<dyn CallModel>,
}

impl ModelSummarizer {
    pub fn new(call_model: Arc<dyn CallModel>) -> Self {
        Self { call_model }
    }
}

#[async_trait]
impl Summarize for ModelSummarizer {
    async fn summarize(&self, messages: &[Message]) -> Result<String> {
        // 把结构化消息摊平成纯文本 —— 摘要 prompt 的 user 消息只能是字符串。
        // 注意这里不能直接把 messages 传给模型：它们带 tool_calls，
        // 会被理解成「要你继续这轮工具调用」而不是「请摘要这段历史」。
        let rendered = messages
            .iter()
            .map(|m| format!("{}: {}", m.role(), m.content()))
            .collect::<Vec<_>>()
            .join("\n");

        let result = self
            .call_model
            .call(&[
                Message::System {
                    content: SUMMARY_PROMPT.to_string(),
                },
                Message::User { content: rendered },
            ])
            .await?;
        Ok(result.text)
    }
}

// ============================================================================
// 接到 agent 循环上的两个钩子
// ============================================================================

/// compact 钩子：包一层 CompactOptions 实现 agent::Compact。
///
/// agent.rs 定义的 Compact trait 只有 `compact(Vec<Message>) -> Vec<Message>`，
/// 参数都在这个结构体里预先装好，循环因此不用知道 max_tokens 之类的存在。
pub struct CompactHook {
    opts: CompactOptions,
}

impl CompactHook {
    pub fn new(max_tokens: usize, keep_recent: usize, summarize: Arc<dyn Summarize>) -> Self {
        Self {
            opts: CompactOptions {
                max_tokens,
                keep_recent,
                summarize,
            },
        }
    }
}

#[async_trait]
impl Compact for CompactHook {
    async fn compact(&self, messages: Vec<Message>) -> Result<Vec<Message>> {
        compact_messages(messages, &self.opts).await
    }
}

/// on_complete 钩子：跑完把这轮的完整消息写回会话文件。
///
/// **过滤掉 system 消息**：system prompt 由 config 提供，每次 run_agent 都会重新
/// 注入（agent.rs 里那句 `vec![Message::System { .. }]`）。存进去的话下次
/// 加载会变成「history 里有一条 system + 新注入的一条 system」，
/// 两条系统提示叠着，模型行为会飘。
pub struct SaveSessionHook {
    store: Arc<dyn SessionStore>,
    session_id: String,
}

impl SaveSessionHook {
    pub fn new(store: Arc<dyn SessionStore>, session_id: impl Into<String>) -> Self {
        Self {
            store,
            session_id: session_id.into(),
        }
    }
}

#[async_trait]
impl OnComplete for SaveSessionHook {
    async fn on_complete(&self, messages: &[Message]) -> Result<()> {
        let persisted: Vec<Message> = messages
            .iter()
            .filter(|m| !matches!(m, Message::System { .. }))
            .cloned()
            .collect();
        self.store.save(&self.session_id, &persisted).await
    }
}
