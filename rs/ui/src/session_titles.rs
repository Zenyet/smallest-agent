// ============================================================================
// session_titles.rs —— 用户改过的会话标题
// ----------------------------------------------------------------------------
// 默认标题是从第一条用户消息推的（core 的 session_title）。用户重命名之后
// 要覆盖那个推导结果，而覆盖值没地方存 —— 会话文件的形状由 core 的
// JsonSessionStore 决定（就是 `Message[]`），每答完一轮 SaveSessionHook
// 都会整体覆写它。
//
// 和 projects.json / providers.json 同一个模式：单独一个文件存「core 不管
// 但 UI 需要」的元数据。
//
// ## 为什么不把它并进 projects.json
//
// 两者都是「按 session_id 索引的元数据」，看着能合。但它们的生命周期不同：
// 项目映射在删项目时要批量清理，标题不需要；标题在会话改名时写，项目映射
// 在新建会话时写。合在一个文件里意味着任何一边的写操作都要读-改-写另一边的
// 数据，多一处出错机会。
// ============================================================================

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context as _, Result};

/// 标题的最大长度。
///
/// 和 core 的 TITLE_MAX 一致 —— 侧边栏那点宽度放不下更长的，
/// 而截断显示（省略号）比让用户以为自己起的名字被完整保留了要诚实。
const TITLE_MAX: usize = 60;

/// session_id → 用户设的标题。
pub type Titles = BTreeMap<String, String>;

fn titles_path() -> Result<PathBuf> {
    crate::settings::settings_path()
        .map(|p| p.with_file_name("session_titles.json"))
        .context("算 session_titles.json 路径失败")
}

/// 读。文件不存在或坏了都返回空表 —— 标题丢了只是回落到自动推导，
/// 不该让应用起不来。
pub fn load() -> Titles {
    let Ok(path) = titles_path() else {
        return Titles::new();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return Titles::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn save(titles: &Titles) -> Result<()> {
    let path = titles_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("建配置目录失败：{}", dir.display()))?;
    }
    let json = serde_json::to_vec_pretty(titles).context("序列化标题失败")?;
    std::fs::write(&path, json).with_context(|| format!("写 {} 失败", path.display()))
}

/// 规范化用户输入的标题。
///
/// 返回 None 表示「用回自动推导的」—— 空输入不该存成一个空标题，
/// 那会让侧边栏出现一行点不到的空白。
pub fn normalize(input: &str) -> Option<String> {
    // 折叠所有空白（含换行）：多行粘贴进来会把侧边栏撑变形
    let flat = input.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    // 按字符截断而不是字节 —— 中文一个字 3 字节，按字节切会切出半个字符
    Some(flat.chars().take(TITLE_MAX).collect())
}

/// 设一个标题。传 None 表示恢复自动推导。
pub fn set(titles: &mut Titles, session_id: &str, title: Option<String>) {
    match title {
        Some(t) => {
            titles.insert(session_id.to_string(), t);
        }
        // 删掉记录而不是存空串：「没记录」和「记了空串」不该是两种
        // 表示同一件事的状态
        None => {
            titles.remove(session_id);
        }
    }
}

/// 会话被删后清掉它的标题。
pub fn forget(titles: &mut Titles, session_id: &str) {
    titles.remove(session_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_collapses_whitespace() {
        assert_eq!(
            normalize("  多行\n标题   带空格 "),
            Some("多行 标题 带空格".to_string())
        );
    }

    #[test]
    fn empty_input_means_auto() {
        assert_eq!(normalize(""), None);
        assert_eq!(normalize("   "), None);
        assert_eq!(normalize("\n\t"), None);
    }

    #[test]
    fn truncates_by_chars_not_bytes() {
        // 一个汉字 3 字节，按字节截会切出半个字符
        let long = "中".repeat(100);
        let out = normalize(&long).unwrap();
        assert_eq!(out.chars().count(), TITLE_MAX);
        // 能正常转回字符串说明没切坏
        assert!(out.chars().all(|c| c == '中'));
    }

    #[test]
    fn set_none_removes_the_record() {
        let mut titles = Titles::new();
        set(&mut titles, "s1", Some("我的会话".into()));
        assert_eq!(titles.get("s1").map(|s| s.as_str()), Some("我的会话"));

        set(&mut titles, "s1", None);
        // 恢复自动推导 = 删记录，不是存空串
        assert!(titles.is_empty());
    }

    #[test]
    fn forget_clears() {
        let mut titles = Titles::new();
        set(&mut titles, "s1", Some("x".into()));
        forget(&mut titles, "s1");
        assert!(titles.is_empty());
    }
}
