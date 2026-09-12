// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ModelPicker } from '../../electron/renderer/src/components/ModelPicker'
import type { VendorEntry } from '../../electron/main/vendors'

// jsdom 没实现 popover。组件内部已经 try/catch 了（见 ModelPicker 的 effect），
// 但补上桩才能让「开着」这个状态在测试里成立。
beforeAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>
  const open = new WeakSet<HTMLElement>()
  proto.showPopover = function (this: HTMLElement) {
    open.add(this)
  }
  proto.hidePopover = function (this: HTMLElement) {
    open.delete(this)
  }
  const realMatches = HTMLElement.prototype.matches
  proto.matches = function (this: HTMLElement, sel: string) {
    if (sel === ':popover-open') return open.has(this)
    return realMatches.call(this, sel)
  }
})

afterEach(cleanup)

const catalog: VendorEntry[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: [
      { id: 'claude-opus-5', name: 'Claude Opus 5' },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
    ],
    nativeSearch: { kind: 'none' },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    nativeSearch: { kind: 'none' },
  },
]

const props = {
  catalog,
  currentVendor: 'anthropic',
  currentModel: 'claude-opus-5',
  onPick: () => {},
}

const panel = () => screen.getByRole('listbox', { hidden: true }) as HTMLElement

describe('ModelPicker', () => {
  // ## 下面三条锁的是「浮层跑到窗口顶端」那个 bug
  //
  // 根因是 UA 样式：`[popover] { inset: 0; margin: auto; height: fit-content }`。
  // place() 只设了 bottom，于是 top:0 还留着 —— top / bottom / height 三个都
  // 非 auto 就是过约束，CSS 的解法是**丢掉 bottom 保留 top**，浮层被钉在视口
  // 顶端。修法是显式把 top（和 right）让成 auto。
  //
  // 右键菜单没中招是碰巧：它设的正好是胜出的那个 top。

  it('把 UA 默认的 inset 让开：top / right 都是 auto', () => {
    render(<ModelPicker {...props} />)
    const el = panel()
    expect(el.style.top).toBe('auto')
    expect(el.style.right).toBe('auto')
  })

  it('auto margin 也要清掉，否则浮层被推离指定坐标', () => {
    render(<ModelPicker {...props} />)
    expect(panel().style.margin).toBe('0px')
  })

  // bottom 是真正定位的那一边（浮层往上开：composer 在窗口底部，
  // 往下开会掉出窗口）。它必须真的落在 style 上 —— 空字符串说明
  // place() 没生效，浮层会退回 UA 的居中。
  it('用 bottom 定位（往上开），不是 top', () => {
    render(<ModelPicker {...props} />)
    expect(panel().style.bottom).not.toBe('')
  })

  // --- 列表内容 ---

  it('按厂商分组，组头是厂商名', () => {
    render(<ModelPicker {...props} />)
    expect(screen.getByText('Anthropic')).toBeTruthy()
    expect(screen.getByText('DeepSeek')).toBeTruthy()
  })

  // ## 下面四条锁的是「一级和二级分不开」那个问题
  //
  // 字号和颜色在这里靠不住：ink-2(#a5a8ad) 和 ink-3(#9a9da3) 差不到一档，
  // 11px 和 12px 在这个尺寸下也看不出来 —— 上一版两级就长得一模一样。
  // 所以改用三个跟字色无关的信号，这几条各锁一个。

  it('组与组之间有一条出血分隔线（结构分隔，最强的那个信号）', () => {
    const { container } = render(<ModelPicker {...props} />)
    // 两个厂商 → 一条线（第一组之上不画）
    const lines = container.querySelectorAll('.bg-line')
    expect(lines).toHaveLength(1)
    // -mx-1 让它铺满浮层宽度，缩在里面的短线看着像断掉的下划线
    expect(lines[0].className).toMatch(/-mx-1/)
  })

  it('模型行比组头缩进 —— 层级用位置表达', () => {
    render(<ModelPicker {...props} />)
    const header = screen.getByText('Anthropic')
    const row = screen.getByRole('option', { name: /Claude Opus 5/, hidden: true })
    // 组头 px-3（含 -mx-1 的出血），模型行 pl-3.5：差 6px
    expect(header.className).toMatch(/\bpx-3\b/)
    expect(row.className).toMatch(/\bpl-3\.5\b/)
    // 缩的是 padding 不是 margin —— 选中态的底色要铺满浮层宽度
    expect(row.className).not.toMatch(/\bml-/)
  })

  it('组头吸顶 —— 三十多个模型装在 320px 的滚动区里，滚到中间要知道在哪家', () => {
    render(<ModelPicker {...props} />)
    const header = screen.getByText('Anthropic')
    expect(header.className).toMatch(/\bsticky\b/)
    expect(header.className).toMatch(/\btop-0\b/)
    // 吸顶必须自带底色，否则滚上来的行会从它背后透出来
    expect(header.className).toMatch(/bg-overlay/)
  })

  it('组头比模型行更小、带字距 —— 不靠 ink-2/ink-3 那点色差', () => {
    render(<ModelPicker {...props} />)
    const header = screen.getByText('Anthropic')
    expect(header.className).toMatch(/text-\[10\.5px\]/)
    expect(header.className).toMatch(/tracking-/)
    expect(header.className).toMatch(/font-semibold/)
  })

  it('触发按钮只显示模型名，不带厂商前缀（composer 那行放不下）', () => {
    render(<ModelPicker {...props} />)
    expect(screen.getByRole('button', { name: '模型' }).textContent).toBe('Claude Opus 5')
  })

  it('当前项标 aria-selected，其它项不标', () => {
    render(<ModelPicker {...props} />)
    const opts = screen.getAllByRole('option', { hidden: true })
    const selected = opts.filter((o) => o.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0].textContent).toMatch(/Claude Opus 5/)
  })

  // 一次点击同时给出厂商和模型 —— 它们绑在一起（换厂商必然换端点）
  it('选一项时同时交出厂商和模型', () => {
    const picked: [string, string][] = []
    render(<ModelPicker {...props} onPick={(v, m) => picked.push([v, m])} />)
    fireEvent.click(screen.getByRole('option', { name: /DeepSeek Chat/, hidden: true }))
    expect(picked).toEqual([['deepseek', 'deepseek-chat']])
  })

  it('认不出当前模型时显示 id 本身，不是空标签', () => {
    render(<ModelPicker {...props} currentModel="被删掉的模型" />)
    expect(screen.getByRole('button', { name: '模型' }).textContent).toBe('被删掉的模型')
  })

  it('一家都没配时给出去设置里填 key 的提示', () => {
    render(<ModelPicker {...props} catalog={[]} />)
    expect(screen.getByText(/去设置里填一把 API Key/)).toBeTruthy()
  })

  // 浮层规格和右键菜单同一套 —— 应用里所有浮层是一个语言。
  // 那条 1px 边由 shadow-overlay 的第一层给，不再额外写 border
  // （两者并存就是双层描边）。ContextMenu 那边有同样一条断言。
  it('浮层用和右键菜单同一套外观（overlay 底 + card 圆角 + 单层 ring）', () => {
    render(<ModelPicker {...props} />)
    const cls = panel().className
    expect(cls).toMatch(/bg-overlay\b/)
    expect(cls).toMatch(/rounded-card/)
    expect(cls).toMatch(/shadow-overlay\b/)
    expect(cls).not.toMatch(/\bborder(-|\b)/)
  })
})
