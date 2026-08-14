// 设置窗口的 React 根。跟主窗口的 main.tsx 平级、各自独立挂载 ——
// 两个 BrowserWindow 就是两个 renderer 进程，不共享任何 React 状态，
// 设置改动靠主进程广播（CH.settingsChanged）而不是共享内存互通。
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsWindow } from './SettingsWindow'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsWindow />
  </StrictMode>,
)
