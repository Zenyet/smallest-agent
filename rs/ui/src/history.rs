// ============================================================================
// history.rs —— 把磁盘上的会话历史还原成界面消息
// ----------------------------------------------------------------------------
// 单独一个文件的两个理由：
//
//   1. **能测**。这是纯函数（Message 进、SessionChat 出），不需要 gpui
//      的 Window/Context。放在 chat.rs 里的话测试要连带那一大堆 UI 状态。
//   2. chat.rs 已经三千行了，而 `#[test]` 的宏展开在那个规模上会撞到
//      rustc 的 recursion limit（实测报错 "recursion limit reached while
//      expanding #[test]"）。拆出来两个问题一起解决。
//
// ## 这个文件修的是什么
//
// 原来的 hydrate 把工具调用整个丢掉了 —— 磁盘上明明存着（Message 的
// serde 标注一直带着 tool_calls 和 Tool 变体），但重开 app 之后历史里
// 只剩正文，「它当时干了什么」全没了。
//
// 当时的理由写在注释里：「turn 信息在持久化时没保留，硬凑一个会显示错的
// 轮次」。那个顾虑是对的，但结论下早了：turn 不需要存，见 hydrate 的注释。
// ============================================================================

use smallest_agent_core::types::Message;

use crate::chat::{DisplayMessage, Role, SessionChat, ToolTrace};

/// 把磁盘上的历史消息铺成界面消息。
///
/// ## turn 号是**重建**出来的，不是存下来的
///
/// 原来这里把工具调用整个丢掉了，注释的理由是「turn 信息在持久化时
/// 没保留，硬凑一个会显示错的轮次」。那个顾虑是对的，但结论下早了 ——
/// turn 不用存，它由消息顺序唯一决定：
///
///   agent 循环每转一圈，push 一条带 tool_calls 的 Assistant，
///   紧跟着 push 那一批 Tool 结果（见 core/agent.rs 的 messages.push）。
///
/// 所以「一条带 tool_calls 的 Assistant + 它后面紧跟的那批 Tool」
/// 就是一轮，数它出现第几次就是 turn 号。这跟运行时那个计数器一致。
///
/// ## 为什么工具调用要挂在**后面**那条 assistant 上
///
/// 界面上工具轨迹画在正文上方（见 render_message），表达的是
/// 「为了答这句话，我先做了这些」。而磁盘上的顺序是
/// 「带 tool_calls 的 assistant → tool 结果 → 最终回答的 assistant」，
/// 中间那条 assistant 的 content 通常是空的（模型那一轮只调工具没说话）。
///
/// 所以要把工具攒着，等遇到**有正文的** assistant 时一起交给它。
/// 攒的东西在轮次结束时没等到正文（被中断了）也要落地，否则那几次
/// 调用会静默消失 —— 见函数末尾那个 flush。
pub fn hydrate(history: &[Message], times: &[u64]) -> SessionChat {
    let mut chat = SessionChat::default();
    // 待归属的工具轨迹，等一条有正文的 assistant 来收
    let mut pending: Vec<ToolTrace> = Vec::new();
    // 已经开了几轮工具调用。turn 从 1 开始，和运行时一致
    let mut turn: u32 = 0;
    // tool_call_id → (轮次, 工具名, 参数)。Tool 消息只带 id，
    // 名字和参数在前面那条 Assistant 的 tool_calls 里
    let mut calls: std::collections::BTreeMap<String, (u32, String, String)> =
        std::collections::BTreeMap::new();

    for (idx, m) in history.iter().enumerate() {
        match m {
            Message::User { content } => {
                // 用户消息前先把没归属的工具落地，否则它们会跨到
                // 下一轮对话里去
                flush_pending(&mut chat, &mut pending);
                chat.messages.push(DisplayMessage {
                    role: Role::User,
                    text: content.clone(),
                    tools: Vec::new(),
                    streaming: false,
                    cache_hit: false,
                    interrupted: false,
                    at: times.get(idx).copied().unwrap_or(0),
                });
            }
            Message::Assistant {
                content,
                tool_calls,
            } => {
                if !tool_calls.is_empty() {
                    // 新一轮工具调用
                    turn += 1;
                    for c in tool_calls {
                        // args 存的是 Map，显示成紧凑 JSON —— 和运行时
                        // ToolTrace.args 的形状对齐（那边也是序列化后的字符串）
                        let args = serde_json::to_string(&c.args).unwrap_or_default();
                        calls.insert(c.id.clone(), (turn, c.name.clone(), args));
                    }
                }
                if !content.is_empty() {
                    // 有正文：这条就是「答案」，把攒着的工具挂给它
                    chat.messages.push(DisplayMessage {
                        role: Role::Assistant,
                        text: content.clone(),
                        tools: std::mem::take(&mut pending),
                        streaming: false,
                        interrupted: false,
                        cache_hit: false,
                        at: times.get(idx).copied().unwrap_or(0),
                    });
                }
            }
            Message::Tool {
                content,
                tool_call_id,
                name,
            } => {
                // 用 id 找回这次调用的轮次和参数。找不到的话（历史被
                // 手改过、或者上游丢了那条 assistant）仍然显示出来，
                // 只是参数空着 —— 比整条丢掉好，用户至少知道调过什么
                let (t, n, args) = calls.remove(tool_call_id).unwrap_or_else(|| {
                    (turn.max(1), name.clone(), String::new())
                });
                pending.push(ToolTrace {
                    turn: t,
                    name: n,
                    args,
                    output: content.clone(),
                });
            }
            // System 不显示：它是我们注入的，不是对话内容
            Message::System { .. } => {}
        }
    }
    // 收尾：最后一轮只有工具没有正文（被中断、或者存盘时正好在那个点）
    flush_pending(&mut chat, &mut pending);
    chat
}

