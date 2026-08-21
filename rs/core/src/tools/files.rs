// ============================================================================
// tools/files.rs —— 文件工具：列目录 / 读 / 写 / 改 / 找
// ----------------------------------------------------------------------------
// 全部经过 Workspace 解析路径，越界的直接报错回给模型（见 workspace.rs）。
//
// ## 为什么自己实现，而不是继续用 MCP 的 filesystem server
//
// 那条路是通的，而且现在就配着一个。但它有三个实际问题：
//
//   1. 要 node + npx。用户装没装、网络能不能拉包，都不在我们控制内，
//      而「agent 会不会读文件」不该取决于这个
//   2. 起子进程要时间，第一次尤其慢
//   3. **它现在指向一个临时目录**（用户配置里就是 /var/.../tmp.xxx），
//      重启就换一个，写进去的东西第二天就没了
//
// 内置这几个是「开箱就有」的保底。MCP 那条路继续留着 —— 它负责的是
// 我们没内置的能力（数据库、GitHub、公司内部系统）。
//
// ## 命名对齐 approval.rs 的名单
//
// 写类工具叫 `write_file` / `edit_file` / `create_directory`，
// 正好落在 needs_approval 的名单里，所以它们自动会弹审批卡。
// 改名字之前先去看那张名单，否则会**静默失去审批**。
// ============================================================================

use std::sync::Arc;

use anyhow::{Context as _, Result, bail};
use async_trait::async_trait;
use serde_json::{Value, json};

use crate::types::{Args, Tool, ToolRegistry};
use crate::workspace::Workspace;

/// 单文件读取上限。
///
/// 超过就截断而不是报错 —— 模型要的通常是文件开头那部分（看看这是什么），
/// 而报错会让它以为文件不可用。截断时明确告诉它截了，它可以再用
/// offset 读后面。
const MAX_READ_BYTES: usize = 256 * 1024;

/// 列目录时最多返回多少条。
const MAX_ENTRIES: usize = 500;

/// 搜索时最多返回多少条命中。
const MAX_MATCHES: usize = 200;

/// 取一个字符串参数。
fn str_arg(args: &Args, key: &str) -> Result<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .with_context(|| format!("缺少参数 {key}"))
}

// ============================================================================
// list_directory
// ============================================================================

pub struct ListDirectory(pub Arc<Workspace>);

#[async_trait]
impl Tool for ListDirectory {
    fn name(&self) -> &str {
        "list_directory"
    }
    fn description(&self) -> &str {
        "列出工作目录里某个目录的内容。path 省略则列工作目录本身。\
         返回每一项的名字、是文件还是目录、以及文件大小。"
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "相对工作目录的路径，省略表示工作目录根"
                }
            }
        })
    }
    async fn run(&self, args: &Args) -> Result<Value> {
        // path 省略 = 列根目录。这是最常见的第一步（「看看有什么」），
        // 强制要求参数只会让模型多猜一次
        let raw = args
            .get("path")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(".");
        let dir = self.0.resolve(raw)?;
        let mut rd = tokio::fs::read_dir(&dir)
            .await
            .with_context(|| format!("读目录失败：{}", self.0.relative(&dir)))?;

        let mut entries = Vec::new();
        let mut truncated = false;
        while let Some(e) = rd.next_entry().await? {
            if entries.len() >= MAX_ENTRIES {
                truncated = true;
                break;
            }
            let meta = e.metadata().await.ok();
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            entries.push(json!({
                "name": e.file_name().to_string_lossy(),
                "type": if is_dir { "dir" } else { "file" },
                "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
            }));
        }
        // 目录在前、同类按名字排 —— 顺序稳定，模型多次调用看到的一致
        entries.sort_by(|a, b| {
            let ka = (a["type"] != "dir", a["name"].as_str().unwrap_or("").to_string());
            let kb = (b["type"] != "dir", b["name"].as_str().unwrap_or("").to_string());
            ka.cmp(&kb)
        });

        Ok(json!({
            "path": self.0.relative(&dir),
            "entries": entries,
            "truncated": truncated,
        }))
    }
}

// ============================================================================
// read_file
// ============================================================================

pub struct ReadFile(pub Arc<Workspace>);

