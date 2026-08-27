# Electron 桌面版：Provider 抽象 + ACP 外部 CLI

> 「把 rs/ 侧独有能力同步回 TS 侧」这条线的第 2 个子项目。
> 第 1 个是轮边界取消（`2026-08-25-electron-cancel-design.md`）。
>
> **rs/ 不动。** 这份设计只改 `electron/`，`src/` 继续零修改。gpui 侧那 2100 行
> 是参考实现，不是要搬的代码 —— 两边语言的接缝不同（见「和 gpui 侧的差异」）。

## 要解决什么

桌面版现在只有一种 agent：本仓库的 ReAct 循环。设置页的「Agent 模式」是一段
诚实的占位说明，composer 上也没有引擎选择器。而 gpui 侧可以在同一个界面里
用 Claude Code、Codex 这些外部 CLI 回答 —— 那是「一个界面管所有 agent」的
实用价值，内置 agent 则是一份能读懂的最小实现（那套教学注释是资产）。

两者**并列而不是取代**。这是这个子项目的承重判断。

## 三个要接的东西

### 1. Provider 抽象：「这一轮由谁来跑」

现在 `agent-runner.ts` 的 `runTurn` 直接调 `deps.runAgent`，把「内置 agent」
这一种实现写死在了请求装配里。抽出一层：

```typescript
// electron/main/provider/types.ts（新增，约 90 行）

/** 一轮对话过程中发生的事。两种 provider 都产出这些。 */
export type TurnEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'tool-call'; turn: number; name: string; args: Args; output: string }
  | { kind: 'cache-hit' }                    // 只有内置会发
  | { kind: 'fallback'; model: string }      // 只有内置会发
  | { kind: 'notice'; text: string }         // 外部 CLI 的连接状态、认证提示

export interface Provider {
  readonly id: string
  runTurn(req: TurnRequest): Promise<string>   // 返回完整答案
}

export interface TurnRequest {
  question: string
  /** 我们自己的会话 id，不是 ACP 那边的 —— 见下面「一个连接多个会话」 */
  sessionId: string
  history: Message[]
  cwd?: string
  emit: (e: TurnEvent) => void
  token: CancelToken
  approve: (req: ApprovalAsk) => Promise<ApprovalDecision>
}
```

**为什么事件收进一个 sink，而不是保留现在那组回调。** 现在 runner 用
`emit.chunk` / `emit.toolCall` / `emit.cacheHit` 几个独立回调，各自绑一个 IPC
频道。这在只有内置 agent 时够用，但 ACP 那边天生就是一条通知流
（`session/update`），硬拆成几个回调是反着来的。统一成一个 sink 之后，
IPC 那一层的翻译留在 runner 里，provider 只管产出事件。

现有的 8 个 IPC 事件频道**一个都不改** —— 这是 renderer 侧零改动的前提。

### 2. ACP 客户端：驱动外部 CLI

装 `@agentclientprotocol/sdk`（1.4.0，官方 TS SDK）。

```typescript
// electron/main/provider/acp.ts（新增，约 420 行）
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
const conn = acp.client({ name: 'smallest-agent' })
  .onRequest(acp.methods.client.session.requestPermission, (ctx) => ...)
  .onNotification(acp.methods.client.session.update, (ctx) => ...)
  .connect(stream)          // ← 长命，不是 connectWith
```

**必须用 `connect` 而不是 `connectWith`。** SDK 的例子用后者，但那是作用域式的：
整个会话活在一个闭包里，闭包返回连接就断。我们要的是「建一次连接、多轮对话」——
用户在同一个会话里连续提问，CLI 那侧维护着上下文（这正是用外部 CLI 的意义）。
`connect(stream)` 返回长命的 `ClientConnection`，`.agent.buildSession(cwd).start()`
拿到 `ActiveSession`，之后每轮 `.prompt()` + 循环读 `.nextUpdate()` 到 `stop`。

**权限请求不能自动批准。** SDK 的例子里是交互式问；gpui 侧那份注释写得对 ——
自动批准等于绕过用户对这些 CLI 权限模型的预期。转成我们现有的审批卡：
`session/request_permission` 的 options 映射到 `ApprovalRequestEvent`，
用户的选择回填成 `{outcome: 'selected', optionId}`。超时/窗口关闭一律回
`{outcome: 'cancelled'}` —— 和现有 gate 的 fail-closed 一致。