/// 把没等到正文的工具轨迹落成一条独立的 assistant 消息。
///
/// 没有这一步的话，「调了工具但还没来得及回答就被中断」那一轮
/// 会在历史里彻底消失 —— 而那正是用户最想回看的情况之一
/// （「我上次让它干到哪儿了？」）。
fn flush_pending(chat: &mut SessionChat, pending: &mut Vec<ToolTrace>) {
    if pending.is_empty() {
        return;
    }
    chat.messages.push(DisplayMessage {
        role: Role::Assistant,
        text: String::new(),
        tools: std::mem::take(pending),
        streaming: false,
        // 这条是补出来的（那一轮只有工具没有正文），磁盘上没有
        // 对应的消息下标，所以拿不到时间。0 = 不显示时间
        at: 0,
        // 有工具没正文 = 那一轮没说完。标成中断，界面会加「已停止」，
        // 否则一个空气泡看着像 bug
        interrupted: true,
        cache_hit: false,
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    use smallest_agent_core::types::ToolCall;

    fn tool_call(id: &str, name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            args: args.as_object().cloned().unwrap_or_default(),
        }
    }

    /// 一轮完整的工具调用：assistant 声明 → tool 结果 → assistant 给答案。
    /// 这就是 core/agent.rs 往 messages 里 push 的真实顺序。
    fn one_turn_history() -> Vec<Message> {
        vec![
            Message::User {
                content: "看看有什么文件".into(),
            },
            Message::Assistant {
                content: String::new(),
                tool_calls: vec![tool_call("c1", "list_directory", serde_json::json!({"path": "."}))],
            },
            Message::Tool {
                content: r#"{"entries":[]}"#.into(),
                tool_call_id: "c1".into(),
                name: "list_directory".into(),
            },
            Message::Assistant {
                content: "目录是空的".into(),
                tool_calls: vec![],
            },
        ]
    }

    #[test]
    fn tool_calls_survive_a_reload() {
        // 这是这次要修的核心问题：工具调用记录本来在磁盘上，
        // 但 hydrate 把它们丢了，重开 app 之后历史里只剩正文。
        let chat = hydrate(&one_turn_history(), &[]);
        assert_eq!(chat.messages.len(), 2, "用户一条 + 助手一条");

        let answer = &chat.messages[1];
        assert_eq!(answer.text, "目录是空的");
        assert_eq!(answer.tools.len(), 1, "工具调用该跟着答案一起还原");
        assert_eq!(answer.tools[0].name, "list_directory");
        // 参数也要还原 —— 只有名字的话看不出它到底做了什么
        assert!(answer.tools[0].args.contains("path"), "args={}", answer.tools[0].args);
        assert!(answer.tools[0].output.contains("entries"));
    }

    #[test]
    fn turn_numbers_are_rebuilt_from_message_order() {
        // hydrate 原来的注释说「turn 信息在持久化时没保留」所以放弃了。
        // 这条锁住的是：turn 不用存，它由消息顺序唯一决定。
        let mut h = one_turn_history();
        // 再来一轮
        h.push(Message::Assistant {
            content: String::new(),
            tool_calls: vec![tool_call("c2", "read_file", serde_json::json!({"path": "a.md"}))],
        });
        h.push(Message::Tool {
            content: r#"{"content":"hi"}"#.into(),
            tool_call_id: "c2".into(),
            name: "read_file".into(),
        });
        h.push(Message::Assistant {
            content: "读到了".into(),
            tool_calls: vec![],
        });

        let chat = hydrate(&h, &[]);
        let first = &chat.messages[1].tools[0];
        let second = &chat.messages[2].tools[0];
        assert_eq!(first.turn, 1);
        assert_eq!(second.turn, 2, "第二轮该是 turn 2，不是又一个 1");
        // 分组靠 turn，两轮不能被并成一组
        assert_ne!(first.turn, second.turn);
    }

    #[test]
    fn parallel_calls_in_one_turn_share_a_turn_number() {
        // 同一轮里模型可以一次要调好几个工具。它们必须是同一个 turn，
        // 否则界面上会显示成「本轮 1 次」重复三遍
        let h = vec![
            Message::User { content: "并行".into() },
            Message::Assistant {
                content: String::new(),
                tool_calls: vec![
                    tool_call("a", "read_file", serde_json::json!({"path": "1"})),
                    tool_call("b", "read_file", serde_json::json!({"path": "2"})),
                ],
            },
            Message::Tool {
                content: "{}".into(),
                tool_call_id: "a".into(),
                name: "read_file".into(),
            },
            Message::Tool {
                content: "{}".into(),
                tool_call_id: "b".into(),
                name: "read_file".into(),
            },
            Message::Assistant {
                content: "都读完了".into(),
                tool_calls: vec![],
            },
        ];
        let chat = hydrate(&h, &[]);
        let tools = &chat.messages[1].tools;
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].turn, tools[1].turn, "同一轮的并行调用该同号");
    }

    #[test]
    fn a_denied_call_is_distinguishable_from_a_failure() {
        // 「我不让它做」和「它做了但失败了」在 output 里都是 {"error":...}，
        // 回看历史时必须能分出来
        let denied = ToolTrace {
            turn: 1,
            name: "write_file".into(),
            args: String::new(),
            output: r#"{"error":"用户拒绝了这个操作","denied":true}"#.into(),
        };
        let failed = ToolTrace {
            turn: 1,
            name: "write_file".into(),
            args: String::new(),
            output: r#"{"error":"磁盘满了"}"#.into(),
        };
        assert!(denied.denied());
        assert!(failed.failed() && !failed.denied());
        // 拒绝的也算 failed（它确实没成功），界面靠 denied() 优先判断
        assert!(denied.failed());
    }

    #[test]
    fn an_interrupted_turn_still_shows_its_tools() {
        // 调了工具但没来得及回答就被中断 —— 这一轮不能从历史里消失，
        // 那正是用户最想回看的情况（「上次干到哪儿了」）
        let h = vec![
            Message::User { content: "跑一下".into() },
            Message::Assistant {
                content: String::new(),
                tool_calls: vec![tool_call("c1", "run_command", serde_json::json!({"command": "ls"}))],
            },
            Message::Tool {
                content: r#"{"exit_code":0}"#.into(),
                tool_call_id: "c1".into(),
                name: "run_command".into(),
            },
            // 没有收尾的 assistant
        ];
        let chat = hydrate(&h, &[]);
        assert_eq!(chat.messages.len(), 2, "该补出一条承载工具的助手消息");
        let last = &chat.messages[1];
        assert_eq!(last.tools.len(), 1);
        assert!(last.interrupted, "没说完的那轮该标成已停止，否则是个空气泡");
    }

    #[test]
    fn tools_do_not_leak_across_user_messages() {
        // 上一轮没归属的工具不能跨到下一次提问里去
        let h = vec![
            Message::User { content: "第一问".into() },
            Message::Assistant {
                content: String::new(),
                tool_calls: vec![tool_call("c1", "read_file", serde_json::json!({}))],
            },
            Message::Tool {
                content: "{}".into(),
                tool_call_id: "c1".into(),
                name: "read_file".into(),
            },
            Message::User { content: "第二问".into() },
            Message::Assistant {
                content: "答第二问".into(),
                tool_calls: vec![],
            },
        ];
        let chat = hydrate(&h, &[]);
        // 最后那条答案不该背着第一问的工具
        let last = chat.messages.last().unwrap();
        assert_eq!(last.text, "答第二问");
        assert!(last.tools.is_empty(), "工具串台了");
    }

    #[test]
    fn system_messages_are_not_shown() {
        // 系统提示是我们注入的，不是对话内容
        let h = vec![
            Message::System { content: "你是助手".into() },
            Message::User { content: "hi".into() },
        ];
        let chat = hydrate(&h, &[]);
        assert_eq!(chat.messages.len(), 1);
        assert_eq!(chat.messages[0].text, "hi");
    }

    #[test]
    fn an_orphan_tool_result_is_still_shown() {
        // 历史被手改过、或者上游丢了那条 assistant —— 仍然要显示，
        // 只是参数空着。整条丢掉的话用户不知道调过什么
        let h = vec![
            Message::Tool {
                content: r#"{"ok":1}"#.into(),
                tool_call_id: "missing".into(),
                name: "read_file".into(),
            },
        ];
        let chat = hydrate(&h, &[]);
        assert_eq!(chat.messages.len(), 1);
        assert_eq!(chat.messages[0].tools.len(), 1);
        assert_eq!(chat.messages[0].tools[0].name, "read_file");
    }
}

