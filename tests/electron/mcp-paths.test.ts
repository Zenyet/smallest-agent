import { describe, it, expect } from 'vitest'
import { ownServerSpec, fsServerSpec } from '../../electron/main/mcp-paths'

const dev = {
  isDev: true,
  execPath: '/Applications/App.app/Contents/MacOS/App',
  resourcesPath: '/Applications/App.app/Contents/Resources',
  projectRoot: '/repo',
  notesDir: '/repo/notes',
}
const prod = { ...dev, isDev: false }

describe('ownServerSpec', () => {
  it('开发环境走 npx tsx 跑未编译的 TS', () => {
    const spec = ownServerSpec(dev)
    expect(spec.command).toBe('npx')
    expect(spec.args).toEqual(['tsx', '/repo/mcp-server.ts'])
  })

  it('生产环境用 Electron 自带的 Node 跑编译产物', () => {
    const spec = ownServerSpec(prod)
    expect(spec.command).toBe(prod.execPath)
    expect(spec.args).toEqual(['/Applications/App.app/Contents/Resources/mcp-server.js'])
  })

  it('生产环境必须带 ELECTRON_RUN_AS_NODE，否则子进程会当成 Electron 应用再启一个窗口', () => {
    expect(ownServerSpec(prod).env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('开发环境不需要那个变量', () => {
    expect(ownServerSpec(dev).env).toBeUndefined()
  })
})

describe('fsServerSpec', () => {
  it('两种环境都走 npx（官方 server 不打包，失败则降级跳过）', () => {
    for (const input of [dev, prod]) {
      const spec = fsServerSpec(input)
      expect(spec.command).toBe('npx')
      expect(spec.args).toEqual([
        '-y',
        '@modelcontextprotocol/server-filesystem',
        input.notesDir,
      ])
    }
  })
})
