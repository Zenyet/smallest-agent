// ============================================================================
// workspace.rs —— 沙盒：agent 能碰的那块地
// ----------------------------------------------------------------------------
// 文件读写和命令执行都要先过这里。没有这一层的话，「给 agent 加文件工具」
// 等于给模型一把能改用户整个磁盘的刀。
//
// ## 为什么必须是「解析之后」再判断
//
// 一个只做字符串前缀比较的实现是**不安全**的，两条路都能绕过去：
//
//   1. `../` —— `{root}/../../.ssh/id_rsa` 以 root 开头，但指向 root 外面
//   2. 符号链接 —— 在 root 里放一个指向 `/etc` 的链接，前缀检查看不出来
//
// 所以这里的顺序是：先把路径**规范化**（吃掉 `.` 和 `..`、跟随符号链接），
// 再拿规范化的结果和同样规范化的 root 比。第 2 条只有 `canonicalize`
// 能挡住，而它要求路径**已存在** —— 写新文件时不存在，所以对不存在的
// 路径退化成「规范化它已存在的父目录 + 拼上文件名」，见 resolve。
//
// ## 为什么根目录是显式选的，不是 cwd
//
// 双击启动时 cwd 是 `/`。拿它当沙盒根等于没有沙盒。所以根目录要么是
// 用户在设置里选的，要么是默认那个 `~/SmallestAgent` —— 一个我们建出来、
// 语义明确的地方。
//
// ## 这挡得住什么，挡不住什么
//
// 挡得住：模型自己判断失误、看到了一段恶意文本（prompt injection）之后
// 想读 `~/.ssh` 或者写 `~/.zshrc`。
//
// **挡不住**：用户自己批准了一条 `bash` 命令，而那条命令里写着
// `rm -rf ~`。命令执行是在真实 shell 里跑的，沙盒只限制它的**工作目录**，
// 不是一个内核级的隔离容器。所以命令类工具必须走审批，让用户看见
// 到底要执行什么 —— 这是 approval.rs 存在的原因，两层是配合关系。
// ============================================================================

use std::path::{Component, Path, PathBuf};

use anyhow::{Context as _, Result, bail};

/// 设置键：沙盒根目录。留空则用 `default_root()`。
pub const WORKSPACE_DIR: &str = "WORKSPACE_DIR";

/// 默认根目录：`~/SmallestAgent`。
///
/// 放在主目录下而不是临时目录：agent 写出来的东西用户要找得到，
/// 而 `/tmp` 会被系统清掉（现在那个 MCP filesystem server 指的就是
/// 一个临时目录，重启就换一个，等于白干）。
pub fn default_root() -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("找不到用户主目录（HOME 没设）")?;
    Ok(home.join("SmallestAgent"))
}

/// 沙盒。所有文件 / 命令工具都从它拿路径。
#[derive(Debug, Clone)]
pub struct Workspace {
    /// 已经规范化的根。构造时就 canonicalize 过，后面比较才有意义
    root: PathBuf,
}

