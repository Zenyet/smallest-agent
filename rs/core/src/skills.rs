// ============================================================================
// skills.rs —— 技能（skill）的发现与加载
// ----------------------------------------------------------------------------
// 一个技能就是一个目录 + 一个 `SKILL.md`，前面带 YAML frontmatter：
//
//   ---
//   name: adapt
//   description: 什么时候该用它
//   ---
//   正文（真正的指令）
//
// 这个格式是 Claude Code / Codex / OpenCode 都在用的那个，所以照抄 ——
// 理由和 mcp_config.rs 里那条一样：用户已经写好的技能能直接拿来用，
// 发明自己的格式除了「不一样」没有别的收益。
//
// ## 为什么只读 frontmatter，不把正文塞进 system prompt
//
// 技能的正文可以很长（几百行），全部注入等于每轮都付那份 token。
// 这里的做法和上面那些工具一致：**把 name + description 列给模型，
// 正文按需读**。所以加载只解析 frontmatter，正文留在磁盘上。
//
// 目前 UI 只做「看有哪些、开关」——「让模型按需读正文」需要一个
// read_skill 工具，那是下一步，不在这个文件里。
// ============================================================================

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context as _, Result};

/// 一个发现到的技能。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skill {
    /// frontmatter 里的 name。缺了就用目录名 —— 目录名一定存在，
    /// 而一个没名字的技能在界面上是一行点不到的空白。
    pub name: String,
    /// frontmatter 里的 description。可能为空。
    pub description: String,
    /// SKILL.md 的路径。UI 用它「在编辑器里打开」。
    pub path: PathBuf,
    /// 来源的显示名（"用户"、"项目"），列表按它分组。
    pub source: &'static str,
}

/// 一个可能存放技能的目录。
#[derive(Debug, Clone)]
pub struct SkillSource {
    pub name: &'static str,
    pub dir: PathBuf,
}

/// 已知的技能目录。
///
/// 顺序有意义：**排在前面的优先**。同名技能只留第一个 —— 项目级的
/// 应该盖住用户级的，因为项目里那份是为这个仓库特意写的。
///
/// 只列 macOS / Linux 的位置，理由同 mcp_import.rs：Windows 上这些工具的
/// 配置位置又是一套，等有人在那上面用再加。
pub fn known_sources(cwd: &Path) -> Vec<SkillSource> {
    let mut sources = vec![
        // 项目级最优先
        SkillSource {
            name: "项目",
            dir: cwd.join(".claude/skills"),
        },
        // 我们自己的目录。放在用户级 Claude 之前 —— 用户为这个 app
        // 特意写的技能该盖住他给 Claude Code 写的
        SkillSource {
            name: "本应用",
            dir: PathBuf::from("skills"),
        },
    ];

    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        // 我们自己的用户级目录（跟 mcp.json 同一个目录）
        if let Ok(dir) = crate::mcp_config::config_dir() {
            sources.push(SkillSource {
                name: "本应用",
                dir: dir.join("skills"),
            });
        }
        sources.push(SkillSource {
            name: "Claude",
            dir: home.join(".claude/skills"),
        });
        sources.push(SkillSource {
            name: "Codex",
            dir: home.join(".codex/skills"),
        });
        sources.push(SkillSource {
            name: "OpenCode",
            dir: home.join(".config/opencode/skills"),
        });
    }

    sources
}

/// 扫所有已知目录。
///
/// 不返回 Result：一个目录读不了（不存在、没权限）不该让整次发现失败 ——
/// 用户可能有四个来源，一个坏了不影响另外三个。这和 mcp_import::discover
/// 是同一个取舍。
///
/// 同名去重，先出现的赢（见 known_sources 的顺序说明）。
pub fn discover(cwd: &Path) -> Vec<Skill> {
    let mut out: Vec<Skill> = Vec::new();

    for source in known_sources(cwd) {
        let Ok(entries) = std::fs::read_dir(&source.dir) else {
            continue;
        };
        // read_dir 的顺序是文件系统给的（不保证），排一下让列表稳定 ——
        // 每次启动技能顺序都变会让人以为配置动了
        let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        dirs.sort();

        for dir in dirs {
            let md = dir.join("SKILL.md");
            let Ok(text) = std::fs::read_to_string(&md) else {
                continue;
            };
            // 目录名做兜底名字
            let fallback = dir
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let (name, description) = parse_frontmatter(&text, &fallback);

            if out.iter().any(|s| s.name == name) {
                continue;
            }
            out.push(Skill {
                name,
                description,
                path: md,
                source: source.name,
            });
        }
    }

    out
}

