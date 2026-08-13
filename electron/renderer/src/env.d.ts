/// <reference types="vite/client" />
// vite/client 提供 CSS / 静态资源等侧效应导入的类型声明（main.tsx 的 import './styles.css' 靠它）

import type { ElectronAPI } from '../../main/preload'

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
