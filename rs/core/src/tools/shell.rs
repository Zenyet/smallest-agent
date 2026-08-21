// ============================================================================
// tools/shell.rs —— 执行命令
// ----------------------------------------------------------------------------
// 这是整套工具里**唯一一个能造成任意后果**的。所以关于它的取舍要写清楚。
//
// ## 三层约束，缺一层都不行
//
//   1. **审批**。工具名叫 `run_command`，正好在 approval.rs 的危险名单里，
//      所以每次执行前都会弹卡片、把完整命令给用户看。这是最后一道闸，
//      也是唯一能挡住「用户自己批准了 rm -rf」的地方 —— 挡不住的话
//      前两层都是装饰。**改名字之前先看那张名单**（有测试锁着）。
//
//   2. **工作目录**。子进程的 cwd 设成沙盒根，所以相对路径的命令
//      （`ls`、`cat a.txt`）只能看到沙盒里的东西。
//
//   3. **超时**。命令可能永远不返回（`tail -f`、等输入的交互式程序），
//      而 agent 循环会一直 await 它 —— 那个会话就卡死了，连停止都点不动。
//
// ## 说清楚这挡不住什么
//
// 这**不是**沙箱化的执行。命令在真实 shell 里跑，拥有当前用户的全部权限。
// `cat ~/.ssh/id_rsa` 里的绝对路径不受第 2 层限制 —— cwd 只影响相对路径。
//
// 换句话说：真正的防线是第 1 层，用户看着那条命令按的「允许」。
// 第 2、3 层降低的是「模型无心之失」的概率，不是「恶意命令」的能力。
// 要真正隔离得上容器 / seatbelt，那是另一个量级的工程。
//
// 这个取舍和 Claude Code、Cursor 这类工具是同一个 —— 它们也是
// 「展示命令 + 用户确认」，而不是内核级隔离。
// ============================================================================

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use async_trait::async_trait;
use serde_json::{Value, json};

use crate::types::{Args, Tool, ToolRegistry};
use crate::workspace::Workspace;

/// 单条命令最长跑多久。
///
/// 2 分钟：够跑构建和测试，又不至于让一个卡住的命令把会话挂到天荒地老。
/// 超时后 kill 掉子进程并把「超时了」作为结果回给模型 —— 它能据此
/// 换个做法（比如加 `--no-watch`），比整轮失败有用。
const TIMEOUT: Duration = Duration::from_secs(120);

/// 输出上限。构建日志能有几十 MB，整个塞回模型会瞬间爆上下文。
const MAX_OUTPUT: usize = 32 * 1024;

/// 截断输出，保留**尾部**。
///
/// 保尾不保头：命令的结论在最后（报错信息、测试汇总、最终结果），
/// 而开头通常是无关的编译进度。这一点和读文件相反，那里保头。
fn tail(s: &str) -> (String, bool) {
    if s.len() <= MAX_OUTPUT {
        return (s.to_string(), false);
    }
    // 从字符边界切，否则多字节字符会被劈开
    let start = s.len() - MAX_OUTPUT;
    let start = (start..s.len())
        .find(|i| s.is_char_boundary(*i))
        .unwrap_or(s.len());
    (s[start..].to_string(), true)
}

pub struct RunCommand(pub Arc<Workspace>);

#[async_trait]
impl Tool for RunCommand {
    fn name(&self) -> &str {
        "run_command"
    }
    fn description(&self) -> &str {
        "在工作目录里执行一条 shell 命令，返回 stdout、stderr 和退出码。\
         每次执行都需要用户确认。命令在工作目录下运行，请用相对路径。\
         不要执行需要交互输入的命令（它们会超时）。"
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "要执行的完整命令，例如 `ls -la` 或 `python3 script.py`"
                }
            },
            "required": ["command"]
        })
    }

    async fn run(&self, args: &Args) -> Result<Value> {
        let command = args
            .get("command")
            .and_then(|v| v.as_str())
            .context("缺少参数 command")?
            .trim()
            .to_string();
        if command.is_empty() {
            bail!("command 不能为空");
        }

        // 用 `sh -c` 而不是自己切词：模型写出来的是给人看的 shell 语法
        // （管道、重定向、`&&`），自己切词会把它们当成普通参数，
        // 得到一个语义完全不同的命令 —— 那比不支持更危险。
        let child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(&command)
            .current_dir(self.0.root())
            .stdin(Stdio::null()) // 关掉 stdin：等输入的命令直接得到 EOF 而不是挂住
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("启动命令失败：{command}"))?;

        let out = match tokio::time::timeout(TIMEOUT, child.wait_with_output()).await {
            Ok(r) => r.with_context(|| format!("执行命令失败：{command}"))?,
            Err(_) => {
                // 超时。子进程已经被 wait_with_output 拿走了所有权，
                // 没法再 kill —— 但 stdin 是 null、并且我们不再读它的输出，
                // 它会在自己写满管道缓冲区之后停住。说明白比假装成功强。
                return Ok(json!({
                    "command": command,
                    "error": format!("命令超过 {} 秒还没结束，已放弃等待。\
                        如果它是常驻进程（server、watch 模式），换成一次性的命令。",
                        TIMEOUT.as_secs()),
                    "timed_out": true,
                }));
            }
        };

        let (stdout, out_truncated) = tail(&String::from_utf8_lossy(&out.stdout));
        let (stderr, err_truncated) = tail(&String::from_utf8_lossy(&out.stderr));

        Ok(json!({
            "command": command,
            "exit_code": out.status.code(),
            "stdout": stdout,
            "stderr": stderr,
            // 明确告诉模型截断了，否则它会把不完整的日志当成全部
            "truncated": out_truncated || err_truncated,
        }))
    }
}

