import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSessions, deleteSession, sessionTitle, newSessionId } from '../../electron/main/sessions'
import type { Message } from '../../src/types'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sessions-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const write = (id: string, messages: Message[]) =>
  writeFile(join(dir, `${id}.json`), JSON.stringify(messages), 'utf8')

describe('sessionTitle', () => {
  it('取第一条 user 消息作标题', () => {
    expect(sessionTitle([
      { role: 'assistant', content: '你好' },
      { role: 'user', content: '北京天气怎么样' },
    ])).toBe('北京天气怎么样')
  })

  it('超长标题截断到 30 字符', () => {
    const long = 'x'.repeat(50)
    expect(sessionTitle([{ role: 'user', content: long }])).toHaveLength(30)
  })

  it('没有 user 消息时给默认名', () => {
    expect(sessionTitle([])).toBe('新会话')
  })

  it('折叠换行，避免标题把列表撑开', () => {
    expect(sessionTitle([{ role: 'user', content: '第一行\n第二行' }])).toBe('第一行 第二行')
  })
})

describe('newSessionId', () => {
  it('只含文件名安全字符（store.ts 的 safeId 会把其他字符换成下划线）', () => {
    expect(newSessionId(1739000000000)).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it('不同时间戳产生不同 id', () => {
    expect(newSessionId(1)).not.toBe(newSessionId(2))
  })

  it('同一毫秒内多次调用也不碰撞（连点两次「新对话」会走到这条路）', () => {
    // 计数器保证的是确定性唯一，不是概率性唯一 —— 所以这条断言不会偶发红
    const ids = new Set(Array.from({ length: 500 }, () => newSessionId(1739000000000)))
    expect(ids.size).toBe(500)
  })

  it('时间戳在前，所以 id 仍然可按创建时间排序', () => {
    expect(newSessionId(1) < newSessionId(2)).toBe(true)
  })
})

describe('listSessions', () => {
  it('目录不存在时返回空数组，不抛错（首次启动就是这种情况）', async () => {
    expect(await listSessions(join(dir, 'nope'))).toEqual([])
  })

  it('列出会话并带上标题', async () => {
    await write('s1', [{ role: 'user', content: '问题一' }])
    const list = await listSessions(dir)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 's1', title: '问题一' })
  })

  it('忽略非 .json 文件', async () => {
    await write('s1', [{ role: 'user', content: 'q' }])
    await writeFile(join(dir, 'notes.md'), 'x', 'utf8')
    expect(await listSessions(dir)).toHaveLength(1)
  })

  it('跳过内容损坏的会话文件而不是整个列表报错', async () => {
    await write('good', [{ role: 'user', content: 'q' }])
    await writeFile(join(dir, 'broken.json'), '{not json', 'utf8')
    const list = await listSessions(dir)
    expect(list.map((s) => s.id)).toEqual(['good'])
  })

  it('按最近更新排序，最新的在前', async () => {
    await write('old', [{ role: 'user', content: 'a' }])
    await new Promise((r) => setTimeout(r, 10))
    await write('new', [{ role: 'user', content: 'b' }])
    const list = await listSessions(dir)
    expect(list[0].id).toBe('new')
  })
})

describe('deleteSession', () => {
  it('删掉对应文件', async () => {
    await write('s1', [{ role: 'user', content: 'q' }])
    await deleteSession(dir, 's1')
    expect(existsSync(join(dir, 's1.json'))).toBe(false)
  })

  it('删不存在的会话不报错（前端重复点删除时不该崩）', async () => {
    await expect(deleteSession(dir, 'ghost')).resolves.toBeUndefined()
  })

  it('防路径穿越：id 里的 ../ 不能跳出目录', async () => {
    await writeFile(join(dir, 'outside.json'), '[]', 'utf8')
    await deleteSession(dir, '../outside')
    expect(existsSync(join(dir, 'outside.json'))).toBe(true)
  })
})
