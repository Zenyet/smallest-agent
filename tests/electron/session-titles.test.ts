import { describe, it, expect } from 'vitest'
import {
  forgetTitle,
  normalizeTitles,
  withTitle,
  TITLE_MAX,
} from '../../electron/main/session-titles'

// 这个文件不 import electron，所以能在纯 Node 下跑 —— 持久化那一层在
// session-titles-store.ts（`new Store()` 在模块顶层就要 app.getPath()）。
// 分工和 context-menu.ts / projects.ts 一致。
describe('normalizeTitles', () => {
  it('保留合法的 id → 标题', () => {
    expect(normalizeTitles({ s1: '我的会话', s2: '另一个' })).toEqual({
      s1: '我的会话',
      s2: '另一个',
    })
  })

  // 磁盘上的 JSON 可能是手改的或旧版本写的，一个畸形值不该让整个侧边栏炸掉
  it('丢掉非字符串的值', () => {
    expect(normalizeTitles({ s1: '好的', s2: 123, s3: null, s4: { a: 1 }, s5: ['x'] })).toEqual({
      s1: '好的',
    })
  })

  it('非对象输入退化成空表', () => {
    expect(normalizeTitles(null)).toEqual({})
    expect(normalizeTitles(undefined)).toEqual({})
    expect(normalizeTitles('字符串')).toEqual({})
    expect(normalizeTitles(42)).toEqual({})
    // 数组也不行 —— 它的 key 是下标，不是 sessionId
    expect(normalizeTitles(['a', 'b'])).toEqual({})
  })

  it('去掉首尾空白', () => {
    expect(normalizeTitles({ s1: '  两边有空格  ' })).toEqual({ s1: '两边有空格' })
  })

  // 空白标题等于「没改名」，留着会让侧边栏显示一个空行
  it('纯空白的标题被丢掉', () => {
    expect(normalizeTitles({ s1: '   ', s2: '', s3: '\n\t' })).toEqual({})
  })

  it('超长标题截到 TITLE_MAX', () => {
    const long = 'x'.repeat(TITLE_MAX + 20)
    const out = normalizeTitles({ s1: long })
    expect(out.s1).toHaveLength(TITLE_MAX)
  })

  // 和 gpui 侧的 TITLE_MAX 对齐（rs/ui/src/session_titles.rs）。
  // 侧边栏那点宽度放不下更长的，锁住这个值免得两边漂移。
  it('TITLE_MAX 是 60', () => {
    expect(TITLE_MAX).toBe(60)
  })
})

describe('withTitle', () => {
  it('写入新标题', () => {
    expect(withTitle({}, 's1', '新名字')).toEqual({ s1: '新名字' })
  })

  it('覆盖已有标题', () => {
    expect(withTitle({ s1: '旧' }, 's1', '新')).toEqual({ s1: '新' })
  })

  // 空标题 = 恢复自动推导的名字，所以是删掉这条覆盖而不是存一个空串
  it('空标题删掉覆盖', () => {
    expect(withTitle({ s1: '旧', s2: '留着' }, 's1', '')).toEqual({ s2: '留着' })
    expect(withTitle({ s1: '旧' }, 's1', '   ')).toEqual({})
  })

  it('截到 TITLE_MAX', () => {
    const out = withTitle({}, 's1', 'y'.repeat(TITLE_MAX + 5))
    expect(out.s1).toHaveLength(TITLE_MAX)
  })

  // 不改原表：调用方（store）拿返回值写盘，原地改会让「写盘前后」难以区分
  it('不改原表', () => {
    const before = { s1: '原' }
    withTitle(before, 's2', '新')
    expect(before).toEqual({ s1: '原' })
  })
})

describe('forgetTitle', () => {
  it('删掉指定 id', () => {
    expect(forgetTitle({ s1: 'a', s2: 'b' }, 's1')).toEqual({ s2: 'b' })
  })

  // 引用比较是调用方跳过写盘的依据（projects 的 forgetSession 同一个约定），
  // 所以「没这一条」必须返回同一个对象，不能返回一个内容相同的新对象
  it('没这一条时原样返回同一个对象', () => {
    const titles = { s1: 'a' }
    expect(forgetTitle(titles, '不存在')).toBe(titles)
  })

  it('不改原表', () => {
    const before = { s1: 'a', s2: 'b' }
    forgetTitle(before, 's1')
    expect(before).toEqual({ s1: 'a', s2: 'b' })
  })
})
