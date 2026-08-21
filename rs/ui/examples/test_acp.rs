// ============================================================================
// test_acp.rs —— 手动测试 ACP provider
// ----------------------------------------------------------------------------
// 单元测试需要 SDK 的 in-process 模式（2.0 已移除），所以改成手动例子。
// 运行方式：
//   cargo run -p smallest-agent-ui --example test_acp
//
// 前置条件：
//   1. 配好 ANTHROPIC_API_KEY
//   2. 有 npx（测试用的是官方 claude-agent-acp 适配器）
// ============================================================================

use std::path::PathBuf;
use std::sync::Arc;

use smallest_agent_core::approval::ApproveAll;
use smallest_agent_core::cancel::CancelToken;
use smallest_agent_core::provider::{AcpProvider, AcpSpec, Provider, TurnEvent, TurnRequest};

fn main() -> anyhow::Result<()> {
    // smol 已经在 ui 的依赖里，用它的 block_on
    smol::block_on(async {
        // 建一个 ACP provider，用官方的 claude-agent-acp 适配器
        let spec = AcpSpec::claude_code(PathBuf::from("/tmp"));
        let provider = AcpProvider::new(spec).with_approver(Arc::new(ApproveAll));

        println!("🚀 测试 ACP provider");
        println!("Provider: {}", provider.name());
        println!("manages_own_tools: {}", provider.manages_own_tools());
        println!();

        // 发一轮简单问题
        let question = "现在几点了？直接告诉我时间就行，不要调用工具。";
        println!("❓ 问题：{}", question);
        println!();

        let cancel = CancelToken::new();
        let events = Arc::new(|ev: TurnEvent| match ev {
            TurnEvent::Delta(s) => print!("{}", s),
            TurnEvent::ToolCall { name, .. } => println!("\n🔧 工具调用：{}", name),
            TurnEvent::Fallback(msg) => println!("\n⚠️  降级：{}", msg),
            TurnEvent::CacheHit => println!("\n💾 缓存命中"),
            TurnEvent::Notice(msg) => println!("\n💬 {}", msg),
        });

        let req = TurnRequest::new(question, events, cancel);

        match provider.run_turn(req).await {
            Ok(answer) => {
                println!("\n");
                println!("✅ 回答完毕");
                println!("最终答案：{}", answer);
            }
            Err(e) => {
                println!("\n❌ 出错：{:#}", e);
                return Err(e);
            }
        }

        Ok(())
    })
}
