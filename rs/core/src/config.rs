// ============================================================================
// config.rs —— 环境变量驱动的运行时配置（对应 TS 版 src/config.ts）
// ----------------------------------------------------------------------------
// 职责：把散落在 .env 里的字符串变量聚合成一个强类型 Config。
// 「单一真相源」——所有模块从 Config 取参数，不直接读 std::env，
// 便于测试和参数校验集中管理。
//
// 与 TS 版的唯一结构性差异：TS 的 loadConfig 默认参数是 process.env，
// 测试时传假 env 对象。Rust 没有默认参数，拆成两个函数：
// load_config() 读真实环境，load_config_from() 接受任意取值闭包。
// ============================================================================

use anyhow::{Result, bail};

use crate::types::Config;

/// 系统提示：约束模型行为的「全局指令」，每次调模型时作为首条 system 消息注入。
///
/// 两条关键约束：
///   1. 有外部数据需求时调工具，不要凭空编造（防幻觉）
///   2. 用到 RAG 检索结果时注明来源文件名（Stage 3 加的溯源要求）
pub const SYSTEM_PROMPT: &str = concat!(
    "你是一个简洁、诚实的中文助手，同时是一个能动手的 agent。\n",
    // 不写「你可以调用工具」这种空话：工具清单和参数已经在请求里了，
    // 模型看得见。这里要说的是**它自己判断不出来的那些**：
    // 哪些操作有副作用、结果从哪来、什么时候该停下来问。
    "\n",
    "你有这些能力，需要时直接用，不要凭空编造，也不要反过来问用户「要不要我去查」。\n",
    // 工具清单是动态的：没有工作目录的会话不会有文件和命令工具。
    // 所以这里说「如果你有」，而不是断言它们一定在
    "如果下面这些工具在你的清单里：\n",
    "  • 文件：list_directory / read_file / write_file / edit_file / search_files。\n",
    "    它们只能在**工作目录**里活动，越界会报错并告诉你根目录在哪。\n",
    "  • 命令：run_command，在工作目录里执行 shell 命令。\n",
    "  • 网络：fetch_url 抓取网页正文；搜索用你手上的搜索工具（可能是\n",
    "    厂商自带的，也可能是 web_search）。\n",
    "\n",
    // 这三条是模型最容易犯的错，逐条对应真实的失败方式
    "几条要求：\n",
    "  1. 改文件前先 read_file 看一眼当前内容，不要凭记忆改。\n",
    "  2. write_file 会**覆盖整个文件**；只改一小段时用 edit_file。\n",
    "  3. 写文件和执行命令需要用户确认，被拒绝时不要换个说法重试同一个操作，\n",
    "     先说明你为什么需要它。\n",
    "\n",
    "回答用到读文件或网页得到的内容时，注明来源（文件名或网址）。"
);

/// 从真实进程环境读配置。
pub fn load_config() -> Result<Config> {
    load_config_from(&|key| std::env::var(key).ok())
}

