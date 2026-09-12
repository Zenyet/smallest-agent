# Beautiful UI — AI 原生界面组件

19 个开源的 AI 原生界面组件（copy-paste 风格），源码来自 [ithmz/beautiful-ui](https://github.com/ithmz/beautiful-ui)（MIT License）。

技术栈：React 19 + Next.js 16 + Tailwind CSS v4 + TypeScript。每个组件均为**单文件自包含**，内联了演示数据，直接复制文件到你的项目即可适配使用。

## 组件清单（components/ui/）

| # | 文件 | 用途 |
|---|------|------|
| 01 | `loading-state.tsx` | 像素网格加载器，带微光动画和耗时显示 |
| 02 | `thinking-state.tsx` | 可展开的 Agent 思考过程（步骤/推理/搜索/编码） |
| 03 | `streaming-text.tsx` | 流式文本回答，含来源、操作和追问建议 |
| 04 | `approval-card.tsx` | 人类介入确认卡片（Agent 执行关键操作前询问） |
| 05 | `tool-chips.tsx` | 工具调用和代码编辑的紧凑标签 |
| 06 | `task-rows.tsx` | 实时 Agent 任务状态行（运行中/失败/已完成） |
| 07 | `chat-composer.tsx` | 带推理回复和输入框的标签式聊天面板 |
| 08 | `prompt-bar.tsx` | 支持 @来源、/命令、模型选择、听写的输入条 |
| 09 | `recommendation-card.tsx` | 带置信度的 Agent 建议卡片 |
| 10 | `context-cards.tsx` | 检索到的知识块及其来源展示 |
| 11 | `diff-table.tsx` | 批量 AI 编辑表格数据的差异对比表 |
| 12 | `records-table.tsx` | CRM 风格网格（标签、排序、关系状态） |
| 13 | `filter-table.tsx` | 用状态标签重新组织实时数据的表格 |
| 14 | `sidebar-nav.tsx` | 工作区侧边栏导航，带快速搜索 |
| 15 | `search.tsx` | 命令搜索，支持实时过滤和空状态 |
| 16 | `insight-cards.tsx` | 带可滚动实时图表的分页洞察卡片 |
| 17 | `code-block.tsx` | Agent 逐行流式生成的代码块 |
| 18 | `fine-tune-card.tsx` | 在设计检查器中调整属性的微调卡片 |
| 19 | `selection-actions.tsx` | 选中文本后交给 Agent 改写的操作菜单 |

## 如何使用

### 方式一：只复制单个组件（推荐）

把 `components/ui/` 下你需要的 `.tsx` 文件复制到项目，然后：

1. 组件使用 Tailwind v4 的设计 token（`bg-surface`、`text-ink-muted`、`border-line` 等），需要在项目的 `globals.css` 中加入本目录根部的 `globals.css` 中的 `:root` 变量和 `@theme inline` 块（亮/暗双模式，暗色跟随 `prefers-color-scheme`）。
2. 无需安装任何额外 UI 依赖（只用 React 内置 hooks）。
3. 每个文件的导出函数名为 `XxxDemo`，内含演示数据，按需替换为真实数据。

### 方式二：整体运行演示

```bash
cd beautiful-ui
pnpm install   # 或 npm install
pnpm dev       # http://localhost:3000
```

## 目录说明

- `components/ui/` — 19 个组件源码（单文件）
- `globals.css` — Tailwind v4 设计 token（亮/暗主题）
- `package.json` / `tsconfig.json` / `postcss.config.mjs` / `next.config.ts` — 演示项目配置

## 许可证

MIT License，自由使用。原始仓库：https://github.com/ithmz/beautiful-ui