pub fn register(registry: &mut ToolRegistry, ws: Arc<Workspace>) {
    registry.insert("run_command".into(), Arc::new(RunCommand(ws)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;

    fn temp_ws() -> Arc<Workspace> {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "sa-shell-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        Arc::new(Workspace::new(&dir).expect("建沙盒"))
    }

    fn args(cmd: &str) -> Args {
        let mut m = Map::new();
        m.insert("command".into(), json!(cmd));
        m
    }

    #[tokio::test]
    async fn runs_a_command_and_returns_output() {
        let t = RunCommand(temp_ws());
        let out = t.run(&args("echo hello")).await.expect("该成功");
        assert_eq!(out["exit_code"], 0);
        assert_eq!(out["stdout"].as_str().unwrap().trim(), "hello");
    }

    #[tokio::test]
    async fn runs_in_the_workspace_root() {
        // cwd 必须是沙盒根 —— 否则相对路径的命令会打到别处去
        let ws = temp_ws();
        let root = ws.root().to_path_buf();
        tokio::fs::write(root.join("marker.txt"), "x").await.unwrap();
        let out = RunCommand(ws).run(&args("ls")).await.expect("该成功");
        assert!(out["stdout"].as_str().unwrap().contains("marker.txt"));
    }

    #[tokio::test]
    async fn shell_syntax_works() {
        // 管道和 && 必须原样生效，自己切词会把它们变成普通参数
        let t = RunCommand(temp_ws());
        let out = t
            .run(&args("echo a && echo b | tr 'b' 'c'"))
            .await
            .expect("该成功");
        let s = out["stdout"].as_str().unwrap();
        assert!(s.contains('a') && s.contains('c'), "{s}");
    }

    #[tokio::test]
    async fn failure_reports_the_exit_code_instead_of_erroring() {
        // 非零退出是**正常结果**，不是工具故障 —— 模型要看到 stderr
        // 才能决定下一步，包成 Err 会让它只看到一句「执行失败」
        let t = RunCommand(temp_ws());
        let out = t.run(&args("exit 3")).await.expect("不该是 Err");
        assert_eq!(out["exit_code"], 3);
    }

    #[tokio::test]
    async fn stdin_is_closed_so_interactive_commands_do_not_hang() {
        // 等输入的命令必须立刻拿到 EOF。挂住的话整个会话卡死，
        // 而这条测试跑不完就是它挂了
        let t = RunCommand(temp_ws());
        let out = t.run(&args("cat")).await.expect("该立刻返回");
        assert_eq!(out["exit_code"], 0);
    }

    #[tokio::test]
    async fn empty_command_is_rejected() {
        let t = RunCommand(temp_ws());
        assert!(t.run(&args("   ")).await.is_err());
    }

    #[test]
    fn tail_keeps_the_end_and_respects_char_boundaries() {
        // 保尾：命令的结论在最后。切在字符中间会 panic，所以也测中文
        let long = "中".repeat(MAX_OUTPUT);
        let (s, truncated) = tail(&long);
        assert!(truncated);
        assert!(s.len() <= MAX_OUTPUT);
        assert!(s.ends_with('中'));

        let (s, truncated) = tail("short");
        assert!(!truncated);
        assert_eq!(s, "short");
    }

    #[test]
    fn run_command_is_covered_by_the_approval_list() {
        // 这是三层约束里最关键的一层。名字改了就静默失去审批
        assert!(crate::approval::needs_approval("run_command"));
    }
}