impl Workspace {
    /// 用一个目录建沙盒。目录不存在就建出来。
    ///
    /// 建目录是刻意的：第一次用的时候它当然不存在，而报错让用户自己
    /// 去 Finder 里建一个是没必要的一步。
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        std::fs::create_dir_all(root)
            .with_context(|| format!("建工作目录失败：{}", root.display()))?;
        // canonicalize 要求存在，所以必须在 create_dir_all 之后。
        // 这一步同时解掉 macOS 上 /var → /private/var 那类符号链接 ——
        // 不解的话根是 /var/... 而解析出来的路径是 /private/var/...，
        // 前缀比较会**全部失败**，表现成「什么都读不了」。
        let root = root
            .canonicalize()
            .with_context(|| format!("解析工作目录失败：{}", root.display()))?;
        Ok(Self { root })
    }

    /// 从设置里读根目录，没配就用默认的。
    pub fn from_settings(get: &dyn Fn(&str) -> Option<String>) -> Result<Self> {
        let configured = get(WORKSPACE_DIR)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        match configured {
            Some(dir) => Self::new(expand_tilde(&dir)),
            None => Self::new(default_root()?),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn display(&self) -> String {
        self.root.display().to_string()
    }

    /// 把模型给的路径解析成一个**保证在沙盒内**的绝对路径。
    ///
    /// 相对路径按沙盒根解释（模型说 `notes/a.md` 就是 `{root}/notes/a.md`）。
    /// 绝对路径也允许，但同样要落在根里面 —— 模型有时会把上一轮读到的
    /// 绝对路径原样传回来，一律拒绝反而逼它去猜相对路径。
    ///
    /// 越界返回 Err。错误信息里带上根目录，因为模型看到这个错之后
    /// 需要知道它能在哪儿活动。
    pub fn resolve(&self, raw: &str) -> Result<PathBuf> {
        let raw = raw.trim();
        if raw.is_empty() {
            bail!("路径不能为空");
        }
        let p = expand_tilde(raw);
        let joined = if p.is_absolute() {
            p
        } else {
            self.root.join(p)
        };

        // 已存在：直接 canonicalize，符号链接一并解掉。
        // 不存在（写新文件）：解析父目录，再拼回文件名 ——
        // 父目录必须已存在且在沙盒内，所以「在 root 外面造一个新文件」
        // 这条路同样被堵住。
        let resolved = match joined.canonicalize() {
            Ok(c) => c,
            Err(_) => {
                let parent = joined
                    .parent()
                    .context("路径没有父目录")?
                    .to_path_buf();
                let name = joined
                    .file_name()
                    .context("路径没有文件名")?
                    .to_os_string();
                // 父目录也可能还不存在（模型要建 a/b/c.txt 而 a/b 没有）。
                // 往上找到第一个存在的祖先来判断越界，中间那几层由
                // 写入工具自己 create_dir_all —— 它们都在已通过检查的
                // 前缀之下，安全。
                let (existing, rest) = nearest_existing(&parent)?;
                let base = existing
                    .canonicalize()
                    .with_context(|| format!("解析路径失败：{}", existing.display()))?;
                base.join(rest).join(name)
            }
        };

        if !resolved.starts_with(&self.root) {
            bail!(
                "路径越出工作目录了：{} 不在 {} 里面。\
                 只能读写工作目录内的文件。",
                resolved.display(),
                self.root.display()
            );
        }
        Ok(resolved)
    }

    /// 显示用的相对路径。给模型和 UI 看的都用这个 ——
    /// 一长串绝对路径在对话里是噪音，而且泄露用户名。
    pub fn relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| path.display().to_string())
    }
}

/// 把开头的 `~` 展开成主目录。
///
/// 模型很爱写 `~/xxx`。不展开的话会得到一个名字真的叫 `~` 的目录，
/// 而那个错看起来像「路径不存在」，查不到根因。
fn expand_tilde(raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix("~/")
        && let Some(home) = std::env::var_os("HOME")
    {
        return PathBuf::from(home).join(rest);
    }
    PathBuf::from(raw)
}

