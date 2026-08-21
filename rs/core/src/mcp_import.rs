// ============================================================================
// mcp_import.rs —— 从其它 CLI/编辑器导入 MCP 配置
// ----------------------------------------------------------------------------
// 各家工具的 MCP 配置格式**都是同一个形状**（`{"mcpServers": {...}}`），
// 只有存放位置不同。所以导入不需要解析器适配，只需要知道去哪找。
//
// ## 为什么是「发现 + 让用户选」而不是自动合并
//
// 自动把找到的配置全并进来有两个问题：
//   1. 用户在 Claude Desktop 里配的 server 未必想在这儿跑 —— 比如那个
//      filesystem server 开的是他的文档目录，他可能不想让这个 app 也能读
//   2. 同名 server 冲突时谁赢？静默覆盖会让人莫名发现工具变了
//
// 所以这里只负责**发现**（扫已知位置、读出来、列出有哪些 server），
// 选哪些导入是 UI 的事。这也让「导入」变成一个可撤销的显式动作。
// ============================================================================

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::mcp_config::{McpConfig, McpServerEntry};

/// 一个可能存在 MCP 配置的来源。
#[derive(Debug, Clone)]
pub struct ConfigSource {
    /// 显示名（"Claude Desktop"、"Cursor"）
    pub name: &'static str,
    pub path: PathBuf,
}

/// 从一个来源发现到的东西。
#[derive(Debug, Clone)]
pub struct Discovered {
    pub source: ConfigSource,
    /// 读出来的 server。空 Vec 表示文件存在但没配 server。
    pub servers: BTreeMap<String, McpServerEntry>,
}

/// 已知的配置位置。
///
/// 只列 macOS 和 Linux 的路径 —— Windows 上这些工具的配置位置又是一套，
/// 等有人在 Windows 上用再加（现在加等于写没验证过的代码）。
// clippy 会建议把下面那个 vec 写成字面量（vec_init_then_push）——
// 不听：字面量里没法给每一项写行内注释，而「这个路径属于哪个工具、
// 为什么有两个」正是这段唯一需要解释的东西。
#[allow(clippy::vec_init_then_push)]
fn known_sources() -> Vec<ConfigSource> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return vec![];
    };

    let mut sources = vec![];

    // Claude Desktop。macOS 和 Linux 位置不同，两个都试 ——
    // 只判断 cfg!(target_os) 会漏掉在 Linux 上跑的情况。
    // 文件不存在的来源后面会被过滤掉，多试几个路径没有代价。
    sources.push(ConfigSource {
        name: "Claude Desktop",
        path: home.join("Library/Application Support/Claude/claude_desktop_config.json"),
    });
    sources.push(ConfigSource {
        name: "Claude Desktop",
        path: home.join(".config/Claude/claude_desktop_config.json"),
    });

    // Claude Code（CLI）—— 用户级配置有两种历史位置
    sources.push(ConfigSource {
        name: "Claude Code",
        path: home.join(".claude/mcp.json"),
    });
    sources.push(ConfigSource {
        name: "Claude Code",
        path: home.join(".claude.json"),
    });

    sources.push(ConfigSource {
        name: "Cursor",
        path: home.join(".cursor/mcp.json"),
    });

    sources.push(ConfigSource {
        name: "Codex",
        path: home.join(".codex/config.json"),
    });

    sources.push(ConfigSource {
        name: "Gemini CLI",
        path: home.join(".gemini/settings.json"),
    });

    // OpenCode 也有两种位置
    sources.push(ConfigSource {
        name: "OpenCode",
        path: home.join(".opencode/mcp.json"),
    });
    sources.push(ConfigSource {
        name: "OpenCode",
        path: home.join(".config/opencode/mcp.json"),
    });

    sources.push(ConfigSource {
        name: "Windsurf",
        path: home.join(".codeium/windsurf/mcp_config.json"),
    });

    // Cline 是 VS Code 扩展，配置埋在扩展的 globalStorage 里
    sources.push(ConfigSource {
        name: "Cline",
        path: home.join(
            "Library/Application Support/Code/User/globalStorage/\
             saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
        ),
    });

    sources
}

