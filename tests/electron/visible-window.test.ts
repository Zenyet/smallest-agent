import { describe, it, expect } from 'vitest'
import { visibleRange } from '../../electron/renderer/src/visible-window'

describe('visibleRange', () => {
  it('消息少于上限时全部显示', () => {
    expect(visibleRange(20)).toEqual({ start: 0, hiddenCount: 0 })
  })

  it('刚好等于上限时也全部显示', () => {
    expect(visibleRange(100, 100)).toEqual({ start: 0, hiddenCount: 0 })
  })

  it('超过上限时只显示最近的，并报告隐藏了多少条', () => {
    expect(visibleRange(150, 100)).toEqual({ start: 50, hiddenCount: 50 })
  })

  it('空列表不会算出负数', () => {
    expect(visibleRange(0)).toEqual({ start: 0, hiddenCount: 0 })
  })
})