/// 往上找到第一个存在的祖先，返回它和剩下那段。
///
/// 剩下那段里如果还有 `..` 就直接拒绝：它没法通过 canonicalize 消解
/// （那几层还不存在），留着就是一个绕过沙盒的口子。
fn nearest_existing(path: &Path) -> Result<(PathBuf, PathBuf)> {
    let mut rest: Vec<Component<'_>> = Vec::new();
    let mut cur = path;
    loop {
        if cur.exists() {
            let mut tail = PathBuf::new();
            for c in rest.iter().rev() {
                if matches!(c, Component::ParentDir) {
                    bail!("路径里有 .. 且中间目录不存在，无法安全解析");
                }
                tail.push(c.as_os_str());
            }
            return Ok((cur.to_path_buf(), tail));
        }
        let Some(parent) = cur.parent() else {
            bail!("路径无法解析：{}", path.display());
        };
        if let Some(name) = cur.file_name() {
            rest.push(Component::Normal(name));
        } else if cur.file_name().is_none() && cur != parent {
            bail!("路径无法解析：{}", path.display());
        }
        cur = parent;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个临时沙盒。用进程 id + 计数器避免并行测试撞车。
    fn temp_ws() -> (Workspace, PathBuf) {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "sa-ws-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let ws = Workspace::new(&dir).expect("建沙盒");
        let root = ws.root().to_path_buf();
        (ws, root)
    }

    #[test]
    fn relative_paths_resolve_inside_the_root() {
        let (ws, root) = temp_ws();
        let p = ws.resolve("notes/a.md").expect("该通过");
        assert_eq!(p, root.join("notes/a.md"));
    }

    #[test]
    fn dotdot_cannot_escape() {
        // 这是沙盒最基本的那条线。字符串前缀比较挡不住这个
        let (ws, _) = temp_ws();
        assert!(ws.resolve("../../etc/passwd").is_err());
        assert!(ws.resolve("a/../../../../etc/passwd").is_err());
    }

    #[test]
    fn dotdot_that_stays_inside_is_fine() {
        // 不能一刀切禁掉 ..：`a/../b` 是合法的，模型拼路径时会写出来
        let (ws, root) = temp_ws();
        std::fs::create_dir_all(root.join("a")).unwrap();
        let p = ws.resolve("a/../b.txt").expect("没越界就该通过");
        assert_eq!(p, root.join("b.txt"));
    }

    #[test]
    fn absolute_paths_outside_are_rejected() {
        let (ws, _) = temp_ws();
        assert!(ws.resolve("/etc/passwd").is_err());
        assert!(ws.resolve("/tmp").is_err());
    }

    #[test]
    fn absolute_paths_inside_are_allowed() {
        // 模型常把上一轮读到的绝对路径原样传回来，一律拒绝会逼它瞎猜
        let (ws, root) = temp_ws();
        let inside = root.join("x.txt");
        let p = ws.resolve(&inside.display().to_string()).expect("该通过");
        assert_eq!(p, inside);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_pointing_outside_are_rejected() {
        // 前缀比较**看不出**这个 —— 只有 canonicalize 能挡。
        // 沙盒里放一个指向 /etc 的链接，然后试着读它下面的东西。
        let (ws, root) = temp_ws();
        let link = root.join("escape");
        let _ = std::os::unix::fs::symlink("/etc", &link);
        // 建链接失败（某些环境不允许）就跳过，不让测试假过
        if !link.exists() {
            return;
        }
        assert!(
            ws.resolve("escape/passwd").is_err(),
            "符号链接指向沙盒外，必须拒绝"
        );
    }

    #[test]
    fn new_files_in_missing_subdirs_resolve() {
        // 写新文件时路径不存在，canonicalize 会失败 —— 这条路要能走通，
        // 否则 write_file 永远建不了新目录里的文件
        let (ws, root) = temp_ws();
        let p = ws.resolve("deep/nested/new.txt").expect("该通过");
        assert_eq!(p, root.join("deep/nested/new.txt"));
    }

    #[test]
    fn empty_path_is_rejected() {
        let (ws, _) = temp_ws();
        assert!(ws.resolve("   ").is_err());
    }

    #[test]
    fn relative_renders_a_short_path() {
        let (ws, root) = temp_ws();
        assert_eq!(ws.relative(&root.join("a/b.txt")), "a/b.txt");
    }

    #[test]
    fn from_settings_uses_the_configured_dir() {
        let dir = std::env::temp_dir().join(format!("sa-ws-cfg-{}", std::process::id()));
        let d = dir.display().to_string();
        let ws = Workspace::from_settings(&|k| {
            if k == WORKSPACE_DIR {
                Some(d.clone())
            } else {
                None
            }
        })
        .expect("该建得出来");
        assert_eq!(ws.root(), dir.canonicalize().unwrap());
    }

    #[test]
    fn blank_setting_falls_back_to_default() {
        // 空串不该被当成一个叫 "" 的目录
        let ws = Workspace::from_settings(&|_| Some("   ".into()));
        // HOME 一定有，所以这里该成功并落在 ~/SmallestAgent
        let ws = ws.expect("该回落到默认目录");
        assert!(ws.root().ends_with("SmallestAgent"), "{}", ws.display());
    }

    #[test]
    fn error_message_names_the_root_so_the_model_can_recover() {
        // 模型看到越界错误之后要知道自己能在哪儿活动，否则只会换个
        // 姿势再撞一次
        let (ws, root) = temp_ws();
        let err = ws.resolve("/etc/passwd").unwrap_err().to_string();
        assert!(err.contains(&root.display().to_string()), "{err}");
    }
}
