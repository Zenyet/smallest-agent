// SessionStore（src/memory/store.ts）只有 load/save，没有 list ——
// 会话列表是桌面端才需要的能力，所以放在 Electron 层，src/ 不动。
import { readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Message } from '../../src/types'
import type { SessionMeta } from '../shared/channels'

const TITLE_MAX = 30

// 和 store.ts 里的 safeId 同样的规则（那个函数没导出，这里复刻一份）：
// 把非安全字符换成下划线，防止 "../../etc/passwd" 这类 id 跳出目录。
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function sessionTitle(messages: Message[]): string {
  const first = messages.find((m) => m.role === 'user')
  if (!first) return '新会话'
  // 折叠所有空白（含换行），否则多行输入会把侧边栏撑变形
  const flat = first.content.replace(/\s+/g, ' ').trim()
  return flat.slice(0, TITLE_MAX) || '新会话'
}

// seed 通常是 Date.now()。光靠时间戳不够：同一毫秒内点两次「新对话」会得到同一个 id，
// 于是两个会话条目指向同一个文件，先写入的历史被后一个静默继承。
//
// 用进程内自增计数器而不是随机后缀：随机只能让碰撞「不太可能」（4 位 base-36 抽 200 次
// 撞一次的概率约 1.2%，测试会偶发红），计数器则从构造上保证同一进程内绝不重复 ——
// 而「连点两次新对话」正好就是同一进程内的场景。
// 前缀仍是时间戳，所以 id 保持可按创建时间排序；字符集限定 [a-z0-9-]，
// 天然满足 store.ts 的 safeId 规则。
let idCounter = 0

export function newSessionId(seed: number): string {
  idCounter += 1
  return `s${seed.toString(36)}-${idCounter.toString(36)}`
}

export async function listSessions(dir: string): Promise<SessionMeta[]> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    // 目录不存在 = 还没有任何会话（首次启动），返回空列表而不是报错
    return []
  }

  const metas: SessionMeta[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const path = join(dir, file)
    try {
      const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
      const messages = JSON.parse(raw) as Message[]
      metas.push({
        id: file.slice(0, -'.json'.length),
        title: sessionTitle(messages),
        updatedAt: info.mtimeMs,
      })
    } catch {
      // 单个文件坏了就跳过它，不要让整个列表打不开
      continue
    }
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteSession(dir: string, id: string): Promise<void> {
  try {
    await unlink(join(dir, `${safeId(id)}.json`))
  } catch {
    // 文件本来就不在（重复点删除）—— 结果一致，不必报错
  }
}
