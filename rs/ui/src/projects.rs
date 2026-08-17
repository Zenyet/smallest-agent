// ============================================================================
// projects.rs —— 项目分组：把会话按「本地目录」归类
//                对应 electron/main/{projects,projects-store}.ts
// ----------------------------------------------------------------------------
// 纯逻辑 + 一个 JSON 落盘，不碰 gpui。所以下面那组函数能直接单测。
//
// ## 为什么项目映射不能存进会话文件
//
// 会话文件的形状由 core 的 JsonSessionStore 决定（就是一个 Message[] 数组），
// 没有地方放元数据，而且每答完一轮 SaveSessionHook 都会整体覆写那个文件 ——
// 塞进去的额外字段会被下一次 save 抹掉。所以映射走自己的持久化文件。
// 这和 Electron 版走 electron-store 是同一个理由。
// ============================================================================

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use smallest_agent_core::memory::SessionMeta;

/// 「未分组」不是真项目（没有目录、不可删），但折叠状态要能记住，
/// 所以需要一个稳定 id 参与 collapsed 集合。前缀带下划线，和 `p...` 形状不撞。
pub const UNGROUPED_ID: &str = "_ungrouped";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    /// 展示名，默认取目录 basename
    pub name: String,
    /// 绝对路径。**项目的身份由它决定** —— 同一个目录不重复添加
    pub dir: String,
    pub created_at: u128,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ProjectsState {
    #[serde(default)]
    pub projects: Vec<Project>,
    /// session_id → project_id。一个会话最多属于一个项目；
    /// 不在这里的归「未分组」
    #[serde(default)]
    pub session_project: BTreeMap<String, String>,
    /// 折叠着的分组 id（含 UNGROUPED_ID）。持久化，重启后仍然折叠
    #[serde(default)]
    pub collapsed: Vec<String>,
}

impl ProjectsState {
    /// 清掉垃圾数据。
    ///
    /// 磁盘上的 JSON 可能是手改过的或旧版本写的。指向已删项目的映射尤其要清 ——
    /// 留着它会让那个会话既不在任何项目下、也不在「未分组」里，
    /// 直接从侧边栏消失。
    pub fn normalize(mut self) -> Self {
        let known: Vec<&str> = self.projects.iter().map(|p| p.id.as_str()).collect();
        self.session_project
            .retain(|_, pid| known.contains(&pid.as_str()));
        self
    }
}

/// 从目录路径取展示名。
///
/// 两种分隔符都认。兜底分两级：取不出名字时退回原始路径（比占位符有信息量），
/// 路径本身也空才用占位符 —— 空名字在侧边栏里是一行点不到的空白。
pub fn project_name_from_dir(dir: &str) -> String {
    let trimmed = dir.trim_end_matches(['/', '\\']);
    let last = trimmed.rsplit(['/', '\\']).next().unwrap_or("");
    if !last.is_empty() {
        last.to_string()
    } else if !dir.is_empty() {
        dir.to_string()
    } else {
        "未命名项目".to_string()
    }
}

/// 生成项目 id。手法同 core 的 new_session_id：时间戳前缀可排序，
/// 进程内自增计数器保证同一毫秒连续添加也不碰撞。
pub fn new_project_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("p{}-{}", now_millis(), n)
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 添加项目。
///
/// **目录即身份**：同一个目录再选一次不该长出第二个同名项目 —— 用户很容易这么干，
/// 原生选择器每次都从头开始，记不住上次选过什么。已存在就原样返回同一个 id，
/// 让调用方拿着它继续往下走（比如把新会话挂上去）。
pub fn add_project(state: &mut ProjectsState, dir: &str) -> Project {
    if let Some(existing) = state.projects.iter().find(|p| p.dir == dir) {
        return existing.clone();
    }
    let project = Project {
        id: new_project_id(),
        name: project_name_from_dir(dir),
        dir: dir.to_string(),
        created_at: now_millis(),
    };
    state.projects.push(project.clone());
    project
}

