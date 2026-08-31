// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ChatWindow } from '../../electron/renderer/src/components/ChatWindow'
import { AttachmentStrip } from '../../electron/renderer/src/components/AttachmentPicker'
import type { ContentPart } from '../../src/types'

afterEach(cleanup)

const chat = { messages: [], running: false }

function setup(props: Partial<Parameters<typeof ChatWindow>[0]> = {}) {
  const sent: string[] = []
  const view = render(
    <ChatWindow
      chat={chat}
      sessionId="s1"
      onSend={(t) => sent.push(t)}
      onDecide={() => {}}
      {...props}
    />,
  )
  return { sent, view }
}

/** jsdom 的 FileReader 认 File，所以这里给真的 File，不 mock reader。 */
function makeFile(name: string, type: string, bytes = 8): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

function pick(files: File[]) {
  // input[type=file] 没有 role，用 hidden 的那个 —— composer 里只有这一个
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  // files 是只读属性，得用 defineProperty 塞进去
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  fireEvent.change(input)
  return input
}

describe('附件入口', () => {
  it('composer 里有添加附件的按钮', () => {
    setup()
    expect(screen.getByRole('button', { name: '添加附件' })).toBeTruthy()
  })

  it('接受的类型里既有图片也有文件', () => {
    setup()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.accept).toContain('image/png')
    expect(input.accept).toContain('application/pdf')
  })

  it('可以多选', () => {
    setup()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.multiple).toBe(true)
  })

  // 跑起来时不能加附件 —— 那一轮的请求已经发出去了，加进来的东西
  // 只会静默留在下一条消息上，用户以为它进了当前这轮
  it('会话正在跑时按钮禁用', () => {
    setup({ chat: { messages: [], running: true } })
    expect((screen.getByRole('button', { name: '添加附件' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})

describe('附件预览', () => {
  it('选了图片之后出现缩略图，src 是 data URI', async () => {
    setup()
    pick([makeFile('shot.png', 'image/png')])
    const img = (await waitFor(() => screen.getByAltText('shot.png'))) as HTMLImageElement
    expect(img.src.startsWith('data:')).toBe(true)
  })

  it('选了 PDF 之后显示文件名，不是缩略图', async () => {
    setup()
    pick([makeFile('report.pdf', 'application/pdf')])
    await waitFor(() => expect(screen.getByText('report.pdf')).toBeTruthy())
    expect(screen.queryByAltText('report.pdf')).toBeNull()
  })

  // ## 这一条锁的是删除键的可发现性
  //
  // 删除键常显、不做 hover 才出现：composer 里这些卡片本来就小，
  // 藏起来的话用户得先划过去才知道能删。测试断言它**一开始就在**，
  // 别改成 hover 才渲染。
  it('每张卡片都带一个常显的删除键', async () => {
    setup()
    pick([makeFile('a.png', 'image/png')])
    await waitFor(() => expect(screen.getByRole('button', { name: '移除 a.png' })).toBeTruthy())
  })

  it('点删除键把那一张摘掉，其余留下', async () => {
    setup()
    pick([makeFile('a.png', 'image/png'), makeFile('b.pdf', 'application/pdf')])
    await waitFor(() => expect(screen.getByAltText('a.png')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('b.pdf')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: '移除 a.png' }))
    expect(screen.queryByAltText('a.png')).toBeNull()
    expect(screen.getByText('b.pdf')).toBeTruthy()
  })

  it('没有附件时整条预览区不渲染', () => {
    const { container } = render(<AttachmentStrip attachments={[]} onRemove={() => {}} />)
    expect(container.querySelector('.attachment-strip')).toBeNull()
  })

  // 预览必须在 textarea **前面**：放到下面那行 h-7 的选择器里会把
  // 整行撑到两倍高，模型名和权限那几个 chip 跟着往下掉
  it('预览条排在输入框之前', async () => {
    const { view } = setup()
    pick([makeFile('a.png', 'image/png')])
    await waitFor(() => expect(screen.getByAltText('a.png')).toBeTruthy())
    const strip = view.container.querySelector('.attachment-strip')!
    const box = screen.getByRole('textbox')
    // compareDocumentPosition 的 FOLLOWING 位（4）= strip 在 box 之前
    expect(strip.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('附件被拒时', () => {
  // 不弹 alert：那是模态框，多选时每个坏文件弹一次，得连点好几下
  // 才回得到输入框。错误显示成 composer 里的一行字。
  it('类型不认时给出提示，不加进预览', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    setup()
    pick([makeFile('virus.exe', 'application/x-msdownload')])
    await waitFor(() => expect(screen.getByText(/不支持的类型/)).toBeTruthy())
    expect(screen.getByText(/virus\.exe/)).toBeTruthy()
    expect(alertSpy).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })

  it('超过 20MB 时拒掉', async () => {
    setup()
    const big = makeFile('huge.png', 'image/png', 1)
    // 真造 20MB 太慢，直接改 size —— 组件只读这个属性
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 })
    pick([big])
    await waitFor(() => expect(screen.getByText(/超过 20MB/)).toBeTruthy())
    expect(screen.queryByAltText('huge.png')).toBeNull()
  })

  it('成功加一个之后，上一次的报错消失', async () => {
    setup()
    pick([makeFile('x.exe', 'application/x-msdownload')])
    await waitFor(() => expect(screen.getByText(/不支持的类型/)).toBeTruthy())
    pick([makeFile('ok.png', 'image/png')])
    await waitFor(() => expect(screen.queryByText(/不支持的类型/)).toBeNull())
  })

  // 一次多选里既有能收的也有不能收的：能收的要收下，别因为一个坏的整批丢掉
  it('一批里好的收下、坏的报错', async () => {
    setup()
    pick([makeFile('good.png', 'image/png'), makeFile('bad.exe', 'application/x-msdownload')])
    await waitFor(() => expect(screen.getByAltText('good.png')).toBeTruthy())
    expect(screen.getByText(/不支持的类型/)).toBeTruthy()
  })
})

describe('附件的生命周期', () => {
  it('发送后清空', async () => {
    setup()
    pick([makeFile('a.png', 'image/png')])
    await waitFor(() => expect(screen.getByAltText('a.png')).toBeTruthy())
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '看这个' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(screen.queryByAltText('a.png')).toBeNull()
  })

  // ## 这一条锁的是「附件跟着串会话」
  //
  // 附件和 showAll 同理，属于「当前打开的那个会话」。不清的话在 A 会话
  // 挂的图会跟到 B 会话发出去 —— 而用户在 B 里根本没见过它。
  it('切换会话时清空', async () => {
    const { view } = setup()
    pick([makeFile('a.png', 'image/png')])
    await waitFor(() => expect(screen.getByAltText('a.png')).toBeTruthy())
    view.rerender(
      <ChatWindow chat={chat} sessionId="s2" onSend={() => {}} onDecide={() => {}} />,
    )
    expect(screen.queryByAltText('a.png')).toBeNull()
  })

  it('同一个文件能连选两次（value 被清空）', async () => {
    setup()
    const input = pick([makeFile('a.png', 'image/png')])
    await waitFor(() => expect(screen.getByAltText('a.png')).toBeTruthy())
    expect(input.value).toBe('')
  })
})

describe('多模态消息的形状', () => {
  // 这一组不过 UI，直接验类型层：图片和文件在 ContentPart 上是两种变体，
  // 因为它们在 src/llm.ts 的 toSdkMessages 里翻译成不同形状
  // （image_url vs file）。合成一种的话那边没法分派。
  it('image 变体带 data 和 detail', () => {
    const part: ContentPart = {
      type: 'image',
      data: 'data:image/png;base64,AAA',
      filename: 'a.png',
      detail: 'auto',
    }
    expect(part.type).toBe('image')
  })

  it('file 变体带 mimeType 和 filename', () => {
    const part: ContentPart = {
      type: 'file',
      data: 'data:application/pdf;base64,AAA',
      mimeType: 'application/pdf',
      filename: 'a.pdf',
    }
    expect(part.mimeType).toBe('application/pdf')
  })
})
