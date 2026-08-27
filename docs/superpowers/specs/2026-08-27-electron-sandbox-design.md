# Electron 桌面版：按会话隔离的文件沙箱

> 「把 rs/ 侧独有能力同步回 TS 侧」这条线的第 3 个子项目。
> 第 1 个是轮边界取消，第 2 个是 Provider 抽象 + ACP 外部 CLI。
>
> **rs/ 不动，`src/` 也不动。** 参考实现是 `rs/core/src/workspace.rs`（339 行）。

## 先纠正一个我说错的判断

上一轮我说「TS 侧完全没有路径收敛」。**那是错的** —— 我只 grep 了我们自己的
代码，没读那个 MCP server 的实现。

`@modelcontextprotocol/server-filesystem@2026.1.14` 已经做了正确的收敛，
算法和 `workspace.rs` 是同一套：

| 防的是什么 | 它怎么做 | 位置 |
|---|---|---|
| `../` 跳出 | `path.resolve(path.normalize(p))` | `path-validation.js:25` |
| 符号链接指向外面 | `fs.realpath` 后再查一次 | `lib.js:53-56` |
| 在外面造新文件 | 校验**父目录**的 realpath | `lib.js:66` |

这三条正是 `workspace.rs` 文件头点名的那两条绕过路径的防法。所以**不需要
再写一套路径校验** —— 写了就是两套逻辑对同一件事各判一遍，不一致时行为
没法推理。

## 真正的缺陷：边界的粒度

`fsServerSpec` 把允许目录写死成一个 `input.notesDir`（`mcp-paths.ts:37`），
默认 `./notes`（`src/config.ts:54`）。而 `createRuntime` 在 `index.ts:224`
**只在启动时跑一次**，所以这个边界是全应用、全会话共用的一个固定值。

三条实际后果：

1. **不跟着会话走。** 在项目 X 下开的会话，内置 agent 的文件工具看到的仍是
   `notesDir`，不是 X。gpui 侧 `providers.rs:191` 专门解决过这个 ——
   沙盒根是「会话所属项目的目录」。
2. **两种引擎不一致。** 上一个子项目给外部 CLI 接的 `cwd` 跟着项目走
   （`resolveCwd`），内置 agent 却是全局 `notesDir`。同一个会话、两个引擎，
   可写范围不同 —— 用户没法预期 agent 在哪儿干活。
3. **`./notes` 是相对路径。** 双击启动时 cwd 可能是 `/`，它会解析成 `/notes`。
   `workspace.rs:21` 警告的正是这件事：「拿 cwd 当沙盒根等于没有沙盒」。

## 方案：每个项目一个 fs server 实例

边界是**起子进程时**作为命令行参数传进去的，子进程启动时定死。要让边界跟着
会话变，只有两条路：

- **A. 每项目一个实例**：切到另一个项目的会话就起一个新的 npx 子进程。
- **B. 我们这侧再装饰一层**：按会话校验 14 个工具的路径参数后再放行。

**选 A。** B 有两个问题：要维护「哪个工具的哪个参数是路径」那张表
（`read_file` 是 `path`，`move_file` 是 `source`+`destination`，
`read_multiple_files` 是 `paths` 数组…），而这张表跟着那个包的版本走 ——
它升级加一个工具，我们不加就漏一个，**而漏掉的那个是没有边界的**。
加上前面说的「两套逻辑」问题，A 的语义干净得多：一个会话一个边界，
复用已经验证过的收敛实现。

A 的代价是切项目时起进程的延迟（首次 npx 几秒），用缓存压掉 ——
和上个子项目给 ACP 做的 registry 同构。

### 缓存键是项目目录，不是会话 id

```typescript
// electron/main/fs-tools.ts（新增，约 170 行）
export interface FsToolsPool {
  /** 拿这个目录的文件工具。目录相同的会话共用一个子进程。 */
  forDir(dir: string): Promise<ToolRegistry>
  disposeAll(): Promise<void>
}
```

同一个项目下的多个会话共用一个实例 —— 它们的沙盒边界**本来就是同一个**，
按会话分实例只是白起进程。这和 ACP 那边按 `(provider, 模型)` 缓存是同一条
推理：键取「决定行为的那个东西」，不取「谁在用」。

### 没有项目的会话不装文件工具

照 gpui 的选择（`providers.rs` 的 `fs_shell_tools` 对 `None` 返回空注册表）。
理由是那边注释写的：**退回某个默认目录的话，agent 往里写东西用户不会去找。**

代价是「未分组」的会话没有文件能力（仍然能聊天、检索笔记、上网）。这是
有意的取舍 —— 一个没有明确边界的沙盒不如没有沙盒，因为它给人一种
「有保护」的错觉。composer 上要说明这件事，不能让用户以为工具坏了。

### 为什么不加 WORKSPACE_DIR 设置

gpui 有一个 `WORKSPACE_DIR` 设置键（`workspace.rs:40`），默认
`~/SmallestAgent`。**这边不加。**