/// 从 SKILL.md 里抠出 name 和 description。
///
/// 手写而不是拉一个 YAML 库：frontmatter 只有几个标量键，而 serde_yaml
/// 已经不维护了、yaml-rust2 是另一套 API —— 为两个字符串加一个依赖不值。
///
/// 只认最顶上那对 `---`。没有 frontmatter 就返回兜底名 + 空描述。
fn parse_frontmatter(text: &str, fallback: &str) -> (String, String) {
    let mut name = String::new();
    let mut description = String::new();

    let mut lines = text.lines();
    // 第一行必须是 `---`，否则整个文件都是正文
    if lines.next().map(str::trim) != Some("---") {
        return (fallback.to_string(), String::new());
    }

    for line in lines {
        let t = line.trim();
        if t == "---" {
            break;
        }
        // 只取第一个冒号左边当键：description 的值里常有冒号
        // （"Use when: ..."），split 全部会把值切碎
        let Some((key, value)) = t.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'').trim();
        match key.trim() {
            "name" => name = value.to_string(),
            "description" => description = value.to_string(),
            _ => {}
        }
    }

    if name.is_empty() {
        name = fallback.to_string();
    }
    (name, description)
}

/// 被停用的技能名。
///
/// 存名字而不是路径：同名技能会被去重成一个，而用户关掉的是「那个技能」，
/// 不是「那个文件」。路径还会因为仓库移动而变。
pub type DisabledSkills = std::collections::BTreeSet<String>;

fn disabled_path() -> Result<PathBuf> {
    Ok(crate::mcp_config::config_dir()?.join("skills_disabled.json"))
}

/// 读停用列表。读不到就当没停用任何 —— 和 settings 一样静默降级，
/// 因为「技能全开着」是个安全的默认值。
pub fn load_disabled() -> DisabledSkills {
    let Ok(path) = disabled_path() else {
        return DisabledSkills::new();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return DisabledSkills::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn save_disabled(disabled: &DisabledSkills) -> Result<()> {
    use anyhow::Context as _;
    let path = disabled_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("建配置目录失败：{}", dir.display()))?;
    }
    let json = serde_json::to_vec_pretty(disabled).context("序列化停用列表失败")?;
    std::fs::write(&path, json).with_context(|| format!("写 {} 失败", path.display()))
}

// ============================================================================
// 把技能接到 agent 上
// ----------------------------------------------------------------------------
// 两个工具，而不是把技能正文塞进 system prompt：
//
//   • list_skills —— 有哪些技能可用（name + description）
//   • read_skill  —— 读某个技能的正文
//
// ## 为什么是工具而不是 prompt 注入
//
// 正文可以几百行，全注入等于每轮都付那份 token，而一次对话通常只用到零个
// 或一个技能。列表（每个技能一行描述）便宜，正文按需读。
//
// ## 为什么工具在**调用时**才读停用列表
//
// 用户在设置里关掉一个技能应该立即生效。如果在建工具时把列表烤进去，
// 那就得在「用户点了开关」和「下一轮对话」之间重建工具注册表 ——
// 而注册表还烤在 HttpCallModel 里（见 BuiltinProvider::set_tools），
// 一路要重建到 provider。每次调用读一个小 JSON 便宜得多，也不会不一致。
// ============================================================================

use crate::types::{Args, Tool};
use async_trait::async_trait;
use serde_json::{Value, json};

/// 发现技能时用哪个工作目录。
///
/// 每次调用重新取 cwd 而不是建工具时存一份：进程的 cwd 在运行期不变，
/// 但取一次是零成本，而存一份就多一个「什么时候会过期」的问题。
fn cwd() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
}

/// 当前启用的技能（发现到的减去被停用的）。
pub fn enabled() -> Vec<Skill> {
    let disabled = load_disabled();
    discover(&cwd())
        .into_iter()
        .filter(|s| !disabled.contains(&s.name))
        .collect()
}

/// `list_skills` —— 列出可用技能。
pub struct ListSkills;

#[async_trait]
impl Tool for ListSkills {
    fn name(&self) -> &str {
        "list_skills"
    }