/// 扫所有已知位置，返回找到的配置。
///
/// 不返回 Result：单个文件坏了不该让整次发现失败 —— 用户可能有五个来源，
/// 一个格式不对不影响另外四个。坏的那个直接跳过。
pub fn discover() -> Vec<Discovered> {
    let mut out: Vec<Discovered> = Vec::new();

    for source in known_sources() {
        let Ok(bytes) = std::fs::read(&source.path) else {
            continue;
        };
        // 这些工具的配置文件里除了 mcpServers 还有一堆别的字段
        // （主题、快捷键…），所以解析成 McpConfig（它 #[serde(default)] 忽略未知字段）
        let Ok(config) = serde_json::from_slice::<McpConfig>(&bytes) else {
            continue;
        };
        // 没配 server 的来源不列出来 —— 显示一个「找到了但里面是空的」
        // 只会让用户点进去发现什么都没有
        if config.servers.is_empty() {
            continue;
        }

        // 同一个工具可能命中多个路径（Claude Desktop 在 macOS/Linux 各一个），
        // 合并进同名条目而不是列两行
        if let Some(existing) = out.iter_mut().find(|d| d.source.name == source.name) {
            for (k, v) in config.servers {
                existing.servers.entry(k).or_insert(v);
            }
        } else {
            out.push(Discovered {
                source,
                servers: config.servers,
            });
        }
    }

    out
}

/// 把选中的 server 合并进现有配置。
///
/// 冲突处理：**同名不覆盖**，改成加后缀（`filesystem` → `filesystem-2`）。
///
/// 为什么不覆盖也不跳过：
///   • 覆盖会让用户已有的配置静默消失
///   • 跳过会让「导入」看起来没生效（他明明选了那一项）
/// 加后缀两者都避免了，代价是名字变丑 —— 但那是用户能看见并自己改的。
pub fn merge_into(
    config: &mut McpConfig,
    incoming: impl IntoIterator<Item = (String, McpServerEntry)>,
) -> Vec<String> {
    let mut added = Vec::new();

    for (name, entry) in incoming {
        let mut key = name.clone();
        let mut n = 2;
        while config.servers.contains_key(&key) {
            key = format!("{name}-{n}");
            n += 1;
        }
        config.servers.insert(key.clone(), entry);
        added.push(key);
    }

    added
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(cmd: &str) -> McpServerEntry {
        McpServerEntry {
            command: cmd.into(),
            args: vec![],
            env: Default::default(),
            disabled: false,
        }
    }

    #[test]
    fn merge_adds_new_servers() {
        let mut config = McpConfig::default();
        let added = merge_into(
            &mut config,
            [
                ("fs".to_string(), entry("a")),
                ("git".to_string(), entry("b")),
            ],
        );
        assert_eq!(added.len(), 2);
        assert_eq!(config.servers.len(), 2);
    }

    #[test]
    fn conflicting_names_get_suffixed_not_overwritten() {
        let mut config = McpConfig::default();
        config.servers.insert("fs".into(), entry("original"));

        let added = merge_into(&mut config, [("fs".to_string(), entry("imported"))]);

        // 原来那个必须还在，且命令没变
        assert_eq!(config.servers["fs"].command, "original");
        // 导入的那个换了名字
        assert_eq!(added, vec!["fs-2"]);
        assert_eq!(config.servers["fs-2"].command, "imported");
    }

    #[test]
    fn multiple_conflicts_keep_counting() {
        let mut config = McpConfig::default();
        config.servers.insert("fs".into(), entry("a"));
        config.servers.insert("fs-2".into(), entry("b"));

        let added = merge_into(&mut config, [("fs".to_string(), entry("c"))]);
        assert_eq!(added, vec!["fs-3"]);
    }

    #[test]
    fn parses_config_with_unrelated_fields() {
        // 真实的 claude_desktop_config.json 里除了 mcpServers 还有别的东西。
        // 解析必须忽略它们而不是失败。
        let json = r#"{
            "theme": "dark",
            "someOtherSetting": 42,
            "mcpServers": {
                "fs": { "command": "npx", "args": ["-y", "server-filesystem"] }
            }
        }"#;
        let config: McpConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.servers.len(), 1);
        assert_eq!(config.servers["fs"].command, "npx");
    }

    #[test]
    fn known_sources_are_absolute_paths() {
        // 相对路径会让「从哪导入」取决于工作目录 —— 双击启动时那是 /
        for source in known_sources() {
            assert!(
                source.path.is_absolute(),
                "{} 的路径不是绝对路径：{}",
                source.name,
                source.path.display()
            );
        }
    }
}
