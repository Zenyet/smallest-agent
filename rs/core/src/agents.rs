// ============================================================================
// agents.rs —— 自定义 agent
// ----------------------------------------------------------------------------
// 一个自定义 agent 就是「一套预设」：系统提示 + 用哪个模型 + 能用哪些工具。
// 对应 Claude Code 的 subagent、Cursor 的 custom mode 那类东西。
//
// ## 为什么它不是一个新的 Provider
//
// Provider 答的是「谁来跑这一轮」（我们自己 vs 外部 CLI 子进程）。
// 自定义 agent 答的是「用什么设定跑」—— 它**总是**内置 provider 跑的，
// 只是换了系统提示和模型。做成 Provider 会让「Claude Code + 我的代码审查
// agent」这种组合无法表达（外部 CLI 有它自己的系统提示，我们插不进去）。
//
// 所以它是内置 provider 的一层参数，和厂商/模型选择并列。
//
// ## 工具白名单为什么是可选的
//
// 空 = 全部可用。这是刻意的默认值：多数 agent 只是「换个说话方式」，
// 限制工具是少数场景（比如一个只读的代码审查 agent 不该能写文件）。
// 默认全开意味着用户建一个 agent 时不用先想清楚工具清单。
// ============================================================================

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};

/// 一个自定义 agent。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentDef {
    /// 唯一 id。会话绑定引用它。
    pub id: String,
    /// 显示名
    pub name: String,
    /// 一句话说明它是干什么的。只给人看，不发给模型 ——
    /// 模型看到的是 system_prompt。
    #[serde(default)]
    pub description: String,
    /// 系统提示。空 = 用全局那个（config.system_prompt）。
    #[serde(default)]
    pub system_prompt: String,
    /// 用哪家的哪个模型，形状是 `厂商id/模型id`。
    /// 空 = 跟着会话自己选的那个走。
    #[serde(default)]
    pub model: String,
    /// 允许用的工具名。空 = 全部可用，见文件头。
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub disabled: bool,
}

impl AgentDef {
    /// 建一个新的，id 用时间戳。
    ///
    /// 不用名字派生 id：用户会改名字，而 id 被会话绑定引用着 ——
    /// 改名导致绑定失效是最难解释的一类 bug（「我只是改了个名字」）。
    pub fn new(name: impl Into<String>) -> Self {
        let id = format!(
            "agent-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
        Self {
            id,
            name: name.into(),
            description: String::new(),
            system_prompt: String::new(),
            model: String::new(),
            tools: Vec::new(),
            disabled: false,
        }
    }

    /// 把这个 agent 的设定应用到一份配置上。
    ///
    /// 只覆盖它明确指定了的东西 —— 空字段表示「不管这一项」，
    /// 而不是「设成空」。所以一个只填了系统提示的 agent 不会把模型清掉。
    pub fn apply(&self, config: &crate::types::Config) -> crate::types::Config {
        let mut out = config.clone();
        if !self.system_prompt.trim().is_empty() {
            out.system_prompt = self.system_prompt.clone();
        }
        out
    }

    /// 按白名单过滤工具注册表。
    ///
    /// 空白名单返回原样（全部可用）。名单里有但注册表里没有的工具直接忽略 ——
    /// 那通常是 MCP server 没连上，而为此报错会让整个 agent 不可用，
    /// 代价比「少一个工具」大得多。
    pub fn filter_tools(&self, tools: &crate::types::ToolRegistry) -> crate::types::ToolRegistry {
        if self.tools.is_empty() {
            return tools.clone();
        }
        tools
            .iter()
            .filter(|(name, _)| self.tools.iter().any(|t| t == *name))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}

/// 落盘的状态。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentsState {
    #[serde(default)]
    pub agents: Vec<AgentDef>,
    /// session_id → agent_id。不在这里的会话不用任何自定义 agent。
    #[serde(default)]
    pub session_agent: BTreeMap<String, String>,
}

impl AgentsState {
    /// 清掉指向已删 agent 的绑定。
    ///
    /// 同 providers 那边的 normalize：悬空绑定会让选择器显示空白，
    /// 用户不知道这个会话在用什么设定。
    pub fn normalize(mut self) -> Self {
        let known: Vec<String> = self.agents.iter().map(|a| a.id.clone()).collect();
        self.session_agent
            .retain(|_, aid| known.contains(aid));
        self
    }

