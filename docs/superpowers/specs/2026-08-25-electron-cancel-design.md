# Electron 桌面版：agent 取消（轮边界）

> 这是「把 rs/ 侧独有能力同步回 TS 侧」这条线的第 1 个子项目。
> 全线共 5 个子项目，拆分与顺序见文末「上下文：这是 5 个子项目里的第 1 个」。

## 要解决什么

`electron/README.md` 的「已知限制」里有两条，它们其实是同一个问题：

- **无 agent 取消** —— 一个 turn 跑起来就停不下来，要停只能退出程序。
- **正在跑的会话不能删** —— 上一条的直接后果。删掉文件也没用，那一轮还会跑完，
  `onComplete` 里的 `sessions.save()` 会无条件把文件写回来，会话就「复活」了。
  所以主进程直接拒绝，返回 `DELETE_BLOCKED`。

README 把原因记成 `src/agent.ts` 的限制（「它不接受 AbortSignal」），并由此认为
桌面版只能继承这个限制。**这个结论是错的**，下面那节解释为什么。

rs 侧已经有 `core/src/cancel.rs`（149 行，含测试），UI 也接完了。本子项目把它移到 TS 侧。

## 关键发现：不改 `src/` 也能取消

`runAgent` 的签名确实不收 `AbortSignal`。但 `callModel` 是**注入**的：

```typescript
// src/agent.ts:26-34
export interface AgentDeps {
  callModel: (messages: Message[]) => Promise<ModelResult>  // ← 注入点
  tools: ToolRegistry
  config: Pick<Config, 'systemPrompt' | 'maxTurns'>
  // ...
}
```

而 ReAct 循环每一轮的第一件事就是调它（`src/agent.ts:53`），且 `runAgent`
**不捕获** `callModel` 的抛错。所以包一层「进来先查令牌，已取消就抛」的装饰器，
就能让循环在下一轮入口停下，异常一路上抛到 `agent-runner.ts` 的 `try/finally`。

这是现有的第 4 个接缝，和 README 记的那三个（`loadConfig(env)`、
`loadMcpToolsFromServers` 的 `connect` 参数、`runAgent` 的 `onTurn`/`onComplete`）
同一性质，只是之前没人用过。`src/` 一行不改。

### 为什么不走工具那条路

直觉上「在工具执行前查令牌、抛错」粒度更细。但 `runTool` 把所有抛错吃掉：

```typescript
// src/tools/index.ts:27-32
} catch (err) {
  return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
}
```

抛进去只会让模型下一轮读到「工具坏了」然后换个参数重试 —— 循环根本不会停。
这和 `approval.ts` 当年选择返回 `{denied: true}` 而不是抛错是同一个坑，
那边的注释（`approval.ts:148-153`）已经写明：明确告诉模型是用户拒绝，它才会换路子。

工具边界的取消要走「装饰注册表 + 返回 `{cancelled: true}` 告知模型」，
而长工具（shell）还要自己接 signal 才能真停。**本子项目不做这一层**，
理由见「不做什么」。

## 粒度与它的代价

取消只在**轮边界**生效。点了取消之后：

1. 当前这一轮的模型请求会跑完（流式的话文字还会继续吐一会儿）
2. 这一轮已经开跑的工具会跑完
3. 到下一轮 `callModel` 入口时停下

所以长工具（shell、网络请求）下用户可能等几十秒才看到停下。这是轮边界的固有代价。

打断「正在流的模型请求」需要把 `abortSignal` 传给 SDK 的
`streamText`/`generateText`（`src/llm.ts:115`、`:125`）。但 `makeCallModel(config,
registry, onText)` 没有 signal 参数，零修改下只能在 electron 侧另写一份带 signal
的 `makeCallModel` —— 那会把 `toSdkMessages` 那堆逐形状翻译（`llm.ts:26-64`）
复制一份，以后 `src/llm.ts` 改了这边不会跟着变。**本子项目不做**，留给后续。

## 组件设计

### `electron/main/cancel.ts`（新增，约 40 行）

照 `rs/core/src/cancel.rs` 的形状。不 import electron，所以能在纯 Node 下单测。

