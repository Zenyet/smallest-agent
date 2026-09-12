// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { SettingsPanel } from '../../electron/renderer/src/components/SettingsPanel'
import type { Fact } from '../../electron/shared/channels'

// ============================================================================
// 设置面板的「记忆」页
//
// ## 为什么这一页非做不可
//
// 我在设计这套记忆系统时把它标成「不可协商」，理由是：模型会记错，而记错
// 一条会污染之后**每一次**对话 —— 那种失败看不见、且持久。没有这个列表的话
// 用户唯一的出路是去翻 ~/.smallest-agent/facts.json。
//
// （而我第一版交付时恰恰漏了它。这一组测试锁住它别再消失。）
//
// ## 为什么用 vi.mock 而不是塞 window.electronAPI
//
// api.ts 里是 `export const api = window.electronAPI || mockAPI` —— 那行在
// **模块 import 时**求值，所以 beforeEach 里塞 window 已经太晚，拿到的还是
// mockAPI。只能拦模块本身。
//
// （这和 facts-store 里 factsFile() 从常量改成函数是同一类问题：模块加载时
//  固化的东西，测试没法替。）
// ============================================================================

const T0 = Date.now()
const fact = (over: Partial<Fact> = {}): Fact => ({
  key: 'user-location',
  value: '用户住在深圳',
  scope: 'global',
  updatedAt: T0,
  ...over,
})

// vi.mock 会被提升到文件顶部，所以共享状态要用 vi.hoisted 建
const h = vi.hoisted(() => ({
  facts: [] as unknown[],
  readError: false,
  updateError: false,
  updateCalls: [] as string[],
  forgetCalls: [] as [string, string][],
  listeners: [] as ((facts: unknown[]) => void)[],
}))

vi.mock('../../electron/renderer/src/api', () => ({
  api: {
    getFacts: async () => { if (h.readError) throw new Error('read failed'); return h.facts },
    getSettingsStatus: async () => ({ pendingKeys: [], applied: {}, inheritedKeys: [] }),
    updateFact: async (key: string, scope: string, value: string) => {
      h.updateCalls.push(value)
      if (h.updateError) throw new Error('保存失败，请重试')
      h.facts = h.facts.map(f => (f as Fact).key === key && (f as Fact).scope === scope ? { ...(f as Fact), value } : f)
      return h.facts
    },
    forgetFact: async (key: string, scope: string) => {
      h.forgetCalls.push([key, scope])
      h.facts = h.facts.filter(
        (f) => !((f as Fact).key === key && (f as Fact).scope === scope),
      )
      return h.facts
    },
    onFactsChanged: (cb: (f: unknown[]) => void) => {
      h.listeners.push(cb)
      return () => {}
    },
    // 面板挂载时还会调这个
    detectProviders: async () => [],
  },
}))

function installApi(facts: Fact[]) {
  h.readError = false
  h.updateError = false
  h.updateCalls = []
  h.facts = [...facts]
  h.forgetCalls = []
  h.listeners = []
}

beforeEach(() => installApi([]))
afterEach(cleanup)

const renderMemory = () =>
  render(
    <SettingsPanel
      settings={{}}
      activeSection="memory"
      onSave={async () => {}}
      onRestart={async () => {}}
    />,
  )

