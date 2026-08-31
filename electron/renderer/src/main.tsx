import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// 全局兜底：拦掉**投放区之外**的文件放置。
//
// 对话区自己有 dropProps 接管（见 ChatWindow），但窗口里还有别的地方 ——
// 侧边栏、设置页、两栏之间的空隙。在那些地方松手会走 Chromium 的默认行为：
// 把窗口导航到 file:// 那个文件。表现是整个 app 变成一个 PDF 阅读器或者
// 一张裸图，**没有返回入口**（没有地址栏也没有后退键），只能杀掉重启。
//
// 挂在 document 上而不是各个组件里：这是「浏览器默认行为」级别的问题，
// 漏一个角落就会踩到，而新加的面板不会有人想起来补这一条。
// 用 capture 阶段：组件自己的 handler 在冒泡阶段跑，那边该收的照常收得到。
for (const type of ['dragover', 'drop'] as const) {
  document.addEventListener(
    type,
    (e) => {
      // 只拦文件。拖文本（编辑框之间拖一段选中的字）是正常的编辑操作，
      // 拦掉会让输入框没法接收拖进来的文字。
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault()
    },
    { capture: true },
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
