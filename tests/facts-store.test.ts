import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Fact } from '../src/memory/facts'
import {
  factsFile,
  forgetFactByKey,
  getFacts,
  getFactsStrict,
  migrateFrom,
  rememberFact,
} from '../src/memory/facts-store'

// ============================================================================
// 记忆的磁盘落地 + 从旧路径迁移
//
// ## 为什么要 mock homedir
//
// facts-store 在模块顶层就算出 factsFile()（`homedir()/.smallest-agent/...`）。
// 不 mock 的话这一组测试会读写**真实的**用户记忆文件 —— 跑一次测试就把
// 开发者自己的记忆冲掉了。
// ============================================================================

let tmp: string
let realHome: string | undefined

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'facts-test-'))
  realHome = process.env.HOME
  // factsFile() 是惰性求值的（见那边的注释），所以这里改 HOME 有效 ——
  // 如果它是模块加载时求值的常量，这一组就会读写真实的用户记忆文件
  process.env.HOME = tmp
})

afterEach(() => {
  process.env.HOME = realHome
  rmSync(tmp, { recursive: true, force: true })
})

describe('迁移：从旧路径合并过来', () => {
  const T0 = 1_700_000_000_000

  it('旧文件不存在时什么都不做', () => {
    migrateFrom(join(tmp, 'nope.json'))
    expect(getFacts()).toEqual([])
  })

  it('旧文件坏了不抛，也不清掉现有记忆', () => {
    rememberFact({ key: 'keep', value: '留着我', scope: 'global' })
    const legacy = join(tmp, 'legacy.json')
    writeFileSync(legacy, '{ 这不是合法 JSON')
    expect(() => migrateFrom(legacy)).not.toThrow()
    expect(getFacts().map((f) => f.key)).toEqual(['keep'])
  })

  it('把旧文件里的事实搬过来', () => {
    const legacy = join(tmp, 'legacy.json')
    const old: Fact[] = [
      { key: 'user-location', value: '用户住在广州', scope: 'global', updatedAt: T0 },
    ]
    writeFileSync(legacy, JSON.stringify(old))
    migrateFrom(legacy)
    expect(getFacts()).toHaveLength(1)
    expect(getFacts()[0].value).toBe('用户住在广州')
  })

  it('保留原始的 updatedAt，不重置成「现在」', () => {
    const legacy = join(tmp, 'legacy.json')
    writeFileSync(
      legacy,
      JSON.stringify([{ key: 'k', value: 'v', scope: 'global', updatedAt: T0 }]),
    )
    migrateFrom(legacy)
    // 重置成 Date.now() 会让旧事实假装很新鲜，抢掉真正新事实的注入位置
    expect(getFacts()[0].updatedAt).toBe(T0)
  })

  // ## 这一条是迁移里唯一有争议的决定
  //
  // 实测撞到过：CLI 那份说「用户住在杭州」，桌面端那份说「广州」——
  // 同一个 key、不同的值。留新的那条是唯一可辩护的规则（「后说的话作数」
  // 符合用户对记忆的直觉）。
  it('同 key 冲突时留 updatedAt 新的那条', () => {
    // 现在这份：杭州，比较新
    rememberFact({ key: 'user-location', value: '用户住在杭州', scope: 'global' })
    const newer = getFacts()[0].updatedAt

    // 旧文件：广州，更早
    const legacy = join(tmp, 'legacy.json')
    writeFileSync(
      legacy,
      JSON.stringify([
        { key: 'user-location', value: '用户住在广州', scope: 'global', updatedAt: newer - 10_000 },
      ]),
    )
    migrateFrom(legacy)

    expect(getFacts()).toHaveLength(1)
    expect(getFacts()[0].value).toBe('用户住在杭州')
  })

  it('旧的那条更新时它赢', () => {
    rememberFact({ key: 'user-location', value: '用户住在杭州', scope: 'global' })
    const mine = getFacts()[0].updatedAt

    const legacy = join(tmp, 'legacy.json')
    writeFileSync(
      legacy,
      JSON.stringify([
        { key: 'user-location', value: '用户住在广州', scope: 'global', updatedAt: mine + 10_000 },
      ]),
    )
    migrateFrom(legacy)
    expect(getFacts()[0].value).toBe('用户住在广州')
  })

  it('不冲突的两边都留下', () => {
    rememberFact({ key: 'a', value: '我这边的', scope: 'global' })
    const legacy = join(tmp, 'legacy.json')
    writeFileSync(
      legacy,
      JSON.stringify([{ key: 'b', value: '旧文件的', scope: 'global', updatedAt: T0 }]),
    )
    migrateFrom(legacy)
    expect(getFacts().map((f) => f.key).sort()).toEqual(['a', 'b'])
  })

  // 幂等：迁移完旧文件刻意不删（万一合并有 bug，原始数据还在），
  // 所以每次启动都会再跑一遍
  it('重复迁移不产生重复条目', () => {
    const legacy = join(tmp, 'legacy.json')
    writeFileSync(
      legacy,
      JSON.stringify([{ key: 'k', value: 'v', scope: 'global', updatedAt: T0 }]),
    )
    migrateFrom(legacy)
    migrateFrom(legacy)
    migrateFrom(legacy)
    expect(getFacts()).toHaveLength(1)
  })

  it('迁移不删旧文件（合并有 bug 时还能手工恢复）', () => {
    const legacy = join(tmp, 'legacy.json')
    writeFileSync(
      legacy,
      JSON.stringify([{ key: 'k', value: 'v', scope: 'global', updatedAt: T0 }]),
    )
    migrateFrom(legacy)
    expect(existsSync(legacy)).toBe(true)
  })
})