- `CancelToken` —— `cancel()` / `isCancelled()` / `throwIfCancelled()`
- `Cancelled` —— 专用错误类。**必须是独立类型**，不能用普通 `Error` 加字符串匹配，
  否则「网络挂了」这类真错误会被误判成取消（rs 侧 `cancel.rs:147` 有这条测试）
- `isCancelled(err)` —— 判别函数，只认 `Cancelled`
- `withCancel(callModel, token)` —— 装饰器：进来先 `throwIfCancelled()`，再转发

**一次性设计**：每轮建一个新令牌，不复用。rs 侧 `chat.rs:967` 的注释记了这点 ——
复用会让上一轮的取消泄漏到下一轮。

### `electron/main/agent-runner.ts`（改动）

现在的串行锁是一个 `busy` 布尔（`:83`）。加一张 `sessionId → CancelToken` 的表：

- 每轮开头建令牌、登记；`callModel` 装饰链**最外层**套 `withCancel`
- `catch` 里用 `isCancelled(err)` 分流：取消走「取消」分支（发 `cancelled` 事件），
  真错误走现有的 `error` 分支
- **取消路径上仍然 `sessions.save()`** —— 保住已经产生的那部分对话，用户点停止
  不该丢掉前面几轮的结果
- `finally` 里清 `busy` 和令牌表项

**装饰链顺序**：现有链是 `withFallback(withCache(withRetry(makeCallModel)))`
（`call-model.ts:20-34`，`build()` 里由内往外套，再按需包 fallback）。
`withCancel` 要套在**最外层**，即 `buildCallModel` 返回值之外。

两个理由，都不只是洁癖：

- 套在 `withRetry` 里面的话，取消抛的异常会被当成可重试的失败，
  反复重试几次才放弃 —— 用户点了停止还要等几轮退避
- 套在 `withFallback` 里面的话，取消会触发「主模型失败，换备用模型」，
  于是取消反而多打一次请求

所以取消的装饰不进 `buildCallModel`，在 `agent-runner` 里套在它的返回值上。

### IPC 契约（`electron/shared/channels.ts`）

- 请求：`cancelMessage: 'agent:cancel-message'`，参数 `{ sessionId }`
- 事件：`cancelled: 'agent:cancelled'`，载荷 `{ sessionId }`
- `DELETE_BLOCKED` 的注释要改。它现在写的是「没有真正的取消机制」（`:92`），
  这条前提本子项目之后就不成立了

`ipc-handlers.ts` 接 `cancelMessage`；`preload.ts` / `renderer/src/api.ts` 透出。

### 删除正在跑的会话

从「拒绝」改成「先取消再删」。**顺序不能反**：取消路径上会存盘，
先删文件的话存盘后落地、会话又回来了。rs 侧 `chat.rs:909-914` 和 `:938-944`
记了这个坑。

rs 侧用 200ms 定时器兜（那边的注释说明了为什么不做严格的完成信号：
要给 bridge 加一条反向通路，为一个删除时序不值）。**TS 侧不抄这个 200ms**：
`agent-runner` 在主进程内、能拿到那轮的 promise，可以 `await` 它跑完再删。
比定时器确定。

顺序：`token.cancel()` → `await` 该轮结束 → 删会话文件 → 清项目映射等衍生数据。

### UI

- `ChatWindow.tsx` —— 跑着的时候发送键变成停止键（不是并排加一个按钮，
  composer 那行放不下第三个控件）；收到 `cancelled` 事件清 loading 态
- `ChatWindow.tsx:21` 那张错误码文案表里 `DELETE_BLOCKED` 那条要删或改 ——
  这个码之后不该再出现
- `App.tsx:221` 的 `DELETE_BLOCKED` 处理分支同上

## 数据流

