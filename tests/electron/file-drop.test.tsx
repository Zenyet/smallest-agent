// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ChatWindow } from '../../electron/renderer/src/components/ChatWindow'

afterEach(cleanup)

const chat = { messages: [], running: false }

function setup(props: Partial<Parameters<typeof ChatWindow>[0]> = {}) {
  const view = render(
    <ChatWindow
      chat={chat}
      sessionId="s1"
      onSend={() => {}}
      onDecide={() => {}}
      {...props}
    />,
  )
  return { view, section: view.container.querySelector('.chat')! }
}

function makeFile(name: string, type: string, bytes = 8): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

/**
 * jsdom 不实现 DataTransfer，fireEvent 也不会自己造一个 ——
 * 手写一个只带我们读的两个字段（types / files / dropEffect）的替身。
 */
function dt(files: File[] = [], types?: string[]) {
  return {
    files,
    types: types ?? (files.length > 0 ? ['Files'] : []),
    dropEffect: 'none',
  }
}

describe('拖拽投放', () => {
  it('拖文件进来时显示提示', () => {
    const { section } = setup()
    expect(document.querySelector('.chat__dropzone')).toBeNull()
    fireEvent.dragEnter(section, { dataTransfer: dt([makeFile('a.png', 'image/png')]) })
    expect(document.querySelector('.chat__dropzone')).toBeTruthy()
    expect(screen.getByText('松手添加附件')).toBeTruthy()
  })

  it('松手后提示消失，文件进预览', async () => {
    const { section } = setup()
    const files = [makeFile('a.png', 'image/png')]
    fireEvent.dragEnter(section, { dataTransfer: dt(files) })
    fireEvent.drop(section, { dataTransfer: dt(files) })
    expect(document.querySelector('.chat__dropzone')).toBeNull()
    await waitFor(() => expect(screen.getByAltText('a.png')).toBeTruthy())
  })

  it('拖出去（没松手）提示消失', () => {
    const { section } = setup()
    const transfer = dt([makeFile('a.png', 'image/png')])
    fireEvent.dragEnter(section, { dataTransfer: transfer })
    fireEvent.dragLeave(section, { dataTransfer: transfer })
    expect(document.querySelector('.chat__dropzone')).toBeNull()
  })

  // ## 坑 1：dragleave 会在划过子元素时触发
  //
  // 拖着文件从 composer 划到里面的 textarea，浏览器先给 textarea 发
  // dragenter、再给 composer 发 dragleave。只看这两个事件的话高亮会在
  // 拖动过程中疯狂闪。实现用计数器记深度，归零才算真离开。
  it('划过子元素时提示不闪 —— 进两层只出一层还在', () => {
    const { section } = setup()
    const transfer = dt([makeFile('a.png', 'image/png')])
    fireEvent.dragEnter(section, { dataTransfer: transfer })
    // 进到子元素：又一次 dragenter（冒泡上来），然后父元素收到 dragleave
    fireEvent.dragEnter(section, { dataTransfer: transfer })
    fireEvent.dragLeave(section, { dataTransfer: transfer })
    // 深度还有 1，提示必须还在
    expect(document.querySelector('.chat__dropzone')).toBeTruthy()
    // 再出一层才归零
    fireEvent.dragLeave(section, { dataTransfer: transfer })
    expect(document.querySelector('.chat__dropzone')).toBeNull()
  })

  // ## 坑 2：不 preventDefault 浏览器会导航到那个文件
  //
  // Electron 里表现为整个 app 白屏（变成 PDF 阅读器或裸图），
  // 没有地址栏也没有后退键，只能杀掉重启。
  it('dragover 和 drop 都拦掉默认行为', () => {
    const { section } = setup()
    const files = [makeFile('a.png', 'image/png')]

    const over = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(over, 'dataTransfer', { value: dt(files) })
    section.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)

    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: dt(files) })
    section.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
  })

  // ## 坑 3：拖文本进来也是 drag 事件
  //
  // 从别处拖一段选中的文字过来同样触发 dragenter，但 dataTransfer 里
  // 没有文件。不分辨的话会亮起「松手添加附件」，松手之后什么也没发生。
  it('拖的是文字（不是文件）时不亮提示', () => {
    const { section } = setup()
    fireEvent.dragEnter(section, { dataTransfer: dt([], ['text/plain']) })
    expect(document.querySelector('.chat__dropzone')).toBeNull()
  })

  it('提示层不吃鼠标事件 —— 否则它一出现就等于「离开了投放区」', () => {
    const { section } = setup()
    fireEvent.dragEnter(section, { dataTransfer: dt([makeFile('a.png', 'image/png')]) })
    const zone = document.querySelector('.chat__dropzone')!
    expect(zone.className).toContain('pointer-events-none')
  })

  // 跑起来时不收：那一轮的请求已经发出去了，这时候收下的东西只会静默
  // 留在下一条消息上，而用户以为它进了当前这轮
  it('会话正在跑时不接收拖放', async () => {
    const { section } = setup({ chat: { messages: [], running: true } })
    const files = [makeFile('a.png', 'image/png')]
    fireEvent.dragEnter(section, { dataTransfer: dt(files) })
    expect(document.querySelector('.chat__dropzone')).toBeNull()
    fireEvent.drop(section, { dataTransfer: dt(files) })
    await Promise.resolve()
    expect(screen.queryByAltText('a.png')).toBeNull()
  })

  it('拖进来的文件走同一份校验 —— 坏类型同样被拒', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const { section } = setup()
    const files = [makeFile('x.exe', 'application/x-msdownload')]
    fireEvent.drop(section, { dataTransfer: dt(files) })
    await waitFor(() => expect(screen.getByText(/不支持的类型/)).toBeTruthy())
    expect(alertSpy).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })

  it('一次拖多个：图片和文件都收下', async () => {
    const { section } = setup()
    const files = [makeFile('a.png', 'image/png'), makeFile('b.pdf', 'application/pdf')]
    fireEvent.drop(section, { dataTransfer: dt(files) })
    // 两个都得 waitFor：acceptFiles 逐个 await 读文件（为了让预览的排列
    // 和用户选的顺序一致），所以第二个比第一个晚落。只等第一个、然后
    // 同步断言第二个的话，在负载高的时候第二个还没到 —— 那是**测试**
    // 的时序错，不是产品的
    await waitFor(() => expect(screen.getByAltText('a.png')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('b.pdf')).toBeTruthy())
  })

  // textarea 对文件有自己的默认行为：Chromium 把路径当文字插进去。
  // 不拦的话拖一张图到输入框，得到的是一行 /Users/…/shot.png
  it('输入框上的 drop 被拦掉，不会把路径插成文字', () => {
    setup()
    const box = screen.getByRole('textbox')
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: dt([makeFile('a.png', 'image/png')]),
    })
    box.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    expect((box as HTMLTextAreaElement).value).toBe('')
  })
})