#[async_trait]
impl Tool for ReadFile {
    fn name(&self) -> &str {
        "read_file"
    }
    fn description(&self) -> &str {
        "读取工作目录里一个文本文件的内容。文件很大时会截断。"
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "相对工作目录的文件路径" }
            },
            "required": ["path"]
        })
    }
    async fn run(&self, args: &Args) -> Result<Value> {
        let path = self.0.resolve(&str_arg(args, "path")?)?;
        let bytes = tokio::fs::read(&path)
            .await
            .with_context(|| format!("读文件失败：{}", self.0.relative(&path)))?;

        let total = bytes.len();
        let truncated = total > MAX_READ_BYTES;
        let slice = if truncated {
            &bytes[..MAX_READ_BYTES]
        } else {
            &bytes[..]
        };
        // 二进制文件用 from_utf8_lossy 会得到一堆 U+FFFD，对模型是纯噪音。
        // 明确告诉它这是二进制，比塞一屏乱码有用
        let text = match std::str::from_utf8(slice) {
            Ok(t) => t.to_string(),
            Err(_) if truncated => String::from_utf8_lossy(slice).to_string(),
            Err(_) => {
                return Ok(json!({
                    "path": self.0.relative(&path),
                    "error": "这是二进制文件，不是文本，读不了",
                    "size": total,
                }));
            }
        };

        Ok(json!({
            "path": self.0.relative(&path),
            "content": text,
            "size": total,
            "truncated": truncated,
        }))
    }
}

// ============================================================================
// write_file —— 走审批
// ============================================================================

pub struct WriteFile(pub Arc<Workspace>);

#[async_trait]
impl Tool for WriteFile {
    fn name(&self) -> &str {
        "write_file"
    }
    fn description(&self) -> &str {
        "把内容写进工作目录里的一个文件（覆盖已有内容）。父目录会自动创建。"
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "相对工作目录的文件路径" },
                "content": { "type": "string", "description": "要写入的完整内容" }
            },
            "required": ["path", "content"]
        })
    }
    async fn run(&self, args: &Args) -> Result<Value> {
        let path = self.0.resolve(&str_arg(args, "path")?)?;
        let content = str_arg(args, "content")?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("建目录失败：{}", self.0.relative(parent)))?;
        }
        tokio::fs::write(&path, content.as_bytes())
            .await
            .with_context(|| format!("写文件失败：{}", self.0.relative(&path)))?;
        Ok(json!({
            "path": self.0.relative(&path),
            "written": content.len(),
        }))
    }
}

// ============================================================================
// edit_file —— 走审批
// ============================================================================

pub struct EditFile(pub Arc<Workspace>);

#[async_trait]
impl Tool for EditFile {
    fn name(&self) -> &str {
        "edit_file"
    }
    fn description(&self) -> &str {
        "把文件里的一段文本替换成另一段。old_text 必须在文件中**恰好出现一次**，\
         否则会报错并告诉你出现了几次 —— 这时请带上更多上下文重试。"
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "相对工作目录的文件路径" },
                "old_text": { "type": "string", "description": "要被替换的原文，需唯一" },
                "new_text": { "type": "string", "description": "替换成的新文本" }
            },
            "required": ["path", "old_text", "new_text"]
        })
    }
    async fn run(&self, args: &Args) -> Result<Value> {
        let path = self.0.resolve(&str_arg(args, "path")?)?;
        let old = str_arg(args, "old_text")?;
        let new = str_arg(args, "new_text")?;
        if old.is_empty() {
            bail!("old_text 不能为空 —— 那样无法定位要改哪里");
        }

        let text = tokio::fs::read_to_string(&path)
            .await
            .with_context(|| format!("读文件失败：{}", self.0.relative(&path)))?;

        // 要求唯一匹配。这是防「改错地方」最有效的一条约束：
        // 出现多次时替换第一个几乎总是错的，而模型看到计数之后
        // 会自己带更多上下文重试。
        let count = text.matches(&old).count();
        if count == 0 {
            bail!(
                "在 {} 里没找到 old_text。文件可能和你以为的不一样，先 read_file 看一眼。",
                self.0.relative(&path)
            );
        }
        if count > 1 {
            bail!(
                "old_text 在 {} 里出现了 {} 次，必须唯一。请带上更多上下文再试。",
                self.0.relative(&path),
                count
            );
        }

        let updated = text.replacen(&old, &new, 1);
        tokio::fs::write(&path, updated.as_bytes())
            .await
            .with_context(|| format!("写文件失败：{}", self.0.relative(&path)))?;
        Ok(json!({
            "path": self.0.relative(&path),
            "replaced": 1,
        }))
    }
}

// ============================================================================
// search_files —— 在工作目录里按内容找
// ============================================================================

pub struct SearchFiles(pub Arc<Workspace>);

