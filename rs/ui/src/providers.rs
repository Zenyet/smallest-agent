// ============================================================================
// providers.rs —— provider 注册表与会话绑定
// ----------------------------------------------------------------------------
// 两件事：
//   1. 管理有哪些 provider 可用（内置 agent + 用户配的外部 CLI）
//   2. 记住每个会话用的是哪个 —— 用户可以在会话 A 用内置 agent、
//      会话 B 用 claude code，切来切去不该丢
//
// ## 为什么 provider 绑定要单独存一个文件
//
// 和项目分组同一个理由（见 projects.rs 的文件头）：会话文件的形状由 core 的
// JsonSessionStore 决定（就是 `Message[]`），没地方放元数据，而且每答完一轮
// SaveSessionHook 都会整体覆写它。塞进去的字段会被下一次 save 抹掉。
//
// ## 为什么 provider 实例要缓存
//
// AcpProvider 持有子进程连接（懒建，第一次对话才起）。每次切会话都新建一个
// 意味着重新起 npx、重新握手，几秒的等待。所以按 id 缓存实例，
// 切回去时复用同一个连接 —— 这也保住了 CLI 那侧的会话上下文。
// ============================================================================

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use smallest_agent_core::provider::Provider;
use smallest_agent_core::vendors;

/// 内置 provider 的固定 id。
///
/// 用常量而不是字面量散在各处：它出现在配置文件、UI 的选中判断、
/// 默认值三个地方，改字面量必然漏一个。
pub const BUILTIN_ID: &str = "builtin";

/// 一个模型选择。
///
/// ## 为什么模型要用户配而不是自动发现
///
/// **ACP v1 协议里没有模型选择** —— 我查过 schema，只有 SessionMode
/// （ask / architect 那种工作模式），没有 available_models 之类的东西。
/// 所以客户端没法问 CLI「你支持哪些模型」。
///
/// 各家 CLI 的做法是读环境变量或命令行参数（`ANTHROPIC_MODEL`、
/// `--model` 之类）。所以这里让用户声明「有哪些选择、每个怎么传」，
/// 我们负责在启动子进程时把它应用上。
///
/// 代价是模型列表会过期（各家出新模型要用户自己加一行）。换来的是
/// **不用为每家 CLI 写一个适配器** —— 那是 waku 走的路（12 个 driver 文件）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelChoice {
    pub id: String,
    /// 显示名（"Claude Sonnet 4.6"）
    pub name: String,
    /// 追加的环境变量。多数 CLI 走这条。
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// 追加的命令行参数（`["--model", "opus"]`）。
    #[serde(default)]
    pub args: Vec<String>,
}

impl ModelChoice {
    /// 走 ANTHROPIC_MODEL 环境变量的模型（Claude Code 那套）。
    ///
    /// id 直接当模型标识用 —— 它本来就是要传给 CLI 的那个字符串，
    /// 再起一个内部 id 等于多一层要对上的映射。
    pub fn env(id: &str, name: &str) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            env: [("ANTHROPIC_MODEL".to_string(), id.to_string())]
                .into_iter()
                .collect(),
            args: vec![],
        }
    }

    /// 走 `--model` 命令行参数的模型（Codex 那套）。
    pub fn arg(id: &str, name: &str) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            env: Default::default(),
            args: vec!["--model".to_string(), id.to_string()],
        }
    }
}

/// 一个外部 CLI provider 的定义。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalProvider {
    /// 唯一 id，会话绑定引用它
    pub id: String,
    /// 显示名（"Claude Code"）
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// 工作目录。None = 跟着当前选中的项目走。
    ///
    /// 这是外部 CLI 和内置 agent 在「项目」概念上的接缝：内置 agent 的项目
    /// 只是会话分组，而 CLI 的 cwd 决定它能看到哪些文件。None 让两者对齐 ——
    /// 用户在项目 X 下开的会话，CLI 就在 X 的目录里干活。
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub disabled: bool,
    /// 这个 CLI 支持哪些模型。空表示不提供选择（用它的默认模型）。
    #[serde(default)]
    pub models: Vec<ModelChoice>,
}

/// 落盘的状态。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProvidersState {
    /// 用户配的外部 CLI
    #[serde(default)]
    pub external: Vec<ExternalProvider>,
    /// session_id → provider_id。不在这里的会话用内置 provider。
    #[serde(default)]
    pub session_provider: BTreeMap<String, String>,
    /// session_id → model_id。只对外部 provider 有意义。
    /// 不在这里的会话用那个 provider 的第一个模型（或它的默认）。
    #[serde(default)]
    pub session_model: BTreeMap<String, String>,
    /// 新会话默认用哪个。
    #[serde(default)]
    pub default_provider: Option<String>,

    /// 内置 agent 用哪家的哪个模型，按会话记。值的形状是 `厂商id/模型id`
    /// （`anthropic/claude-opus-5`）。
    ///
    /// ## 为什么和 session_model 分开存
    ///
    /// 两者的键空间不同：session_model 的值是「某个外部 CLI 声明的模型 id」，
    /// 只在那个 CLI 里有意义；这里的值是「厂商 + 模型」，由 core 的 vendors
    /// 目录定义。合在一张表里的话 normalize 没法判断某个值该按哪套规则校验，
    /// 而校验错的后果是把合法绑定清掉（用户选的模型莫名回到默认）。
    #[serde(default)]
    pub builtin_model: BTreeMap<String, String>,
    /// 内置 agent 的默认厂商/模型，新会话用它。同样是 `厂商id/模型id`。
    #[serde(default)]
    pub default_builtin_model: Option<String>,

    /// session_id → 权限模式（"readonly" / "ask" / "auto"）。
    ///
    /// 只对内置 agent 有意义 —— 外部 CLI 自带权限模型，我们不插手。
    /// 不在这里的会话用默认模式（Ask）。存字符串而不是枚举是为了
    /// 和这个文件里其它 BTreeMap<String,String> 一致，序列化也稳。
    #[serde(default)]
    pub session_permission: BTreeMap<String, String>,
}