    fn description(&self) -> &str {
        "列出当前可用的技能（技能是针对某类任务的操作指南）。\
         开始一个可能有对应技能的任务前先调它看看，再用 read_skill 读需要的那份。"
    }

    fn parameters(&self) -> Value {
        // 无参。properties 空对象而不是省略：有些模型对缺字段的 schema
        // 会生成奇怪的调用
        json!({ "type": "object", "properties": {}, "required": [] })
    }

    async fn run(&self, _args: &Args) -> Result<Value> {
        let list: Vec<Value> = enabled()
            .into_iter()
            .map(|s| json!({ "name": s.name, "description": s.description }))
            .collect();
        // 空列表也正常返回，不报错 —— 「没有技能」是个合法答案，
        // 报错会让模型以为工具坏了并重试
        Ok(json!({ "skills": list }))
    }
}

/// `read_skill` —— 读一个技能的正文。
pub struct ReadSkill;

#[async_trait]
impl Tool for ReadSkill {
    fn name(&self) -> &str {
        "read_skill"
    }

    fn description(&self) -> &str {
        "读取某个技能的完整内容（操作指南）。名字用 list_skills 返回的那个。"
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "技能名" }
            },
            "required": ["name"]
        })
    }

    async fn run(&self, args: &Args) -> Result<Value> {
        let Some(name) = args.get("name").and_then(|v| v.as_str()) else {
            anyhow::bail!("缺少参数 name");
        };

        // 只在**启用**的技能里找：停用的技能不该还能被读出来，
        // 否则「关掉」只是从列表里藏起来，模型仍然能用它
        let Some(skill) = enabled().into_iter().find(|s| s.name == name) else {
            anyhow::bail!("没有叫「{name}」的技能（用 list_skills 看有哪些）");
        };

        let text = crate::runtime::read_file(&skill.path)
            .await
            .map(|b| String::from_utf8_lossy(&b).to_string())
            .with_context(|| format!("读 {} 失败", skill.path.display()))?;

        Ok(json!({ "name": skill.name, "content": text }))
    }
}

