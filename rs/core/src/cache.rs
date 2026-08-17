// ============================================================================
// cache.rs —— 磁盘缓存：省 token、加速重复查询（对应 TS 版 src/cache.ts）
// ----------------------------------------------------------------------------
// 「CallModel 纯包装」之一。核心思路：相同的（model + messages）→ 相同的输出，
// 没必要每次都联网。把 ModelResult 序列化成 JSON 文件存磁盘，命中直接返回。
//
// ## 一处不兼容，得说清楚
//
// 缓存 key 是 sha256(prefix + '\n' + json(messages)) 的前 32 位十六进制，
// 算法与 TS 版一致。但**算出来的值和 TS 版不一样**，所以 Rust 不会命中
// TS 写下的 .llm-cache/*.json，反之亦然。
//
// 原因是 JSON 序列化的键序：TS 的 JSON.stringify 按对象字面量的插入顺序输出，
// Rust 的 serde_json 对 Map 按键名排序。ToolCall.args 是模型给的任意对象，
// 键序不可控，没法在两边对齐。
//
// 结论是接受这个差异：两版各用自己的缓存目录内容，互不命中但都自洽 ——
// 缓存本来就是可丢弃的，冷启动多花一次 API 调用而已。
// 真要共享的话得引入 canonical JSON（键序归一 + 空白归一），
// 为一个可丢弃的缓存加这层复杂度不值。
// ============================================================================

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context as _, Result};
use async_trait::async_trait;
use sha2::{Digest as _, Sha256};

use crate::types::{CallModel, Message, ModelResult};

/// 缓存的最小接口。抽成 trait 是为了测试能换成内存实现，不必真读写磁盘。
#[async_trait]
pub trait ResultCache: Send + Sync {
    async fn get(&self, key: &str) -> Option<ModelResult>;
    async fn set(&self, key: &str, value: &ModelResult) -> Result<()>;
}

/// Arc 转发，理由同 types.rs 里 CallModel 的那两个：
/// 调用方想在外面留一份引用查命中率时，不必自己写一层包装。
#[async_trait]
impl<T: ResultCache + ?Sized> ResultCache for Arc<T> {
    async fn get(&self, key: &str) -> Option<ModelResult> {
        (**self).get(key).await
    }
    async fn set(&self, key: &str, value: &ModelResult) -> Result<()> {
        (**self).set(key, value).await
    }
}

/// 生成缓存 key：sha256(prefix + '\n' + json(messages))，取前 32 位十六进制。
///
/// prefix 通常是 model id（如 "deepseek-chat"），保证不同模型的缓存互不干扰 ——
/// 即使 messages 完全相同，不同模型的输出也可能不同，必须分开存。
pub fn cache_key(prefix: &str, messages: &[Message]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(prefix.as_bytes());
    hasher.update(b"\n");
    // 序列化失败在这里不可能发生（Message 全是可序列化类型），
    // 真失败了退化成空串也只是缓存不命中，不影响正确性。
    hasher.update(
        serde_json::to_string(messages)
            .unwrap_or_default()
            .as_bytes(),
    );
    // 取前 16 字节 = 32 个十六进制字符，与 TS 的 .slice(0, 32) 对齐
    hasher
        .finalize()
        .iter()
        .take(16)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 基于本地文件系统的缓存，每条是 <dir>/<key>.json。
pub struct DiskCache {
    base: PathBuf,
}

impl DiskCache {
    /// dir 会被转成绝对路径，避免工作目录变化时找不到缓存。
    pub fn new(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref();
        let base = if dir.is_absolute() {
            dir.to_path_buf()
        } else {
            std::env::current_dir()
                .context("取当前工作目录失败")?
                .join(dir)
        };
        Ok(Self { base })
    }

    fn file_for(&self, key: &str) -> PathBuf {
        self.base.join(format!("{key}.json"))
    }
}

#[async_trait]
impl ResultCache for DiskCache {
    async fn get(&self, key: &str) -> Option<ModelResult> {
        let file = self.file_for(key);
        // 读不到（不存在）或解析失败（写入中断、磁盘错误）都当未命中，
        // 自愈而非让整次调用炸掉。这是 TS 版的行为，照搬。
        // 走 runtime:: 而不是直接 tokio::fs —— 见 runtime.rs 里「文件 IO」那段
        let bytes = crate::runtime::read_file(file).await.ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    async fn set(&self, key: &str, value: &ModelResult) -> Result<()> {
        // 目录不存在时自动创建，第一次写入不会报错
        crate::runtime::create_dir_all(self.base.clone())
            .await
            .with_context(|| format!("建缓存目录失败：{}", self.base.display()))?;
        let json = serde_json::to_vec(value).context("序列化缓存内容失败")?;
        let file = self.file_for(key);
        crate::runtime::write_file(file.clone(), json)
            .await
            .with_context(|| format!("写缓存失败：{}", file.display()))
    }
}

/// 命中回调，用于打日志或统计命中率。不影响主流程。
pub type OnHit = Box<dyn Fn() + Send + Sync>;

/// 给任意 CallModel 套上缓存：命中直接返回，未命中调下层后写入。
///
/// 这就是 TS 版 withCache 的对应物 —— 那边是高阶函数返回闭包，
/// 这边是「持有内层 CallModel 的结构体」，同样能任意套娃：
/// Cached::new(Retrying::new(raw), ...)。
pub struct Cached<C> {
    inner: C,
    cache: Box<dyn ResultCache>,
    /// 通常传 model id，使不同模型共用一个缓存实例但 key 不碰撞。
    key_prefix: String,
    on_hit: Option<OnHit>,
}

impl<C> Cached<C> {
    pub fn new(inner: C, cache: Box<dyn ResultCache>, key_prefix: impl Into<String>) -> Self {
        Self {
            inner,
            cache,
            key_prefix: key_prefix.into(),
            on_hit: None,
        }
    }

    pub fn with_on_hit(mut self, f: impl Fn() + Send + Sync + 'static) -> Self {
        self.on_hit = Some(Box::new(f));
        self
    }
}

#[async_trait]
impl<C: CallModel> CallModel for Cached<C> {
    async fn call(&self, messages: &[Message]) -> Result<ModelResult> {
        let key = cache_key(&self.key_prefix, messages);
        if let Some(hit) = self.cache.get(&key).await {
            if let Some(on_hit) = &self.on_hit {
                on_hit();
            }
            // 命中：不联网，直接返回
            return Ok(hit);
        }
        let result = self.inner.call(messages).await?;
        // 写缓存失败（磁盘满、权限问题）向上传播而不是静默吞掉：
        // 这属于环境问题，早报比事后查「为什么缓存一直不命中」容易。
        self.cache.set(&key, &result).await?;
        Ok(result)
    }
}
