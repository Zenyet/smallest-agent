// ============================================================================
// provider/builtin.rs —— 内置 agent 作为一个 Provider
// ----------------------------------------------------------------------------
// 把 agent.rs 的 ReAct 循环包成 Provider。这一层只做两件事：
//   1. 装配那摞装饰器（HTTP → 降级 → 重试 → 缓存），每轮重新绑取消令牌
//   2. 把 run_agent 的两个回调（on_text / on_turn）转成统一的 TurnEvent 流
//
// 装配逻辑从 UI 挪到这里，原因是它属于「内置 provider 怎么工作」这个知识，
// 不属于界面。UI 之前那份 build_stack 里有一段专门解释「为什么基座和装饰器
// 要分两层建」，那个论证跟着搬过来了。
// ============================================================================

use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;

use crate::agent::{AgentDeps, Compact, OnComplete, TurnInfo, run_agent};
use crate::approval::{Approver, DenyAll};
use crate::cache::{Cached, DiskCache};
use crate::cancel::CancelToken;
use crate::llm::HttpCallModel;
use crate::provider::{Provider, TurnEvent, TurnRequest};
use crate::resilience::{Retrying, WithFallback};
use crate::types::{AgentConfig, CallModel, Config, ToolRegistry};

/// 内置 agent。
pub struct BuiltinProvider {
    config: Config,
    /// HTTP 基座 —— 建它贵（reqwest 的连接池），所以只建一次。
    ///
    /// 每轮 clone 它并绑上新的取消令牌（with_cancel 取 &self 就是为这个），
    /// 这样连接池能复用，而令牌保持「一轮一个」。直接每轮重建的话
    /// 每次对话都要重新 TLS 握手。
    base: HttpCallModel,
    tools: ToolRegistry,
    compact: Option<Arc<dyn Compact>>,
    on_complete: Option<Arc<dyn OnComplete>>,
    /// 危险工具执行前问谁。默认拒绝 —— 安全默认值。
    approver: Arc<dyn Approver>,
}

impl BuiltinProvider {
    pub fn new(config: Config, tools: ToolRegistry) -> Result<Self> {
        let base = HttpCallModel::new(&config, tools.clone())?;
        Ok(Self {
            config,
            base,
            tools,
            compact: None,
            on_complete: None,
            approver: Arc::new(DenyAll),
        })
    }

    pub fn with_compact(mut self, compact: Arc<dyn Compact>) -> Self {
        self.compact = Some(compact);
        self
    }

    pub fn with_on_complete(mut self, on_complete: Arc<dyn OnComplete>) -> Self {
        self.on_complete = Some(on_complete);
        self
    }

    pub fn with_approver(mut self, approver: Arc<dyn Approver>) -> Self {
        self.approver = approver;
        self
    }

    /// 工具变了要重建基座：注册表被烤进了请求体构造里
    /// （HttpCallModel 持有它），不重建的话模型看不到新工具。
    ///
    /// MCP server 是后台异步连的，连上时界面已经起来了，所以这个方法必须存在。
    pub fn set_tools(&mut self, tools: ToolRegistry) -> Result<()> {
        self.base = HttpCallModel::new(&self.config, tools.clone())?;
        self.tools = tools;
        Ok(())
    }

    pub fn tools(&self) -> &ToolRegistry {
        &self.tools
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    /// 把四层装饰器叠起来。便宜，每轮调一次。
    ///
    /// 层序有语义：重试包在降级**外面**，所以是「主模型重试到用尽才降级」。
    /// 反过来包会变成「主模型一失败就降级，降级完的整体再重试」。
    fn build_stack(
        &self,
        cancel: CancelToken,
        events: &crate::provider::EventSink,
    ) -> Result<Arc<dyn CallModel>> {
        let on_text = {
            let events = events.clone();
            Arc::new(move |delta: &str| events(TurnEvent::Delta(delta.to_string())))
        };
        let primary = self.base.with_cancel(cancel).with_on_text(on_text);
        let fallback = primary.with_model(&self.config.fallback_model);

        let with_fallback = {
            let events = events.clone();
            WithFallback::new(primary, fallback)
                .with_on_fallback(move |err| events(TurnEvent::Fallback(format!("{err:#}"))))
        };
        let retrying = Retrying::new(with_fallback).with_retries(self.config.max_retries);

        if !self.config.cache_enabled {
            return Ok(Arc::new(retrying));
        }
        let cache = DiskCache::new(&self.config.cache_dir)?;
        let events = events.clone();
        Ok(Arc::new(
            Cached::new(retrying, Box::new(cache), self.config.model.clone())
                .with_on_hit(move || events(TurnEvent::CacheHit)),
        ))
    }
}

#[async_trait]
impl Provider for BuiltinProvider {
    fn name(&self) -> &str {
        "内置 agent"
    }

    /// 内置 agent 的工具由我们配（走 MCP），所以是 false ——
    /// UI 该显示工具状态那一行。
    fn manages_own_tools(&self) -> bool {
        false
    }

    async fn run_turn(&self, req: TurnRequest) -> Result<String> {
        let TurnRequest {
            question,
            history,
            events,
            cancel,
        } = req;

        let call_model = self.build_stack(cancel.clone(), &events)?;

        let mut deps = AgentDeps::new(
            call_model,
            self.tools.clone(),
            AgentConfig::from(&self.config),
        )
        .with_cancel(cancel)
        .with_approver(self.approver.clone())
        .with_history(history)
        .with_on_turn({
            let events = events.clone();
            move |info: &TurnInfo| {
                for t in &info.tool_results {
                    events(TurnEvent::ToolCall {
                        turn: info.turn,
                        name: t.name.clone(),
                        args: t.args.clone(),
                        output: t.output.clone(),
                    });
                }
            }
        });
        if let Some(c) = &self.compact {
            deps = deps.with_compact(c.clone());
        }
        if let Some(oc) = &self.on_complete {
            deps = deps.with_on_complete(oc.clone());
        }

        run_agent(&question, deps).await
    }
}
