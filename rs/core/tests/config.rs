// ============================================================================
// tests/config.rs —— 环境变量解析（对应 TS 版 tests 里的 config 用例）
// ----------------------------------------------------------------------------
// 用 load_config_from 注入假 env，不碰真实进程环境，测试之间互不干扰
// （std::env::set_var 是全局状态，并行测试会打架，所以 core 里刻意不用它）。
// ============================================================================

use std::collections::HashMap;

use smallest_agent_core::config::{SYSTEM_PROMPT, load_config_from};

fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
    let map: HashMap<String, String> = pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    move |k: &str| map.get(k).cloned()
}

#[test]
fn requires_api_key() {
    let err = load_config_from(&env(&[])).unwrap_err();
    assert!(err.to_string().contains("Missing DEEPSEEK_API_KEY"));
}

#[test]
fn empty_api_key_is_also_missing() {
    // TS 那边 `if (!apiKey)` 把空字符串也当缺失，这里对齐
    let err = load_config_from(&env(&[("DEEPSEEK_API_KEY", "")])).unwrap_err();
    assert!(err.to_string().contains("Missing DEEPSEEK_API_KEY"));
}

#[test]
fn fills_defaults() {
    let c = load_config_from(&env(&[("DEEPSEEK_API_KEY", "sk-x")])).unwrap();
    assert_eq!(c.base_url, "https://api.deepseek.com/v1");
    assert_eq!(c.model, "deepseek-chat");
    assert_eq!(c.temperature, 0.0);
    assert_eq!(c.max_turns, 10);
    assert_eq!(c.session_id, "default");
    assert_eq!(c.max_context_tokens, 2000);
    assert_eq!(c.keep_recent, 6);
    assert_eq!(c.max_retries, 2);
    assert_eq!(c.system_prompt, SYSTEM_PROMPT);
    // 缓存和流式默认开
    assert!(c.cache_enabled);
    assert!(c.stream);
}

#[test]
fn fallback_model_follows_primary_when_unset() {
    // FALLBACK_MODEL 没设 → 跟主模型一样，等于「不切换」
    let c = load_config_from(&env(&[
        ("DEEPSEEK_API_KEY", "sk-x"),
        ("DEEPSEEK_MODEL", "deepseek-reasoner"),
    ]))
    .unwrap();
    assert_eq!(c.model, "deepseek-reasoner");
    assert_eq!(c.fallback_model, "deepseek-reasoner");
}

#[test]
fn fallback_model_can_be_set_independently() {
    let c = load_config_from(&env(&[
        ("DEEPSEEK_API_KEY", "sk-x"),
        ("DEEPSEEK_MODEL", "deepseek-reasoner"),
        ("FALLBACK_MODEL", "deepseek-chat"),
    ]))
    .unwrap();
    assert_eq!(c.fallback_model, "deepseek-chat");
}

#[test]
fn only_zero_disables_cache_and_stream() {
    let off = load_config_from(&env(&[
        ("DEEPSEEK_API_KEY", "sk-x"),
        ("LLM_CACHE", "0"),
        ("STREAM", "0"),
    ]))
    .unwrap();
    assert!(!off.cache_enabled);
    assert!(!off.stream);

    // 任何其他值都视为开启，包括 "false"（这是 TS 版的行为，照搬）
    let on = load_config_from(&env(&[
        ("DEEPSEEK_API_KEY", "sk-x"),
        ("LLM_CACHE", "false"),
        ("STREAM", "no"),
    ]))
    .unwrap();
    assert!(on.cache_enabled);
    assert!(on.stream);
}

#[test]
fn rejects_non_numeric() {
    let err =
        load_config_from(&env(&[("DEEPSEEK_API_KEY", "sk-x"), ("MAX_TURNS", "abc")])).unwrap_err();
    assert!(err.to_string().contains("MAX_TURNS 必须是数字"));
    assert!(err.to_string().contains("\"abc\""));
}

#[test]
fn rejects_infinity() {
    // parse::<f64>() 能接受 "inf"，得靠 is_finite 拦住
    let err = load_config_from(&env(&[
        ("DEEPSEEK_API_KEY", "sk-x"),
        ("TEMPERATURE", "inf"),
    ]))
    .unwrap_err();
    assert!(err.to_string().contains("TEMPERATURE 必须是数字"));
}

#[test]
fn rejects_empty_number_unlike_ts() {
    // 有意与 TS 不同：TS 的 Number('') === 0 会静默把 MAX_TURNS 变成 0，
    // 循环一轮都不跑；这边当配置错误报出来。见 config.rs 里 num_from_env 的注释。
    let err =
        load_config_from(&env(&[("DEEPSEEK_API_KEY", "sk-x"), ("MAX_TURNS", "")])).unwrap_err();
    assert!(err.to_string().contains("MAX_TURNS 必须是数字"));
}
