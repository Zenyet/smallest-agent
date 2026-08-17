// ============================================================================
// provider.rs —— 「一轮对话由谁来跑」的抽象
// ----------------------------------------------------------------------------
// 到目前为止 UI 直接调 run_agent，也就是把「内置 agent」这一种实现写死了。
// 这个 trait 把它变成两种之一：
//
//   • BuiltinProvider —— 本仓库自己实现的 ReAct 循环（agent.rs）
//   • AcpProvider    —— 驱动外部 agent CLI（claude code / codex / opencode…），
//                       走 ACP 协议，模型逻辑在别人进程里
//
// 这是「C 方案」的承重结构：两者并列而不是取代，因为它们的价值不同 ——
// 内置 agent 是一份能读懂的最小实现（那套教学注释是资产），
// 外部 CLI 是「一个界面管所有 agent」的实用价值。
//
// ## 为什么事件要改成推送到 sink，而不是保留原来的回调
//
// 原来 core 用两个独立回调：OnText（流式文字）和 on_turn（工具轨迹），
// UI 的 bridge 再把它们转成一条 channel 的事件流。这套在只有内置 agent 时够用，
// 但 ACP 那边天生就是一条通知流（session/update），硬拆成两个回调是反着来的。
//
// 所以统一成「一个 sink 收所有事件」。sink 是 Fn 而不是 channel：
// core 是库，不该规定用哪个 channel 实现（UI 用 smol 的，CLI 直接打 stdout，
// 测试用 Vec）。
// ============================================================================

pub mod acp;
pub mod builtin;

use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;

use crate::cancel::CancelToken;
use crate::types::{Args, Message};

/// 一轮对话过程中发生的事。
///
/// 两种 provider 都产出这些。ACP 那边的 session/update 通知会被翻译成这里的变体，
/// 内置 agent 则由 run_agent 的钩子转过来。
#[derive(Debug, Clone)]
pub enum TurnEvent {
    /// 流式文本增量，逐 token 到达
    Delta(String),
    /// 一个工具跑完了
    ToolCall {
        /// 第几轮（ReAct 的圈数）。ACP 那边没有这个概念，填 0。
        turn: u32,
        name: String,
        args: Args,
        output: String,
    },
    /// 缓存命中，这一轮没联网。只有内置 provider 会发。
    CacheHit,
    /// 降级到备用模型。只有内置 provider 会发。
    Fallback(String),
    /// provider 想说一句话（连接状态、模型切换之类），UI 显示成提示行。
    ///
    /// 有这个变体是因为外部 CLI 会报告一些内置 agent 没有的状态
    /// （「正在认证」「切换到 opus」），不该为每种都加一个变体。
    Notice(String),
}

/// 事件接收端。
///
/// **注意它可能在任意线程上被调用** —— 内置 provider 的流式回调跑在专用运行时的
/// 工作线程上，ACP 的通知跑在读子进程 stdout 的任务里。所以实现里不能碰
/// UI 状态，只能往 channel 发或者写日志。
pub type EventSink = Arc<dyn Fn(TurnEvent) + Send + Sync>;

/// 跑一轮需要的东西。
///
/// 打包成结构体而不是一串参数：字段会随 provider 种类增加（ACP 要 cwd、
/// 要权限模式），位置参数迟早排到七八个。
pub struct TurnRequest {
    pub question: String,
    /// 之前的对话。
    ///
    /// 内置 provider 每轮都把完整历史发给模型（无状态）；ACP 那边 CLI 自己
    /// 维护会话，所以只在**新建会话**时需要它。两种语义不同，但都要这个字段。
    pub history: Vec<Message>,
    pub events: EventSink,
    pub cancel: CancelToken,
}

/// 「谁来跑这一轮」。
#[async_trait]
pub trait Provider: Send + Sync {
    /// 显示名，UI 上给用户选的时候用。
    fn name(&self) -> &str;

    /// 这个 provider 支不支持工具。
    ///
    /// 内置的支持（走 MCP）；外部 CLI 自己管工具，我们既不知道它有哪些、
    /// 也不该替它配 —— UI 靠这个决定要不要显示工具状态那一行。
    fn manages_own_tools(&self) -> bool {
        false
    }

    /// 跑一轮，返回最终答案。
    ///
    /// 过程中的事件推给 req.events。取消靠 req.cancel ——
    /// 两种实现的取消方式不同（内置是 abort HTTP，ACP 是发 session/cancel），
    /// 但对调用方是同一个语义。
    async fn run_turn(&self, req: TurnRequest) -> Result<String>;
}

/// Arc 转发，理由同 types.rs 里 CallModel 那几个：
/// UI 把 provider 存成 Arc<dyn Provider>，而有些地方要泛型接收。
#[async_trait]
impl<T: Provider + ?Sized> Provider for Arc<T> {
    fn name(&self) -> &str {
        (**self).name()
    }
    fn manages_own_tools(&self) -> bool {
        (**self).manages_own_tools()
    }
    async fn run_turn(&self, req: TurnRequest) -> Result<String> {
        (**self).run_turn(req).await
    }
}

pub use acp::{AcpProvider, AcpSpec};
pub use builtin::BuiltinProvider;
