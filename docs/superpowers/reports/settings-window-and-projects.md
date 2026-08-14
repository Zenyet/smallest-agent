# 设置独立窗口 + 侧边栏项目分组

两项结构改造。`src/`、`cli.ts`、`mcp-server.ts` 和既有 `tests/` 一行未改（`git status` 已核对）。

- 测试：42 文件 / 357 测试全绿（基线 39 / 293，新增 3 个文件 64 个测试）
- `pnpm typecheck` 干净，`pnpm build:electron` 通过（两个 renderer 入口都产出）
- 图标 skill 的三条自查 grep 全空

---

## 1. 设置搬进独立窗口

原来是 `App.tsx` 里一个 `fixed inset-0` 浮层，由 `showSettings` state 控制。现在是第二个 `BrowserWindow`。

**新增的文件**

| 文件 | 作用 |
|---|---|
| `electron/renderer/settings.html` | 第二个 renderer 入口，CSP 跟主窗口同一份 |
| `electron/renderer/src/settings-main.tsx` | 设置窗口的 React 根 |
| `electron/renderer/src/SettingsWindow.tsx` | 窗口外壳，接住原来 `App.tsx` 替面板做的事 |
| `electron/main/app-menu.ts` | 菜单模板（纯模块，不 import electron） |

`electron.vite.config.ts` 的 `renderer.build.rollupOptions.input` 从单入口改成
`{ index, settings }` 两个入口。两个窗口共用同一个 preload，`contextIsolation: true` /
`nodeIntegration: false` 都保持不变。

**窗口本身**（`index.ts` 的 `openSettingsWindow`）：720×620，最小 560×420，可缩放；
`titleBarStyle: 'hiddenInset'` 与主窗口一致，因此它自己也要给红绿灯让位 ——
`SettingsPanel` 的 header 保留 `pl-20`（80px，覆盖红绿灯约 78px 的占位），
整条 header 是 `-webkit-app-region: drag`，右上关闭按钮单独标 `no-drag`。
`backgroundColor` 取 `#1c1d1f`（= `--color-canvas`），避免开窗瞬间闪色。

**单例**：模块级 `settingsWin` 变量 + `isDestroyed()` 判断 + `closed` 事件里清引用。
两者都要有：光靠事件的话，事件派发前的那一瞬间点第二次会拿到已销毁的窗口去
`focus()` 而抛异常。已开着时还额外处理了「被最小化」——只 `focus()` 一个最小化的窗口
在 macOS 上毫无反应，所以先 `restore()` 再 `show()` 再 `focus()`。

**⌘,** 挂在菜单项的 `accelerator` 上，不用 `globalShortcut`：后者是系统级的，
会把 ⌘, 从别的应用手里抢走。macOS 下设置项在应用名菜单里（系统惯例位置），
Windows/Linux 下挂「文件」菜单、用 `Ctrl+,`。顺带补了「编辑」菜单 ——
没有它 macOS 上连 ⌘V 都不能用，设置窗口那些输入框会变成粘不进 API key 的死框。
菜单和 `CH.openSettings` 都在 `createRuntime` 之前注册，所以启动那几十秒里 ⌘, 不是死键。

**设置怎么跨窗口同步**

主进程加了 `broadcast(channel, payload)`（遍历 `BrowserWindow.getAllWindows()`，
逐个查 `isDestroyed()`），传给 `setupIpcHandlers`。`CH.saveSettings` 写完后广播
`CH.settingsChanged` 给所有窗口，而不是只回给发起 invoke 的那一个。

主窗口这边我把 `settings` state 整块删了，而不是留一份靠广播续命的副本。理由：
搬走面板之后主窗口里没有任何东西读它 —— 主进程每轮都用 `readConfig()` 重新读一次设置
（`ipc-handlers.ts` 里 runner 的构造方式），所以 `STREAM` / `MAX_TURNS` 这类改动
下一轮自然生效，主窗口不需要知道；`NOTES_DIR` / `EMBEDDING_MODEL` 要重启才生效，
那条路由设置窗口自己的重启警告负责。留一份没人读、还会慢慢变旧的 state 是负资产。
广播仍然发给所有窗口，设置窗口靠它推进重启警告的比较基线（保存成功后警告应当消失）。

`sendStatus` 也改成广播：设置窗口要知道 `phase`，否则它不知道什么时候才能安全地
`getSettings`。

**保住的既有行为**（每一条原来都花过一轮 review）