**取消走协议自己的通道。** ACP 有 `session/cancel` 通知，比内置那边的轮边界
取消更利落（不用等下一轮 `callModel` 入口）。`CancelToken` 触发时发这条通知，
然后等 agent 回 `stopReason: 'cancelled'`。

### 3. 会话绑定：谁用哪个引擎

```typescript
// electron/main/providers.ts（新增，约 260 行 —— 纯数据 + 纯函数，可直接单测）
export interface ProvidersState {
  external: ExternalProvider[]              // 用户配的外部 CLI
  sessionProvider: Record<string, string>   // sessionId → providerId
  sessionModel: Record<string, string>      // 只对外部 provider 有意义
  builtinModel: Record<string, string>      // `厂商id/模型id`
  sessionPermission: Record<string, string> // 'readonly' | 'ask' | 'auto'
  defaultProvider?: string
}
```

落盘走 `electron-store` 的自己一个顶层 key，和 `projects-store.ts` 同构
（同样的理由：`src/` 冻结，`createJsonSessionStore` 每轮整体覆写 `Message[]`，
塞进会话文件的元数据活不过一轮）。读的时候过一遍 `normalize`：指向已删
provider 的绑定要清掉，否则那个会话既不属于任何外部 provider、也不显示成内置，
选择器上是空的，用户不知道点发送会走哪条路。

**`sessionModel` 和 `builtinModel` 分开存**，不合成一张表。两者的键空间不同：
前者的值是「某个外部 CLI 声明的模型 id」，只在那个 CLI 里有意义；后者是
「厂商 + 模型」，由 `vendors.ts` 定义。合在一起的话 normalize 没法判断某个值
该按哪套规则校验，而校验错的后果是把合法绑定清掉 —— 用户选的模型莫名回到默认。

## 模型清单为什么要用户配

**ACP 协议里没有模型选择。** 我查了 SDK 1.4.0 的 schema：`SessionUpdate` 有
`current_mode_update`（ask/architect 那种工作模式），没有 available_models。
有一组 `providers/list` / `providers/set` 方法，但它标着 **UNSTABLE**
（"not part of the spec yet, and may be removed or changed at any point"），
而且答的是「LLM 路由怎么配」而不是「有哪些模型可选」。所以客户端问不出
「你支持哪些模型」。

各家 CLI 的做法是读环境变量或命令行参数（`ANTHROPIC_MODEL`、`--model`）。
所以让用户声明「有哪些选择、每个怎么传」，我们在起子进程时应用上：

```typescript
export interface ModelChoice {
  id: string
  name: string
  env?: Record<string, string>   // 多数 CLI 走这条
  args?: string[]                // Codex 那套走 --model
}
```

代价是清单会过期（各家出新模型要用户自己加一行）。换来的是**不用为每家
CLI 写一个适配器** —— waku 走的是那条路（12 个 driver 文件），因为它用各家
原生协议、要拿到各家独有能力。走标准 ACP 覆盖面更划算，代价是拿不到
rewind / computer-use 那类独有功能。

### 清单里放哪几家

模板里预置 5 家，**全部 `disabled: true`** —— 它们要 npx 拉包（首次几十秒）
且要各自的认证，不该在用户没看过配置的情况下就出现在选择器里。

