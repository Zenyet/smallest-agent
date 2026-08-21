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
fn requires_at_least_one_vendor_key() {
    // 一个 key 都没有才算缺失。报错要把所有可用的键名列出来 ——
    // 只提 DeepSeek 会让想用别家的人以为必须先注册 DeepSeek。
    let err = load_config_from(&env(&[])).unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("DEEPSEEK_API_KEY"), "{msg}");
    assert!(msg.contains("ANTHROPIC_API_KEY"), "{msg}");
}

#[test]
fn empty_api_key_is_also_missing() {
    // TS 那边 `if (!apiKey)` 把空字符串也当缺失，这里对齐
    let err = load_config_from(&env(&[("DEEPSEEK_API_KEY", "")])).unwrap_err();
    assert!(err.to_string().contains("DEEPSEEK_API_KEY"));
}

#[test]
fn any_vendor_key_is_enough() {
    // 这是加多厂商时修的那个 bug：只填了 Anthropic key 的用户
    // 原来连 app 都起不来，报错还让他去填 DeepSeek 的 key。
    let c = load_config_from(&env(&[("ANTHROPIC_API_KEY", "sk-ant-x")])).unwrap();
    assert_eq!(c.api_key, "sk-ant-x");
    assert_eq!(c.base_url, "https://api.anthropic.com/v1");
    // 模型和降级目标都跟着这家走，不能留 deepseek 的 id
    assert!(c.model.starts_with("claude-"), "model={}", c.model);
    assert!(
        c.fallback_model.starts_with("claude-"),
        "fallback={}",
        c.fallback_model
    );
}

#[test]
fn vendor_order_decides_who_wins_when_several_keys_are_set() {
    // vendors::ALL 的顺序说了算，DeepSeek 在第一 ——
    // 这保证老配置（只有 DeepSeek key）行为不变
    let c = load_config_from(&env(&[
        ("ANTHROPIC_API_KEY", "sk-ant"),
        ("DEEPSEEK_API_KEY", "sk-ds"),
    ]))
    .unwrap();
    assert_eq!(c.api_key, "sk-ds");
}

#[test]
fn builtin_endpoints_are_fixed_and_ignore_the_old_override_keys() {
    // `ANTHROPIC_BASE_URL` 这类覆盖键删掉了 —— 内置厂商的地址是常量，
    // 要指别的地方走自定义端点（下一个测试）。
    //
    // 这条锁的是「删干净了」：留一个看不见却仍然生效的覆盖，比没有覆盖
    // 更难查 —— 设置页上已经没有那一栏了。
    let c = load_config_from(&env(&[
        ("ANTHROPIC_API_KEY", "k"),
        ("ANTHROPIC_BASE_URL", "https://proxy.example.com/v1"),
    ]))
    .unwrap();
    assert_eq!(c.base_url, "https://api.anthropic.com/v1");
}

#[test]
fn a_custom_endpoint_alone_is_enough_to_start() {
    // 只跑本地模型的人：没有任何厂商的 key，app 也必须起得来。
    // 这是「自定义端点」这个条目要顶住的主线场景。
    let c = load_config_from(&env(&[
        ("CUSTOM_BASE_URL", "http://localhost:11434/v1/"),
        ("CUSTOM_MODELS", "llama3.1, qwen2.5:14b"),
    ]))
    .unwrap();
    // 末尾斜杠去掉了，否则拼成 //chat/completions
    assert_eq!(c.base_url, "http://localhost:11434/v1");
    // 模型取清单里第一个
    assert_eq!(c.model, "llama3.1");
    // 本地服务不校验 authorization，没 key 是合法状态
    assert_eq!(c.api_key, "");
}

#[test]
fn a_custom_endpoint_needs_both_an_address_and_a_model_list() {
    // 只填地址：选不出模型来，等于还没配完，报错要和「一个都没配」一样
    let err = load_config_from(&env(&[("CUSTOM_BASE_URL", "http://localhost:11434/v1")]))
        .unwrap_err();
    assert!(err.to_string().contains("CUSTOM_MODELS"), "{err}");
}

#[test]
fn builtin_keys_win_over_a_custom_endpoint_for_the_baseline() {
    // 两样都配了的时候基线走内置那家 —— 保证老配置行为不变。
    // 真正用哪家由会话绑定决定，基线只是 CLI 和「还没选过」时的兜底。
    let c = load_config_from(&env(&[
        ("DEEPSEEK_API_KEY", "sk-ds"),
        ("CUSTOM_BASE_URL", "http://localhost:11434/v1"),
        ("CUSTOM_MODELS", "llama3.1"),
    ]))
    .unwrap();
    assert_eq!(c.base_url, "https://api.deepseek.com/v1");
}

#[test]
fn legacy_deepseek_model_key_still_works() {
    // 老用户升级之后不该发现自己配的模型没生效了
    let c = load_config_from(&env(&[
        ("DEEPSEEK_API_KEY", "k"),
        ("DEEPSEEK_MODEL", "deepseek-reasoner"),
    ]))
    .unwrap();
    assert_eq!(c.model, "deepseek-reasoner");
}

#[test]
fn generic_model_key_takes_precedence() {
    let c = load_config_from(&env(&[
        ("DEEPSEEK_API_KEY", "k"),
        ("DEEPSEEK_MODEL", "old"),
        ("MODEL", "new"),
    ]))
    .unwrap();
    assert_eq!(c.model, "new");
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
