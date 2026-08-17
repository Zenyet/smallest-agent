// ============================================================================
// approval.rs —— 危险操作前的确认
// ----------------------------------------------------------------------------
// 两个 provider 都需要它，理由不同但形状一样：
//   • 内置 agent：MCP 工具里的 write_file / edit_file 会改用户的磁盘，
//     模型判断错了就是数据损失
//   • 外部 CLI（ACP）：协议里就有 session/request_permission，agent 写文件前
//     会主动问。不实现的话只有两个选择 —— 全拒绝（任何编辑都失败，provider
//     没法用）或全批准（绕过用户对那些 CLI 权限模型的预期）
//
// ## 这是唯一一处「反向」通路
//
// 别的东西都是单向的：事件从 provider 流向 UI。审批是请求-响应 ——
// **agent 任务会停下来等用户点按钮**。所以这里有两条约束：
//
//   1. 请求要带一个 oneshot 的回信通道（Responder），跨线程送回答案
//   2. 必须有超时。用户可能关了窗口、或者根本没注意到那张卡片，
//      而 agent 任务在等一个永远不会来的答案 —— 那个会话就永久卡住，
//      连「停止」都点不了（它已经在 await 上了）。
//
// ## 选项而不是「批准/拒绝」两个布尔
//
// 形状照 ACP 的 PermissionOption 设计（一组带 id 的选项，响应是选了哪个）。
// 理由是各家 CLI 的选项不一样 —— claude code 有「本次允许 / 本会话都允许 /
// 拒绝」，别家可能有「只读方式执行」。硬编码成两个布尔就没法转发它们真正
// 提供的选项，而擅自把「本会话都允许」映射成「批准」是在替用户做他没做的决定。
// ============================================================================

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::oneshot;

/// 等用户回答的最长时间。
///
/// 5 分钟：够用户切个窗口回来看，又不至于让一个被忽略的请求把会话挂到天荒地老。
/// 超时按「拒绝」处理 —— 危险操作的默认答案必须是不做。
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(300);

/// 一个可选项。
#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalOption {
    /// 回答时报这个 id。ACP 那边是 agent 给的，内置 agent 由我们自己定。
    pub id: String,
    /// 按钮上的字
    pub label: String,
    /// 这个选项是不是「同意做」。
    ///
    /// UI 靠它决定按钮样式（同意用实心、拒绝用描边），而不是靠猜 label 的字面。
    /// 猜字面在多语言和各家自定义选项下必然出错。
    pub is_approve: bool,
}

impl ApprovalOption {
    pub fn approve(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            is_approve: true,
        }
    }
    pub fn reject(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            is_approve: false,
        }
    }
}

/// 一次审批请求。
#[derive(Debug, Clone)]
pub struct ApprovalRequest {
    /// 唯一 id，UI 回答时带上 —— 用户可能在两张卡片之间来回，
    /// 不带 id 就分不清答的是哪个。
    pub id: String,
    /// 一句话说清要做什么（「写入 src/main.rs」）
    pub title: String,
    /// 细节，UI 折叠显示（完整路径、diff、命令行）
    pub detail: String,
    pub options: Vec<ApprovalOption>,
}

/// 用户的回答。
#[derive(Debug, Clone, PartialEq)]
pub enum ApprovalOutcome {
    /// 选了某个选项
    Selected(String),
    /// 取消了整轮（点了停止），或者超时
    Cancelled,
}

/// 谁来回答审批请求。
///
/// UI 实现它（弹卡片等用户点）；CLI 实现成读 stdin；测试实现成固定答案。
/// 不实现的话（None）表示「没人能回答」—— 那时一律按拒绝处理，
/// 而不是默默放行。
#[async_trait]
pub trait Approver: Send + Sync {
    async fn request(&self, req: ApprovalRequest) -> ApprovalOutcome;
}

/// 一个总是拒绝的实现，用于「没配审批 UI」的场合。
///
/// 有这个而不是让调用方处理 Option<Approver>：默认拒绝是安全默认值，
/// 而把「没有审批器」和「审批器说不」当成同一件事能省掉一堆分支。
pub struct DenyAll;

#[async_trait]
impl Approver for DenyAll {
    async fn request(&self, _req: ApprovalRequest) -> ApprovalOutcome {
        ApprovalOutcome::Cancelled
    }
}