- 防抖自动保存（文本 500ms）+ toggle 立即保存 —— 面板内部逻辑，未动
- 验证错误就近显示、`.settings__error`、`settings-validate.ts` 那条链路 —— 未动
- `NOTES_DIR`/`EMBEDDING_MODEL` 的重启警告 + `aria-live` + `aria-describedby` —— 未动
- 重启按钮的守卫（有 turn 在跑或审批悬着就拒绝）—— 未动
- API key `type="password"`、明文存储披露挂在 `DEEPSEEK_API_KEY` 的 hint 里 —— 未动
- 两段式 provider 探测（第一阶段不返回密钥）—— 未动，但**额外**在启动失败路径也注册了
  这两个 handler（抽出 `setupProviderHandlers()`）：设置搬进独立窗口后，启动失败时
  用户唯一的出路就是开设置改配置，而面板一挂载就调 `detectProviders`，
  那条路径上没有 handler 的话面板一打开就先吃一个 reject
- **「settings 没读回来就不渲染面板」这条**跟着面板搬到了 `SettingsWindow.tsx`：
  等 `phase` 落定才 `getSettings`，拿到之前渲染「读取设置中…」。原注释警告的后果
  （一排空输入框 → 一保存把好的 key 冲掉）在新窗口里同样成立，有测试锚住

`SettingsPanel` 本身只改了两处：根元素 `fixed inset-0` → `h-full flex-1`（没有别的东西
要被它盖住了），左导航 `w-56` → `w-40`（原来的宽度是为对齐主窗口侧边栏，在 720px
的窗口里会把字段区挤窄）。

---

## 2. 侧边栏项目分组

### 数据模型与持久化

一个项目 = 名字 + 绝对目录路径。`Project { id, name, dir, createdAt }`。
一个会话最多属于一个项目；没有项目的会话落到「未分组」。

```ts
interface ProjectsState {
  projects: Project[]
  sessionProject: Record<string, string>  // sessionId → projectId
  collapsed: string[]                     // 折叠着的分组 id（含 '_ungrouped'）
}
```

**存在哪儿**：`electron-store`，顶层 key `projects`，与 `settings` 互不干扰
（`electron/main/projects-store.ts`，跟 `settings-store.ts` 同样的手法）。

**为什么不能存进会话文件**：`src/` 冻结，会话文件的形状由
`src/memory/store.ts` 的 `createJsonSessionStore` 决定 —— 就是一个 `Message[]` 数组，
没有地方放元数据；而且 `runAgent` 每答完一轮都整体覆写那个文件，任何塞进去的
额外字段都会被下一次 `save()` 抹掉。所以映射必须活在 Electron 层自己的持久化里。
副作用之一是好的：新会话还没落盘就能定下它属于哪个项目。

读取时一律过 `normalizeProjectsState()`：磁盘 JSON 可能是手改的或旧版本写的，
一个畸形的 `collapsed` 不该让侧边栏渲染时炸掉。它还会丢掉指向已删项目的悬空映射 ——
留着会让那个会话既不在任何项目下、也不在「未分组」里，直接从列表消失。

`SessionMeta` 加了可选的 `projectId`。`CH.listSessions` 的 handler 用
`decorateSessions()` 把映射贴上去，让「某个会话属于哪个项目」只有一个真相来源，
而不是让 renderer 拿两份数据自己对。

### 纯逻辑模块

`electron/main/projects.ts` —— `addProject` / `removeProject` / `assignSession` /
`forgetSession` / `toggleCollapsed` / `groupSessions` / `decorateSessions` /
`projectNameFromDir` / `newProjectId`。全是纯函数，38 个单测（`tests/electron/projects.test.ts`）。

刻意**不** import `node:path`：这个模块 renderer 也在用（`App.tsx` 拿 `groupSessions`），
而 renderer 是浏览器环境，bundler 会把 `node:path` 外部化成空壳、构建直接失败 ——
这一点是 `pnpm build:electron` 抓出来的，测试抓不到（vitest 跑在 Node 里）。
需要的只是 basename 一件事，改成字符串切分（两种分隔符都认，Windows 上
`dialog` 返回反斜杠路径）。

几个刻意的行为选择，都有测试锚住：

- **目录即身份**：同一个目录重复添加不长出第二个项目，返回原来那个。原生选择器
  每次从头开始、记不住上次选过什么，用户很容易重复选。
- **删项目不删会话**：名下会话回到「未分组」，同时清掉它的映射和折叠状态。
- **空项目要显示**：刚添加完目录、里面还没有对话时，如果那一行不出现，
  那次「添加项目」看起来就像什么都没发生。