/// 从任意「取值函数」读配置。测试传一个查 HashMap 的闭包即可。
pub fn load_config_from(get: &dyn Fn(&str) -> Option<String>) -> Result<Config> {
    // ## 找一个配好的厂商
    //
    // 原来这里写死了 `DEEPSEEK_API_KEY`：没填就直接 bail。加了多厂商之后
    // 那是个真 bug —— 只填了 Anthropic key 的用户**连 app 都起不来**，
    // 而报错让他去填一个他根本不用的厂商的 key。
    //
    // 现在按 vendors 的顺序找第一个**配好的**：内置九家看有没有 key，
    // 自定义端点看有没有地址 + 模型清单（见 vendors::is_configured）。
    // DeepSeek 排在第一，所以老配置的行为一个字都没变。
    //
    // 桌面版里这份 Config 只是**基线** —— 真正用哪家由会话绑定决定，
    // 每轮在 Registry 里用 Selection::apply 覆盖掉这三个字段。
    // 基线仍然要有个合理值，因为 CLI 直接用它。
    let Some(vendor_id) = crate::vendors::first_configured(get) else {
        bail!(
            "还没配任何模型。在设置 → 模型里填一把 API Key（{}），\
             或者用自定义端点指向第三方 / 本地服务（{} + {}）",
            crate::vendors::key_envs().join(" / "),
            crate::vendors::CUSTOM_BASE_URL,
            crate::vendors::CUSTOM_MODELS,
        );
    };

    // first_configured 刚刚认过这个 id，所以一定解析得出来。
    // expect 而不是静默兜底：走到这儿说明那两个函数对「认识哪些 id」
    // 的看法不一致，那是 bug 而不是用户配错了。
    let vendor = crate::vendors::entry(&vendor_id, get)
        .expect("first_configured 返回的厂商必须解析得出来");

    let api_key = crate::vendors::api_key_setting(&vendor_id)
        .and_then(get)
        // trim：粘 key 时很容易带上前后空格，不去掉就是一个 401
        .map(|k| k.trim().to_string())
        .unwrap_or_default();
    // 端点不再有覆盖键 —— 内置厂商的是常量，自定义端点的由用户填。
    // 见 vendors.rs 文件头那段「为什么内置厂商没有 API 端点这一栏」。
    let base_url = vendor.base_url.clone();
    // 这家的默认模型。自定义端点的话是用户填的清单里第一个 ——
    // is_configured 保证了清单非空，所以这里不会是空串。
    let default_model = vendor
        .models
        .first()
        .map(|m| m.id.clone())
        .unwrap_or_default();
    // 模型：优先用户显式指定的，否则用这家的默认。
    //
    // MODEL 是新的通用键名，DEEPSEEK_MODEL 留着兼容老配置 ——
    // 老用户升级之后不该发现自己配的模型没生效了。
    let model = get("MODEL")
        .or_else(|| get("DEEPSEEK_MODEL"))
        .filter(|s| !s.trim().is_empty());

    Ok(Config {
        api_key,
        base_url,
        model: model.clone().unwrap_or_else(|| default_model.clone()),
        // temperature=0 → 输出更确定/一致，适合工具调用场景；调高更「有创意」但不稳定
        // 这家自带的搜索。vendors 那边已经解析好了，直接搬过来
        native_search: vendor.search.clone(),
        temperature: num_from_env(get("TEMPERATURE"), 0.0, "TEMPERATURE")?,
        max_turns: num_from_env(get("MAX_TURNS"), 10.0, "MAX_TURNS")? as u32,
        system_prompt: SYSTEM_PROMPT.to_string(),

        // Stage 3 RAG：本地 embedding 模型，multilingual-e5-small 体积小、中文效果够用
        embedding_model: get("EMBEDDING_MODEL")
            .unwrap_or_else(|| "Xenova/multilingual-e5-small".into()),
        notes_dir: get("NOTES_DIR").unwrap_or_else(|| "./notes".into()),
        hf_endpoint: get("HF_ENDPOINT"),
        local_model_path: get("LOCAL_MODEL_PATH"),

        // Stage 2 记忆：session_id 决定读写哪个会话文件
        session_id: get("SESSION_ID").unwrap_or_else(|| "default".into()),
        sessions_dir: get("SESSIONS_DIR").unwrap_or_else(|| "./.sessions".into()),
        max_context_tokens: num_from_env(get("MAX_CONTEXT_TOKENS"), 2000.0, "MAX_CONTEXT_TOKENS")?
            as u32,
        keep_recent: num_from_env(get("KEEP_RECENT"), 6.0, "KEEP_RECENT")? as usize,

        // fallback_model 优先用独立变量，没设就跟主模型一样——退化成「不切换」。
        // 兜底也跟着厂商走，不再写死 deepseek-chat：
        // 拿另一家的模型 id 去降级只会得到 model not found。
        fallback_model: get("FALLBACK_MODEL")
            .filter(|s| !s.trim().is_empty())
            .or(model)
            .unwrap_or(default_model),
        max_retries: num_from_env(get("MAX_RETRIES"), 2.0, "MAX_RETRIES")? as u32,

        // LLM_CACHE=0 才关闭缓存；其他任何值（包括不设）都视为开启
        cache_enabled: get("LLM_CACHE").as_deref() != Some("0"),
        cache_dir: get("LLM_CACHE_DIR").unwrap_or_else(|| "./.llm-cache".into()),
        // STREAM=0 才关闭流式；同上，默认开启
        stream: get("STREAM").as_deref() != Some("0"),
    })
}

/// 从环境变量读数字，带默认值 + 类型校验。
///
/// 这里和 TS 版有一处**有意的行为差异**：TS 用 `Number(value)`，而
/// `Number('')` 是 0，`Number.isFinite(0)` 为真，所以 TS 版把
/// `MAX_TURNS=`（设了但留空）当成 0 接受，结果 ReAct 循环一轮都不跑。
/// Rust 的 `"".parse::<f64>()` 直接失败，这边选择保留这个更严格的行为：
/// 空值是配置错误，早报比静默跑出个 0 好。
/// 其余情况（非数字报错、错误消息文案）与 TS 一致，方便两版对照排查。
/// 注：parse 能接受 "inf" / "NaN"，所以仍要显式查 is_finite。
fn num_from_env(value: Option<String>, fallback: f64, name: &str) -> Result<f64> {
    let Some(value) = value else {
        return Ok(fallback);
    };
    match value.parse::<f64>() {
        Ok(n) if n.is_finite() => Ok(n),
        _ => bail!("{name} 必须是数字，得到的是 \"{value}\""),
    }
}