/// 把 `厂商id/模型id` 拆开。
///
/// 模型 id 里不含斜杠（vendors.rs 那张表里都是 `claude-opus-5` 这种形状），
/// 所以按第一个斜杠切就够。切不开说明是脏数据，返回 None 让调用方回落到默认。
fn split_vendor_model(v: &str) -> Option<(&str, &str)> {
    let (vendor, model) = v.split_once('/')?;
    if vendor.is_empty() || model.is_empty() {
        return None;
    }
    Some((vendor, model))
}

/// 建一个 provider 实例要知道的、**属于这个会话**的那些东西。
///
/// 打成一个结构体而不是继续加参数：原来是 8 个位置参数，其中
/// `Option<PathBuf>` / `Option<&str>` / `Option<&AgentDef>` 三个都是 Option，
/// 顺序写错编译器拦不住（clippy 也在这个数上报了 too_many_arguments）。
/// 具名字段让调用点自己说清哪个是哪个。
pub struct SessionContext<'a> {
    /// 工作目录，同时是内置 agent 文件/命令工具的沙盒根
    pub cwd: Option<PathBuf>,
    /// 外部 CLI 的模型 id。内置 agent 走 `builtin`
    pub model_id: Option<&'a str>,
    /// 内置 agent 用哪家的哪个模型
    pub builtin: &'a vendors::Selection,
    /// 这个会话绑的自定义 agent
    pub agent: Option<&'a smallest_agent_core::agents::AgentDef>,
    /// 这个会话的权限模式
    pub permission: PermissionMode,
}

/// 按会话的工作目录装文件和命令工具。
///
/// ## 为什么沙盒根是「会话所属项目的目录」，而不是一个全局设置
///
/// 上一版加了个全局 `WORKSPACE_DIR`（默认 `~/SmallestAgent`）。那是多余的：
/// **这个 app 里的会话本来就有工作目录** —— 侧边栏的「项目」带着一个真实
/// 路径，新建对话时就选了，而且早就作为 cwd 传给外部 CLI 了
/// （见 chat.rs 的 project_dir_for）。再要用户去设置里配第二个目录，
/// 等于同一件事有两个真相，而且两者一旦不一致，用户看着 A 目录、
/// agent 在 B 目录里干活。
///
/// 所以直接复用它：**内置 agent 和外部 CLI 现在看到的是同一个目录**。
/// 在项目 X 下开的会话，两种引擎都在 X 里读写。
///
/// ## 没有项目的会话
///
/// 返回空 —— 不装文件和命令工具。不退回某个默认目录，因为那个目录
/// 用户没选过，agent 往里写东西他不会去找。这种会话仍然能聊天、
/// 上网、用技能，composer 上会说明「没有工作目录」。
fn fs_shell_tools(cwd: Option<&std::path::Path>) -> smallest_agent_core::types::ToolRegistry {
    let mut tools = smallest_agent_core::types::ToolRegistry::new();
    let Some(dir) = cwd else {
        return tools;
    };
    match smallest_agent_core::workspace::Workspace::new(dir) {
        Ok(ws) => {
            let ws = Arc::new(ws);
            smallest_agent_core::tools::files::register(&mut tools, ws.clone());
            smallest_agent_core::tools::shell::register(&mut tools, ws);
        }
        // 目录被删了 / 不可写。记一行，让这个会话退化成「只能聊天」，
        // 而不是整轮失败 —— 用户可能只是想问句话
        Err(err) => eprintln!("[workspace] {} 用不了，文件和命令工具不可用：{err:#}", dir.display()),
    }
    tools
}

/// 内置 agent 的权限模式。仿 Codex 的那个选择器。
///
/// ## 为什么是每会话，而不是全局设置
///
/// 「这条对话能不能动我的磁盘」是个**随任务变**的判断：查点东西用只读，
/// 让它改代码用询问，跑一串脚手架命令时切自动。绑在会话上，切会话就切
/// 回各自的模式，不用每次进设置改一个全局开关。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    /// 只读：写文件、执行命令一律**拒绝**。能读、能搜、能上网，动不了东西。
    ReadOnly,
    /// 询问（默认）：危险操作弹卡片让用户确认。就是原来的行为。
    Ask,
    /// 自动：危险操作**不问直接放行**。清楚自己在干什么、要连着跑很多步时用。
    Auto,
}

impl PermissionMode {
    pub const ALL: [PermissionMode; 3] =
        [PermissionMode::ReadOnly, PermissionMode::Ask, PermissionMode::Auto];

    pub fn from_id(s: &str) -> Self {
        match s {
            "readonly" => PermissionMode::ReadOnly,
            "auto" => PermissionMode::Auto,
            // 认不出的（旧数据、手改坏了）落到最安全那档：会问
            _ => PermissionMode::Ask,
        }
    }
    pub fn id(&self) -> &'static str {
        match self {
            PermissionMode::ReadOnly => "readonly",
            PermissionMode::Ask => "ask",
            PermissionMode::Auto => "auto",
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            PermissionMode::ReadOnly => "只读",
            PermissionMode::Ask => "询问",
            PermissionMode::Auto => "自动",
        }
    }
    pub fn icon(&self) -> gpui_component::IconName {
        use gpui_component::IconName;
        match self {
            PermissionMode::ReadOnly => IconName::Eye,
            PermissionMode::Ask => IconName::CircleCheck,
            // 没有 Zap / Bolt —— IconName 是按图标 svg 文件名生成的，
            // 那套里没有闪电。Play 表意也对：不问，直接跑
            PermissionMode::Auto => IconName::Play,
        }
    }
}

/// 按权限模式包一层审批。
///
/// 三种模式统一从这一个点表达，覆盖**所有**危险工具 —— 包括 MCP 带进来的
/// 那些（它们的名字我们控制不了，但都会经过 needs_approval，也就都会到这里）。
/// 这比在注册表里按模式增删工具更可靠：那样只能管住我们自己的工具。
struct ModeApprover {
    inner: Arc<dyn smallest_agent_core::approval::Approver>,
    mode: PermissionMode,
}

