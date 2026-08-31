// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ToolCallIndicator } from '../../electron/renderer/src/components/ToolCallIndicator'
import type { ToolCallEvent } from '../../electron/shared/channels'

const baseEvent: ToolCallEvent = {
  sessionId: 's1',
  turn: 1,
  toolName: 'get_weather',
  args: { city: 'Beijing' },
  output: '{"temp": 20}',
  elapsedMs: 100,
}

describe('工具输出截断', () => {
  // ## 这一组锁的是「长输出卡顿」的修复
  //
  // directory_tree 能返回 42k 字符 / 1800+ 行。<pre> 一次性渲染这么大的
  // 文本节点在 M3 Max 上都有感知延迟，中低配 Windows 会卡得明显。
  //
  // 参考 Continue.dev / ChatGPT：超过阈值时只显示前 N 行，末尾加下载按钮。

  it('短输出不截断，不显示下载按钮', () => {
    render(<ToolCallIndicator event={baseEvent} />)
    fireEvent.click(screen.getByRole('button', { name: /get_weather/ }))
    expect(screen.queryByText(/输出过长/)).toBeNull()
    expect(screen.queryByRole('button', { name: /下载/ })).toBeNull()
  })

  // ## 这一组锁的是「上一版按行截断的缺陷」
  //
  // 上一版用 `lines.slice(0, 200)`，对单行输入完全无效。而 `runTool` 用的
  // 是 `JSON.stringify(output)` 没缩进参数 —— 绝大多数工具输出是**一整行**。
  // 194 万字符原封不动进 DOM，卡顿 + 撞 16MB 光栅化上限（日志里 122 次
  // "Failed to serialize op"）。
  //
  // 现在字符是硬上限，行数只作辅助（防止缩进 JSON 撑出几千行高度）。

  it('超过 4k 字符时截断', () => {
    const long = 'x'.repeat(4001)
    render(<ToolCallIndicator event={{ ...baseEvent, output: long }} />)
    fireEvent.click(screen.getByRole('button', { name: /get_weather/ }))
    expect(screen.getByText(/输出过长/)).toBeTruthy()
    expect(screen.getByText(/4,001 字符/)).toBeTruthy()
  })

  it('单行百万字符被截断到 4k（上一版的死穴）', () => {
    const oneLine = 'x'.repeat(1_000_000)
    const { container } = render(<ToolCallIndicator event={{ ...baseEvent, output: oneLine }} />)
    fireEvent.click(screen.getByRole('button', { name: /get_weather/ }))
    const pres = container.querySelectorAll('pre')
    const shown = pres[pres.length - 1].textContent ?? ''
    // 关键断言：DOM 里**真实渲染**的字符数是 4000，不是 100 万
    expect(shown.length).toBe(4000)
    expect(screen.getByText(/1,000,000 字符/)).toBeTruthy()
  })

  it('缩进过的 JSON 也截断（防止撑出几千行）', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`).join('\n')
    // 200 行，每行 7 字符，总共 1400 字符 —— 按字符不会截断
    expect(lines.length).toBeLessThan(4000)
    const { container } = render(<ToolCallIndicator event={{ ...baseEvent, output: lines }} />)
    fireEvent.click(screen.getByRole('button', { name: /get_weather/ }))
    const pres = container.querySelectorAll('pre')
    const shown = pres[pres.length - 1].textContent ?? ''
    // 但行数超 120，会被切掉
    const shownLines = shown.split('\n').length
    expect(shownLines).toBe(120)
    expect(screen.getByText(/输出过长/)).toBeTruthy()
  })

  it('字符和行数都显示，带千分位', () => {
    const long = 'x'.repeat(123456)
    render(<ToolCallIndicator event={{ ...baseEvent, output: long }} />)
    fireEvent.click(screen.getByRole('button', { name: /get_weather/ }))
    expect(screen.getByText(/123,456 字符/)).toBeTruthy()
  })

  it('单行输出不显示「/ N 行」（那个 1 没意义）', () => {
    const long = 'x'.repeat(5000)
    render(<ToolCallIndicator event={{ ...baseEvent, output: long }} />)
    fireEvent.click(screen.getByRole('button', { name: /get_weather/ }))
    const notice = screen.getByText(/输出过长/).textContent ?? ''
    expect(notice).not.toMatch(/\/.*行/)
  })

  describe('下载功能', () => {
    let createObjectURL: ReturnType<typeof vi.fn>
    let revokeObjectURL: ReturnType<typeof vi.fn>
    let clickSpy: any
    /** 被点击的那个 <a>。下载靠它，所以断言 download 属性要从这里取 */
    let anchor: HTMLAnchorElement | null

    beforeEach(() => {
      createObjectURL = vi.fn(() => 'blob:fake-url')
      revokeObjectURL = vi.fn()
      clickSpy = vi.fn()
      anchor = null

      global.URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL
      global.URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL

      // **不能** stub document.body.appendChild —— React 挂载也走它，
      // 换成 mock 之后组件根本渲染不出来（"Target container is not a
      // DOM element"）。只拦 createElement('a')，把 click 换掉，
      // 真实的 append/remove 照常发生。
      const origCreate = document.createElement.bind(document)
      vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        const el = origCreate(tag)
        if (tag === 'a') {
          anchor = el as HTMLAnchorElement
          el.click = clickSpy
        }
        return el
      }) as typeof document.createElement)
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('点下载按钮生成 blob URL 并触发下载', () => {
      const long = 'x'.repeat(10001)
      render(<ToolCallIndicator event={{ ...baseEvent, output: long }} />)
      fireEvent.click(screen.getByRole('button', { name: /get_weather/ }))
      fireEvent.click(screen.getByRole('button', { name: /下载/ }))

      expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
      const blob = createObjectURL.mock.calls[0][0] as Blob
      expect(blob.type).toBe('text/plain;charset=utf-8')
      expect(blob.size).toBe(10001)

      expect(clickSpy).toHaveBeenCalledOnce()
      // 用完要撤销，否则 blob 一直占着内存
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url')
      // 点完之后要从 DOM 里摘掉，不留一个隐形的 <a>
      expect(anchor?.isConnected).toBe(false)
    })

    it('下载的文件名带工具名', () => {
      const long = 'x'.repeat(10001)
      render(<ToolCallIndicator event={{ ...baseEvent, toolName: 'directory_tree', output: long }} />)
      fireEvent.click(screen.getByRole('button', { name: /directory_tree/ }))
      fireEvent.click(screen.getByRole('button', { name: /下载/ }))

      expect(anchor?.download).toBe('directory_tree-output.txt')
    })

    it('下载的内容是完整输出，不是截断后的', async () => {
      const lines = Array.from({ length: 400 }, (_, i) => `line-${i}`).join('\n')
      render(<ToolCallIndicator event={{ ...baseEvent, output: lines }} />)
      fireEvent.click(screen.getByRole('button', { name: /get_weather/ }))
      fireEvent.click(screen.getByRole('button', { name: /下载/ }))

      const blob = createObjectURL.mock.calls[0][0] as Blob
      // 验证最后一行在里面 —— 截断后的 <pre> 里看不到它。
      // 必须 await：不 await 的话断言在测试结束后才跑，失败也不报
      const text = await blob.text()
      expect(text).toContain('line-399')
      expect(text).toContain('line-0')
    })
  })
})
