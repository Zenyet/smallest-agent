import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// 应用里所有浮层（右键菜单 + composer 左下角四个选择器）是**一个**视觉语言：
// overlay 底 + card 圆角 + 一层 hairline ring，ring 由 shadow-overlay 的
// 第一层给（0 0 0 1px var(--color-line-strong)）。
//
// ## 为什么是跨文件扫描，而不是每个组件各断言一条
//
// 这个 bug 就是这么漏的：用户点名了 ModelPicker 和 PermissionPicker，
// 改完才发现 ProviderPicker 和 CliModelPicker 是同一份复制粘贴的类名 ——
// 而它们各自的测试都不会知道彼此的存在。按「约定」扫描才防得住下一个新浮层。
describe('浮层描边一致性', () => {
  const dir = join(__dirname, '../../electron/renderer/src/components')

  it('没有任何浮层同时写了 shadow-overlay 和 border-*（那是双层描边）', () => {
    const offenders: string[] = []
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.tsx'))) {
      const src = readFileSync(join(dir, file), 'utf8')
      for (const line of src.split('\n')) {
        // 只看 className 那一行，注释里提到 border 不算
        if (!line.includes('className=')) continue
        if (line.includes('shadow-overlay') && /\bborder(-|\s|")/.test(line)) {
          offenders.push(`${file}: ${line.trim().slice(0, 80)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
