import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = import.meta.dirname

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
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
      rollupOptions: { input: resolve(root, 'electron/renderer/index.html') },
    },
  },
})
