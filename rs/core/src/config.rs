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

use anyhow::{Result, anyhow, bail};

use crate::types::Config;

/// 系统提示：约束模型行为的「全局指令」，每次调模型时作为首条 system 消息注入。
///
/// 两条关键约束：
///   1. 有外部数据需求时调工具，不要凭空编造（防幻觉）
///   2. 用到 RAG 检索结果时注明来源文件名（Stage 3 加的溯源要求）
pub const SYSTEM_PROMPT: &str = concat!(
    "你是一个简洁、诚实的中文助手。当需要外部信息（如天气、笔记）时调用提供的工具，不要凭空编造；信息足够时直接回答。",
    "当回答用到 search_notes 或读取文件得到的内容时，在末尾注明来源文件名（如：来源：01-rag.md）。"
);

/// 从真实进程环境读配置。
pub fn load_config() -> Result<Config> {
    load_config_from(&|key| std::env::var(key).ok())
}

/// 从任意「取值函数」读配置。测试传一个查 HashMap 的闭包即可。
pub fn load_config_from(get: &dyn Fn(&str) -> Option<String>) -> Result<Config> {
    // 只有 API key 是强制必填，其余都有合理默认值。
    let api_key = get("DEEPSEEK_API_KEY")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Missing DEEPSEEK_API_KEY（把 .env.example 复制成 .env 并填好）"))?;

    let model = get("DEEPSEEK_MODEL");

    Ok(Config {
        api_key,
        base_url: get("DEEPSEEK_BASE_URL").unwrap_or_else(|| "https://api.deepseek.com/v1".into()),
        model: model.clone().unwrap_or_else(|| "deepseek-chat".into()),
        // temperature=0 → 输出更确定/一致，适合工具调用场景；调高更「有创意」但不稳定
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

        // fallback_model 优先用独立变量，没设就跟主模型一样——退化成「不切换」
        fallback_model: get("FALLBACK_MODEL")
            .or(model)
            .unwrap_or_else(|| "deepseek-chat".into()),
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