// 手写 Future 而不是用 #[async_trait]：ui 这个 crate 没有 async-trait 依赖，
// 为一个 impl 加一个宏依赖不值得。trait 那边用了 async_trait，
// 展开之后就是这个返回 BoxFuture 的形状，所以手写能对上。
impl smallest_agent_core::approval::Approver for ModeApprover {
    fn request<'a, 'b>(
        &'a self,
        req: smallest_agent_core::approval::ApprovalRequest,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = smallest_agent_core::approval::ApprovalOutcome>
                + Send
                + 'b,
        >,
    >
    where
        'a: 'b,
        Self: 'b,
    {
        use smallest_agent_core::approval::ApprovalOutcome;
        match self.mode {
            // "allow" / "deny" 是 standard_options() 里那两个选项的 id，
            // agent 循环按这两个字符串判断放不放行（见 core/agent.rs）
            PermissionMode::Auto => {
                Box::pin(async { ApprovalOutcome::Selected("allow".into()) })
            }
            PermissionMode::ReadOnly => {
                Box::pin(async { ApprovalOutcome::Selected("deny".into()) })
            }
            PermissionMode::Ask => self.inner.request(req),
        }
    }
}

impl ProvidersState {
    /// 清掉指向已删 provider 的绑定。
    ///
    /// 不清的话那个会话会既不属于任何外部 provider、也不显示成内置 ——
    /// 选择器上是空的，用户不知道点发送会走哪条路。
    pub fn normalize(mut self) -> Self {
        let known: Vec<&str> = self
            .external
            .iter()
            .map(|e| e.id.as_str())
            .chain(std::iter::once(BUILTIN_ID))
            .collect();
        self.session_provider
            .retain(|_, pid| known.contains(&pid.as_str()));
        // 模型绑定：指向已删 provider 或已删模型的都清掉。
        //
        // 分两步查而不是一步：模型 id 只在它所属的 provider 里唯一，
        // 全局查会把 A 的模型当成 B 的合法值。
        let valid_models: Vec<(String, String)> = self
            .external
            .iter()
            .flat_map(|e| e.models.iter().map(move |m| (e.id.clone(), m.id.clone())))
            .collect();
        let session_provider = self.session_provider.clone();
        self.session_model.retain(|sid, mid| {
            let Some(pid) = session_provider.get(sid) else {
                // 会话没绑外部 provider，模型绑定就是垃圾
                return false;
            };
            valid_models.iter().any(|(p, m)| p == pid && m == mid)
        });
        if let Some(d) = &self.default_provider
            && !known.contains(&d.as_str())
        {
            self.default_provider = None;
        }

        // 内置模型绑定：只校验**厂商**存在，不校验模型 id。
        //
        // 为什么对模型宽容：vendors.rs 那张清单会过期（各家出新模型比这个
        // 仓库更新快），而用户可以在设置里手填一个不在清单里的模型 id。
        // 按清单校验会把那种绑定当脏数据清掉 —— 用户填了个新模型，
        // 重启之后发现被改回默认了，而且不知道为什么。
        //
        // 厂商则必须校验：它决定 base_url，编不出来。
        // exists 而不是 find：自定义端点（custom）不在静态目录里，
        // 用 find 判断会把绑在它上面的会话当脏数据清掉 —— 用户配好本地模型、
        // 重启之后发现会话被改回 DeepSeek 了。
        let vendor_ok =
            |v: &String| split_vendor_model(v).is_some_and(|(vid, _)| vendors::exists(vid));
        self.builtin_model.retain(|_, v| vendor_ok(v));
        if let Some(d) = &self.default_builtin_model
            && !vendor_ok(d)
        {
            self.default_builtin_model = None;
        }

        self
    }

    /// 内置 agent 在某个会话里用哪家的哪个模型。
    ///
    /// 三级兜底：会话绑定 → 默认绑定 → 目录里的默认厂商 + 它的第一个模型。
    /// 永远返回一个可用的组合，因为「内置 agent 没有模型」这个状态不该存在 ——
    /// 那会让发送按钮点了什么都不发生。
    pub fn builtin_selection(&self, session_id: &str) -> vendors::Selection {
        let raw = self
            .builtin_model
            .get(session_id)
            .or(self.default_builtin_model.as_ref());

        if let Some((vid, mid)) = raw.and_then(|v| split_vendor_model(v))
            && vendors::exists(vid)
        {
            return vendors::Selection {
                vendor_id: vid.to_string(),
                model: mid.to_string(),
            };
        }

        let vendor_id = vendors::DEFAULT_VENDOR.to_string();
        vendors::Selection {
            model: vendors::default_model(&vendor_id)
                .unwrap_or_default()
                .to_string(),
            vendor_id,
        }
    }

    /// 给会话绑一个「厂商 + 模型」。
    ///
    /// 顺手记成默认值，理由同 set_provider：用户切了一次之后，
    /// 新会话大概率也想用这个。
    pub fn assign_builtin_model(&mut self, session_id: &str, sel: &vendors::Selection) {
        let value = format!("{}/{}", sel.vendor_id, sel.model);
        self.builtin_model
            .insert(session_id.to_string(), value.clone());
        self.default_builtin_model = Some(value);
    }

    /// 某个会话的权限模式。没设过就是 Ask（最安全的默认）。
    pub fn permission_for(&self, session_id: &str) -> PermissionMode {
        self.session_permission
            .get(session_id)
            .map(|s| PermissionMode::from_id(s))
            .unwrap_or(PermissionMode::Ask)
    }

    /// 给会话设权限模式。
    ///
    /// **不记成默认值**（不同于换模型/换 provider）：权限是个安全边界，
    /// 「上一个会话开了自动」不该让下一个新会话也默认放行 —— 那正是
    /// 用户最不希望被静默继承的东西。新会话一律从 Ask 开始。
    pub fn assign_permission(&mut self, session_id: &str, mode: PermissionMode) {
        self.session_permission
            .insert(session_id.to_string(), mode.id().to_string());
    }