#[async_trait]
impl Tool for SearchFiles {
    fn name(&self) -> &str {
        "search_files"
    }
    fn description(&self) -> &str {
        "在工作目录里递归搜索包含某段文本的文件，返回文件路径、行号和那一行的内容。"
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "要找的文本（区分大小写）" },
                "path": { "type": "string", "description": "从哪个子目录开始找，省略则整个工作目录" }
            },
            "required": ["query"]
        })
    }
    async fn run(&self, args: &Args) -> Result<Value> {
        let query = str_arg(args, "query")?;
        if query.is_empty() {
            bail!("query 不能为空");
        }
        let raw = args
            .get("path")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(".");
        let root = self.0.resolve(raw)?;

        let mut matches = Vec::new();
        let mut stack = vec![root];
        let mut truncated = false;

        while let Some(dir) = stack.pop() {
            if truncated {
                break;
            }
            let Ok(mut rd) = tokio::fs::read_dir(&dir).await else {
                continue;
            };
            while let Ok(Some(e)) = rd.next_entry().await {
                let p = e.path();
                let Ok(meta) = e.metadata().await else { continue };
                if meta.is_dir() {
                    // 跳过这些：它们体积大、内容对用户没意义，
                    // 扫进去只会把结果淹没并拖慢搜索
                    let name = e.file_name();
                    let name = name.to_string_lossy();
                    if matches!(
                        name.as_ref(),
                        ".git" | "node_modules" | "target" | ".venv" | "__pycache__"
                    ) {
                        continue;
                    }
                    stack.push(p);
                    continue;
                }
                // 大文件跳过：多半是二进制或数据文件
                if meta.len() as usize > MAX_READ_BYTES {
                    continue;
                }
                let Ok(text) = tokio::fs::read_to_string(&p).await else {
                    // 读不成 UTF-8 = 二进制，跳过而不是报错
                    continue;
                };
                for (i, line) in text.lines().enumerate() {
                    if line.contains(&query) {
                        if matches.len() >= MAX_MATCHES {
                            truncated = true;
                            break;
                        }
                        matches.push(json!({
                            "path": self.0.relative(&p),
                            "line": i + 1,
                            // 单行也可能极长（压缩过的 js），截一下
                            "text": line.chars().take(300).collect::<String>(),
                        }));
                    }
                }
                if truncated {
                    break;
                }
            }
        }

        Ok(json!({
            "query": query,
            "matches": matches,
            "truncated": truncated,
        }))
    }
}

// ============================================================================
// create_directory —— 走审批
// ============================================================================

pub struct CreateDirectory(pub Arc<Workspace>);

#[async_trait]
impl Tool for CreateDirectory {
    fn name(&self) -> &str {
        "create_directory"
    }
    fn description(&self) -> &str {
        "在工作目录里创建一个目录（含中间层级）。"
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "相对工作目录的目录路径" }
            },
            "required": ["path"]
        })
    }
    async fn run(&self, args: &Args) -> Result<Value> {
        let path = self.0.resolve(&str_arg(args, "path")?)?;
        tokio::fs::create_dir_all(&path)
            .await
            .with_context(|| format!("建目录失败：{}", self.0.relative(&path)))?;
        Ok(json!({ "path": self.0.relative(&path), "created": true }))
    }
}

