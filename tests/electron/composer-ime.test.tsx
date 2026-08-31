// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ChatWindow } from '../../electron/renderer/src/components/ChatWindow'

afterEach(cleanup)

const chat = { messages: [], running: false }

function setup() {
  const sent: string[] = []
  render(
    <ChatWindow
      chat={chat}
      sessionId="s1"
      onSend={(t) => sent.push(t)}
      onDecide={() => {}}
    />,
  )
  return { sent, box: screen.getByRole('textbox') }
}

describe('composer 的回车', () => {
  // ## 这一组锁的是「中文输入法打字时按回车就把半成品发出去」那个 bug
  //
  // 输入法在拼字期间，回车的语义是**确认候选词**，不是发送。原来的
  // handler 只看 key === 'Enter' && !shiftKey，于是用户打「你好」按回车
  // 选字，选字的那个回车同时被当成发送 —— 用户完全没有发送的意图。
  //
  // 修法是读 nativeEvent.isComposing。不自己接 compositionstart/end：
  // 那两个事件和 keydown 的先后顺序各平台不一致（Safari 的 compositionend
  // 在 keydown 之后），自己维护 boolean 会在边界上错判。

  it('拼字中的回车不发送 —— 那是在选词', () => {
    const { sent, box } = setup()
    fireEvent.change(box, { target: { value: '你好' } })
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    expect(sent).toEqual([])
  })

  it('选完词之后的回车正常发送', () => {
    const { sent, box } = setup()
    fireEvent.change(box, { target: { value: '你好' } })
    // 先是选词那次（不发），再是真的要发那次
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(sent).toEqual(['你好'])
  })

  it('英文直接打字按回车照常发送（没有 composing 这一段）', () => {
    const { sent, box } = setup()
    fireEvent.change(box, { target: { value: 'hello' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(sent).toEqual(['hello'])
  })

  it('Shift+Enter 是换行，不发送', () => {
    const { sent, box } = setup()
    fireEvent.change(box, { target: { value: 'a' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(sent).toEqual([])
  })

  it('拼字中的 Shift+Enter 也不发送', () => {
    const { sent, box } = setup()
    fireEvent.change(box, { target: { value: 'a' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true, isComposing: true })
    expect(sent).toEqual([])
  })

  it('空输入按回车不发送', () => {
    const { sent, box } = setup()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(sent).toEqual([])
  })

  it('只有空白的输入不发送', () => {
    const { sent, box } = setup()
    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(sent).toEqual([])
  })

  it('发送后清空输入框', () => {
    const { box } = setup()
    fireEvent.change(box, { target: { value: 'hi' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect((box as HTMLTextAreaElement).value).toBe('')
  })
})
