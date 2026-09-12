// ============================================================================
// memory/facts-store.ts —— 跨会话事实的磁盘落地
// ----------------------------------------------------------------------------
// 纯逻辑（upsert / 淘汰 / 渲染 / 规范化）在 facts.ts，那边是纯函数、有单测。
// 这个文件只管读写一个 JSON 文件。
//
// ## 为什么 CLI 和桌面端共用一份（以及为什么曾经不是）
//
// 第一版是两份：CLI 写 ~/.smallest-agent/facts.json，桌面端写
// userData/memory.json。理由是「CLI 拿不到 app.getPath()」—— 那条约束是真的，
// 但**结论错了**：路径本来就可以是同一个，`~/.smallest-agent/` 两边都算得出来。
//
// 分成两份的实际后果是两个真相：同一个 key（user-location）在 CLI 那份里是
// 「杭州」、桌面端那份里是「广州」，而用户以为它们是同一个记忆。他在终端里
// 告诉 agent 的事，第二天打开桌面端就不认识了。
//
// 现在统一到 ~/.smallest-agent/facts.json。代价是脱离了 Electron 的 userData
// 惯例（备份工具、卸载清理找不到它），换来的是「在哪记的都记得」——
// 对单机单人的用法，后者重要得多。
//
// ## 为什么不进 electron-store
//
// 它**必须能被人直接看和改**：
//
//   • 模型会记错。它记下「用户在北京」而你在深圳，这条会污染之后每一次
//     对话，而且看不见、持久。设置面板里有删除按钮，但那个列表本身也可能
//     出问题 —— 文件是最后的兜底。
//   • electron-store 那个 config.json 混着 API key、窗口尺寸、provider 配置。
//     让用户为了删一条记错的事实去编辑那个文件，等于让他冒着改坏 key 的风险。
//
// 两空格缩进、一条一行，`cat` 能读，手删一行不会坏
// （normalizeFacts 丢掉畸形条目而不是抛错）。
// ============================================================================

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import {
  forgetFact,
  normalizeFacts,
  upsertFact,
  type Fact,
  type FactScope,
} from './facts'

/**
 * 记忆文件的位置。
 *
 * 不用 app.getPath('userData')：那个 API 只有 Electron 主进程有，而 CLI
 * 也要读写同一份记忆。homedir() 两边都能拿到。
 *
 * ## 为什么是函数而不是常量
 *
 * 常量会在**模块加载那一刻**求值，于是路径被永久定死。两个后果：
 *
 *   • 测试没法把它指到临时目录 —— 改 process.env.HOME 已经太晚（模块早就
 *     import 过了），结果测试会读写**真实的**用户记忆文件。
 *   • 将来要支持「换一个记忆库」（比如按 profile 分）时无处下手。
 *
 * 惰性求值的代价是每次调用多一次 join —— 相对于紧接着的那次文件 IO
 * 可以忽略。
 */
export function factsFile(): string {
  return join(homedir(), '.smallest-agent', 'facts.json')
}

/**
 * 读全部事实。
 *
 * **同步**：这是刻意的。异步版本要求调用方 await，而它的调用点在工具的
 * run() 里和系统提示装配里 —— 那两处都在热路径上，一个 await 会让每轮
 * 多一次事件循环往返。文件只有几 KB，同步读的代价可以忽略。
 *
 * （第一版 CLI 那份是异步 + 内存缓存，结果 getFacts() 读的是还没填上的
 *  缓存 —— 进程刚起来的第一轮永远拿到空数组。同步读没这个问题。）
 *
 * 读不到（首次运行）或解析失败（手改坏了）都返回空数组 —— 记忆是增强，
 * 不是必需品，它坏掉不该让对话一起挂掉。
 *
 * 不缓存：写操作很稀（模型偶尔调一次 remember），而缓存要处理「用户在
 * 外部手改了文件」的失效问题 —— 那正是我们鼓励他做的事。
 */
export function getFacts(): Fact[] {
  try {
    return normalizeFacts(JSON.parse(readFileSync(factsFile(), 'utf8')))
  } catch {
    return []
  }
}

/** Settings must distinguish an unreadable file from an empty memory library. */
export function getFactsStrict(): Fact[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(factsFile(), 'utf8'))
    if (!Array.isArray(raw)) throw new Error('invalid facts')
    return normalizeFacts(raw)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('无法读取记忆文件，请检查文件格式和访问权限。')
  }
}

/**
 * 写盘。先写临时文件再 rename —— rename 在同一文件系统内是原子的，
 * 所以中途崩溃不会留下一个截断的 JSON（那会让用户下次启动丢掉全部记忆）。
 */
function save(facts: Fact[]): void {
  const path = factsFile()
  const tmp = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  // 两空格缩进：这份文件的设计目标之一就是人能读能改
  writeFileSync(tmp, JSON.stringify(facts, null, 2), 'utf8')
  renameSync(tmp, path)
}

/** 记一条。返回写完之后的完整列表。 */
export function rememberFact(input: {
  key: string
  value: string
  scope: FactScope
  sessionId?: string
}): Fact[] {
  const before = getFacts()
  const after = upsertFact(before, input, Date.now())
  // 引用比较：空 key/value 时 upsertFact 原样返回，跳过写盘
  if (after !== before) save(after)
  return after
}

/** 忘掉一条。返回写完之后的完整列表。 */
export function forgetFactByKey(key: string, scope: FactScope): Fact[] {
  const before = getFacts()
  const after = forgetFact(before, key, scope)
  if (after !== before) save(after)
  return after
}

/**
 * 从旧路径迁移过来（一次性）。
 *
 * 桌面端曾经写在 userData/memory.json。那份数据是用户真实的记忆，不能
 * 因为改了路径就丢掉。
 *
 * **合并而不是覆盖**：两份都可能有内容，而且可能有同 key 的冲突
 * （实测过：CLI 那份说「用户住在杭州」，桌面端那份说「广州」）。
 * 冲突时留 updatedAt 新的那条 —— 那是唯一可辩护的规则，
 * 「后说的话作数」符合用户对记忆的直觉。
 *
 * 迁移完**不删**旧文件：万一合并逻辑有 bug，原始数据还在。它只是个
 * 几 KB 的孤儿文件，留着的成本远低于误删记忆的代价。
 *
 * @param legacyPath 旧文件路径。调用方给 —— 这个模块不该知道 Electron 的
 *   userData 在哪（它也要被 CLI 用）。
 */
export function migrateFrom(legacyPath: string): void {
  let legacy: Fact[]
  try {
    legacy = normalizeFacts(JSON.parse(readFileSync(legacyPath, 'utf8')))
  } catch {
    return // 旧文件不存在或坏了 —— 没什么可迁移的
  }
  if (legacy.length === 0) return

  const current = getFacts()
  let merged = current
  for (const f of legacy) {
    const existing = merged.find((c) => c.key === f.key && c.scope === f.scope)
    // 同 key 冲突：新的赢。没冲突：直接收下
    if (!existing || f.updatedAt > existing.updatedAt) {
      merged = upsertFact(
        merged,
        { key: f.key, value: f.value, scope: f.scope, sessionId: f.sourceSessionId },
        f.updatedAt,
      )
    }
  }
  if (merged !== current) save(merged)
}
