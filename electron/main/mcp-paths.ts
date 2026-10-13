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
    // Keep the entry beside its packaged dependencies. A script copied directly
    // into Resources cannot resolve modules inside app.asar/node_modules.
    args: [join(input.resourcesPath, 'app.asar', 'out', 'main', 'mcp-server.js')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

// 官方 filesystem server 依赖 npx 联网拉包，打包环境不可靠 ——
// 所以它是可选的：连不上就跳过，那个会话没有文件能力，不阻塞启动。
//
// ## 这个函数**不再被启动路径用**
//
// 它原来在 createRuntime 里被调一次，允许目录写死成全局 notesDir ——
// 而那个参数就是沙箱边界，写死等于「全应用一个固定边界，不跟着会话走」。
// 现在边界按「会话所属项目的目录」懒建，命令行由 fs-tools.ts 的
// defaultFsSpec 拼（形状和这里一样，只是目录是参数）。
//
// 留着它是因为 notesDir 那个默认边界在「只想读写笔记」的场景下仍然合理，
// 而删掉它会连带删掉 McpPathsInput.notesDir 的唯一用途 —— 那个字段
// ownServerSpec 也在用。要用的话调用方自己传绝对路径。
export function fsServerSpec(input: McpPathsInput): McpServerSpec {
  return {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', input.notesDir],
  }
}