describe('读写', () => {
  it('首次运行读到空数组，不抛', () => {
    expect(getFacts()).toEqual([])
  })

  // 第一版 CLI 那份是异步 + 内存缓存，getFacts() 读的是还没填上的缓存 ——
  // 进程刚起来的第一轮永远拿到空数组。同步读没这个问题。
  it('写完立刻读得到（同步，没有缓存空窗）', () => {
    rememberFact({ key: 'k', value: '刚写的', scope: 'global' })
    expect(getFacts()[0].value).toBe('刚写的')
  })

  it('手改坏了返回空数组，不让对话一起挂掉', () => {
    rememberFact({ key: 'k', value: 'v', scope: 'global' })
    writeFileSync(factsFile(), 'garbage{{{')
    expect(getFacts()).toEqual([])
  })

  it('文件是两空格缩进的（设计目标：人能读能改）', () => {
    rememberFact({ key: 'k', value: 'v', scope: 'global' })
    expect(readFileSync(factsFile(), 'utf8')).toContain('\n  {')
  })

  it('删一条', () => {
    rememberFact({ key: 'a', value: '1', scope: 'global' })
    rememberFact({ key: 'b', value: '2', scope: 'global' })
    forgetFactByKey('a', 'global')
    expect(getFacts().map((f) => f.key)).toEqual(['b'])
  })

  it('写盘用临时文件 + rename（崩溃不留截断的 JSON）', () => {
    rememberFact({ key: 'k', value: 'v', scope: 'global' })
    // .tmp 应该已经被 rename 掉了，不残留
    expect(existsSync(`${factsFile()}.tmp`)).toBe(false)
    expect(existsSync(factsFile())).toBe(true)
  })
})


describe('设置页严格读取', () => {
  it('首次运行返回空列表；损坏文件明确报错而非伪装为空', () => {
    expect(getFactsStrict()).toEqual([])
    rememberFact({ key: 'keep', value: 'remember me', scope: 'global' })
    writeFileSync(factsFile(), '{ malformed')
    expect(() => getFactsStrict()).toThrow('无法读取记忆文件')
    expect(getFacts()).toEqual([])
    expect(readFileSync(factsFile(), 'utf8')).toBe('{ malformed')
  })
})
