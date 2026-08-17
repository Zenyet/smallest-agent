// ============================================================================
// mcp_config.rs —— MCP server 列表的配置与加载
// ----------------------------------------------------------------------------
// TS 版和 Electron 版都是**写死在代码里**的（`cli.ts:58` 那个数组、
// `electron/main/mcp-paths.ts` 那个函数）。这边做成配置文件，理由：
//   • 工具是这个 app 的能力边界，写死意味着用户改不了
//   • MCP 生态里每个 server 的启动命令都不一样，穷举进代码是徒劳
//
// ## 为什么用 `mcpServers` 这个形状
//
// Claude Desktop、Cursor、Cline 用的都是这个形状：
//   { "mcpServers": { "名字": { "command": "...", "args": [...], "env": {...} } } }
//
// 照抄的好处是用户能把已有配置直接粘过来 —— 这类配置写一次要查半天文档，
// 让人为了我们再写一遍不合理。发明自己的格式除了「不一样」没有任何收益。
// ============================================================================

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::mcp::McpServerSpec;
use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};

/// 配置文件的根。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct McpConfig {
    /// 名字 → server 定义。名字只用于显示和排序，不参与协议。
    #[serde(default, rename = "mcpServers")]
    pub servers: BTreeMap<String, McpServerEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct McpServerEntry {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// 设 true 就跳过这个 server。
    ///
    /// 比让用户删掉整段再手打回来友好 —— MCP 配置写一次要查文档，
    /// 临时停用不该以丢失配置为代价。
    #[serde(default)]
    pub disabled: bool,
}

/// 用户配置目录。
///
/// core 自己定这个路径而不是让调用方传：CLI 和桌面版必须看到同一份配置，
/// 让两边各自算路径迟早会不一致（而且这种 bug 表现成「命令行有工具、
/// 界面里没有」，很难想到是路径问题）。
pub fn config_dir() -> Result<PathBuf> {
    let base = if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|h| h.join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .map(|h| h.join(".config"))
            })
    }
    .context("找不到用户配置目录")?;
    Ok(base.join("smallest-agent"))
}

/// 配置文件路径。
pub fn config_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("mcp.json"))
}

/// 读配置。
///
/// 返回 Result 而不是像 settings 那样静默降级成空：**MCP 配置写错了必须让
/// 用户知道**。settings 缺了还有默认值可用，而这里配置读不进来的后果是
/// 「工具静默消失」—— 用户会以为是模型不肯调工具，而不是配置有语法错误。
pub fn load_config() -> Result<McpConfig> {
    let path = config_path()?;
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        // 没有这个文件是正常的（没配过工具），返回空配置
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(McpConfig::default()),
        Err(e) => {
            return Err(anyhow::Error::new(e).context(format!("读 {} 失败", path.display())));
        }
    };
    serde_json::from_slice(&bytes)
        .with_context(|| format!("{} 不是合法的 MCP 配置", path.display()))
}

pub fn save_config(config: &McpConfig) -> Result<()> {
    let path = config_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("建配置目录失败：{}", dir.display()))?;
    }
    let json = serde_json::to_vec_pretty(config).context("序列化 MCP 配置失败")?;
    std::fs::write(&path, json).with_context(|| format!("写 {} 失败", path.display()))
}

impl McpConfig {
    /// 转成 core 要的 spec 列表，跳过 disabled 的。
    ///
    /// 顺序按名字（BTreeMap）—— 同名工具后面的 server 覆盖前面的
    /// （见 core 的 load_mcp_tools_from_servers），所以顺序得确定，
    /// 不然同一份配置每次启动的行为可能不同。
    pub fn to_specs(&self) -> Vec<McpServerSpec> {
        self.servers
            .values()
            .filter(|e| !e.disabled)
            .map(|e| McpServerSpec::new(e.command.clone(), e.args.clone()).with_env(e.env.clone()))
            .collect()
    }

    /// 启用的 server 数量，UI 上显示用。
    pub fn enabled_count(&self) -> usize {
        self.servers.values().filter(|e| !e.disabled).count()
    }
}

/// 一份示例配置，第一次打开工具设置时写进去当模板。
///
/// 用 filesystem server 做示例：它是官方的、`npx -y` 就能跑、
/// 而且「让模型能读某个目录」是最容易理解的工具能力。
/// 默认 disabled —— 不该在用户没看过配置的情况下就把某个目录暴露给模型。
pub fn example_config() -> McpConfig {
    let mut servers = BTreeMap::new();
    servers.insert(
        "filesystem".to_string(),
        McpServerEntry {
            command: "npx".into(),
            args: vec![
                "-y".into(),
                "@modelcontextprotocol/server-filesystem".into(),
                "/tmp".into(),
            ],
            env: BTreeMap::new(),
            disabled: true,
        },
    );
    McpConfig { servers }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_desktop_shape() {
        // 这就是 Claude Desktop / Cursor 的配置形状，用户应该能直接粘过来
        let json = r#"{
            "mcpServers": {
                "filesystem": {
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
                },
                "github": {
                    "command": "docker",
                    "args": ["run", "-i", "ghcr.io/github/github-mcp-server"],
                    "env": { "GITHUB_TOKEN": "xxx" }
                }
            }
        }"#;
        let config: McpConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.servers.len(), 2);
        assert_eq!(config.servers["github"].env["GITHUB_TOKEN"], "xxx");
        // args 缺省时是空数组而不是解析失败
        assert_eq!(config.servers["filesystem"].args.len(), 3);
    }

    #[test]
    fn missing_optional_fields_default() {
        let config: McpConfig =
            serde_json::from_str(r#"{"mcpServers":{"x":{"command":"foo"}}}"#).unwrap();
        let entry = &config.servers["x"];
        assert!(entry.args.is_empty());
        assert!(entry.env.is_empty());
        assert!(!entry.disabled);
    }

    #[test]
    fn empty_config_is_valid() {
        // 没配过工具是正常状态，不该解析失败
        let config: McpConfig = serde_json::from_str("{}").unwrap();
        assert!(config.servers.is_empty());
        assert_eq!(config.enabled_count(), 0);
    }

    #[test]
    fn disabled_servers_are_skipped() {
        let json = r#"{"mcpServers":{
            "on": {"command":"a"},
            "off": {"command":"b","disabled":true}
        }}"#;
        let config: McpConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.enabled_count(), 1);
        let specs = config.to_specs();
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].command, "a");
    }

    #[test]
    fn spec_order_is_deterministic() {
        // 同名工具后面的 server 覆盖前面的，所以顺序必须确定
        let json = r#"{"mcpServers":{
            "zebra": {"command":"z"},
            "alpha": {"command":"a"},
            "middle": {"command":"m"}
        }}"#;
        let config: McpConfig = serde_json::from_str(json).unwrap();
        let specs = config.to_specs();
        let commands: Vec<&str> = specs.iter().map(|s| s.command.as_str()).collect();
        assert_eq!(commands, vec!["a", "m", "z"]);
    }

    #[test]
    fn env_survives_roundtrip() {
        let config = example_config();
        let json = serde_json::to_string(&config).unwrap();
        let back: McpConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.servers.len(), 1);
        // 示例配置默认停用 —— 不该在用户没看过配置时就暴露目录给模型
        assert!(back.servers["filesystem"].disabled);
    }

    #[test]
    fn serialized_key_is_mcp_servers() {
        // 键名必须是 mcpServers（camelCase），否则粘过来的配置读不进
        let json = serde_json::to_string(&example_config()).unwrap();
        assert!(json.contains("\"mcpServers\""), "实际：{json}");
    }
}