    /// 某个会话用哪个 provider。
    ///
    /// 有绑定就用绑定，没绑定才落到默认值。**绑过的会话不会因为默认值变了
    /// 而换引擎** —— 见 assign 的注释。
    pub fn provider_for(&self, session_id: &str) -> &str {
        self.session_provider
            .get(session_id)
            .map(|s| s.as_str())
            .or(self.default_provider.as_deref())
            .unwrap_or(BUILTIN_ID)
    }

    /// 绑定一个会话到某个 provider。
    ///
    /// ## 为什么内置也要存一条记录
    ///
    /// 以前这里对内置做了个「省一条记录」的优化：内置是默认值，所以不存，
    /// 直接把 key 删掉。**那是个 bug**，表现是这样的：
    ///
    ///   1. 会话 A 用内置 agent 聊了十几轮（没有记录，因为内置不存）
    ///   2. 用户在会话 B 里切到 claude code —— set_provider 顺手把
    ///      default_provider 记成了 claude code
    ///   3. 回到会话 A，它没有绑定，于是落到默认值 —— **静默变成了 claude code**
    ///
    /// 于是 A 那十几轮内置 agent 的历史被喂给了 CLI，而 CLI 自己那侧
    /// 什么都不知道。用户眼里是「同一个会话，怎么换了个引擎」。
    ///
    /// 根因是「没记录」同时表示两件事：「就是要用内置」和「还没定」。
    /// 现在每次绑定都存，两者分开 —— 多一条记录，换掉一整类不可见的串台。
    pub fn assign(&mut self, session_id: &str, provider_id: &str) {
        self.session_provider
            .insert(session_id.to_string(), provider_id.to_string());
    }

    /// 没绑过就绑上，绑过的不动。
    ///
    /// 用在两处：新建会话（绑当前默认值）和**收养老会话**。后者是迁移路径 ——
    /// 这个改动之前，走内置 agent 的会话是不存记录的，磁盘上那些会话全都
    /// 没有绑定。它们的历史是内置 agent 写的（那时候只有内置会存盘），
    /// 所以一律收养成内置，否则用户改了默认值就会把它们卷走。
    pub fn bind_if_unbound(&mut self, session_id: &str, provider_id: &str) -> bool {
        if self.session_provider.contains_key(session_id) {
            return false;
        }
        self.session_provider
            .insert(session_id.to_string(), provider_id.to_string());
        true
    }

    /// 某个会话用哪个模型。返回 None 表示用 provider 的默认。
    pub fn model_for(&self, session_id: &str) -> Option<&str> {
        self.session_model.get(session_id).map(|s| s.as_str())
    }

    /// 绑定会话到某个模型。
    pub fn assign_model(&mut self, session_id: &str, model_id: Option<&str>) {
        match model_id {
            Some(m) => {
                self.session_model
                    .insert(session_id.to_string(), m.to_string());
            }
            None => {
                self.session_model.remove(session_id);
            }
        }
    }

    /// 某个 provider 有哪些模型可选。
    pub fn models_for(&self, provider_id: &str) -> &[ModelChoice] {
        self.find_external(provider_id)
            .map(|e| e.models.as_slice())
            .unwrap_or(&[])
    }

    /// 会话被删后清掉绑定。
    pub fn forget(&mut self, session_id: &str) {
        self.session_provider.remove(session_id);
        self.session_model.remove(session_id);
        self.builtin_model.remove(session_id);
    }

    /// 可选的 provider 列表，给 UI 渲染选择器。
    ///
    /// 内置永远排第一 —— 它是默认值，也是唯一保证可用的那个
    /// （外部 CLI 要装 npx、要网络、要认证）。
    pub fn options(&self) -> Vec<ProviderOption> {
        let mut out = vec![ProviderOption {
            id: BUILTIN_ID.to_string(),
            name: "内置 agent".to_string(),
            external: false,
        }];
        for e in self.external.iter().filter(|e| !e.disabled) {
            out.push(ProviderOption {
                id: e.id.clone(),
                name: e.name.clone(),
                external: true,
            });
        }
        out
    }

    pub fn find_external(&self, id: &str) -> Option<&ExternalProvider> {
        self.external.iter().find(|e| e.id == id)
    }
}

/// 给 UI 用的选项。
#[derive(Debug, Clone)]
pub struct ProviderOption {
    pub id: String,
    pub name: String,
    /// 是不是外部 CLI。UI 靠它显示不同的图标。
    pub external: bool,
}

// ============================================================================
// 落盘
// ============================================================================

fn state_path() -> Result<PathBuf> {
    crate::settings::settings_path()
        .map(|p| p.with_file_name("providers.json"))
        .context("算 providers.json 路径失败")
}

/// 配置文件路径的可显示形式，给设置页用。
pub fn state_path_display() -> String {
    state_path()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "(路径不可用)".into())
}

pub fn load_state() -> ProvidersState {
    let Ok(path) = state_path() else {
        return ProvidersState::default();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return ProvidersState::default();
    };
    serde_json::from_slice::<ProvidersState>(&bytes)
        .unwrap_or_default()
        .normalize()
}

pub fn save_state(state: &ProvidersState) -> Result<()> {
    let path = state_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("建配置目录失败：{}", dir.display()))?;
    }
    let json = serde_json::to_vec_pretty(state).context("序列化 provider 状态失败")?;
    std::fs::write(&path, json).with_context(|| format!("写 {} 失败", path.display()))
}

