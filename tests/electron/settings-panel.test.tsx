// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { SettingsPanel } from '../../electron/renderer/src/components/SettingsPanel'
import { SETTING_KEYS } from '../../electron/main/config-env'

afterEach(cleanup)

// 面板重构成左侧分组导航 + 右侧字段的 master-detail 之后，NOTES_DIR /
// EMBEDDING_MODEL 归在「检索」分组、MAX_TURNS 归在「高级」分组——默认打开的
// 是第一个分组「通用」，所以要先点导航切过去，字段才会出现在 DOM 里。
const openSection = (label: '通用' | 'Provider' | '检索' | '高级') => {
  fireEvent.click(screen.getByRole('button', { name: label }))
}

describe('SettingsPanel', () => {
  it('把已有设置填进输入框', () => {
    render(<SettingsPanel settings={{ DEEPSEEK_MODEL: 'deepseek-chat' }} onSave={async () => {}} onClose={() => {}} onRestart={async () => {}} />)
    openSection('Provider')
    expect((screen.getByLabelText('DEEPSEEK_MODEL') as HTMLInputElement).value).toBe('deepseek-chat')
  })

  it('API Key 用密码框，不明文显示在屏幕上', () => {
    render(<SettingsPanel settings={{}} onSave={async () => {}} onClose={() => {}} onRestart={async () => {}} />)
    openSection('Provider')
    expect((screen.getByLabelText('DEEPSEEK_API_KEY') as HTMLInputElement).type).toBe('password')
  })

  it('保存时把改动交出去（auto-save，防抖后自动保存）', async () => {
    const saved: Array<{ DEEPSEEK_API_KEY?: string }> = []
    render(<SettingsPanel settings={{}} onSave={async (p) => { saved.push(p) }} onClose={() => {}} onRestart={async () => {}} />)
    openSection('Provider')
    fireEvent.change(screen.getByLabelText('DEEPSEEK_API_KEY'), { target: { value: 'sk-new' } })
    // 等待防抖（500ms）
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(saved[0]?.DEEPSEEK_API_KEY).toBe('sk-new')
  })

  it('改 NOTES_DIR 时提示需要重启', async () => {
    render(<SettingsPanel settings={{ NOTES_DIR: '/old' }} onSave={async () => {}} onClose={() => {}} onRestart={async () => {}} />)
    openSection('检索')
    fireEvent.change(screen.getByLabelText('NOTES_DIR'), { target: { value: '/new' } })
    // 警告基于 draft 变化，立即出现；但有两处匹配文本：<span> 和 <button>，用更具体的查询
    expect(screen.getByText('需要重启应用才能生效。')).toBeTruthy()
  })

  it('改 EMBEDDING_MODEL 时提示需要重启', async () => {
    render(<SettingsPanel settings={{ EMBEDDING_MODEL: 'old-model' }} onSave={async () => {}} onClose={() => {}} onRestart={async () => {}} />)
    openSection('检索')
    fireEvent.change(screen.getByLabelText('EMBEDDING_MODEL'), { target: { value: 'new-model' } })
    // 警告基于 draft 变化，立即出现；但有两处匹配文本：<span> 和 <button>，用更具体的查询
    expect(screen.getByText('需要重启应用才能生效。')).toBeTruthy()
  })

  it('保存后显示重启按钮', async () => {
    render(<SettingsPanel settings={{ NOTES_DIR: '/old' }} onSave={async () => {}} onClose={() => {}} onRestart={async () => {}} />)
    openSection('检索')
    fireEvent.change(screen.getByLabelText('NOTES_DIR'), { target: { value: '/new' } })
    // Auto-save 会在防抖后自动保存，等待
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(await screen.findByRole('button', { name: /立即重启/ })).toBeTruthy()
  })

  it('保存后切到其它分组，重启提示仍然可见（警告横跨分组，不属于某一个 section）', async () => {
    render(<SettingsPanel settings={{ NOTES_DIR: '/old' }} onSave={async () => {}} onClose={() => {}} onRestart={async () => {}} />)
    openSection('检索')
    fireEvent.change(screen.getByLabelText('NOTES_DIR'), { target: { value: '/new' } })
    // Auto-save 会在防抖后自动保存，等待
    await new Promise(resolve => setTimeout(resolve, 600))
    await screen.findByRole('button', { name: /立即重启/ })
    openSection('Provider')
    expect(screen.getByText(/需要重启应用才能生效/)).toBeTruthy()
  })

  it('点击重启按钮触发 onRestart', async () => {
    let restarted = 0
    render(<SettingsPanel settings={{ NOTES_DIR: '/old' }} onSave={async () => {}} onClose={() => {}} onRestart={async () => { restarted++ }} />)
    openSection('检索')
    fireEvent.change(screen.getByLabelText('NOTES_DIR'), { target: { value: '/new' } })
    // Auto-save 会在防抖后自动保存，等待
    await new Promise(resolve => setTimeout(resolve, 600))
    // 等待重启按钮出现
    const restartBtn = await screen.findByRole('button', { name: /立即重启/ })
    await fireEvent.click(restartBtn)
    expect(restarted).toBe(1)
  })

  it('关闭按钮触发 onClose', () => {
    let closed = 0
    render(<SettingsPanel settings={{}} onSave={async () => {}} onClose={() => closed++} onRestart={async () => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /关闭/ }))
    expect(closed).toBe(1)
  })

  it('settings 类名保留作测试锚点', () => {
    const { container } = render(<SettingsPanel settings={{}} onSave={async () => {}} onClose={() => {}} onRestart={async () => {}} />)
    expect(container.querySelector('.settings')).toBeTruthy()
  })

  it('field 类名保留在每个输入字段上', () => {
    const { container } = render(<SettingsPanel settings={{}} onSave={async () => {}} onClose={() => {}} onRestart={async () => {}} />)
    expect(container.querySelectorAll('.field').length).toBeGreaterThan(0)
  })

  it('settings__warn 类名用于警告提示', () => {
    const { container } = render(
      <SettingsPanel settings={{ NOTES_DIR: '/old' }} onSave={async () => {}} onClose={() => {}} onRestart={async () => {}} />,
    )
    openSection('检索')
    fireEvent.change(screen.getByLabelText('NOTES_DIR'), { target: { value: '/new' } })
    expect(container.querySelector('.settings__warn')).toBeTruthy()
  })

  it('验证失败时显示错误并保持面板打开', async () => {
    const { container } = render(
      <SettingsPanel
        settings={{}}
        onSave={async () => {
          throw new Error('MAX_TURNS 必须是数字，得到的是 "abc"')
        }}
        onClose={() => {}}
        onRestart={async () => {}}
      />,
    )
    openSection('高级')
    fireEvent.change(screen.getByLabelText('MAX_TURNS'), { target: { value: 'abc' } })
    // Auto-save 会在防抖后自动保存，等待
    await new Promise(resolve => setTimeout(resolve, 600))
    // 等待异步错误处理
    await screen.findByText(/必须是数字/)
    expect(container.querySelector('.settings__error')).toBeTruthy()
  })

  it('重启被阻止时显示错误', async () => {
    render(
      <SettingsPanel
        settings={{ NOTES_DIR: '/old' }}
        onSave={async () => {}}
        onClose={() => {}}
        onRestart={async () => {
          throw new Error('有会话正在处理中，无法重启')
        }}
      />,
    )
    openSection('检索')
    fireEvent.change(screen.getByLabelText('NOTES_DIR'), { target: { value: '/new' } })
    // Auto-save 会在防抖后自动保存，等待
    await new Promise(resolve => setTimeout(resolve, 600))
    // 等待重启按钮出现
    const restartBtn = await screen.findByRole('button', { name: /立即重启/ })
    await fireEvent.click(restartBtn)
    // 等待异步错误处理
    await screen.findByText(/正在处理中/)
  })

  it('左侧导航列出四个分组：通用 / Provider / 检索 / 高级', () => {
    render(<SettingsPanel settings={{}} onSave={async () => {}} onClose={() => {}} onRestart={async () => {}} />)
    expect(screen.getByRole('button', { name: '通用' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Provider' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '检索' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '高级' })).toBeTruthy()
  })

  it('切换分组只显示该组的字段，其它分组的字段不在 DOM 里（master-detail，不是手风琴）', () => {
    render(<SettingsPanel settings={{}} onSave={async () => {}} onClose={() => {}} onRestart={async () => {}} />)
    // 默认打开「通用」
    expect(screen.getByLabelText('STREAM')).toBeTruthy()
    expect(screen.queryByLabelText('NOTES_DIR')).toBeNull()
    openSection('检索')
    expect(screen.getByLabelText('NOTES_DIR')).toBeTruthy()
    expect(screen.queryByLabelText('STREAM')).toBeNull()
  })

  it('每个 SETTING_KEYS 里的键都能在某个分组下找到——分组重构不能让设置变得够不到', () => {
    render(<SettingsPanel settings={{}} onSave={async () => {}} onClose={() => {}} onRestart={async () => {}} />)
    const found = new Set<string>()
    for (const label of ['通用', 'Provider', '检索', '高级'] as const) {
      openSection(label)
      for (const key of SETTING_KEYS) {
        if (screen.queryByLabelText(key)) found.add(key)
      }
    }
    expect([...found].sort()).toEqual([...SETTING_KEYS].sort())
  })
})
