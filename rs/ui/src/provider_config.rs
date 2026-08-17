// ============================================================================
// provider_config.rs —— provider 选择配置
// ----------------------------------------------------------------------------
// 让用户选用哪个 provider：内置 agent（用 MCP 工具）或外部 CLI（claude code /
// codex）。形状照 Electron 版的「provider 选择器」（它是个下拉菜单），
// 这边存成配置文件。
//
// ## 为什么不直接写死「就用内置的」
//
// 外部 CLI 是真实需求 —— 它们各有独门工具（claude code 的 computer-use、
// codex 的代码库理解），而我们的内置 agent 只能调 MCP。让用户能换 provider
// 才能对标 waku 的「一个界面管所有 agent」。
// ============================================================================

use std::path::PathBuf;

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};

/// provider 配置的根。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    /// 当前激活的 provider。"builtin" 或外部 CLI 的 id。
    #[serde(default = "default_active")]
    pub active: String,
    /// 外部 CLI 的定义。
    #[serde(default)]
    pub external: Vec<ExternalProvider>,
}

fn default_active() -> String {
    "builtin".into()
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            active: default_active(),
            external: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalProvider {
    /// 唯一 id，active 字段引用它
    pub id: String,
    /// 显示名（"Claude Code"、"Codex"）
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    /// 工作目录。None = 跟着项目走（选中哪个项目就用哪个目录）
    pub cwd: Option<PathBuf>,
}

/// 配置文件路径。
pub fn config_path() -> Result<PathBuf> {
    crate::settings::settings_path()
        .map(|p| p.with_file_name("providers.json"))
        .context("算 providers.json 路径失败")
}

/// 读配置。文件不存在时返回空配置（默认用内置 provider）。
pub fn load_config() -> ProviderConfig {
    let Ok(path) = config_path() else {
        return ProviderConfig::default();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return ProviderConfig::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn _save_config(config: &ProviderConfig) -> Result<()> {
    let path = config_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("建配置目录失败：{}", dir.display()))?;
    }
    let json = serde_json::to_vec_pretty(config).context("序列化 provider 配置失败")?;
    std::fs::write(&path, json).with_context(|| format!("写 {} 失败", path.display()))
}

/// 一份示例配置，第一次打开 provider 设置时写进去当模板。
pub fn _example_config() -> ProviderConfig {
    ProviderConfig {
        active: "builtin".into(),
        external: vec![
            ExternalProvider {
                id: "claude-code".into(),
                name: "Claude Code".into(),
                command: "npx".into(),
                args: vec![
                    "-y".into(),
                    "@agentclientprotocol/claude-agent-acp@latest".into(),
                ],
                env: Default::default(),
                cwd: None,
            },
            ExternalProvider {
                id: "codex".into(),
                name: "Codex".into(),
                command: "npx".into(),
                args: vec!["-y".into(), "@agentclientprotocol/codex-acp@latest".into()],
                env: Default::default(),
                cwd: None,
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_uses_builtin() {
        let config = ProviderConfig::default();
        assert_eq!(config.active, "builtin");
        assert!(config.external.is_empty());
    }

    #[test]
    fn roundtrip() {
        let config = _example_config();
        let json = serde_json::to_string(&config).unwrap();
        let back: ProviderConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.active, "builtin");
        assert_eq!(back.external.len(), 2);
        assert_eq!(back.external[0].name, "Claude Code");
    }

    #[test]
    fn missing_active_defaults_to_builtin() {
        // 旧版配置可能没有 active 字段
        let json = r#"{"external":[]}"#;
        let config: ProviderConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.active, "builtin");
    }
}
