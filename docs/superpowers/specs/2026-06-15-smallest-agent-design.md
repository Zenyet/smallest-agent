# smallest-agent — 设计文档

**日期:** 2026-06-15
**作者:** Roy Z（与 Claude Code 协作）
**状态:** 已批准设计（待用户复审）

## 1. 目标

用一个**最小但能真正跑起来**的 agent 项目，把 18 个 AI 工程核心概念串成一条线，**基于代码动手学习**，而不是孤立地学每个概念。

学习清单（18 个概念）：

> 提示词工程、上下文工程、工具调用、MCP、Skills、上下文压缩、记忆、RAG、微调、模型底层原理与调用参数（temperature 等）、模型优势与局限、Agent 开发框架、模型选型、缓存、降低幻觉、减少 token 消耗、降低延迟、限流降级（异常处理）、构建测试体系评估 Agent 效果。

核心方法论：**先跑通最小例子，再理解原理**。每个概念都不是孤立的——它们全都是「在那个 ~80 行循环的某个位置加一段代码」。

## 2. 关键决策（已确认）

| 维度 | 选择 | 理由 |
|------|------|------|
| 范围 | 规划全部 6 个阶段，**逐阶段实现**，每阶段一个 checkpoint | 既要 smallest，又要最终覆盖全部概念 |
| 语言 | TypeScript（Node 22 + pnpm 10） | 贴合用户前端技术栈，零学习成本 |
| SDK | **Vercel AI SDK** 作为「调模型 + 定义工具」层 | TS 生态主流方案、provider 无关 |
| 循环 | **手写 `while` 循环**，不用 SDK 的 `maxSteps` 自动循环 | 保持「smallest」，看清 agent 每一轮 |
| Provider | **DeepSeek**（OpenAI 兼容），全部走环境变量 | 用户现有 API 端点；一行切换其他 provider |
| 版本控制 | `lab/smallest-agent` + `git init`（main 分支） | 设计文档与代码都提交 |

**不用的东西：** LangChain、LlamaIndex、任何 Agent 框架——它们会把核心循环藏起来，偷走学习机会。

## 3. 核心架构

一个手写的 agent 循环（chat 里那段「50 行就是 agent 的灵魂」落地版）：

```
agent(userInput):
  messages = [system, user]
  for turn in 1..maxTurns:
    step = callModel(messages, tools)     # Vercel AI SDK，单轮，不自动循环
    messages.push(step.assistant)
    if step.toolCalls:
        for call in step.toolCalls:
            result = runTool(call.name, call.args)
            messages.push(toolResult(call.id, result))
        continue                          # 把工具结果喂回去，再问一次
    else:
        return step.text                  # 模型说「我搞定了」
  throw "exceeded maxTurns"               # 防止死循环
```

**保持透明的关键技巧：** 工具定义时**不挂 `execute` 函数**，于是 SDK 把 tool-calls 交还给「我」，由我自己执行并把结果 push 回 `messages`。用户看到的是循环本身，而不是黑箱。

每一轮都打印可读的 **trace**（模型说了什么、调了哪个工具、参数、返回值），让用户**看见**机制——这同时也是后面 eval / observability 阶段的种子。

## 4. 仓库结构（为 6 个阶段预留位置，当前只填 stage 0）

```
smallest-agent/
  src/
    agent.ts        # 循环本体（stage 0）
    llm.ts          # provider 封装，env 驱动（今天是 DeepSeek，可切换）
    tools/
      index.ts      # 工具注册表
      weather.ts    # 一个假工具，证明 tool-calling 跑通（stage 0）
    trace.ts        # 打印每一轮
    config.ts       # temperature / model / maxTurns 等
  cli.ts            # `pnpm dev "你的问题"`
  .env.example      # DEEPSEEK_API_KEY / BASE_URL / MODEL
  notes/            # 示例 markdown，给后面 RAG 阶段用
  README.md         # 6 阶段 × 18 概念的可勾选学习地图
  docs/superpowers/specs/  # 本设计文档
```

后续阶段都是**新增文件 + 循环里加几行**，绝不重写：

- stage 1：`tools/searchNotes.ts` + `rag.ts`
- stage 2：`memory.ts` + `compress.ts`
- stage 3：把工具注册表换成 MCP client
- stage 4：给 `llm.ts` 包一层 caching / retry / streaming
- stage 5：新增 `eval/`

## 5. 18 个概念 → 循环里的挂载点

| 概念 | 挂载在循环的哪 | 阶段 |
|------|----------------|------|
| 提示词工程 | `SYSTEM_PROMPT` | 0 |
| 上下文工程 | `messages` 构建处 | 0 |
| 温度等参数 | `callModel()` 参数 | 0 |
| 工具调用 | 工具定义 + runTool | 0 |
| 模型选型 | `llm.ts` 初始化（env） | 0 |
| 模型底层 / 优势局限 | 贯穿，trace 里观察 | 0+ |
| RAG | 一个 `search_notes` 工具 | 1 |
| 记忆 | `messages` 持久化 | 2 |
| 上下文压缩 | `messages` 太长时 | 2 |
| MCP | 工具来源（动态加载） | 3 |
| Skills | runTool 内部的能力包 | 3 |
| 缓存 | `callModel()` 之前/之中 | 4 |
| 省 token | 上下文裁剪 + 缓存 | 4 |
| 降延迟 | streaming + 模型选型 | 4 |
| 限流降级 | `callModel()` 外层 try-catch / fallback | 4 |
| 降幻觉 | system prompt + 工具 + verifier | 4 |
| 测试评估 | 整个 agent 外面套一层 | 5 |
| 微调 | 换掉 `llm` 用自己微调的模型 | 5（认知为主） |