| 引擎 | 启动方式 | 状态 |
|---|---|---|
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp@latest` | 已验证 npm 有 0.70.0 |
| Codex | `npx -y @agentclientprotocol/codex-acp@latest` | 已验证 npm 有 1.6.2 |
| Gemini CLI | `npx -y @google/gemini-cli --experimental-acp` | 原生 ACP 开关，不需要适配器 |
| Pi | `npx -y pi-acp@latest` | 已验证 npm 有 0.0.33（版本号还早，可能不稳） |
| DeepSeek Harness | `npx -y deepseek-acp@latest` | 已验证 npm 有 0.7.0（第三方维护） |

**Kimi Code 不预置。** `@moonshot-ai/kimi-code` 是 CLI 本身，没有 ACP 桥；
我搜了 npm 也没有第三方适配器。编一个包名进模板的后果是用户点了之后
npx 报 404，而错误信息指向我们而不是那个不存在的包。哪天有了，加一行就行 ——
这正是「清单是用户可改的配置文件」而不是硬编码的理由。

模板写进 `providers.json`（挨着 `settings.json`），第一次打开设置页时生成。
用户可以照任何一家 CLI 的 README 加条目 —— 命令、参数、环境变量都是它自己的。

## 权限模式选择器

`readonly` / `ask` / `auto`，仿 Codex，**按会话记**。

「这条对话能不能动我的磁盘」是个随任务变的判断：查点东西用只读，让它改代码
用询问，跑一串脚手架命令时切自动。绑在会话上，切会话就切回各自的模式，
不用每次进设置改一个全局开关。

**只对内置 agent 显示。** 外部 CLI 自带权限模型（Claude Code 有它自己的
「本次允许 / 本会话都允许」），旁边再放一个只会让人以为这个能管住它。

实现上包一层现有的审批闸口，而不是按模式增删工具：

```typescript
// electron/main/approval.ts（改动，约 +35 行）
function modeGate(inner: ApprovalGate, mode: PermissionMode): ApprovalGate
//   auto     → 直接 'allow'，不弹卡片
//   readonly → 直接 'deny'
//   ask      → 走 inner（现在的行为）
```

从这一个点表达三种模式，覆盖**所有**危险工具 —— 包括 MCP 带进来的那些
（它们的名字我们控制不了，但都会经过 `WRITE_TOOLS` 判断，也就都会到这里）。
按模式增删注册表只能管住我们自己那几个工具。

## 工作目录

外部 CLI 的 `cwd` 决定它能看到哪些文件。**复用侧边栏那个项目的目录** ——
会话本来就有工作目录，新建对话时就选了。再要用户去设置里配第二个目录等于
同一件事有两个真相，而两者一旦不一致，用户看着 A 目录、agent 在 B 目录里干活。

没有项目的会话不装 cwd。不退回某个默认目录 —— 那个目录用户没选过，agent
往里写东西他不会去找。这种会话仍然能聊天，composer 上说明「没有工作目录」。

## 实例缓存

外部 provider 按 `(providerId, modelId)` 缓存实例，内置的不缓存。

**外部要缓存**：ACP provider 持有子进程连接。每轮新建一个意味着重新起 npx、
重新握手（几秒），而且丢掉 CLI 那侧的会话上下文 —— 那正是用外部 CLI 的意义。

**键里带模型**：模型是通过子进程的 env/args 传的（协议里没有模型选择），
换模型要用不同命令行重新起进程。复用旧实例等于换了个名字还在用旧模型。

**键里不带会话 id**：两个都走 Claude Code 的会话拿到同一个实例、同一个
子进程。这是故意的（起进程贵）。「对话不混」由 ACP 协议保证 —— 一个连接上
按会话各开一个 ACP session，所以 `TurnRequest` 必须带 `sessionId`。

不带的后果是那类看不见的 bug：两个会话发到同一个 ACP session，B 的提问带着
A 的上下文回答。界面上是两条独立对话，CLI 那侧是一条 —— 只表现成
「模型莫名提到我没说过的事」。

**内置反过来**：它无状态（历史每轮显式传），重建代价只是建一个 client。
缓存它反而要处理「MCP 工具热插进来之后什么时候失效」。

## 和 gpui 侧的差异

同一个设计在两边的接缝不同，照抄反而会带进不必要的复杂度：

- **不需要「连接住在长任务里」那套。** Rust 侧要那么写是因为
  `ConnectionTo<Agent>` 不是 `Send + Sync`，放不进 `Provider`（要求 Send+Sync）。
  TS 没有这个约束，`ClientConnection` 直接存字段里。gpui 那边的
  `mpsc::UnboundedSender<SessionCommand>` + 共享格子（`Arc<Mutex<Option<TurnSlot>>>`）
  在这边整个不需要 —— 那是绕 Send 的手法，不是设计的一部分。
- **不需要 `Arc<Mutex<>>` 保护事件槽。** 单线程事件循环，每轮直接换 sink。
- **取消更简单。** 内置那边已经有 `CancelToken`（第 1 个子项目），外部走
  `session/cancel`，两条都不用新机制。

## UI

三处，都在已有组件里加：

- **composer 引擎选择器**（`ProviderPicker.tsx`，新增约 90 行）——
  只有一个可选时不做成菜单，显示成纯文本（「现在用的是这个，没别的可选」）。
  点开只有一项的下拉是空动作。
- **composer 权限选择器**（`PermissionPicker.tsx`，新增约 70 行）——
  只在内置 agent 时渲染。
- **设置页「Agent 模式」**（`SettingsPanel.tsx` 改动）—— 那段占位说明换成
  真的引擎列表 + `providers.json` 的路径。这一页**不做成表单**：外部 CLI 的
  配置是从各家 README 粘过来的，表单会强迫用户把一行命令拆成几个输入框。

三个浮层复用刚统一好的那套外观（`bg-overlay` + `border-line-strong` +
`rounded-card`，见 `ModelPicker.tsx` / `ContextMenu.tsx`）。`ModelPicker` 的
分组头/缩进/吸顶那套层级信号也照用。

## 数据流

```
用户点发送
  → renderer: sendMessage(sessionId, text)          （IPC 不变）
  → ipc-handlers: runner.run(...)
  → agent-runner: 查 providersState.providerFor(sessionId)
      ├─ 'builtin' → BuiltinProvider  → runAgent(...)         （现在的路径）
      └─ 外部      → AcpProvider      → session.prompt(...)
  → 两者都往 emit(TurnEvent) 推
  → agent-runner 把 TurnEvent 翻成现有的 8 个 IPC 事件
  → renderer 不知道这一轮是谁跑的                    （chat-reducer 零改动）