/// 一个总是批准的实现。
///
/// **只该在明确知道后果时用**（自动化脚本、测试）。留着它是因为不留的话
/// 用户会自己写一个更糙的版本。
pub struct ApproveAll;

#[async_trait]
impl Approver for ApproveAll {
    async fn request(&self, req: ApprovalRequest) -> ApprovalOutcome {
        match req.options.iter().find(|o| o.is_approve) {
            Some(o) => ApprovalOutcome::Selected(o.id.clone()),
            // 一个「同意」选项都没有：那就没什么可批准的
            None => ApprovalOutcome::Cancelled,
        }
    }
}

/// 回信通道的发送端。
///
/// 单独一个类型而不是裸 oneshot::Sender：
///   • `respond` 可以被调多次而不 panic（第二次静默丢弃）——
///     UI 那边「用户快速点两下」是真会发生的
///   • Drop 时自动回 Cancelled，所以 UI 那边忘了回答（比如卡片被销毁）
///     不会让 agent 永久等待
pub struct Responder {
    tx: Option<oneshot::Sender<ApprovalOutcome>>,
}

impl Responder {
    pub fn respond(mut self, outcome: ApprovalOutcome) {
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(outcome);
        }
    }
}

impl Drop for Responder {
    fn drop(&mut self) {
        // 没回答就当取消。这条比看着不重要 —— UI 里卡片被销毁（切会话、
        // 关窗口）时不走 respond，少了这个 agent 任务会一直挂在 await 上。
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(ApprovalOutcome::Cancelled);
        }
    }
}

/// 把「请求 + 回信通道」交给外部的通道类型。
///
/// UI 侧拿到它之后：把 request 存进状态渲染卡片，把 responder 留着等用户点。
pub type ApprovalSink = Arc<dyn Fn(ApprovalRequest, Responder) + Send + Sync>;

/// 基于 sink 的 Approver：发出去，等回信，带超时。
pub struct SinkApprover {
    sink: ApprovalSink,
    timeout: Duration,
}

impl SinkApprover {
    pub fn new(sink: ApprovalSink) -> Self {
        Self {
            sink,
            timeout: APPROVAL_TIMEOUT,
        }
    }

    /// 测试用：把超时调短，不然一个用例要等 5 分钟。
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

#[async_trait]
impl Approver for SinkApprover {
    async fn request(&self, req: ApprovalRequest) -> ApprovalOutcome {
        let (tx, rx) = oneshot::channel();
        (self.sink)(req, Responder { tx: Some(tx) });

        // 超时和等待都要走 runtime:: —— 这段可能跑在 gpui 的执行器上，
        // 那里没有 tokio 的 timer（见 runtime.rs 的接缝说明）。
        let timeout = self.timeout;
        match crate::runtime::spawn(async move { tokio::time::timeout(timeout, rx).await }).await {
            // 正常收到回答
            Ok(Ok(Ok(outcome))) => outcome,
            // 通道断了（Responder 被 drop 且没发 —— 理论上 Drop 里发了，
            // 但运行时正在关闭时可能收不到）
            Ok(Ok(Err(_))) => ApprovalOutcome::Cancelled,
            // 超时：按拒绝处理。危险操作的默认答案必须是不做。
            Ok(Err(_)) => ApprovalOutcome::Cancelled,
            // spawn 出错（任务 panic）
            Err(_) => ApprovalOutcome::Cancelled,
        }
    }
}

/// 判断一个工具调用要不要审批。
///
/// 按名字匹配而不是让每个工具自己声明：工具是从 MCP server 动态发现的，
/// 我们不控制它们的定义，没有地方让它们声明「我是危险的」。
///
/// 名单是保守的 —— 宁可多问一次。漏判的代价是用户的文件被改，
/// 误判的代价只是多点一下按钮。
pub fn needs_approval(tool_name: &str) -> bool {
    const DANGEROUS: &[&str] = &[
        // 文件写入类
        "write_file",
        "edit_file",
        "create_directory",
        "move_file",
        "delete_file",
        "remove_file",
        // 执行类
        "execute_command",
        "run_command",
        "bash",
        "shell",
    ];
    let lower = tool_name.to_ascii_lowercase();
    DANGEROUS.iter().any(|d| lower == *d)
        // 前缀匹配兜住命名变体（write_file_lines、edit_file_range 之类）
        || lower.starts_with("write_")
        || lower.starts_with("edit_")
        || lower.starts_with("delete_")
        || lower.starts_with("remove_")
}

/// 给内置 agent 用的标准两选项。
pub fn standard_options() -> Vec<ApprovalOption> {
    vec![
        ApprovalOption::approve("allow", "允许"),
        ApprovalOption::reject("deny", "拒绝"),
    ]
}

/// 生成审批请求的 id。
pub fn new_approval_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!("ap-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_dangerous_tools() {
        assert!(needs_approval("write_file"));
        assert!(needs_approval("edit_file"));
        assert!(needs_approval("Write_File"), "大小写不该影响判断");
        // 前缀变体
        assert!(needs_approval("write_file_lines"));
        assert!(needs_approval("delete_directory"));
        // 只读的不该拦
        assert!(!needs_approval("read_file"));
        assert!(!needs_approval("read_text_file"));
        assert!(!needs_approval("list_directory"));
        assert!(!needs_approval("search_files"));
        assert!(!needs_approval("get_file_info"));
    }