/// 示例配置，给「第一次打开设置页时写一份模板进去」用。
///
/// 两个都默认 disabled —— 它们要 npx 拉包（首次几十秒）且要各自的认证，
/// 不该在用户没看过配置的情况下就出现在选择器里。
///
/// 暂时没有调用点（现在用户得自己新建 providers.json），留着是因为
/// 删了下次还得重写，而它只有二十行。
#[allow(dead_code)]
pub fn example_state() -> ProvidersState {
    // 模型清单照 waku 的 model_catalog.rs 抄（那份维护得比我随手列的全）。
    //
    // ## 三点说明
    //
    // 1. 这是**用户可改的模板**，不是权威清单 —— ACP 协议查不到模型
    //    （见 ModelChoice 的注释），各家出新模型时你自己加一行。
    //
    // 2. 1M 上下文用 id 后缀表达（`claude-opus-5[1m]`）而不是单独的选项维度。
    //    waku 那边是二级选项（模型 × 上下文窗口），需要一个嵌套的选择 UI；
    //    这边摊平成独立条目 —— 多几行换掉一层 UI，在这个规模下划算。
    //    只给顶配模型加 1M 条目，否则列表长一倍而多数人用不到。
    //
    // 3. **我没有验证 claude-agent-acp 是否真的读 ANTHROPIC_MODEL。**
    //    这是 Claude Code 的标准环境变量，适配器大概率透传，但没实测。
    //    填错的后果是 CLI 用它的默认模型（不会崩），换个变量名再试即可。
    let claude_models = vec![
        ModelChoice::env("claude-fable-5", "Claude Fable 5"),
        ModelChoice::env("claude-fable-5[1m]", "Claude Fable 5 (1M)"),
        ModelChoice::env("claude-opus-5", "Claude Opus 5"),
        ModelChoice::env("claude-opus-5[1m]", "Claude Opus 5 (1M)"),
        ModelChoice::env("claude-opus-4-8", "Claude Opus 4.8"),
        ModelChoice::env("claude-opus-4-7", "Claude Opus 4.7"),
        ModelChoice::env("claude-opus-4-6", "Claude Opus 4.6"),
        ModelChoice::env("claude-opus-4-5", "Claude Opus 4.5"),
        ModelChoice::env("claude-sonnet-5", "Claude Sonnet 5"),
        ModelChoice::env("claude-sonnet-5[1m]", "Claude Sonnet 5 (1M)"),
        ModelChoice::env("claude-sonnet-4-6", "Claude Sonnet 4.6"),
        ModelChoice::env("claude-haiku-4-5", "Claude Haiku 4.5"),
    ];

    let codex_models = vec![
        ModelChoice::arg("gpt-5.6-sol", "GPT-5.6-Sol"),
        ModelChoice::arg("gpt-5.6-terra", "GPT-5.6-Terra"),
        ModelChoice::arg("gpt-5.6-luna", "GPT-5.6-Luna"),
        ModelChoice::arg("gpt-5.5", "GPT-5.5"),
        ModelChoice::arg("gpt-5.4", "GPT-5.4"),
    ];

    ProvidersState {
        external: vec![
            ExternalProvider {
                id: "claude-code".into(),
                name: "Claude Code".into(),
                command: "npx".into(),
                args: vec![
                    "-y".into(),
                    "@agentclientprotocol/claude-agent-acp@latest".into(),
                ],
                env: Default::default(),
                cwd: None,
                disabled: true,
                models: claude_models,
            },
            ExternalProvider {
                id: "codex".into(),
                name: "Codex".into(),
                command: "npx".into(),
                args: vec!["-y".into(), "@agentclientprotocol/codex-acp@latest".into()],
                env: Default::default(),
                cwd: None,
                disabled: true,
                models: codex_models,
            },
        ],
        // 会话绑定类的字段模板里都是空的 —— 这是「第一次打开设置写一份模板」
        // 用的，那时候还没有任何会话
        ..Default::default()
    }
}

// ============================================================================
// 实例注册表
// ============================================================================

use smallest_agent_core::agent::Compact;
use smallest_agent_core::approval::Approver;
use smallest_agent_core::provider::{AcpProvider, AcpSpec, BuiltinProvider};
use smallest_agent_core::types::{Config, ToolRegistry};

/// 外部 provider 的实例缓存。键是 (provider_id, model_id) —— 见 Registry 的注释。
type ExternalCache = BTreeMap<(String, Option<String>), Arc<dyn Provider>>;

/// 按 id 建 provider 实例并缓存。
///
/// ## 为什么外部 provider 要缓存、内置的不缓存
///
/// AcpProvider 持有子进程连接（懒建）。每次对话新建一个意味着重新起 npx、
/// 重新握手（几秒），而且**丢掉 CLI 那侧的会话上下文** —— 那正是用外部 CLI
/// 的意义。所以缓存，切回去时复用同一个连接。
///
/// 内置 provider 反过来：它无状态（历史每轮显式传），而重建的代价只是建一个
/// reqwest client。缓存它反而要处理「工具热插进来之后什么时候失效」。
///
/// ## 一个实例服务多个会话，但对话不混
///
/// 缓存键里**没有会话 id**，所以两个都走 claude code 的会话拿到同一个实例、
/// 同一个子进程。这是故意的（起进程贵），而「对话不混」由 core 那边保证：
/// AcpProvider 在一条连接上按会话 id 各开一个 ACP 会话。
/// 见 core 的 acp.rs 里 `acp_sessions` 那个 map。
///
/// ## 缓存键为什么要带模型
///
/// 模型是通过**子进程的 env / args** 传的（协议里没有模型选择，见
/// ModelChoice 的注释）。换模型意味着要用不同的命令行重新起进程 ——
/// 复用旧实例就等于换了个名字但还在用旧模型，而用户以为切了。
pub struct Registry {
    config: Config,
    tools: ToolRegistry,
    compact: Arc<dyn Compact>,
    approver: Arc<dyn Approver>,
    /// (provider_id, model_id) → 已建好的实例。
    ///
    /// Mutex 因为 get 要在 &self 上改缓存 —— 调用点在 render 路径上，
    /// 拿不到 &mut self。
    external_cache: std::sync::Mutex<ExternalCache>,
}

impl Registry {
    pub fn new(
        config: Config,
        tools: ToolRegistry,
        compact: Arc<dyn Compact>,
        approver: Arc<dyn Approver>,
    ) -> Self {
        Self {
            config,
            tools,
            compact,
            approver,
            external_cache: std::sync::Mutex::new(BTreeMap::new()),
        }
    }

    /// 工具变了（MCP 后台连上）时更新。
    ///
    /// 只影响内置 provider —— 它把注册表烤进了 HTTP 请求体构造里。
    /// 外部 CLI 自己管工具，缓存不用动。
    pub fn set_tools(&mut self, tools: ToolRegistry) {
        self.tools = tools;
    }