```

## 测试

纯函数那部分直接单测，不需要起子进程：

- `providers.ts` 的 normalize / 绑定读写 / `厂商id/模型id` 拆分（约 25 条）
- `ModelChoice` 到 env+args 的展开（约 8 条）
- 权限模式包装：`auto` 不弹卡、`readonly` 直接拒、`ask` 走原路（约 6 条）
- `session/update` 到 `TurnEvent` 的翻译，喂 SDK 的类型对象即可（约 12 条）
- 三个浮层组件的 UI 测试（约 20 条）

**真起子进程的端到端不进 CI** —— 要 npx 拉包和各家的认证。手动验证清单
另写，跑一次记一次结果。

## 不做什么

- **不做 ACP 的 terminal / fs 能力。** 客户端可以声明 `fs.readTextFile` 之类
  让 agent 通过我们读写文件。先不声明 —— 那些 CLI 自己就有文件访问，
  声明了等于多一条要审批的路径。
- **不做 `loadSession`。** 恢复历史要 agent 支持那个 capability，且要把整段
  历史回放成通知。外部 CLI 的会话历史先留在它自己那侧。
- **不做 SessionMode（ask/architect）。** 那是各家 CLI 的工作模式，和我们的
  权限模式是两件事，混在一个选择器里会让人以为能互相覆盖。
- **不碰 `src/`。** 内置 provider 就是现在 `runTurn` 里那段装配，挪个位置。

## 规模

| 文件 | 行数 |
|---|---|
| `provider/types.ts` | ~90 |
| `provider/builtin.ts` | ~150（多是从 agent-runner 挪过去的） |
| `provider/acp.ts` | ~420 |
| `providers.ts` + `providers-store.ts` | ~285 |
| `approval.ts` 改动 | ~35 |
| `agent-runner.ts` / `ipc-handlers.ts` / `channels.ts` / `preload.ts` 改动 | ~180 |
| UI 三处 | ~230 |
| 测试 | ~420 |
| **合计** | **~1810** |

分四轮交付，每轮都能单独跑通测试：

1. `providers.ts` + store + normalize（纯数据，最先能测）
2. Provider 抽象 + 内置 provider 搬过去（行为不变，测试应该全绿）
3. ACP provider + 端到端跑通 Claude Code
4. UI 三处 + 权限模式