/// 删项目**不删会话**：目录只是个分类标签，磁盘上的对话历史还在。
/// 名下的会话回到「未分组」，而不是跟着消失。
pub fn remove_project(state: &mut ProjectsState, id: &str) {
    state.projects.retain(|p| p.id != id);
    state.session_project.retain(|_, pid| pid != id);
    state.collapsed.retain(|c| c != id);
}

/// 把会话挂到项目下。project_id 传 None 表示挪回「未分组」。
///
/// 指向不存在的项目一律当 None 处理，否则会造出一条悬空映射
/// （下次启动 normalize 才清掉）。
pub fn assign_session(state: &mut ProjectsState, session_id: &str, project_id: Option<&str>) {
    match project_id {
        Some(pid) if state.projects.iter().any(|p| p.id == pid) => {
            state
                .session_project
                .insert(session_id.to_string(), pid.to_string());
        }
        _ => {
            state.session_project.remove(session_id);
        }
    }
}

/// 会话被删后清掉它的映射。
///
/// 不清的话，将来某个新会话万一拿到同样的 id（core 的计数器保证进程内不会，
/// 但跨进程重启后时间戳可能重合）会莫名出现在一个它从没被放进去过的项目下。
pub fn forget_session(state: &mut ProjectsState, session_id: &str) {
    state.session_project.remove(session_id);
}

pub fn toggle_collapsed(state: &mut ProjectsState, id: &str) {
    if let Some(pos) = state.collapsed.iter().position(|c| c == id) {
        state.collapsed.remove(pos);
    } else {
        state.collapsed.push(id.to_string());
    }
}

/// 渲染层要的形状。
#[derive(Debug, Clone)]
pub struct SessionGroup {
    /// 项目 id，或 UNGROUPED_ID
    pub id: String,
    pub name: String,
    /// 「未分组」没有目录
    pub dir: Option<String>,
    pub collapsed: bool,
    pub sessions: Vec<SessionMeta>,
}

/// 会话按项目分组：项目按添加顺序，「未分组」垫在最后。
///
/// 两条不对称的规则，都是有意的：
///   • **空项目也要出现** —— 用户刚添加一个目录、还没在里面开对话时，
///     这一行不显示的话那次「添加项目」看起来就像什么都没发生。
///   • **「未分组」空着就不显示** —— 它是兜底分类不是用户建的东西，
///     空着还占一行只是噪音。
pub fn group_sessions(sessions: &[SessionMeta], state: &ProjectsState) -> Vec<SessionGroup> {
    let mut groups: Vec<SessionGroup> = state
        .projects
        .iter()
        .map(|p| SessionGroup {
            id: p.id.clone(),
            name: p.name.clone(),
            dir: Some(p.dir.clone()),
            collapsed: state.collapsed.contains(&p.id),
            sessions: Vec::new(),
        })
        .collect();

    let mut ungrouped: Vec<SessionMeta> = Vec::new();
    for s in sessions {
        match state.session_project.get(&s.id) {
            Some(pid) => match groups.iter_mut().find(|g| &g.id == pid) {
                Some(g) => g.sessions.push(s.clone()),
                // 映射指向已删项目（normalize 会清，但内存态里可能刚删）
                None => ungrouped.push(s.clone()),
            },
            None => ungrouped.push(s.clone()),
        }
    }

    if !ungrouped.is_empty() {
        groups.push(SessionGroup {
            id: UNGROUPED_ID.to_string(),
            name: "未分组".to_string(),
            dir: None,
            collapsed: state.collapsed.contains(&UNGROUPED_ID.to_string()),
            sessions: ungrouped,
        });
    }
    groups
}

// ============================================================================
// 落盘
// ============================================================================

fn projects_path() -> Result<PathBuf> {
    crate::settings::settings_path()
        .map(|p| p.with_file_name("projects.json"))
        .context("算 projects.json 路径失败")
}

/// 读。文件不存在或坏了都返回空状态 —— 分组信息缺失不该让应用起不来。
pub fn load_projects() -> ProjectsState {
    let Ok(path) = projects_path() else {
        return ProjectsState::default();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return ProjectsState::default();
    };
    serde_json::from_slice::<ProjectsState>(&bytes)
        .unwrap_or_default()
        .normalize()
}