```
用户点停止
  → renderer: api.cancelMessage(sessionId)
  → IPC 'agent:cancel-message'
  → ipc-handlers → runner.cancel(sessionId)
  → 表里取出 token，token.cancel()
  ⋯ 当前轮的模型请求 / 工具继续跑完 ⋯
  → 下一轮 callModel 入口：withCancel 查到已取消 → throw Cancelled
  → runAgent 不捕获，异常上抛
  → agent-runner catch：isCancelled(err) === true
      → sessions.save()（保住已有对话）
      → emit cancelled { sessionId }
      → finally: busy = false，清表项
  → renderer 收到 cancelled：清 loading 态，停止键复原
```

## 错误处理

| 情况 | 行为 |
|---|---|
| 取消一个没在跑的会话 | 静默无操作。不报错 —— 用户可能在事件到达前又点了一次 |
| 取消后又立刻发新消息 | 正常走。令牌是一次性的，新一轮新令牌 |
| 真错误（网络挂了）被误判成取消 | 由 `Cancelled` 独立类型防住，有测试 |
| 取消路径上存盘失败 | 按现有 `sessions.save()` 的失败处理走，不额外发明 |
| 取消撞上审批弹窗悬着 | 审批闸口有 5 分钟 fail-closed 超时（`approval.ts:48` 的 `DEFAULT_TIMEOUT_MS`）。取消不动它，那一轮会在审批结算后的下一个轮边界停下 |

## 测试

进 `tests/electron/`，vitest 纯 Node 下跑（符合现有「不 import electron 的模块要能单测」的约定）：

- `CancelToken` 状态机：新建未取消、`cancel()` 后已取消、克隆共享状态
- `withCancel`：未取消时透传、已取消时抛 `Cancelled`
- `isCancelled`：认 `Cancelled`、**不认**普通 `Error`
- runner 的取消分支：`isCancelled` 走取消路径、取消路径上存了盘、`finally` 清了 busy
- 装饰链顺序：`withCancel` 在 `withRetry` 外面（取消不被重试）

**40 个现有测试文件必须继续全绿** —— 那是零修改约束的回归检查，`src/` 没动旧测试就不该红。

UI 那两处（停止键、错误码文案）按现有惯例手动验收。

## 不做什么

- **打断正在流的模型请求** —— 要在 electron 侧复制一份带 `abortSignal` 的
  `makeCallModel`，连带复制 `toSdkMessages`。收益是省几十秒等待，代价是长期漂移
- **工具边界取消** —— 要装饰注册表 + 长工具自己接 signal（shell 得能 kill 子进程）。
  它和第 5 个子项目（workspace）耦合：rs 侧 `tools/shell.rs`、`tools/files.rs`
  就是靠 cancel + workspace 一起做的
- **取消粒度的 UI 提示** —— 比如「正在停止…」的中间态。先看轮边界的实际手感

## 上下文：这是 5 个子项目里的第 1 个

rs/ 侧独有的 8 个能力共约 3700 行 Rust，而 `src/` 全部只有 381 行。
按 `rs/core` 内部的依赖关系拆成 5 个子项目，各走自己的 spec → plan → 实现：

| # | 子项目 | rs 行数 | core 内被谁依赖 | 状态 |
|---|---|---|---|---|
| 1 | **cancel（轮边界）** | 149 | agent, runtime, resilience, acp, builtin | **本文档** |
| 2 | vendors（多厂商） | 1017 | config, types, wire | 待做 |
| 3 | skills / automations / 自定义 agent | 1186 | 无（只被 UI 调） | 待做 |
| 4 | provider 抽象 + ACP | 1026 | acp, builtin | 待做 |
| 5 | workspace | 339 | tools/files, tools/shell | 待做 |

顺序理由：cancel 是 provider 的前置（rs 侧 `provider/mod.rs:112` 的
`TurnRequest::new` 就收 `CancelToken`），且它最小、能立刻销掉两条已知限制。
③ 在 core 里零被依赖，是纯新增。④ 最大，建在 ① 之上。

**约束（已确认）**：`src/` 仍是教学主线，守住零修改。根 README 把它定位成
「把 18 个 AI 工程核心概念串成一条线」并规定了阅读顺序，`agent.ts` 的文件头
也记着「从 Stage 0 到 Stage 5 几乎没动过」。3700 行灌进 381 行会淹掉这条主线。
所以 5 个子项目全部落在 `electron/` 里。
