// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { SettingsPanel } from '../../electron/renderer/src/components/SettingsPanel'
import { GROUPS, SECTIONS, type SectionId } from '../../electron/renderer/src/settings-fields'
import type { DesktopSettings } from '../../electron/main/config-env'
import type { ProvidersView } from '../../electron/shared/channels'
import { ALL } from '../../electron/main/vendors'

afterEach(cleanup)

// 面板现在只渲染**一页**。「在哪一页」是 App 传进来的 prop，不是它自己的
// 状态 —— 那份分区导航搬去了侧边栏（SettingsNav.tsx，设置打开时整个换掉
// 会话列表），所以「切页」在这里不是点一个按钮，而是换 activeSection。
//
// renderAt 直接渲染在某一页上；要验「切页之后仍然……」那类横跨分区的行为
// 时用返回的 open()，它走 rerender —— 组件实例不变，draft / error 那些内部
// 状态跟着留下来，和真实里点导航切页是同一件事。
type SectionLabel = (typeof SECTIONS)[number]['label']

const idOf = (label: SectionLabel): SectionId =>
  SECTIONS.find((s) => s.label === label)!.id

const noop = {
  onSave: async () => {},
  onRestart: async () => {},
}

function renderAt(
  label: SectionLabel,
  props: {
    settings?: DesktopSettings
    providers?: ProvidersView
    onSave?: (patch: DesktopSettings) => Promise<void>
    onRestart?: () => Promise<void>
  } = {},
) {
  const all = { settings: {}, ...noop, ...props }
  const view = render(<SettingsPanel {...all} activeSection={idOf(label)} />)
  return {
    ...view,
    open: (next: SectionLabel) =>
      view.rerender(<SettingsPanel {...all} activeSection={idOf(next)} />),
  }
}

