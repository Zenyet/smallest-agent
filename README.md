# smallest-agent

用一个最小但能真正跑起来的 agent，把 18 个 AI 工程核心概念串成一条线，基于代码动手学习。
方法论：**先跑通最小例子，再理解原理**。核心就是一个手写的 `while` 循环——每个概念都是「在循环的某个位置加一段代码」。

## 两个入口：CLI 和桌面版

同一套 agent 核心（`src/`），两个入口：

| | 命令行 | 桌面版 |
|---|---|---|
| 启动 | `pnpm dev "你的问题"` | `pnpm dev:electron` |
| 打包 | - | `pnpm package:mac` |
| 入口文件 | `cli.ts` | `electron/main/index.ts` |
| 适合 | 读代码、看 trace、跑 eval | 日常使用、多会话 |

**建议的阅读顺序：先 CLI 再桌面版。** `cli.ts` 把整条装配线写在一个文件里，从上往下读就能看懂 agent 是怎么组装起来的；桌面版是同一条装配线拆成「启动时一次」和「每条消息一次」两段，先理解了单次版本再看拆分才不会绕。

桌面版的架构说明见 [`electron/README.md`](electron/README.md)。

## 快速开始

```bash
pnpm install
cp .env.example .env   # 填入 DeepSeek 的 key / baseURL / model

# 命令行
pnpm dev "北京天气怎么样"

# 桌面版（首次启动后在设置面板填入 API Key）
pnpm dev:electron

# 测试
pnpm test              # 266 个测试（CLI + 桌面版）
```

## Stage 0 在做什么

一个手写 agent 循环（`src/agent.ts`）：调模型 → 若要调工具则执行并把结果喂回 → 否则返回答案。
工具定义不挂 `execute`，所以 SDK 把 tool-call 交还给我们自己执行——循环看得见。

## Stage 1 在做什么

RAG 不是新架构，只是注册表里多了一个 `search_notes` 工具——agent 循环一行没改。
启动时读 `notes/` → 切块 → 本地 embedding → 建内存向量库；提问时模型按需调 `search_notes`，
用余弦相似度取回最相关片段再作答。换更大的向量库（pgvector / sqlite-vec）只需替换 `src/rag/store.ts`，接口不变。

> embedding 模型默认 `Xenova/multilingual-e5-small`（多语言，含中文），首次运行会从 HuggingFace 下载。
> 想指向你真实的 Obsidian vault：设置 `NOTES_DIR=/path/to/vault`。

## Stage 2 在做什么

`runAgent` 开局把上次会话的 messages（存在 `.sessions/<id>.json`）塞回 system 与本轮 user 之间，跑完再存回——这就是「记忆」。
历史超过 `MAX_CONTEXT_TOKENS`（粗估 ~4 字符/token）时，把 system 与最近 `KEEP_RECENT` 条之间的老消息用 DeepSeek 摘成一条「对话摘要」，省 token、不爆上下文。

> 看记忆：`SESSION_ID=demo pnpm dev "我叫 Roy"` 再 `SESSION_ID=demo pnpm dev "我叫啥"`。
> 看压缩：把 `MAX_CONTEXT_TOKENS` 调到很小（如 50），多聊几轮，trace/会话文件里会出现「【之前对话摘要】」。
> 换新会话：换一个 `SESSION_ID`，或删掉 `.sessions/<id>.json`。

## Stage 3 在做什么

工具不再写死在代码里。`cli.ts` 启动时起一个 stdio MCP server（`mcp-server.ts`），`tools/list` 动态发现工具，转成注册表喂给 agent；`runTool` 对 MCP 工具走 `tools/call`。往 server 加个工具，agent 不改一行就能用。
`get_weather` 已搬进 MCP server；`search_notes` 因为要进程内向量库留本地——演示「本地 + MCP 两种来源合并成一个注册表」。
Skills 做成 `skills/*.md`：模型先 `list_skills` 看有哪些，需要时再 `get_skill` 拉全文——真实 Claude Skills 的「渐进披露」。

> 试试：`pnpm dev "用 code-review 技能评审：function add(a,b){return a-b}"`，看它先 list_skills、再 get_skill、按技能要点作答。

此外 `cli.ts` 还**额外连了一个我们没写的 server**——官方的 `@modelcontextprotocol/server-filesystem`（指向 `./notes`），它的 `list_directory`/`read_file` 等工具被同样合并进注册表。这证明：写一次 MCP client，即插即用任何人写的 server。

> 试试：`pnpm dev "列出我 notes 目录里有哪些文件"`，看 agent 调外部 fs server 的工具读你的笔记目录。
> 注意：fs server 对 `./notes` 有读写权限，别让它删/改东西；换目录用 `MCP_FS_DIR=/some/dir`。

## Stage 4a 在做什么

三层可组合的生产包装套在 `callModel` 外面（agent 循环不变）：
- `withRetry`：429/5xx/超时等瞬时错误指数退避重试。
- `withFallback`：主模型连续失败 → 切到 `FALLBACK_MODEL`。
- `withCache`：按 `sha256(model+messages)` 磁盘缓存 `ModelResult`，同样的请求第二次秒回、零 token。