describe('记忆页', () => {
  it('没有事实时给出上手提示，而不是一片空白', async () => {
    renderMemory()
    expect(await screen.findByText(/还没有记住任何事实/)).toBeTruthy()
    // 告诉用户怎么开始
    expect(screen.getByText(/我住在深圳/)).toBeTruthy()
  })

  it('列出记住的事实', async () => {
    installApi([fact(), fact({ key: 'pkg', value: '这个仓库用 pnpm', scope: 'project:/lab/x' })])
    renderMemory()
    expect(await screen.findByText('用户住在深圳')).toBeTruthy()
    expect(screen.getByText('这个仓库用 pnpm')).toBeTruthy()
  })

  it('标出作用域：全局 vs 项目', async () => {
    installApi([fact(), fact({ key: 'pkg', value: '项目那条', scope: 'project:/lab/x' })])
    renderMemory()
    await screen.findByText('用户住在深圳')
    expect(screen.getByText('全局 · 所有项目')).toBeTruthy()
    expect(screen.getByText('项目 · /lab/x')).toBeTruthy()
  })

  // key 露出来是为了排查：模型偶尔会用两个不同的 key 记同一件事
  // （user-location 和 user-city），看得见才发现得了
  it('显示 key', async () => {
    installApi([fact()])
    renderMemory()
    expect(await screen.findByText('user-location')).toBeTruthy()
  })

  it('项目事实显示它属于哪个目录', async () => {
    installApi([fact({ key: 'b', value: 'x', scope: 'project:/lab/myrepo' })])
    renderMemory()
    expect(await screen.findByText('项目 · /lab/myrepo')).toBeTruthy()
  })

  // ## 这是这一页存在的核心理由
  it('点删除按钮忘掉那条', async () => {
    installApi([fact()])
    renderMemory()
    const btn = await screen.findByLabelText(/忘掉「用户住在深圳」/)
    fireEvent.click(btn)
    await waitFor(() => expect(h.forgetCalls).toEqual([['user-location', 'global']]))
  })

  it('删完之后列表里就没有它了', async () => {
    installApi([fact()])
    renderMemory()
    fireEvent.click(await screen.findByLabelText(/忘掉/))
    await waitFor(() => expect(screen.queryByText('用户住在深圳')).toBeNull())
  })

  it('删项目事实时传对作用域（不是字面的 "project"）', async () => {
    installApi([fact({ key: 'pkg', value: '项目那条', scope: 'project:/lab/x' })])
    renderMemory()
    fireEvent.click(await screen.findByLabelText(/忘掉/))
    await waitFor(() => expect(h.forgetCalls).toEqual([['pkg', 'project:/lab/x']]))
  })

  // 新鲜的排在前面，和注入系统提示时的排序一致（renderFacts）——
  // 两处顺序不同会让用户以为「界面上第一条」就是「模型最先看到的那条」
  it('新鲜的排在前面', async () => {
    installApi([
      fact({ key: 'old', value: '旧的那条', updatedAt: T0 - 100_000 }),
      fact({ key: 'new', value: '新的那条', updatedAt: T0 }),
    ])
    const { container } = renderMemory()
    await screen.findByText('新的那条')
    const text = container.textContent ?? ''
    expect(text.indexOf('新的那条')).toBeLessThan(text.indexOf('旧的那条'))
  })

  // ## 为什么订阅广播
  //
  // 模型在对话里调 remember 会改这份数据，而设置页可能正开着 ——
  // 不订阅的话用户看着一个不动的旧列表，以为没记上
  it('模型在对话里记了新东西时，列表跟着更新', async () => {
    installApi([])
    renderMemory()
    await screen.findByText(/还没有记住任何事实/)

    // 主进程广播过来
    expect(h.listeners.length).toBeGreaterThan(0)
    h.listeners.forEach((cb) => cb([fact({ value: '刚记下的' })]))

    expect(await screen.findByText('刚记下的')).toBeTruthy()
  })

  // ## 为什么这一页只能删、不能加
  //
  // 写入只该由模型在对话里发起。给界面一个「新增」按钮意味着用户要自己想
  // key、想作用域、想措辞 —— 那都是模型该做的事。
  it('没有「新增事实」的入口', async () => {
    installApi([fact()])
    renderMemory()
    await screen.findByText('用户住在深圳')
    expect(screen.queryByText(/新增|添加/)).toBeNull()
  })
})


it('读取失败与空记忆分别显示，并可重试', async () => {
  h.readError = true
  renderMemory()
  await screen.findByText('读取记忆失败，请重试。')
  expect(screen.queryByText(/还没有记住任何事实/)).toBeNull()
  h.readError = false
  fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
  await screen.findByText(/还没有记住任何事实/)
})

it('行内编辑支持换行，快捷键保存后返回阅读并恢复焦点', async () => {
  installApi([fact()]); renderMemory()
  fireEvent.click(await screen.findByRole('button', { name: '编辑「用户住在深圳」' }))
  const input = screen.getByRole('textbox', { name: '修改记忆' })
  expect(input.tagName).toBe('TEXTAREA')
  fireEvent.change(input, { target: { value: '用户住在深圳\n喜欢简洁回答' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(h.updateCalls).toEqual([])
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true })
  expect(h.updateCalls).toEqual([])
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
  await waitFor(() => expect(screen.queryByRole('textbox', { name: '修改记忆' })).toBeNull())
  expect(h.updateCalls).toEqual(['用户住在深圳\n喜欢简洁回答'])
  await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toContain('编辑「用户住在深圳'))
})
it('保存失败在条目内保留草稿，取消不修改原文', async () => {
  installApi([fact()]); h.updateError = true; renderMemory()
  fireEvent.click(await screen.findByRole('button', { name: '编辑「用户住在深圳」' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '新内容' } })
  fireEvent.click(screen.getByRole('button', { name: '保存记忆' }))
  await screen.findByRole('alert')
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('新内容')
  expect(screen.queryByRole('button', { name: '重新读取' })).toBeNull()
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
  expect(screen.getByText('用户住在深圳')).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()
})