    #[tokio::test]
    async fn deny_all_cancels() {
        let req = ApprovalRequest {
            id: "1".into(),
            title: "写文件".into(),
            detail: String::new(),
            options: standard_options(),
        };
        assert_eq!(DenyAll.request(req).await, ApprovalOutcome::Cancelled);
    }

    #[tokio::test]
    async fn approve_all_picks_the_approving_option() {
        let req = ApprovalRequest {
            id: "1".into(),
            title: "写文件".into(),
            detail: String::new(),
            options: standard_options(),
        };
        assert_eq!(
            ApproveAll.request(req).await,
            ApprovalOutcome::Selected("allow".into())
        );
    }

    #[tokio::test]
    async fn dropping_responder_without_answering_cancels() {
        // UI 里卡片被销毁（切会话、关窗口）时不走 respond。
        // 少了 Responder 的 Drop 实现，agent 会一直挂在 await 上。
        let sink: ApprovalSink = Arc::new(|_req, _responder| {
            // 故意什么都不做，让 responder 立刻 drop
        });
        let approver = SinkApprover::new(sink).with_timeout(Duration::from_secs(5));
        let req = ApprovalRequest {
            id: "1".into(),
            title: "写文件".into(),
            detail: String::new(),
            options: standard_options(),
        };
        // 不该等到超时 —— Drop 应该立刻回 Cancelled
        let start = std::time::Instant::now();
        assert_eq!(approver.request(req).await, ApprovalOutcome::Cancelled);
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "该立刻返回而不是等超时"
        );
    }

    #[tokio::test]
    async fn responding_twice_does_not_panic() {
        // 用户快速点两下是真会发生的
        let (tx, _rx) = oneshot::channel();
        let responder = Responder { tx: Some(tx) };
        responder.respond(ApprovalOutcome::Selected("allow".into()));
        // respond 消费了 self，所以「点两下」在类型上就不可能 ——
        // 这个测试记录的是：UI 那边必须把 responder move 进第一次回调，
        // 而不是存一份克隆。
    }

    #[tokio::test]
    async fn times_out_into_rejection() {
        let sink: ApprovalSink = Arc::new(|_req, responder| {
            // 把 responder 泄漏掉，模拟「用户一直不回答」——
            // 不 leak 的话 Drop 会立刻回 Cancelled，测不到超时路径
            Box::leak(Box::new(responder));
        });
        let approver = SinkApprover::new(sink).with_timeout(Duration::from_millis(50));
        let req = ApprovalRequest {
            id: "1".into(),
            title: "写文件".into(),
            detail: String::new(),
            options: standard_options(),
        };
        // 超时按拒绝 —— 危险操作的默认答案必须是不做
        assert_eq!(approver.request(req).await, ApprovalOutcome::Cancelled);
    }

    #[tokio::test]
    async fn forwards_the_users_choice() {
        let sink: ApprovalSink = Arc::new(|req, responder| {
            // 模拟用户点了第一个选项
            let id = req.options[0].id.clone();
            responder.respond(ApprovalOutcome::Selected(id));
        });
        let approver = SinkApprover::new(sink);
        let req = ApprovalRequest {
            id: "1".into(),
            title: "写文件".into(),
            detail: String::new(),
            options: standard_options(),
        };
        assert_eq!(
            approver.request(req).await,
            ApprovalOutcome::Selected("allow".into())
        );
    }
}