> 看缓存：同一问题在两个干净会话各跑一次——第二次会打印「🟢 LLM 缓存命中」、几乎瞬时。
> `LLM_CACHE=0` 关缓存；`FALLBACK_MODEL=deepseek-reasoner` 配备用模型；`MAX_RETRIES=3` 调重试。
> 缓存只增不删（无 TTL），清空用 `rm -rf .llm-cache`。每个模型按自己的 id 各自缓存。

## Stage 4b 在做什么

- 降延迟：`makeCallModel(config, registry, onText)` 给了 `onText` 就走 `streamText`，最终答案逐字出现；对 retry/fallback/cache 透明（缓存命中不流式）。`STREAM=0` 关闭。
- 降幻觉：system prompt 要求用到检索/文件内容时注明来源文件名；答案产出后，`makeVerifier`（LLM-as-Judge）拿「问题 + 工具证据 + 答案」让另一个 LLM 判断答案是否被证据支撑，不支撑就打印 ⚠️ 及问题清单。

> 试试：`pnpm dev "根据我的笔记，chunking 为什么重要？"`——答案逐字出现、末尾带（来源：01-rag.md），随后一行 ✅ 核查。
> 故意诱导幻觉：`pnpm dev "根据我的笔记，介绍一下 Rust 的所有权"`（笔记里没有）——看裁判会不会标 ⚠️。

## Stage 5 在做什么

给整个 agent 套评估系统：`evals/cases.ts` 放声明式用例，`runEvalSuite` 对每个用例跑 agent、按 `expect` 选打分器评分、聚合成成绩单。
打分器两类：程序化（contains/toolUsed/cites/refuses）+ LLM-as-Judge（rubric 评分，开放式答案没法字符串匹配只能让模型评）。
harness 与裁判都注入，所以逻辑可确定性单测；`pnpm eval` 才接真 agent。

> 跑分：`pnpm eval`（需 DeepSeek key，会真跑每个用例）。结果写入 `eval-results.json`。
> 这份结果就是「会增值的测试集 / RL 与微调的种子数据」的最小形态——改 prompt/换模型后再跑，看分数涨没涨。
> 微调：本项目不真训练；它体现在「换 `DEEPSEEK_MODEL` 就换模型」这个可替换接口，和 eval 产出的数据资产上。

## 6 阶段 × 18 概念 学习地图

### 阶段 0 — 裸循环 ✅
- [x] 提示词工程（`SYSTEM_PROMPT`）
- [x] 上下文工程（`messages` 数组）
- [x] 温度等参数（`config.temperature`）
- [x] 工具调用 / 工具定义（`tools/` + `runTool`）
- [x] 模型选型（`llm.ts`，env 驱动）
- [x] 模型底层 / 优势局限（trace 里观察）

### 阶段 1 — 真工具 + RAG ✅
- [x] RAG（`search_notes` 工具）
- [x] embedding / 向量检索（本地 transformers.js + 内存余弦库）
- [x] chunking（`src/rag/chunk.ts`）

### 阶段 2 — 记忆 + 上下文管理 ✅
- [x] 记忆（JSON 文件持久化 messages，按 SESSION_ID 分会话）
- [x] 上下文压缩（超 token 预算时 LLM 摘要老消息）

### 阶段 3 — MCP + Skills ✅
- [x] MCP（工具从 stdio MCP server 动态加载，agent 不写死工具）
- [x] Skills（skills/*.md，经 list_skills/get_skill 渐进披露）

### 阶段 4 — 生产化 ✅
- [x] 缓存 / 省 token（withCache，磁盘缓存）
- [x] 限流降级（withRetry 指数退避 + withFallback 切备用模型）
- [x] 降延迟（streamText 流式打印最终答案）
- [x] 降幻觉（引用来源 + LLM-as-Judge verifier 核查）

### 阶段 5 — Eval Harness ✅
- [x] 测试体系 / Eval（runEvalSuite：程序化 + LLM-as-Judge，`pnpm eval`）
- [x] 微调（认知 + 可替换 llm 接口：换 `DEEPSEEK_MODEL` 即换模型；eval-results.json 作种子数据）

## 结构

```
src/agent.ts   循环本体
src/llm.ts     真实模型调用（仅此文件碰 SDK）
src/tools/     runTool（工具执行器）
src/config.ts  env 驱动配置
src/trace.ts   每一轮可读输出
src/rag/       chunk / similarity / store / embed / index（RAG 全套）
src/memory/    store / compact / summarize（记忆 + 压缩）
src/mcp/       MCP client（connectMcp + loadMcpTools）
mcp-server.ts  stdio MCP server（get_weather + skills）
skills/        技能 markdown（渐进披露）
cli.ts         CLI 入口
src/resilience.ts  withRetry + withFallback（限流降级）
src/cache.ts       磁盘 LLM 缓存（省 token）
src/verify.ts      LLM-as-Judge 证据核查（降幻觉）
src/eval/      scorers + harness（评估打分）
evals/cases.ts 评估用例
eval.ts        pnpm eval 入口

electron/main/      主进程：App 级装配 + IPC + agent 执行
electron/renderer/  前端：React 聊天界面
electron/shared/    两端共用的 IPC 频道与事件类型
```
