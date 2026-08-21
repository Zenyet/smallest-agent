// ============================================================================
// automations.rs —— 定时自动化
// ----------------------------------------------------------------------------
// 一条自动化 = 「每隔多久，用哪个 agent，问这句话」。到点了就往一个会话里
// 发一轮，跟用户自己敲了那句话一样。
//
// ## 为什么是「每隔 N 分钟」而不是 cron
//
// cron 表达式能表达「每周一早九点」，间隔表达不了。但引 cron 要一个依赖
// （croner / cron 之类）加一套时区处理，而这个功能的主要用途是
// 「每小时看一眼」「每天汇总一次」—— 间隔够用。
//
// 更关键的是**桌面应用不是常驻服务**：app 关着的时候什么都不会触发。
// 「每周一早九点」在 app 周一没开的情况下要不要补跑？cron 的语义里
// 这是个真问题（catch-up），而间隔天然没有 —— 它只说「距上次多久了」。
// 所以间隔不只是省事，它和这个运行环境更匹配。
//
// ## 为什么每条自动化固定一个会话
//
// 每次触发都新建会话会在侧边栏堆出几十条同名对话。固定一个会话意味着
// 那条自动化的历史都在一处，能翻、能接着聊 —— 而这是桌面应用相对
// 服务端 cron 的优势，不该丢掉。
//
// 代价是那个会话会越来越长，但压缩机制（CompactHook）本来就管这件事。
// ============================================================================

use std::path::PathBuf;

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};

/// 毫秒时间戳。用 u128 和 memory.rs 的 SessionMeta::updated_at 对齐。
pub type Millis = u128;

/// 最短间隔。
///
/// 一分钟以下没有实际用途，而「每 10 秒问一次模型」会烧钱烧到用户发现之前
/// 已经花了不少 —— 这是个花钱的操作，下限该保守。
pub const MIN_INTERVAL_MINUTES: u32 = 1;

/// 一条自动化。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Automation {
    pub id: String,
    pub name: String,
    /// 到点发的那句话。
    pub prompt: String,
    /// 间隔（分钟）。
    pub interval_minutes: u32,
    /// 用哪个自定义 agent（agents.rs 里的 id）。空 = 不用。
    #[serde(default)]
    pub agent_id: String,
    /// 固定往哪个会话发。空 = 第一次触发时建一个并记下来。
    #[serde(default)]
    pub session_id: String,
    /// 上次触发的时间。0 = 还没跑过。
    #[serde(default)]
    pub last_run: Millis,
    /// 关掉的不触发。
    ///
    /// 默认 true（关着）—— 这是**刻意的**：自动化会自动花钱调模型，
    /// 用户建的时候可能还在填提示词。让它一存好就开始跑是个不礼貌的默认值。
    #[serde(default = "default_true")]
    pub disabled: bool,
}

fn default_true() -> bool {
    true
}

impl Automation {
    pub fn new(name: impl Into<String>) -> Self {
        let now = now_millis();
        Self {
            id: format!("auto-{now}"),
            name: name.into(),
            prompt: String::new(),
            interval_minutes: 60,
            agent_id: String::new(),
            session_id: String::new(),
            last_run: 0,
            // 见字段注释：新建的默认关着
            disabled: true,
        }
    }

    /// 到点了吗。
    ///
    /// 没跑过的**不立即触发**：把 last_run 当成「刚建好」处理。
    /// 立即触发的话用户一开启就被问一次，而他可能只是想让它明天开始 ——
    /// 而且那次触发发生在他还没检查提示词的时候。
    pub fn is_due(&self, now: Millis) -> bool {
        if self.disabled || self.prompt.trim().is_empty() {
            return false;
        }
        let interval = self.interval_ms();
        match self.last_run {
            0 => false,
            last => now.saturating_sub(last) >= interval,
        }
    }

    /// 间隔的毫秒数，带下限保护。
    ///
    /// 手改配置文件可能写出 0，那会让 is_due 永远为真 —— 一个死循环般的
    /// 触发风暴，而且每次都花钱。
    pub fn interval_ms(&self) -> Millis {
        let minutes = self.interval_minutes.max(MIN_INTERVAL_MINUTES) as Millis;
        minutes * 60 * 1000
    }

    /// 距下次触发还有多久（毫秒）。没跑过或已停用返回 None。
    pub fn until_next(&self, now: Millis) -> Option<Millis> {
        if self.disabled || self.last_run == 0 {
            return None;
        }
        let next = self.last_run + self.interval_ms();
        Some(next.saturating_sub(now))
    }
}

pub fn now_millis() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 落盘的状态。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AutomationsState {
    #[serde(default)]
    pub items: Vec<Automation>,
}

impl AutomationsState {
    pub fn find(&self, id: &str) -> Option<&Automation> {
        self.items.iter().find(|a| a.id == id)
    }

    pub fn find_mut(&mut self, id: &str) -> Option<&mut Automation> {
        self.items.iter_mut().find(|a| a.id == id)
    }

