// ============================================================================
// memory/store.ts —— 跨会话记忆的磁盘落地：JSON 文件会话存储
// ----------------------------------------------------------------------------
// Stage 2「跨会话记忆」的实现层：每个 sessionId 对应一个 JSON 文件，
// 存储该会话的完整 Message[]，进程重启后仍可 load 出来继续上下文。
//
// 为什么用磁盘而不是内存变量？每次 pnpm dev 是一个全新 Node 进程，
// 内存在进程退出时全部丢失；JSON 文件最简单、可 git 追踪、人肉可读。
//
// 在 agent 循环里：cli 用 store.load() 在 runAgent 前注入 history，
// 用 onComplete 回调调 store.save() 把更新后的消息写回去。
// ============================================================================

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Message } from '../types'

// SessionStore 是纯接口，便于将来换成数据库实现（sqlite、redis 等）而不改调用方。
export interface SessionStore {
  load(sessionId: string): Promise<Message[]>
  save(sessionId: string, messages: Message[]): Promise<void>
}

// 路径穿越防护：把用户传入的 sessionId 里的非安全字符全替换成 '_'，
// 防止类似 "../../etc/passwd" 这种 id 跳出 baseDir 读写任意文件。
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

// createJsonSessionStore 是工厂函数而非 class，
// 方便在测试中传入临时目录、在 cli 中传入 .sessions/ 等不同路径。
export function createJsonSessionStore(dir: string): SessionStore {
  // resolve 转绝对路径，避免 cwd 变化时路径语义改变。
  const baseDir = resolve(dir)
  const fileFor = (id: string) => join(baseDir, `${safeId(id)}.json`)
  return {
    async load(sessionId) {
      const file = fileFor(sessionId)
      // 文件不存在 = 新会话，返回空历史，不报错。
      if (!existsSync(file)) return []
      return JSON.parse(await readFile(file, 'utf8')) as Message[]
    },
    async save(sessionId, messages) {
      // recursive:true = 目录不存在时自动创建，第一次 save 不需要手动 mkdir。
      await mkdir(baseDir, { recursive: true })
      await writeFile(fileFor(sessionId), JSON.stringify(messages, null, 2), 'utf8')
    },
  }
}
