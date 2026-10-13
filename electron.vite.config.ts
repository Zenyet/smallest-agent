import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = import.meta.dirname

export default defineConfig({
  main: {
    // Pure JS dependencies live in devDependencies and are bundled/tree-shaken.
    // Only Transformers and its native runtime remain external production deps.
    plugins: [externalizeDepsPlugin()],
    build: {
      minify: true,
      rollupOptions: {
        // 两个入口：主进程，以及编译后的 mcp-server（打包时要用，见 Task 18）
        input: {
          index: resolve(root, 'electron/main/index.ts'),
          'mcp-server': resolve(root, 'mcp-server.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      minify: true,
      rollupOptions: {
        input: resolve(root, 'electron/main/preload.ts'),
        // preload 在 contextIsolation 下必须是 CJS，显式指定扩展名避免 type:module 干扰
        output: { format: 'cjs', entryFileNames: 'preload.cjs' },
      },
    },
  },
  renderer: {
    root: resolve(root, 'electron/renderer'),
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        // 一个 renderer 入口 = 一个 BrowserWindow。设置以前是独立窗口
        // （macOS ⌘, 的原生做法），现在在主窗口右栏渲染 —— 改完 key 要回来
        // 接着问，独立窗口每次都得切窗口、还会挡住对话。
        input: {
          index: resolve(root, 'electron/renderer/index.html'),
        },
      },
    },
  },
})