理由是 gpui 自己后来也否掉了：`providers.rs:191` 那段注释记着
「上一版加了个全局 WORKSPACE_DIR，那是多余的 —— 这个 app 里的会话本来就有
工作目录（侧边栏的项目带着一个真实路径）。再要用户配第二个目录，等于同一件事
有两个真相，而两者一旦不一致，用户看着 A 目录、agent 在 B 目录里干活。」

那正是我们现在的 bug（缺陷 2）。所以直接复用项目目录，不引入第二个真相。

## 生命周期改动

现在 `createRuntime` 一次性建好 `registry` 并长驻。改成两段：

```
createRuntime（启动一次）
  ├─ embedding 模型、笔记索引      ← 不变，贵且全局
  ├─ 自建 MCP server（Skills）     ← 不变，和沙盒无关
  └─ ❌ fs server                  ← 移出去

FsToolsPool（按项目目录懒建 + 缓存）
  └─ fs server 实例，允许目录 = 那个项目的目录
```

`agent-runner` 每轮拿注册表时合成：

```typescript
// 每轮一次。基础注册表长驻，文件工具按这个会话的项目目录取。
const registry = { ...runtime.registry, ...(await fsPool.forDir(cwd)) }
```

**为什么每轮取而不是缓存在 provider 上**：会话可以被拖到另一个项目下
（`assignSession`），那时边界该跟着变。每轮问一次 pool（命中缓存是同步返回
一个已建好的注册表）比维护失效通知简单。

## 权限模式和沙箱是两层

刚接的 `readonly / ask / auto` 管的是**「要不要执行这个写操作」**，
沙箱管的是**「能写到哪个目录」**。两者配合，缺一个都不够：

- 只有权限模式：批准之后可写范围是全局 `notesDir`，和会话无关
- 只有沙箱：agent 在边界内可以随便改，不问一声

`workspace.rs` 的文件头把这层关系写得很清楚：沙箱**挡不住**用户自己批准的
一条 `rm -rf` —— 命令在真实 shell 里跑，沙盒只限制工作目录，不是内核级隔离。
所以命令类工具必须走审批。

## 这挡得住什么，挡不住什么

**挡得住**：模型判断失误、或读到一段恶意文本（prompt injection）之后想读
`~/.ssh/id_rsa`、写 `~/.zshrc` —— 路径解析后不在项目目录内，工具直接拒绝。

**挡不住**：
- 用户自己批准的危险命令（见上）
- 外部 CLI 的文件访问 —— 它们用自己的工具，我们只给了 `cwd`，管不住它
  往别处写。这一点要在 UI 上说清楚，不能让用户以为那个沙箱也管着 CLI。
- 项目目录本身选得太大（比如选了 `~`）。这是用户的选择，我们只能在添加
  项目时提示，不该阻止。

## 组件

| 文件 | 行数 | 做什么 |
|---|---|---|
| `electron/main/fs-tools.ts` | ~170 | FsToolsPool：按目录建 fs server + 缓存 + 回收 |
| `electron/main/agent-runtime.ts` | ~-25 | 移出 fs server，只留全局资源 |
| `electron/main/agent-runner.ts` | ~+20 | 每轮合成注册表 |
| `electron/main/ipc-handlers.ts` | ~+25 | 装配 pool、接 cwdFor、退出时回收 |
| `electron/main/index.ts` | ~+5 | 退出时 disposeAll |
| ChatWindow / channels | ~+30 | 「这个会话没有工作目录」的说明 |
| 测试 | ~200 | pool 的缓存/回收（注入假 loader）、合成逻辑、没项目时不装 |
| **合计** | **~475** | |

## 测试怎么写

真起 npx 子进程不进 CI（要联网拉包）。`loadMcpToolsFromServers` 本来就是
注入点（`agent-runtime.ts` 已经这么用），pool 也照这个做：

- 同一个目录问两次只建一个实例（缓存生效）
- 不同目录各建一个
- `disposeAll` 关掉全部，且幂等
- 建失败时不进缓存（否则一次网络抖动会把「坏实例」永久缓存住）
- 没有项目目录时返回空注册表，且**不**起进程
- 合成后的注册表里，文件工具能被 WRITE_TOOLS 认出来（审批仍然生效）

**边界本身的正确性不由我们测** —— 那是那个包的职责，它自己有测试。我们测的是
「边界被正确地设成了项目目录」，不是「`../` 能不能绕过去」。

## 不做什么

- **不自己写路径校验。** 见开头那节。
- **不加 WORKSPACE_DIR。** 见上。
- **不做命令执行工具（shell）。** gpui 那边 `fs_shell_tools` 同时装文件和命令
  两组，这边只有文件（命令工具 TS 侧压根不存在）。加它是独立一件事，
  而且它对沙箱的要求更高 —— `cwd` 限制不住 `cd /`。
- **不管外部 CLI 的文件访问。** 管不住，只在 UI 上说明。