describe('投放区之外的全局兜底', () => {
  // ## 为什么需要它
  //
  // 对话区自己有 dropProps 接管，但窗口里还有别的地方 —— 侧边栏、设置页、
  // 两栏之间的空隙。在那些地方松手会走 Chromium 默认行为：把窗口导航到
  // file:// 那个文件。表现是整个 app 变成 PDF 阅读器或一张裸图，
  // **没有返回入口**（没地址栏没后退键），只能杀掉重启。
  //
  // 这里重放 main.tsx 里那段注册，验它的判断逻辑。不 import main.tsx ——
  // 那个模块副作用是 createRoot，import 就把整个 app 挂起来了。
  const install = () => {
    const handler = (e: Event) => {
      const types = (e as DragEvent).dataTransfer?.types
      if (Array.from(types ?? []).includes('Files')) e.preventDefault()
    }
    for (const t of ['dragover', 'drop']) {
      document.addEventListener(t, handler, { capture: true })
    }
    return () => {
      for (const t of ['dragover', 'drop']) {
        document.removeEventListener(t, handler, { capture: true })
      }
    }
  }

  it('窗口空白处放文件被拦下', () => {
    const off = install()
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: dt([makeFile('a.pdf', 'application/pdf')]),
    })
    document.body.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    off()
  })

  // 拖文本是正常的编辑操作（输入框之间拖一段选中的字），
  // 一起拦掉会让输入框没法接收拖进来的文字
  it('拖文本不拦 —— 那是正常的编辑操作', () => {
    const off = install()
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: dt([], ['text/plain']) })
    document.body.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(false)
    off()
  })
})