- **「未分组」没有游离会话时不显示**：它是兜底分类而不是用户建的东西，空着占一行是噪音。
- `newProjectId` 用「时间戳前缀 + 进程内自增计数器」，跟 `newSessionId` 同一套手法：
  连着添加两个项目是同一毫秒内的常见操作，计数器从构造上保证不碰撞（不是概率性的）。

### 添加项目 = 选目录

`CH.addProject` 在主进程调 `dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })`，
挂在主窗口上（macOS 上呈现为 sheet）。用户取消返回 `null` —— 取消不是失败，renderer 原样不动。
项目名默认取目录 basename。

所有项目写操作都返回写完之后的**完整状态**并广播同一份出去（`CH.projectsChanged`），
renderer 不自己推算下一个状态 —— 两个窗口各推算一份迟早分叉。

### 新会话落在当前项目

`CH.createSession` 接受可选 `projectId`，由主进程建映射。`App.tsx` 里
`currentProjectId` 与 `currentId`（当前会话）是两件独立的 state：用户可以选中一个项目
却不打开它下面任何会话（刚添加完、里面还是空的）。选中会话时会把它所属的项目一并
标为选中 —— 否则用户接着点「新对话」会莫名落到「未分组」，而他眼里明明正在某个项目里干活。
乐观插入的新会话行也带上 `projectId`，不然它会先在「未分组」里出现一下、
等第一次回答完刷新才跳到项目下面，那一下跳动看得见。

删会话时顺带 `forgetSession` 清映射（用引用比较跳过「本来就没分组」的常见情况，
免得每次删会话都写一次盘、广播一次没有变化的状态）。

### 布局与视觉

按截图的结构、我们自己的语言实现（token only，无裸 hex，无 `rounded-[Npx]`）：

顶部一行是拖拽区 + 红绿灯让位（`pl-[78px]`）+ 右上角**裸齿轮图标按钮**
（`size-6`、无背景无边框、只有 hover 时文字提亮；标 `no-drag`，否则落在拖拽区里点不动）
→ 新对话按钮（`h-7`）→ 「项目」区标签 + 添加入口 → 项目行（`h-7`，folder 图标，
chevron 折叠按钮带 `aria-expanded`，hover 出现的移除按钮）→ 其下用一条
`border-l border-line` 领起的嵌套会话行（`h-7`）。

折叠时项目行右侧显示会话数 —— 折起来之后用户看不见里面有几条，这个数字让他
不必展开就知道值不值得展开。折叠状态持久化，重启后仍然折叠。

`Icon.tsx` 的 `PATHS` 加了 `folder` 一条（24×24 网格，`fill=none`，
`stroke=currentColor`，圆头圆角）。

侧边栏没有任何 `active:scale`（已按要求移除，未重新引入）。
`.session--active` 等测试锚点类名全部保留，另加 `.project__row--active`。

---

## 判断为超出范围的事

- **项目重命名**：数据模型支持（`Project.name` 独立于 `dir`），但没做 UI。
  截图里没有这个入口，加一个内联编辑态会牵出一套编辑/校验/取消的交互。
- **把已有会话拖进项目 / 右键菜单改归属**：`assignSession` 这条 IPC 已经通了
  （`api.assignSession`），但没接 UI。拖拽在这个密度的列表里要单独设计放置指示。
  目前会话的归属只在创建时定下。
- **项目行显示目录路径**：只放在 `title` 属性里（hover 可见）。`w-56` 的侧边栏里
  再加一行 11px 的路径会让每个项目占两行高，与「默认偏紧凑」相悖。
- **项目排序**：按添加顺序。
- **用项目目录约束 agent 的文件访问范围**：这是个诱人的联想（项目既然是个目录，
  fs MCP 的 allowed directories 似乎该跟着它变），但 MCP server 的 spec 在
  `createRuntime` 时就定下、且 `src/` 冻结，动它要重启整个 runtime。没做。

## 一处值得指出的既有测试断言

`settings-panel.test.tsx` 里 11 个用例全部照原样通过，没有削弱任何断言。
`components.test.tsx` 的 `SessionList` 那一组因为组件 props 从扁平 `sessions`
变成分好组的 `groups` 而必须改写，但每条原断言的意图都保留了下来
（列出会话、选中样式、点击回调、新建、删除不连带触发 onSelect），
另加 12 条覆盖分组/折叠/项目增删/裸齿轮的新断言。没有删除任何测试。