/// 把文件工具装进注册表。
pub fn register(registry: &mut ToolRegistry, ws: Arc<Workspace>) {
    registry.insert("list_directory".into(), Arc::new(ListDirectory(ws.clone())));
    registry.insert("read_file".into(), Arc::new(ReadFile(ws.clone())));
    registry.insert("write_file".into(), Arc::new(WriteFile(ws.clone())));
    registry.insert("edit_file".into(), Arc::new(EditFile(ws.clone())));
    registry.insert("search_files".into(), Arc::new(SearchFiles(ws.clone())));
    registry.insert("create_directory".into(), Arc::new(CreateDirectory(ws)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;

    fn temp_ws() -> Arc<Workspace> {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "sa-files-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        Arc::new(Workspace::new(&dir).expect("建沙盒"))
    }

    fn args(pairs: &[(&str, &str)]) -> Args {
        let mut m = Map::new();
        for (k, v) in pairs {
            m.insert(k.to_string(), json!(v));
        }
        m
    }

    #[tokio::test]
    async fn write_then_read_roundtrips() {
        let ws = temp_ws();
        let w = WriteFile(ws.clone());
        w.run(&args(&[("path", "a/b.txt"), ("content", "你好")]))
            .await
            .expect("写该成功");
        let r = ReadFile(ws.clone());
        let out = r.run(&args(&[("path", "a/b.txt")])).await.expect("读该成功");
        assert_eq!(out["content"], "你好");
        assert_eq!(out["truncated"], false);
    }

    #[tokio::test]
    async fn write_outside_the_sandbox_is_refused() {
        // 沙盒的意义就在这一条
        let ws = temp_ws();
        let w = WriteFile(ws.clone());
        assert!(
            w.run(&args(&[("path", "../escaped.txt"), ("content", "x")]))
                .await
                .is_err()
        );
        assert!(
            w.run(&args(&[("path", "/tmp/escaped.txt"), ("content", "x")]))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn edit_requires_a_unique_match() {
        let ws = temp_ws();
        WriteFile(ws.clone())
            .run(&args(&[("path", "f.txt"), ("content", "a\na\nb")]))
            .await
            .unwrap();
        let e = EditFile(ws.clone());
        // 出现两次：必须拒绝，而且报错要带上次数，模型才知道怎么补救
        let err = e
            .run(&args(&[
                ("path", "f.txt"),
                ("old_text", "a"),
                ("new_text", "c"),
            ]))
            .await
            .expect_err("多处匹配该报错");
        assert!(err.to_string().contains('2'), "{err}");

        // 唯一匹配：该成功
        e.run(&args(&[
            ("path", "f.txt"),
            ("old_text", "a\nb"),
            ("new_text", "z"),
        ]))
        .await
        .expect("唯一匹配该成功");
        let out = ReadFile(ws).run(&args(&[("path", "f.txt")])).await.unwrap();
        assert_eq!(out["content"], "a\nz");
    }

    #[tokio::test]
    async fn edit_missing_text_tells_the_model_to_read_first() {
        let ws = temp_ws();
        WriteFile(ws.clone())
            .run(&args(&[("path", "f.txt"), ("content", "hello")]))
            .await
            .unwrap();
        let err = EditFile(ws)
            .run(&args(&[
                ("path", "f.txt"),
                ("old_text", "nope"),
                ("new_text", "x"),
            ]))
            .await
            .expect_err("找不到该报错");
        assert!(err.to_string().contains("read_file"), "{err}");
    }

    #[tokio::test]
    async fn list_directory_defaults_to_the_root_and_sorts_dirs_first() {
        let ws = temp_ws();
        WriteFile(ws.clone())
            .run(&args(&[("path", "z.txt"), ("content", "x")]))
            .await
            .unwrap();
        CreateDirectory(ws.clone())
            .run(&args(&[("path", "adir")]))
            .await
            .unwrap();
        // 不传 path：该列根目录而不是报错
        let out = ListDirectory(ws).run(&Map::new()).await.expect("该成功");
        let entries = out["entries"].as_array().unwrap();
        assert_eq!(entries[0]["type"], "dir", "目录该排在前面");
        assert_eq!(entries[0]["name"], "adir");
    }

    #[tokio::test]
    async fn search_finds_content_with_line_numbers() {
        let ws = temp_ws();
        WriteFile(ws.clone())
            .run(&args(&[("path", "a.txt"), ("content", "one\nneedle\nthree")]))
            .await
            .unwrap();
        let out = SearchFiles(ws)
            .run(&args(&[("query", "needle")]))
            .await
            .expect("该成功");
        let m = out["matches"].as_array().unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m[0]["line"], 2);
        assert_eq!(m[0]["path"], "a.txt");
    }

    #[tokio::test]
    async fn read_reports_binary_instead_of_returning_garbage() {
        // 二进制读成 lossy 会给模型一屏 U+FFFD，纯噪音
        let ws = temp_ws();
        let p = ws.root().join("bin.dat");
        tokio::fs::write(&p, [0xff_u8, 0xfe, 0x00, 0x01]).await.unwrap();
        let out = ReadFile(ws).run(&args(&[("path", "bin.dat")])).await.unwrap();
        assert!(out["error"].as_str().unwrap_or("").contains("二进制"));
    }

    #[test]
    fn write_tools_are_covered_by_the_approval_list() {
        // 这几个名字必须落在 approval.rs 的危险名单里，否则**静默失去审批**。
        // 改名字的话这条测试会立刻红。
        use crate::approval::needs_approval;
        assert!(needs_approval("write_file"));
        assert!(needs_approval("edit_file"));
        assert!(needs_approval("create_directory"));
        // 只读的不该被拦，否则每次列目录都要用户点一下
        assert!(!needs_approval("read_file"));
        assert!(!needs_approval("list_directory"));
        assert!(!needs_approval("search_files"));
    }
}
