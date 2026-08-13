import { afterEach, beforeAll } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom 不实现 scrollIntoView，但组件用 useEffect 调它，不 polyfill 会炸。
// polyfill 成空函数即可 —— 测试重点是用户交互和状态更新，不是滚动的副作用。
// 仅在 jsdom 环境下（typeof window !== 'undefined'）做 polyfill，避免 node 环境报 Element 未定义。
beforeAll(() => {
  if (typeof window !== 'undefined' && typeof Element !== 'undefined') {
    Element.prototype.scrollIntoView = () => {}
  }

  // Mock window.electronAPI for tests
  if (typeof window !== 'undefined') {
    ;(window as any).electronAPI = {
      detectProviders: async () => [],
      importProvider: async () => null,
      // 其它方法按需添加（settings-panel.test.tsx 现在只用到上面两个）
    }
  }
})

// 每个测试后清理 React 挂载树，避免测试间泄漏（render 会往 document.body 挂 DOM）。
afterEach(cleanup)
