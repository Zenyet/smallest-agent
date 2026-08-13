import { describe, it, expect } from 'vitest'
import { CH } from '../../electron/shared/channels'

describe('CH', () => {
  it('每个频道名都唯一（避免复制粘贴时写重导致事件串台）', () => {
    const names = Object.values(CH)
    expect(new Set(names).size).toBe(names.length)
  })

  it('频道名统一带 agent: 前缀，避免和 Electron 内置事件冲突', () => {
    for (const name of Object.values(CH)) {
      expect(name.startsWith('agent:')).toBe(true)
    }
  })
})