    pub fn find(&self, id: &str) -> Option<&AgentDef> {
        self.agents.iter().find(|a| a.id == id)
    }

    /// 某个会话用哪个自定义 agent。None = 不用。
    pub fn for_session(&self, session_id: &str) -> Option<&AgentDef> {
        let id = self.session_agent.get(session_id)?;
        // 停用的 agent 当成没绑定：用户停用它就是不想用了，
        // 但绑定留着，重新启用之后那些会话还是它的
        self.find(id).filter(|a| !a.disabled)
    }

    pub fn assign(&mut self, session_id: &str, agent_id: Option<&str>) {
        match agent_id {
            Some(a) => {
                self.session_agent
                    .insert(session_id.to_string(), a.to_string());
            }
            None => {
                self.session_agent.remove(session_id);
            }
        }
    }

    pub fn forget(&mut self, session_id: &str) {
        self.session_agent.remove(session_id);
    }

    /// 删一个 agent，连带清掉引用它的绑定。
    pub fn remove(&mut self, agent_id: &str) {
        self.agents.retain(|a| a.id != agent_id);
        self.session_agent.retain(|_, aid| aid != agent_id);
    }

    /// 加或更新一个。按 id 匹配 —— 有就替换，没有就追加。
    pub fn upsert(&mut self, def: AgentDef) {
        match self.agents.iter_mut().find(|a| a.id == def.id) {
            Some(slot) => *slot = def,
            None => self.agents.push(def),
        }
    }
}

fn state_path() -> Result<PathBuf> {
    Ok(crate::mcp_config::config_dir()?.join("agents.json"))
}

/// 路径的可显示形式，给界面上那行「配置文件」用。
pub fn state_path_display() -> String {
    state_path()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "(路径不可用)".into())
}

/// 读。坏了返回空 —— agent 是增强功能，配置读不进来不该让应用起不来。
pub fn load() -> AgentsState {
    let Ok(path) = state_path() else {
        return AgentsState::default();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return AgentsState::default();
    };
    serde_json::from_slice::<AgentsState>(&bytes)
        .unwrap_or_default()
        .normalize()
}