describe('SettingsPanel', () => {
  // --- 凭据页 ---
  //
  // 这一页只管「把手上有的 key 填进去」。没有厂商选择器 —— 用哪家、哪个模型
  // 由 composer 左下角的 ModelPicker 决定，设置页再放一个等于同一件事两个
  // 入口，两处显示的「当前是哪家」迟早不一致。
  //
  // DEEPSEEK_MODEL / DEEPSEEK_BASE_URL 也不在这儿：它们是 buildEnv 从
  // 「选了哪家 + 哪个模型」算出来的派生值（见 config-env.ts）。

  // ## 这一页现在是「选一家、填一栏」，不是九家全摊开
  //
  // 九个 key 输入框里八个永远是空的，用户要在一屏长表单里找自己那一家。
  //
  // 那个 select 选的**不是**「谁答我的问题」—— 它只决定这张表单填哪家的 key
  // （表单作用域），不写 ACTIVE_VENDOR。「用哪家答话」在 composer 左下角，
  // 两处混用会让同一个事实有两个来源（上一版就是那样，撞出过
  // {厂商:anthropic, 模型:deepseek-reasoner} 那种脏组合）。
  it('凭据页有厂商 select，九家加自定义端点都在选项里', () => {
    renderAt('凭据')
    const select = screen.getByLabelText('厂商') as HTMLSelectElement
    const values = [...select.options].map((o) => o.value)
    for (const v of ALL) {
      expect(values, `选项里该有 ${v.name}`).toContain(v.id)
    }
    // 自定义端点在最后 —— 它不是「一家厂商」，是兜底项
    expect(values.at(-1)).toBe('custom')
  })

  it('一次只显示选中那家的 key 栏，不是九栏全摊开', () => {
    renderAt('凭据', { settings: { ANTHROPIC_API_KEY: 'sk-ant' } })
    // 初值挑一个已经配好的 —— 打开设置停在「我配过的那家」
    expect(screen.getByLabelText('ANTHROPIC_API_KEY')).toBeTruthy()
    // 别家的栏不该在 DOM 里
    expect(screen.queryByLabelText('DEEPSEEK_API_KEY')).toBeNull()
    expect(screen.queryByLabelText('MINIMAX_API_KEY')).toBeNull()
  })

  it('换厂商时表单跟着换那一栏', () => {
    renderAt('凭据', { settings: { ANTHROPIC_API_KEY: 'sk-ant' } })
    fireEvent.change(screen.getByLabelText('厂商'), { target: { value: 'deepseek' } })
    expect(screen.getByLabelText('DEEPSEEK_API_KEY')).toBeTruthy()
    expect(screen.queryByLabelText('ANTHROPIC_API_KEY')).toBeNull()
  })

  // 内置九家的地址是常量、模型清单在 vendors.ts 里，没得填。
  // 自定义端点我们一无所知，全靠用户告诉我们。
  it('只有选自定义端点时才出现端点等额外几栏', () => {
    renderAt('凭据')
    expect(screen.queryByLabelText('CUSTOM_BASE_URL')).toBeNull()
    fireEvent.change(screen.getByLabelText('厂商'), { target: { value: 'custom' } })
    expect(screen.getByLabelText('CUSTOM_BASE_URL')).toBeTruthy()
    expect(screen.getByLabelText('CUSTOM_API_KEY')).toBeTruthy()
    expect(screen.getByLabelText('CUSTOM_MODELS')).toBeTruthy()
    expect(screen.getByLabelText('CUSTOM_SEARCH_TOOL')).toBeTruthy()
  })

  // 选厂商是表单作用域，不该写进设置 —— 那会和 composer 的选择器打架
  it('换厂商不写 ACTIVE_VENDOR（那是 composer 的事）', async () => {
    const saved: DesktopSettings[] = []
    renderAt('凭据', { onSave: async (p) => { saved.push(p) } })
    fireEvent.change(screen.getByLabelText('厂商'), { target: { value: 'openai' } })
    await new Promise((r) => setTimeout(r, 600))
    expect(saved).toEqual([])
  })

  it('厂商的 key 栏用厂商名作标题', () => {
    renderAt('凭据', { settings: { ANTHROPIC_API_KEY: 'k' } })
    expect(screen.getByText('Anthropic')).toBeTruthy()
  })

  it('把已有的厂商 key 填进输入框', () => {
    renderAt('凭据', { settings: { ANTHROPIC_API_KEY: 'sk-ant' } })
    expect((screen.getByLabelText('ANTHROPIC_API_KEY') as HTMLInputElement).value).toBe('sk-ant')
  })

  it('API Key 用密码框，不明文显示在屏幕上', () => {
    renderAt('凭据')
    fireEvent.change(screen.getByLabelText('厂商'), { target: { value: 'deepseek' } })
    expect((screen.getByLabelText('DEEPSEEK_API_KEY') as HTMLInputElement).type).toBe('password')
  })

  // --- 高级参数 ---
  //
  // 默认收起：绝大多数人一辈子不需要动温度，摆在 key 旁边会让「配置模型」
  // 看起来比实际复杂 —— 用户以为这些都得填。
  it('高级参数默认收起', () => {
    renderAt('凭据')
    expect(screen.getByRole('switch', { name: '高级参数' })).toBeTruthy()
    expect(screen.queryByLabelText('TEMPERATURE')).toBeNull()
  })

  it('打开开关才露出温度那些参数', () => {
    renderAt('凭据')
    const sw = screen.getByRole('switch', { name: '高级参数' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    expect(sw.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByLabelText('TEMPERATURE')).toBeTruthy()
  })

  it('温度能保存出去', async () => {
    const saved: DesktopSettings[] = []
    renderAt('凭据', { onSave: async (p) => { saved.push(p) } })
    fireEvent.click(screen.getByRole('switch', { name: '高级参数' }))
    fireEvent.change(screen.getByLabelText('TEMPERATURE'), { target: { value: '0.7' } })
    await new Promise((r) => setTimeout(r, 600))
    expect(saved[0]?.TEMPERATURE).toBe('0.7')
  })

  // 「已配几家」是唯一能表达「至少配一把 key 才能对话」的地方 —— 它不是任何
  // 单个字段的属性，所以不能用必填星号表达（九家每家标红星是错的，填一家就够）
  it('一把 key 都没配时给出橙色提示', () => {
    renderAt('凭据')
    expect(screen.getByText(/还没配任何 key/)).toBeTruthy()
  })

  it('配了就显示已配几家和名字', () => {
    renderAt('凭据', { settings: { DEEPSEEK_API_KEY: 'k', ANTHROPIC_API_KEY: 'k2' } })
    expect(screen.getByText(/已配 2 项/)).toBeTruthy()
  })

  it('保存时把改动交出去（auto-save，防抖后自动保存）', async () => {
    const saved: Record<string, string | undefined>[] = []
    renderAt('凭据', { onSave: async (p) => { saved.push(p) } })
    fireEvent.change(screen.getByLabelText('厂商'), { target: { value: 'deepseek' } })
    fireEvent.change(screen.getByLabelText('DEEPSEEK_API_KEY'), { target: { value: 'sk-new' } })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(saved[0]?.DEEPSEEK_API_KEY).toBe('sk-new')
  })

  // --- 能力页（网络搜索）---

  it('能力页有两把搜索 key', () => {
    renderAt('能力')
    expect(screen.getByLabelText('BRAVE_API_KEY')).toBeTruthy()
    expect(screen.getByLabelText('TAVILY_API_KEY')).toBeTruthy()
  })

  // --- Agent 模式页：不是表单 ---

  // 这一页以前是句占位说明（「外部 CLI 还没接进桌面版」）。现在真接上了，
  // 它列的是**实际可选的引擎**，数据从主进程的 providers 状态来。
  it('Agent 模式页列出可选引擎', () => {
    renderAt('Agent 模式', {
      providers: {
        options: [
          { id: 'builtin', name: '内置 agent', external: false },
          { id: 'claude-code', name: 'Claude Code', external: true },
        ],
        current: 'builtin',
        models: [],
        permission: 'ask',
        configPath: '/tmp/config.json',
      },
    })
    expect(screen.getByText('内置 agent')).toBeTruthy()
    expect(screen.getByText('Claude Code')).toBeTruthy()
  })

  it('标出当前会话用的是哪个', () => {
    renderAt('Agent 模式', {
      providers: {
        options: [
          { id: 'builtin', name: '内置 agent', external: false },
          { id: 'claude-code', name: 'Claude Code', external: true },
        ],
        current: 'claude-code',
        models: [],
        permission: 'ask',
        configPath: '/tmp/config.json',
      },
    })
    expect(screen.getByText('当前会话')).toBeTruthy()
  })

  // 这一页不做成表单：外部 CLI 的配置是从各家 README 粘过来的命令行，
  // 表单会强迫用户把一行命令拆成几个输入框
  it('给出配置文件路径而不是一堆输入框', () => {
    renderAt('Agent 模式', {
      providers: {
        options: [{ id: 'builtin', name: '内置 agent', external: false }],
        current: 'builtin',
        models: [],
        permission: 'ask',
        configPath: '/tmp/providers.json',
      },
    })
    expect(screen.getByText('/tmp/providers.json')).toBeTruthy()
    // 没有「命令」「参数」这类输入框
    expect(screen.queryByLabelText('command')).toBeNull()
  })

  // --- 页标题 ---
  //
  // 顶栏那条固定的「设置」去掉了（「我在设置里」由左栏的导航说，顶栏再重复
  // 一遍占 44px 却没说出用户不知道的事）。换成当前分区名 —— 那是这一屏
  // 真正的标题，切页时它会跟着变。
  it('页标题是当前分区名，不是固定的「设置」', () => {
    const v = renderAt('凭据')
    expect(screen.getByRole('heading', { name: '凭据' })).toBeTruthy()
    v.open('高级')
    expect(screen.getByRole('heading', { name: '高级' })).toBeTruthy()
  })

  // --- 重启提示 ---

  it('改 NOTES_DIR 时提示需要重启', () => {
    renderAt('检索', { settings: { NOTES_DIR: '/old' } })
    fireEvent.change(screen.getByLabelText('NOTES_DIR'), { target: { value: '/new' } })
    expect(screen.getByText('需要重启应用才能生效。')).toBeTruthy()
  })

  it('改 EMBEDDING_MODEL 时提示需要重启', () => {
    renderAt('检索', { settings: { EMBEDDING_MODEL: 'old-model' } })
    fireEvent.change(screen.getByLabelText('EMBEDDING_MODEL'), { target: { value: 'new-model' } })
    expect(screen.getByText('需要重启应用才能生效。')).toBeTruthy()
  })

  it('保存后显示重启按钮', async () => {
    renderAt('检索', { settings: { NOTES_DIR: '/old' } })
    fireEvent.change(screen.getByLabelText('NOTES_DIR'), { target: { value: '/new' } })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(await screen.findByRole('button', { name: /立即重启/ })).toBeTruthy()
  })

  it('保存后切到其它分组，重启提示仍然可见（警告横跨分组，不属于某一个 section）', async () => {
    const v = renderAt('检索', { settings: { NOTES_DIR: '/old' } })
    fireEvent.change(screen.getByLabelText('NOTES_DIR'), { target: { value: '/new' } })
    await new Promise((resolve) => setTimeout(resolve, 600))
    await screen.findByRole('button', { name: /立即重启/ })
    v.open('凭据')
    expect(screen.getByText(/需要重启应用才能生效/)).toBeTruthy()
  })

  it('点击重启按钮触发 onRestart', async () => {
    let restarted = 0
    renderAt('检索', {
      settings: { NOTES_DIR: '/old' },
      onRestart: async () => {
        restarted++
      },
    })
    fireEvent.change(screen.getByLabelText('NOTES_DIR'), { target: { value: '/new' } })
    await new Promise((resolve) => setTimeout(resolve, 600))
    fireEvent.click(await screen.findByRole('button', { name: /立即重启/ }))
    expect(restarted).toBe(1)
  })

  // 关闭的入口不在这个组件里了 —— 它是左栏那条「返回对话」，
  // 见 settings-nav.test.tsx。面板本身没有出口按钮。
  it('面板里没有关闭按钮（出口在左栏的「返回对话」）', () => {
    renderAt('通用')
    expect(screen.queryByRole('button', { name: /关闭/ })).toBeNull()
  })

  it('settings 类名保留作测试锚点', () => {
    const { container } = renderAt('通用')
    expect(container.querySelector('.settings')).toBeTruthy()
  })

  it('field 类名保留在每个输入字段上', () => {
    const { container } = renderAt('通用')
    expect(container.querySelectorAll('.field').length).toBeGreaterThan(0)
  })

  it('settings__warn 类名用于警告提示', () => {
    const { container } = renderAt('检索', { settings: { NOTES_DIR: '/old' } })
    fireEvent.change(screen.getByLabelText('NOTES_DIR'), { target: { value: '/new' } })
    expect(container.querySelector('.settings__warn')).toBeTruthy()
  })

  it('验证失败时显示错误并保持面板打开', async () => {
    const { container } = renderAt('高级', {
      onSave: async () => {
        throw new Error('MAX_TURNS 必须是数字，得到的是 "abc"')
      },
    })
    fireEvent.change(screen.getByLabelText('MAX_TURNS'), { target: { value: 'abc' } })
    await new Promise((resolve) => setTimeout(resolve, 600))
    await screen.findByText(/必须是数字/)
    expect(container.querySelector('.settings__error')).toBeTruthy()
  })

  it('重启被阻止时显示错误', async () => {
    renderAt('检索', {
      settings: { NOTES_DIR: '/old' },
      onRestart: async () => {
        throw new Error('有会话正在处理中，无法重启')
      },
    })
    fireEvent.change(screen.getByLabelText('NOTES_DIR'), { target: { value: '/new' } })
    await new Promise((resolve) => setTimeout(resolve, 600))
    fireEvent.click(await screen.findByRole('button', { name: /立即重启/ }))
    await screen.findByText(/正在处理中/)
  })

  // ## 这一条锁的是脏组合的来源
  //
  // 「导入」原来无条件把探测到的 model 写进 ACTIVE_MODEL，而那个值来自被导入
  // 的 CLI 配置（~/.claude/settings.json 的 model），可以是任何字符串 ——
  // 包括别家的模型名。写进去就得到 {厂商:anthropic, 模型:deepseek-reasoner}，
  // 发请求时服务端回「Invalid Anthropic API Key」，把人往错方向引。
  it('导入时不采用不属于该厂商的模型名', async () => {
    const saved: DesktopSettings[] = []
    // detectProviders / importProvider 走的是 api mock（api.ts 里的 fallback），
    // 这里只验「保存出去的 patch 里没有那个脏模型」这半边 —— 探测那半边
    // 由 provider-detect.test.ts 覆盖
    renderAt('凭据', { onSave: async (p) => { saved.push(p) } })
    // 没有可导入的 provider 时这一页不该写任何 ACTIVE_MODEL 出去
    await new Promise((r) => setTimeout(r, 50))
    for (const p of saved) {
      if (p.ACTIVE_VENDOR === 'anthropic' && p.ACTIVE_MODEL) {
        expect(p.ACTIVE_MODEL).toMatch(/^claude-/)
      }
    }
  })

  // 分区和 gpui 的 SettingsSection 一一对应
  it('六个分区，和 gpui 的分区一致', () => {
    // 「模型」那个分区名去掉了：选模型在 composer，设置页只填凭据
    expect(SECTIONS.map((s) => s.label)).toEqual([
      '通用',
      '能力',
      '凭据',
      'Agent 模式',
      '检索',
      '高级',
    ])
  })

  it('切换分组只显示该组的字段，其它分组的字段不在 DOM 里（master-detail，不是手风琴）', () => {
    const v = renderAt('通用')
    expect(screen.getByLabelText('STREAM')).toBeTruthy()
    expect(screen.queryByLabelText('NOTES_DIR')).toBeNull()
    v.open('检索')
    expect(screen.getByLabelText('NOTES_DIR')).toBeTruthy()
    expect(screen.queryByLabelText('STREAM')).toBeNull()
  })

  // 分组重构不能让某个字段变得够不到。GROUPS 是静态分区的真相来源；
  // 凭据页的字段是按厂商动态生成的，单独由上面那几条覆盖。
  it('GROUPS 里的每个键都能在对应分区下找到', () => {
    for (const section of SECTIONS) {
      const groups = GROUPS[section.id]
      if (!groups) continue
      // 凭据页的字段是按选中厂商动态生成的，不走 GROUPS ——
      // 它由上面那几条单独覆盖
      if (section.id === 'provider') continue
      cleanup()
      renderAt(section.label)
      for (const [, keys] of groups) {
        for (const key of keys) {
          expect(screen.queryByLabelText(key), `${section.label} 下应该有 ${key}`).toBeTruthy()
        }
      }
    }
  })
})