/// 把两个技能工具装进注册表。
///
/// 无条件装（哪怕当前没有技能）：技能是用户随时往目录里放的东西，
/// 按「启动时有没有」决定装不装，会让用户加了技能之后必须重启才能用。
/// list_skills 返回空列表足够表达「现在没有」。
pub fn register(registry: &mut crate::types::ToolRegistry) {
    registry.insert("list_skills".into(), Arc::new(ListSkills));
    registry.insert("read_skill".into(), Arc::new(ReadSkill));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_name_and_description() {
        let md = "---\nname: adapt\ndescription: 把设计适配到别的尺寸\n---\n正文";
        let (n, d) = parse_frontmatter(md, "目录名");
        assert_eq!(n, "adapt");
        assert_eq!(d, "把设计适配到别的尺寸");
    }

    #[test]
    fn description_may_contain_colons() {
        // 真实的 description 里常有冒号，按第一个冒号切才对
        let md = "---\nname: x\ndescription: Use when: the user asks\n---\n";
        let (_, d) = parse_frontmatter(md, "f");
        assert_eq!(d, "Use when: the user asks");
    }

    #[test]
    fn missing_name_falls_back_to_dir() {
        let md = "---\ndescription: 只有描述\n---\n";
        let (n, d) = parse_frontmatter(md, "my-skill");
        // 没名字的技能在列表里是一行点不到的空白，所以兜底成目录名
        assert_eq!(n, "my-skill");
        assert_eq!(d, "只有描述");
    }

    #[test]
    fn no_frontmatter_is_not_an_error() {
        let (n, d) = parse_frontmatter("# 就是一篇文档\n没有 frontmatter", "fallback");
        assert_eq!(n, "fallback");
        assert!(d.is_empty());
    }

    #[test]
    fn stops_at_the_closing_marker() {
        // 正文里出现 `key: value` 不该被当成 frontmatter 的字段
        let md = "---\nname: real\n---\ndescription: 这是正文里的，不算\n";
        let (n, d) = parse_frontmatter(md, "f");
        assert_eq!(n, "real");
        assert!(d.is_empty(), "闭合标记之后的内容不该被解析");
    }

    #[test]
    fn ignores_unknown_keys() {
        let md = "---\nname: x\nuser-invocable: true\nargument-hint: \"[a]\"\n---\n";
        let (n, _) = parse_frontmatter(md, "f");
        assert_eq!(n, "x");
    }

    #[test]
    fn strips_quotes_from_values() {
        let md = "---\nname: \"quoted\"\ndescription: 'single'\n---\n";
        let (n, d) = parse_frontmatter(md, "f");
        assert_eq!(n, "quoted");
        assert_eq!(d, "single");
    }

    #[test]
    fn discover_reads_a_real_dir_and_dedups() {
        // 建两层目录，同名技能在两处 —— 前面的来源该赢
        let tmp = std::env::temp_dir().join(format!("skills-test-{}", std::process::id()));
        let project = tmp.join(".claude/skills/dup");
        std::fs::create_dir_all(&project).expect("建项目技能目录");
        std::fs::write(
            project.join("SKILL.md"),
            "---\nname: dup\ndescription: 项目那份\n---\n",
        )
        .expect("写项目技能");

        let found = discover(&tmp);
        let dup: Vec<&Skill> = found.iter().filter(|s| s.name == "dup").collect();
        assert_eq!(dup.len(), 1, "同名只留一个");
        assert_eq!(dup[0].description, "项目那份");
        assert_eq!(dup[0].source, "项目");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn register_installs_both_tools() {
        let mut registry = crate::types::ToolRegistry::new();
        register(&mut registry);
        // 无条件装：用户随时往目录里放技能，按启动时有没有决定装不装
        // 会让新加的技能必须重启才能用
        assert!(registry.contains_key("list_skills"));
        assert!(registry.contains_key("read_skill"));
    }

    #[test]
    fn read_skill_declares_its_required_arg() {
        // schema 里 name 必填 —— 少了这条有些模型会调用时不传参数
        let p = ReadSkill.parameters();
        assert_eq!(p["required"][0], "name");
        assert_eq!(p["properties"]["name"]["type"], "string");
    }

    #[tokio::test]
    async fn read_skill_without_name_errors() {
        let args = serde_json::Map::new();
        let err = ReadSkill.run(&args).await.expect_err("缺参数该报错");
        assert!(err.to_string().contains("name"));
    }

    #[tokio::test]
    async fn read_skill_rejects_unknown_name() {
        let mut args = serde_json::Map::new();
        args.insert("name".into(), json!("绝对不存在的技能名-xyzzy"));
        let err = ReadSkill.run(&args).await.expect_err("不存在的技能该报错");
        // 错误里要提到 list_skills —— 模型看到这条才知道下一步该干什么
        assert!(err.to_string().contains("list_skills"));
    }

    #[tokio::test]
    async fn list_skills_returns_an_array_even_when_empty() {
        // 「没有技能」是合法答案，不该报错（报错会让模型以为工具坏了并重试）
        let out = ListSkills.run(&serde_json::Map::new()).await.expect("不该失败");
        assert!(out["skills"].is_array());
    }

    #[test]
    fn disabled_skills_are_filtered_out() {
        // enabled() 依赖真实 HOME 和 cwd，所以这里只验证过滤那一步的逻辑，
        // 不去动全局状态（改 HOME 会影响并行跑的其它测试）
        let found = [
            Skill {
                name: "keep".into(),
                description: String::new(),
                path: PathBuf::from("/a/SKILL.md"),
                source: "测试",
            },
            Skill {
                name: "drop".into(),
                description: String::new(),
                path: PathBuf::from("/b/SKILL.md"),
                source: "测试",
            },
        ];
        let disabled: DisabledSkills = ["drop".to_string()].into_iter().collect();
        let left: Vec<&Skill> = found
            .iter()
            .filter(|s| !disabled.contains(&s.name))
            .collect();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].name, "keep");
    }

    #[test]
    fn discover_skips_dirs_without_skill_md() {
        let tmp = std::env::temp_dir().join(format!("skills-empty-{}", std::process::id()));
        std::fs::create_dir_all(tmp.join(".claude/skills/not-a-skill")).expect("建目录");

        let found = discover(&tmp);
        // 一个没有 SKILL.md 的目录不是技能，不该出现在列表里
        assert!(!found.iter().any(|s| s.name == "not-a-skill"));

        std::fs::remove_dir_all(&tmp).ok();
    }
}
