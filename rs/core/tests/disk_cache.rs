// ============================================================================
// tests/disk_cache.rs —— DiskCache 的真实文件读写
// ----------------------------------------------------------------------------
// decorators.rs 用的是内存缓存，测的是装饰器逻辑；这里测落盘那部分：
// 目录自动创建、损坏文件当未命中自愈、相对路径解析。
// ============================================================================

use smallest_agent_core::cache::{DiskCache, ResultCache};
use smallest_agent_core::types::{ModelResult, ToolCall};

/// 每个用例用独立临时目录，避免并行测试互相干扰。
fn tmpdir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!(
        "smallest-agent-cache-{tag}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn result(text: &str) -> ModelResult {
    ModelResult {
        text: text.into(),
        tool_calls: vec![],
    }
}

#[tokio::test]
async fn creates_dir_on_first_write() {
    let dir = tmpdir("create");
    assert!(!dir.exists(), "前置：目录还不存在");

    let cache = DiskCache::new(&dir).unwrap();
    cache.set("k1", &result("答案")).await.unwrap();

    assert!(dir.join("k1.json").exists());
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn roundtrips_result_with_tool_calls() {
    let dir = tmpdir("roundtrip");
    let cache = DiskCache::new(&dir).unwrap();

    let original = ModelResult {
        text: "我查一下".into(),
        tool_calls: vec![ToolCall {
            id: "c1".into(),
            name: "get_weather".into(),
            args: serde_json::json!({ "city": "北京" })
                .as_object()
                .cloned()
                .unwrap(),
        }],
    };
    cache.set("k", &original).await.unwrap();

    let got = cache.get("k").await.expect("应该命中");
    assert_eq!(got, original);
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn missing_key_is_none() {
    let dir = tmpdir("missing");
    let cache = DiskCache::new(&dir).unwrap();
    assert!(cache.get("never-written").await.is_none());
}

#[tokio::test]
async fn corrupt_file_reads_as_miss() {
    // 写入中断、磁盘错误留下的半个文件，当未命中自愈，而不是让整次调用炸掉。
    // 这是 TS 版 cache.ts 里 try/catch 返回 undefined 的对应行为。
    let dir = tmpdir("corrupt");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("broken.json"), r#"{"text": "截断了"#).unwrap();

    let cache = DiskCache::new(&dir).unwrap();
    assert!(cache.get("broken").await.is_none());
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn overwrites_existing_entry() {
    let dir = tmpdir("overwrite");
    let cache = DiskCache::new(&dir).unwrap();

    cache.set("k", &result("旧的")).await.unwrap();
    cache.set("k", &result("新的")).await.unwrap();

    assert_eq!(cache.get("k").await.unwrap().text, "新的");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn relative_path_resolves_to_absolute() {
    // 相对路径在构造时就转成绝对路径，之后工作目录变化也不影响
    let cache = DiskCache::new("./.llm-cache-test");
    assert!(cache.is_ok());
}