    /// 拿一个 provider 实例。
    ///
    /// `cwd` 和 `model_id` 只对外部有意义。
    ///
    /// 注意这里**不再收 on_complete** —— 存盘钩子绑一个会话，而实例跨会话
    /// 复用，所以它挪到 TurnRequest 上了（见 core 那边的注释）。
    pub fn get(
        &self,
        id: &str,
        state: &ProvidersState,
        session: SessionContext<'_>,
    ) -> Result<Arc<dyn Provider>> {
        let SessionContext {
            cwd,
            model_id,
            builtin,
            agent,
            permission,
        } = session;
        if id == BUILTIN_ID {
            // agent 指定了模型就用它的，否则用会话选的那个。
            //
            // agent 的模型是可选的（空 = 跟着会话）—— 多数 agent 只是换
            // 说话方式，钉死模型反而碍事。见 pages.rs 那个选择器的注释。
            let builtin = match agent
                .map(|a| a.model.trim())
                .filter(|m| !m.is_empty())
                .and_then(|m| m.split_once('/'))
            {
                Some((vid, mid)) => &vendors::Selection {
                    vendor_id: vid.to_string(),
                    model: mid.to_string(),
                },
                None => builtin,
            };
            // 厂商 + 模型每轮从会话绑定取，key 每轮从设置读。
            //
            // 每轮读盘而不是启动时读一次：用户可以在设置里填一把新 key，
            // 那之后**这一轮**就该用上。缓存起来意味着要在「设置改了」和
            // 「下一轮对话」之间做失效，而那是一条容易漏的通路。
            // 读的是个几百字节的 JSON，一轮一次不值得优化。
            let settings = crate::settings::load_settings();
            // 凭据（key、自定义端点的地址）从哪儿读由这个闭包决定，
            // apply 那边不知道来源 —— 见 vendors::Lookup。
            let config = builtin.apply(&self.config, &|k| settings.get(k).cloned())?;
            // agent 的系统提示和工具白名单。没有 agent 就是原样。
            let config = match agent {
                Some(a) => a.apply(&config),
                None => config,
            };
            // self.tools 只装**和目录无关**的那些（技能、网络、MCP）。
            // 文件和命令工具要沙盒到**这个会话的工作目录**，所以在这里按 cwd
            // 现场装 —— 见下面 fs_shell_tools 的注释，以及为什么不再有全局
            // WORKSPACE_DIR 设置。
            let mut tools = self.tools.clone();
            tools.extend(fs_shell_tools(cwd.as_deref()));

            // 这家自带服务端搜索的话，撤掉我们自己那个 web_search。
            //
            // 留着两个的后果不是「多一个选择」而是**更差**：模型会在两条
            // 路之间乱挑，而我们那个在没配 Brave/Tavily 时只能搜维基百科 ——
            // 厂商自带的那个是全网。给它一个更差的同名选项没有意义。
            //
            // fetch_url 不撤：抓具体网址和搜索是两件事，服务端搜索
            // 不覆盖「把这个链接读一下」。
            if config.native_search.is_some() {
                tools.remove("web_search");
            }
            let tools = match agent {
                Some(a) => a.filter_tools(&tools),
                None => tools,
            };

            // 按会话的权限模式包一层审批。只读会拒掉写和命令，自动会全放行，
            // 询问就是原来的行为。见 ModeApprover。
            let approver: Arc<dyn smallest_agent_core::approval::Approver> = Arc::new(ModeApprover {
                inner: self.approver.clone(),
                mode: permission,
            });

            // 每次重建：便宜（就是建个 reqwest client），而缓存它反而要处理
            // 「工具热插进来之后什么时候失效」
            let p = BuiltinProvider::new(config, tools)?
                .with_compact(self.compact.clone())
                .with_approver(approver);
            return Ok(Arc::new(p));
        }

        let key = (id.to_string(), model_id.map(|s| s.to_string()));
        if let Some(cached) = self.external_cache.lock().expect("缓存锁").get(&key) {
            return Ok(cached.clone());
        }

        let ext = state
            .find_external(id)
            .with_context(|| format!("没有叫「{id}」的 provider"))?;

        // 模型选择追加在 provider 自己的 env / args 之上。
        //
        // 追加而不是替换：provider 的 env 可能有认证之类的东西，
        // 模型只负责加它那一两个键。
        let mut env = ext.env.clone();
        let mut args = ext.args.clone();
        if let Some(mid) = model_id
            && let Some(m) = ext.models.iter().find(|m| m.id == mid)
        {
            env.extend(m.env.clone());
            args.extend(m.args.clone());
        }

        let spec = AcpSpec {
            name: ext.name.clone(),
            command: ext.command.clone(),
            args,
            env,
            // 三级兜底：provider 自己配的 → 会话所属项目的 → 启动目录
            cwd: ext
                .cwd
                .clone()
                .or(cwd)
                .or_else(|| std::env::current_dir().ok())
                .unwrap_or_else(|| PathBuf::from("/")),
        };

        let provider: Arc<dyn Provider> =
            Arc::new(AcpProvider::new(spec).with_approver(self.approver.clone()));
        self.external_cache
            .lock()
            .expect("缓存锁")
            .insert(key, provider.clone());
        Ok(provider)
    }