pub fn save(state: &AgentsState) -> Result<()> {
    let path = state_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("建配置目录失败：{}", dir.display()))?;
    }
    let json = serde_json::to_vec_pretty(state).context("序列化 agent 状态失败")?;
    std::fs::write(&path, json).with_context(|| format!("写 {} 失败", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_config() -> crate::types::Config {
        crate::types::Config {
            api_key: "k".into(),
            base_url: "https://x/v1".into(),
            model: "m".into(),
            temperature: 0.0,
            native_search: Default::default(),
            max_turns: 10,
            system_prompt: "全局提示".into(),
            embedding_model: "e".into(),
            notes_dir: "./n".into(),
            hf_endpoint: None,
            local_model_path: None,
            session_id: "s".into(),
            sessions_dir: "./.s".into(),
            max_context_tokens: 2000,
            keep_recent: 6,
            fallback_model: "m".into(),
            max_retries: 2,
            cache_enabled: true,
            cache_dir: "./.c".into(),
            stream: true,
        }
    }

    #[test]
    fn empty_system_prompt_keeps_the_global_one() {
        // 空字段是「不管这一项」，不是「设成空」——
        // 否则一个只想换模型的 agent 会把系统提示清掉
        let a = AgentDef::new("x");
        let out = a.apply(&base_config());
        assert_eq!(out.system_prompt, "全局提示");
    }

    #[test]
    fn system_prompt_overrides_when_set() {
        let mut a = AgentDef::new("x");
        a.system_prompt = "你是代码审查员".into();
        let out = a.apply(&base_config());
        assert_eq!(out.system_prompt, "你是代码审查员");
    }

    #[test]
    fn blank_system_prompt_is_treated_as_unset() {
        // 用户在输入框里敲了几个空格不该算「设了系统提示」
        let mut a = AgentDef::new("x");
        a.system_prompt = "   \n ".into();
        assert_eq!(a.apply(&base_config()).system_prompt, "全局提示");
    }

    #[test]
    fn ids_do_not_change_when_the_name_changes() {
        // 改名导致绑定失效是最难解释的一类 bug
        let mut a = AgentDef::new("旧名");
        let id = a.id.clone();
        a.name = "新名".into();
        assert_eq!(a.id, id);
    }

    #[test]
    fn disabled_agent_reads_as_unbound_but_keeps_the_binding() {
        let mut st = AgentsState::default();
        let mut a = AgentDef::new("x");
        a.id = "a1".into();
        st.upsert(a);
        st.assign("s1", Some("a1"));
        assert!(st.for_session("s1").is_some());

        st.agents[0].disabled = true;
        // 停用的当没绑定用
        assert!(st.for_session("s1").is_none());
        // 但绑定要留着 —— 重新启用之后那些会话还是它的
        assert_eq!(st.session_agent.get("s1").map(String::as_str), Some("a1"));
    }

    #[test]
    fn normalize_drops_dangling_bindings() {
        let mut st = AgentsState::default();
        st.session_agent.insert("s1".into(), "gone".into());
        let st = st.normalize();
        // 悬空绑定会让选择器显示空白
        assert!(st.session_agent.is_empty());
    }

    #[test]
    fn removing_an_agent_clears_its_bindings() {
        let mut st = AgentsState::default();
        let mut a = AgentDef::new("x");
        a.id = "a1".into();
        st.upsert(a);
        st.assign("s1", Some("a1"));
        st.remove("a1");
        assert!(st.agents.is_empty());
        assert!(st.session_agent.is_empty());
    }

    #[test]
    fn upsert_replaces_by_id_instead_of_appending() {
        let mut st = AgentsState::default();
        let mut a = AgentDef::new("原名");
        a.id = "a1".into();
        st.upsert(a.clone());
        a.name = "改过".into();
        st.upsert(a);
        assert_eq!(st.agents.len(), 1);
        assert_eq!(st.agents[0].name, "改过");
    }

    fn registry_with(names: &[&str]) -> crate::types::ToolRegistry {
        // 用一个最小的假工具填注册表 —— filter_tools 只看键名
        struct Dummy(String);
        #[async_trait::async_trait]
        impl crate::types::Tool for Dummy {
            fn name(&self) -> &str {
                &self.0
            }
            fn description(&self) -> &str {
                ""
            }
            fn parameters(&self) -> serde_json::Value {
                serde_json::json!({})
            }
            async fn run(&self, _args: &crate::types::Args) -> Result<serde_json::Value> {
                Ok(serde_json::Value::Null)
            }
        }
        names
            .iter()
            .map(|n| {
                (
                    n.to_string(),
                    std::sync::Arc::new(Dummy(n.to_string())) as std::sync::Arc<dyn crate::types::Tool>,
                )
            })
            .collect()
    }

    #[test]
    fn empty_whitelist_means_all_tools() {
        let tools = registry_with(&["read", "write"]);
        let a = AgentDef::new("x");
        assert_eq!(a.filter_tools(&tools).len(), 2);
    }

    #[test]
    fn whitelist_keeps_only_listed_tools() {
        let tools = registry_with(&["read", "write", "exec"]);
        let mut a = AgentDef::new("只读");
        a.tools = vec!["read".into()];
        let filtered = a.filter_tools(&tools);
        assert_eq!(filtered.len(), 1);
        assert!(filtered.contains_key("read"));
    }

    #[test]
    fn unknown_names_in_the_whitelist_are_ignored() {
        // 通常是 MCP server 没连上。为此报错会让整个 agent 不可用
        let tools = registry_with(&["read"]);
        let mut a = AgentDef::new("x");
        a.tools = vec!["read".into(), "没连上的工具".into()];
        assert_eq!(a.filter_tools(&tools).len(), 1);
    }
}