    pub fn upsert(&mut self, item: Automation) {
        match self.items.iter_mut().find(|a| a.id == item.id) {
            Some(slot) => *slot = item,
            None => self.items.push(item),
        }
    }

    pub fn remove(&mut self, id: &str) {
        self.items.retain(|a| a.id != id);
    }

    /// 现在该跑哪些。
    pub fn due(&self, now: Millis) -> Vec<&Automation> {
        self.items.iter().filter(|a| a.is_due(now)).collect()
    }
}

fn state_path() -> Result<PathBuf> {
    Ok(crate::mcp_config::config_dir()?.join("automations.json"))
}

pub fn state_path_display() -> String {
    state_path()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "(路径不可用)".into())
}

/// 读。坏了返回空 —— 同 agents，这是增强功能。
pub fn load() -> AutomationsState {
    let Ok(path) = state_path() else {
        return AutomationsState::default();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return AutomationsState::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn save(state: &AutomationsState) -> Result<()> {
    let path = state_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("建配置目录失败：{}", dir.display()))?;
    }
    let json = serde_json::to_vec_pretty(state).context("序列化自动化状态失败")?;
    std::fs::write(&path, json).with_context(|| format!("写 {} 失败", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: Millis = 60 * 1000;

    fn ready(interval: u32) -> Automation {
        let mut a = Automation::new("x");
        a.prompt = "看一眼".into();
        a.interval_minutes = interval;
        a.disabled = false;
        a
    }

    #[test]
    fn new_automations_start_disabled() {
        // 自动化自动花钱调模型，一存好就跑是个不礼貌的默认值
        assert!(Automation::new("x").disabled);
    }

    #[test]
    fn never_run_does_not_fire_immediately() {
        // 一开启就被问一次很突然，而那时用户可能还没检查提示词
        let a = ready(60);
        assert_eq!(a.last_run, 0);
        assert!(!a.is_due(now_millis()));
    }

    #[test]
    fn fires_once_the_interval_has_passed() {
        let mut a = ready(10);
        a.last_run = 1_000_000;
        assert!(!a.is_due(1_000_000 + 9 * MINUTE), "还没到点不该触发");
        assert!(a.is_due(1_000_000 + 10 * MINUTE), "到点了该触发");
    }

    #[test]
    fn disabled_never_fires() {
        let mut a = ready(1);
        a.last_run = 1;
        a.disabled = true;
        assert!(!a.is_due(now_millis()));
    }

    #[test]
    fn empty_prompt_never_fires() {
        // 建了但还没填提示词的不该触发 —— 发一句空话给模型没有意义
        let mut a = ready(1);
        a.prompt = "  ".into();
        a.last_run = 1;
        assert!(!a.is_due(now_millis()));
    }

    #[test]
    fn zero_interval_is_clamped() {
        // 手改配置写出 0 会让 is_due 永远为真 —— 触发风暴，而且每次都花钱
        let mut a = ready(0);
        assert_eq!(a.interval_ms(), MIN_INTERVAL_MINUTES as Millis * MINUTE);
        a.last_run = 1_000_000;
        assert!(!a.is_due(1_000_000 + 30 * 1000), "半分钟不该到点");
        assert!(a.is_due(1_000_000 + MINUTE));
    }

    #[test]
    fn until_next_counts_down() {
        let mut a = ready(10);
        a.last_run = 1_000_000;
        assert_eq!(a.until_next(1_000_000 + 4 * MINUTE), Some(6 * MINUTE));
        // 已经过期的返回 0 而不是下溢
        assert_eq!(a.until_next(1_000_000 + 99 * MINUTE), Some(0));
    }

    #[test]
    fn until_next_is_none_when_not_scheduled() {
        let a = ready(10);
        assert_eq!(a.until_next(now_millis()), None, "没跑过就没有下次时间");
    }

    #[test]
    fn due_lists_only_the_ready_ones() {
        let mut st = AutomationsState::default();
        let mut a = ready(10);
        a.id = "a".into();
        a.last_run = 1_000;
        let mut b = ready(10);
        b.id = "b".into();
        b.last_run = 1_000_000_000; // 很近，还没到点
        st.upsert(a);
        st.upsert(b);

        let due = st.due(1_000 + 10 * MINUTE);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, "a");
    }

    #[test]
    fn upsert_replaces_by_id() {
        let mut st = AutomationsState::default();
        let mut a = ready(10);
        a.id = "a1".into();
        st.upsert(a.clone());
        a.name = "改过".into();
        st.upsert(a);
        assert_eq!(st.items.len(), 1);
        assert_eq!(st.items[0].name, "改过");
    }

    #[test]
    fn disabled_defaults_to_true_when_missing_from_json() {
        // 手写的配置文件里可能没有 disabled 字段。默认必须是「关着」——
        // 默认开启意味着粘一份配置进来就开始花钱
        let a: Automation = serde_json::from_str(
            r#"{"id":"x","name":"n","prompt":"p","interval_minutes":30}"#,
        )
        .expect("该能解析");
        assert!(a.disabled);
    }
}