    /// 丢掉某个 provider 的全部缓存实例（所有模型变体）。
    ///
    /// 用在「用户改了它的配置」之后 —— 不丢的话还在用旧的命令行参数，
    /// 而用户以为改生效了。
    ///
    /// 目前没有调用点：设置页还不能编辑 provider 配置（只能改文件后重启）。
    #[allow(dead_code)]
    pub fn invalidate(&self, id: &str) {
        self.external_cache
            .lock()
            .expect("缓存锁")
            .retain(|(pid, _), _| pid != id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ext(id: &str) -> ExternalProvider {
        ExternalProvider {
            id: id.into(),
            name: id.into(),
            command: "npx".into(),
            args: vec![],
            env: Default::default(),
            cwd: None,
            disabled: false,
            models: vec![],
        }
    }

    #[test]
    fn defaults_to_builtin() {
        let state = ProvidersState::default();
        assert_eq!(state.provider_for("any-session"), BUILTIN_ID);
    }

    #[test]
    fn assign_and_read_back() {
        let mut state = ProvidersState {
            external: vec![ext("claude")],
            ..Default::default()
        };
        state.assign("s1", "claude");
        assert_eq!(state.provider_for("s1"), "claude");
        // 别的会话不受影响
        assert_eq!(state.provider_for("s2"), BUILTIN_ID);
    }

    #[test]
    fn assigning_builtin_keeps_an_explicit_record() {
        let mut state = ProvidersState {
            external: vec![ext("claude")],
            ..Default::default()
        };
        state.assign("s1", "claude");
        state.assign("s1", BUILTIN_ID);
        // 内置也要留记录：「就是要用内置」和「还没定」必须是两种状态，
        // 否则改默认值会把老会话卷走（见 assign 的注释）
        assert_eq!(state.session_provider.get("s1").map(String::as_str), Some(BUILTIN_ID));
        assert_eq!(state.provider_for("s1"), BUILTIN_ID);
    }

    #[test]
    fn bound_session_ignores_a_changed_default() {
        let mut state = ProvidersState {
            external: vec![ext("claude")],
            ..Default::default()
        };
        // 会话明确用内置
        state.assign("s1", BUILTIN_ID);
        // 用户后来在别处把默认值改成了 claude
        state.default_provider = Some("claude".into());
        // s1 不该跟着变 —— 这正是「对话独立」要保证的事
        assert_eq!(state.provider_for("s1"), BUILTIN_ID);
        assert_eq!(state.provider_for("new-session"), "claude");
    }

    #[test]
    fn bind_if_unbound_only_fills_the_gap() {
        let mut state = ProvidersState {
            external: vec![ext("claude")],
            ..Default::default()
        };
        assert!(state.bind_if_unbound("s1", BUILTIN_ID), "没绑过就该绑上");
        assert!(!state.bind_if_unbound("s1", "claude"), "绑过的不该被改掉");
        assert_eq!(state.provider_for("s1"), BUILTIN_ID);
    }

    #[test]
    fn default_provider_applies_to_unbound_sessions() {
        let state = ProvidersState {
            external: vec![ext("claude")],
            default_provider: Some("claude".into()),
            ..Default::default()
        };
        // 没绑定的会话走默认值
        assert_eq!(state.provider_for("new-session"), "claude");
    }

    #[test]
    fn normalize_drops_bindings_to_deleted_providers() {
        let mut state = ProvidersState {
            external: vec![],
            ..Default::default()
        };
        // 手改配置文件可能留下这种
        state
            .session_provider
            .insert("s1".into(), "deleted-provider".into());
        state.default_provider = Some("also-gone".into());

        let state = state.normalize();
        // 悬空绑定要清掉，否则那个会话在选择器上是空的
        assert!(state.session_provider.is_empty());
        assert!(state.default_provider.is_none());
        assert_eq!(state.provider_for("s1"), BUILTIN_ID);
    }

    #[test]
    fn normalize_keeps_builtin_binding() {
        let state = ProvidersState::default();
        let state = ProvidersState {
            default_provider: Some(BUILTIN_ID.into()),
            ..state
        };
        let state = state.normalize();
        // 内置永远是合法 id
        assert_eq!(state.default_provider.as_deref(), Some(BUILTIN_ID));
    }

    #[test]
    fn options_put_builtin_first_and_skip_disabled() {
        let mut off = ext("off");
        off.disabled = true;
        let state = ProvidersState {
            external: vec![ext("claude"), off],
            ..Default::default()
        };
        let opts = state.options();
        assert_eq!(opts.len(), 2, "禁用的不该出现");
        assert_eq!(opts[0].id, BUILTIN_ID, "内置排第一");
        assert!(!opts[0].external);
        assert_eq!(opts[1].id, "claude");
        assert!(opts[1].external);
    }

    #[test]
    fn forget_clears_binding() {
        let mut state = ProvidersState {
            external: vec![ext("claude")],
            ..Default::default()
        };
        state.assign("s1", "claude");
        state.forget("s1");
        assert_eq!(state.provider_for("s1"), BUILTIN_ID);
    }

    fn ext_with_models(id: &str, model_ids: &[&str]) -> ExternalProvider {
        ExternalProvider {
            models: model_ids
                .iter()
                .map(|m| ModelChoice {
                    id: (*m).into(),
                    name: (*m).into(),
                    env: Default::default(),
                    args: vec![],
                })
                .collect(),
            ..ext(id)
        }
    }

    #[test]
    fn model_binding_reads_back() {
        let mut state = ProvidersState {
            external: vec![ext_with_models("claude", &["sonnet", "opus"])],
            ..Default::default()
        };
        state.assign("s1", "claude");
        state.assign_model("s1", Some("opus"));
        assert_eq!(state.model_for("s1"), Some("opus"));
        // 没绑定的会话返回 None（用 provider 默认）
        assert_eq!(state.model_for("s2"), None);
    }

    #[test]
    fn normalize_drops_model_bound_to_wrong_provider() {
        // 模型 id 只在它所属的 provider 里有意义 ——
        // claude 的 opus 和 codex 的 opus 不是一回事
        let mut state = ProvidersState {
            external: vec![
                ext_with_models("claude", &["opus"]),
                ext_with_models("codex", &["gpt-5"]),
            ],
            ..Default::default()
        };
        state.assign("s1", "codex");
        // 手改配置可能造出这种：会话绑 codex，模型却是 claude 的
        state.session_model.insert("s1".into(), "opus".into());

        let state = state.normalize();
        assert_eq!(state.model_for("s1"), None, "跨 provider 的模型绑定要清掉");
    }

    #[test]
    fn normalize_drops_model_when_session_has_no_provider() {
        let mut state = ProvidersState {
            external: vec![ext_with_models("claude", &["opus"])],
            ..Default::default()
        };
        // 只有模型绑定、没有 provider 绑定 —— 那个模型绑定是垃圾
        state.session_model.insert("s1".into(), "opus".into());
        let state = state.normalize();
        assert!(state.session_model.is_empty());
    }

    #[test]
    fn forget_clears_both_bindings() {
        let mut state = ProvidersState {
            external: vec![ext_with_models("claude", &["opus"])],
            ..Default::default()
        };
        state.assign("s1", "claude");
        state.assign_model("s1", Some("opus"));
        state.forget("s1");
        assert!(state.session_provider.is_empty());
        assert!(state.session_model.is_empty());
    }

    #[test]
    fn normalize_keeps_builtin_session_bindings() {
        let mut state = ProvidersState::default();
        state.assign("s1", BUILTIN_ID);
        // 默认值换成别的，用来验证 s1 不跟着走
        state.external = vec![ext("claude")];
        state.default_provider = Some("claude".into());

        let state = state.normalize();
        // 内置是合法 id，这条记录必须留着 —— 清掉就退回「没记录」，
        // 而那正是会被默认值卷走的状态
        assert_eq!(state.provider_for("s1"), BUILTIN_ID);
    }

    #[test]
    fn models_for_unknown_provider_is_empty() {
        let state = ProvidersState::default();
        assert!(state.models_for("nope").is_empty());
        // 内置 provider 没有模型选择（它的模型在设置里配）
        assert!(state.models_for(BUILTIN_ID).is_empty());
    }

    #[test]
    fn example_state_disables_everything() {
        let state = example_state();
        assert_eq!(state.external.len(), 2);
        // 外部 CLI 要 npx 拉包 + 认证，不该默认就出现在选择器里
        assert!(state.external.iter().all(|e| e.disabled));
        assert_eq!(state.options().len(), 1, "只有内置可选");
    }

    // ========================================================================
    // 权限模式
    // ========================================================================

    #[test]
    fn permission_defaults_to_ask_and_unknown_ids_fall_back_safely() {
        // 默认必须是「会问」—— 一个没设过的会话如果默认放行，
        // 用户第一次用就可能被静默改磁盘
        let st = ProvidersState::default();
        assert_eq!(st.permission_for("s1"), PermissionMode::Ask);

        // 手改坏的值也要落到会问那档，不能落到 Auto
        assert_eq!(PermissionMode::from_id("garbage"), PermissionMode::Ask);
        assert_eq!(PermissionMode::from_id("readonly"), PermissionMode::ReadOnly);
        assert_eq!(PermissionMode::from_id("auto"), PermissionMode::Auto);
    }

    #[test]
    fn permission_is_per_session_and_not_remembered_as_a_default() {
        // 换模型/换 provider 会记成默认值，权限**刻意不记** ——
        // 「上个会话开了自动」不该让新会话也放行
        let mut st = ProvidersState::default();
        st.assign_permission("s1", PermissionMode::Auto);
        assert_eq!(st.permission_for("s1"), PermissionMode::Auto);
        // 另一个会话不受影响
        assert_eq!(st.permission_for("s2"), PermissionMode::Ask);
    }

    #[test]
    fn permission_ids_roundtrip() {
        // id 是要落盘的，改了会让老配置失效
        for m in PermissionMode::ALL {
            assert_eq!(PermissionMode::from_id(m.id()), m);
            assert!(!m.label().is_empty());
        }
    }

    /// 极简 block_on。
    ///
    /// ui 这个 crate 没有 tokio 依赖（它跑在 gpui 的执行器上），为一个测试
    /// 加一个 dev-dependency 不值得。ModeApprover 那三条分支里两条是
    /// `async {}` 立即就绪、一条是转发，用不着真正的运行时 —— 忙轮询足够。
    fn block_on<F: std::future::Future>(mut fut: F) -> F::Output {
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
        fn noop(_: *const ()) {}
        fn clone(_: *const ()) -> RawWaker {
            RawWaker::new(std::ptr::null(), &VTABLE)
        }
        static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, noop, noop, noop);
        let waker = unsafe { Waker::from_raw(clone(std::ptr::null())) };
        let mut cx = Context::from_waker(&waker);
        let mut fut = unsafe { std::pin::Pin::new_unchecked(&mut fut) };
        loop {
            if let Poll::Ready(v) = fut.as_mut().poll(&mut cx) {
                return v;
            }
        }
    }

    #[test]
    fn readonly_denies_and_auto_allows_without_asking() {
        use smallest_agent_core::approval::{
            ApprovalOutcome, ApprovalRequest, Approver, standard_options,
        };
        use std::sync::atomic::{AtomicUsize, Ordering};

        /// 记录被问了几次。ReadOnly / Auto 都不该问到它
        struct Counting(AtomicUsize);
        impl Approver for Counting {
            fn request<'a, 'b>(
                &'a self,
                _req: ApprovalRequest,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ApprovalOutcome> + Send + 'b>>
            where
                'a: 'b,
                Self: 'b,
            {
                self.0.fetch_add(1, Ordering::Relaxed);
                Box::pin(async { ApprovalOutcome::Selected("allow".into()) })
            }
        }

        let req = || ApprovalRequest {
            id: "1".into(),
            title: "写文件".into(),
            detail: String::new(),
            options: standard_options(),
        };

        let inner = Arc::new(Counting(AtomicUsize::new(0)));

        // 只读：直接拒，不打扰用户
        let ro = ModeApprover {
            inner: inner.clone(),
            mode: PermissionMode::ReadOnly,
        };
        assert_eq!(
            block_on(ro.request(req())),
            ApprovalOutcome::Selected("deny".into())
        );

        // 自动：直接放行，也不问
        let auto = ModeApprover {
            inner: inner.clone(),
            mode: PermissionMode::Auto,
        };
        assert_eq!(
            block_on(auto.request(req())),
            ApprovalOutcome::Selected("allow".into())
        );

        assert_eq!(inner.0.load(Ordering::Relaxed), 0, "这两档都不该问用户");

        // 询问：转给里层，也就是弹卡片
        let ask = ModeApprover {
            inner: inner.clone(),
            mode: PermissionMode::Ask,
        };
        let _ = block_on(ask.request(req()));
        assert_eq!(inner.0.load(Ordering::Relaxed), 1, "这一档该问");
    }
}