## 6. 实现顺序（6 个阶段，逐阶段验收）

- **阶段 0 — 裸循环（先做这个）**：能真正跑的最小 agent，调一个假工具，打印 trace。覆盖 6 个概念：提示词工程、上下文工程、工具调用、工具定义、temperature/参数、模型选型。~80 行真代码。
- **阶段 1 — 真工具 + RAG**：接入示例笔记，加 `search_notes`（向量检索）。覆盖 RAG、embedding、工具设计。
- **阶段 2 — 记忆 + 上下文管理**：跨会话记忆（存 `messages`）；超长时做压缩/裁剪。覆盖记忆、上下文工程、上下文压缩。
- **阶段 3 — MCP + Skills**：把写死的工具改成从 MCP server 加载。覆盖 MCP 协议、Skills 模式。
- **阶段 4 — 生产化**：prompt caching（省 token）、streaming（降延迟）、try-catch + fallback（限流降级）、引用强制 + verifier（降幻觉）。
- **阶段 5 — Eval Harness**：给整个 agent 套评估系统，20-30 个测试用例自动跑分。覆盖测试体系、Eval，为 RL/微调打基础。

## 7. Stage 0 详细设计（本次先实现）

### 模块与职责

- **`config.ts`** — 从 env 读取并校验：`model`、`baseURL`、`apiKey`、`temperature`（默认 0）、`maxTurns`（默认 10）。单一出口，便于「模型选型 / 调参」一处改。
- **`llm.ts`** — provider 封装。用 Vercel AI SDK 的 OpenAI-compatible provider 指向 DeepSeek 的 `baseURL`。导出一个 `callModel(messages, tools)`，内部调 `generateText`，**单轮**（不自动跑工具），返回 `{ text, toolCalls, assistantMessage }`。换 provider 只改这里。
- **`tools/weather.ts`** — 一个假工具 `get_weather(city)`，返回写死的天气。证明 tool-calling 闭环。
- **`tools/index.ts`** — 工具注册表：名字 → `{ schema(用于给模型的定义，无 execute), run(args) }`。
- **`trace.ts`** — 把每一轮（assistant 文本 / tool_use / tool_result）打印成人类可读格式。
- **`agent.ts`** — 第 3 节那个 `while` 循环。带 `maxTurns` 上限防死循环。
- **`cli.ts`** — 读 `process.argv` 的问题，调 `agent()`，打印结果。

### 数据流

```
用户 → cli.ts → agent(question)
  → callModel(messages, tools)        # llm.ts → DeepSeek
  → 若 toolCalls：runTool → 结果回填 messages → 再 callModel
  → 否则返回 text → cli 打印
每一轮经过 trace.ts 打印
```

### 错误处理（stage 0 最小版）

- `maxTurns` 上限：超过抛错，避免无限循环。
- 工具执行包 try-catch：工具抛错 → 把错误信息作为 tool_result 回填，让模型自己决定怎么办（也是「错误恢复」的最小体感）。
- 缺 env：`config.ts` 启动即报清晰错误。
- 完整的 caching / retry / fallback / streaming 留到阶段 4。

### 验收标准（stage 0 完成的定义）

1. `pnpm install` 成功。
2. 填好 `.env`（DeepSeek key/baseURL/model）后，`pnpm dev "北京天气怎么样"` 能：调用 `get_weather`、把结果喂回模型、返回自然语言答案。
3. 终端打印出每一轮的 trace（看得见 tool_use 和 tool_result）。
4. 问一个**不需要工具**的问题（如「你好」）时，agent 直接回答、不调工具、一轮结束。
5. README 里有 6 阶段 × 18 概念的可勾选清单。

## 8. 阶段 1+ 的待定决策（到那一步再定，不在本次范围）

- **Embeddings（阶段 1）**：DeepSeek 无 embeddings API。倾向**本地 embedding**（transformers.js / fastembed，如 `bge-small`），保持无 key、自包含。
- **向量库（阶段 1）**：先用最小的**内存版 cosine 相似度**（看得见数学），再按需升级到 sqlite-vec 或 pgvector（用户真实技术栈）。
- **笔记来源**：仓库内置一小撮示例 markdown（`notes/`），先让它能跑；之后可指向用户真实 Obsidian vault。

## 9. 非目标（YAGNI）

- 不做对话式前端 UI（chat 里已论证：客户端 ≠ 学到 agent 本质）。
- stage 0 不做记忆、RAG、MCP、缓存、eval——它们各有专属阶段。
- 不引入任何 Agent 框架。
- 不在本项目里真的训练/微调模型（微调以认知与「可替换 llm」的接口体现）。