pub fn save_projects(state: &ProjectsState) -> Result<()> {
    let path = projects_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("建配置目录失败：{}", dir.display()))?;
    }
    let json = serde_json::to_vec_pretty(state).context("序列化项目状态失败")?;
    std::fs::write(&path, json).with_context(|| format!("写项目状态失败：{}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(id: &str) -> SessionMeta {
        SessionMeta {
            id: id.into(),
            title: format!("会话 {id}"),
            updated_at: 0,
        }
    }

    #[test]
    fn name_from_dir_handles_both_separators_and_trailing() {
        assert_eq!(project_name_from_dir("/Users/roy/lab"), "lab");
        assert_eq!(project_name_from_dir("/Users/roy/lab/"), "lab");
        assert_eq!(project_name_from_dir("C:\\Users\\roy\\lab"), "lab");
        // 取不出名字时退回原始路径而不是占位符
        assert_eq!(project_name_from_dir("/"), "/");
        assert_eq!(project_name_from_dir(""), "未命名项目");
    }

    #[test]
    fn same_dir_does_not_create_duplicate() {
        // 目录即身份：再选一次同一个目录应该拿回同一个项目
        let mut state = ProjectsState::default();
        let a = add_project(&mut state, "/tmp/x");
        let b = add_project(&mut state, "/tmp/x");
        assert_eq!(a.id, b.id);
        assert_eq!(state.projects.len(), 1);
    }

    #[test]
    fn removing_project_keeps_sessions_as_ungrouped() {
        let mut state = ProjectsState::default();
        let p = add_project(&mut state, "/tmp/x");
        assign_session(&mut state, "s1", Some(&p.id));
        toggle_collapsed(&mut state, &p.id);

        remove_project(&mut state, &p.id);

        assert!(state.projects.is_empty());
        // 映射和折叠状态都清了
        assert!(state.session_project.is_empty());
        assert!(state.collapsed.is_empty());
        // 会话本身回到「未分组」
        let groups = group_sessions(&[meta("s1")], &state);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, UNGROUPED_ID);
    }

    #[test]
    fn assigning_to_unknown_project_falls_back_to_ungrouped() {
        let mut state = ProjectsState::default();
        assign_session(&mut state, "s1", Some("p-does-not-exist"));
        // 不留悬空映射
        assert!(state.session_project.is_empty());
    }

    #[test]
    fn empty_project_shows_but_empty_ungrouped_does_not() {
        let mut state = ProjectsState::default();
        add_project(&mut state, "/tmp/x");
        // 没有任何会话：项目行仍要出现（否则「添加项目」看着像没反应），
        // 「未分组」不出现（兜底分类，空着是噪音）
        let groups = group_sessions(&[], &state);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].sessions.len(), 0);
        assert_ne!(groups[0].id, UNGROUPED_ID);
    }

    #[test]
    fn normalize_drops_mappings_to_deleted_projects() {
        let mut state = ProjectsState::default();
        state.session_project.insert("s1".into(), "p-gone".into());
        let state = state.normalize();
        // 否则 s1 会既不在项目下、也不在未分组里，从列表消失
        assert!(state.session_project.is_empty());
    }

    #[test]
    fn groups_preserve_project_order_with_ungrouped_last() {
        let mut state = ProjectsState::default();
        let a = add_project(&mut state, "/tmp/a");
        let b = add_project(&mut state, "/tmp/b");
        assign_session(&mut state, "s1", Some(&b.id));
        assign_session(&mut state, "s2", Some(&a.id));

        let groups = group_sessions(&[meta("s1"), meta("s2"), meta("s3")], &state);
        assert_eq!(groups[0].id, a.id);
        assert_eq!(groups[1].id, b.id);
        assert_eq!(groups[2].id, UNGROUPED_ID);
        assert_eq!(groups[2].sessions[0].id, "s3");
    }

    #[test]
    fn forget_session_clears_stale_mapping() {
        let mut state = ProjectsState::default();
        let p = add_project(&mut state, "/tmp/x");
        assign_session(&mut state, "s1", Some(&p.id));
        forget_session(&mut state, "s1");
        assert!(state.session_project.is_empty());
    }
}
