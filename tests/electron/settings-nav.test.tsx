// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { SettingsNav } from '../../electron/renderer/src/components/SettingsNav'
import { SECTIONS } from '../../electron/renderer/src/settings-fields'

afterEach(cleanup)

const noop = { onSelect: () => {}, onClose: () => {} }

// 这个组件存在的理由：设置打开时它**替换掉**会话列表，占的是同一栏。
// 上一版是「会话列表留着 + 设置面板自己再长一列导航」，窗口里横着两列
// 目录共 384px，表单被挤在剩下的地方。见 SettingsNav.tsx 的文件头。
describe('SettingsNav', () => {
  it('列出五个设置分区', () => {
    render(<SettingsNav active="general" {...noop} />)
    for (const s of SECTIONS) {
      expect(screen.getByRole('button', { name: s.label }), `应该有「${s.label}」`).toBeTruthy()
    }
  })

  it('点一项交出它的 id', () => {
    const picked: string[] = []
    render(<SettingsNav active="general" {...noop} onSelect={(id) => picked.push(id)} />)
    fireEvent.click(screen.getByRole('button', { name: '记忆与资料' }))
    expect(picked).toEqual(['memory'])
  })

  // 设置是个页面，得有出口。放顶部而不是底部 —— 「返回」是导航动作，
  // 和下面的分区列表同一层级。
  it('顶部有「返回对话」，点了触发 onClose', () => {
    let closed = 0
    render(<SettingsNav active="general" {...noop} onClose={() => closed++} />)
    fireEvent.click(screen.getByRole('button', { name: /返回对话/ }))
    expect(closed).toBe(1)
  })

  // 分区导航的「我在哪一页」只有这一个地方能说（会话行不同：它的选中态由
  // 右侧内容表达，所以那边 active 不给底）。掉了这个底色就等于没有指示。
  it('当前分区给底并标 aria-current，其它项不标', () => {
    render(<SettingsNav active="advanced" {...noop} />)
    const current = screen.getByRole('button', { name: '高级与诊断' })
    expect(current.getAttribute('aria-current')).toBe('page')
    expect(current.className).toMatch(/bg-hover-2/)

    const other = screen.getByRole('button', { name: '对话偏好' })
    expect(other.getAttribute('aria-current')).toBeNull()
    expect(other.className).not.toMatch(/bg-hover-2/)
  })

  // 换掉的是侧边栏那一栏，宽度和右边框必须和 SessionList 对上，
  // 否则打开/关闭设置时那一栏会跳一下
  it('外壳和会话列表同规格（w-56 + 右边框）', () => {
    const { container } = render(<SettingsNav active="general" {...noop} />)
    const aside = container.querySelector('aside')!
    expect(aside.className).toMatch(/\bw-56\b/)
    expect(aside.className).toMatch(/border-r/)
  })

  // 红绿灯只在左上角，所以让这一栏自己让位 —— 而不是整个 app 顶上留一条横条
  it('顶部留出红绿灯的位置，并且那块可拖拽窗口', () => {
    const { container } = render(<SettingsNav active="general" {...noop} />)
    expect(container.querySelector('[class*="app-region:drag"]')).toBeTruthy()
  })
})
