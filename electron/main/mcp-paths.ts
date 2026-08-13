// cli.ts 用 `npx tsx mcp-server.ts` 启动自建 server，打包后这条命令必然失败：
// 用户机器不一定有 npx，tsx 是 devDependency 不进包，mcp-server.ts 也没编译。
// 生产环境改用 Electron 自带的 Node 跑编译产物 —— process.execPath 就是 Electron 二进制，
// 设 ELECTRON_RUN_AS_NODE=1 让它以纯 Node 模式执行脚本，不再开窗口。
import { join } from 'node:path'

export interface McpServerSpec {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface McpPathsInput {
  isDev: boolean
  execPath: string // process.execPath
  resourcesPath: string // process.resourcesPath（生产）
  projectRoot: string // 仓库根目录（开发）
  notesDir: string
}

export function ownServerSpec(input: McpPathsInput): McpServerSpec {
  if (input.isDev) {
    return { command: 'npx', args: ['tsx', join(input.projectRoot, 'mcp-server.ts')] }
  }
  return {
    command: input.execPath,
    args: [join(input.resourcesPath, 'mcp-server.js')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

// 官方 filesystem server 依赖 npx 联网拉包，打包环境不可靠 ——
// 所以它是可选的：连不上就跳过，UI 标注「文件系统工具不可用」，不阻塞启动。
export function fsServerSpec(input: McpPathsInput): McpServerSpec {
  return {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', input.notesDir],
  }
}
