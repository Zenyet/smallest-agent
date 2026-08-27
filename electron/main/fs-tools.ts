// ============================================================================
// fs-tools.ts —— 按项目目录隔离的文件工具（沙箱）
// ----------------------------------------------------------------------------
// ## 为什么不自己写路径校验
//
// @modelcontextprotocol/server-filesystem 已经做了正确的收敛，算法和
// rs/core/src/workspace.rs 是同一套：
//
//   • path.resolve(path.normalize(p)) 吃掉 `..`        （path-validation.js:25）
//   • fs.realpath 解符号链接后再查一次                  （lib.js:53-56）
//   • 写新文件时校验**父目录**的 realpath                （lib.js:66）
//
// 这三条正是 workspace.rs 文件头点名的那两条绕过路径（`../` 和符号链接）的
// 防法。再写一套等于两套逻辑对同一件事各判一遍，不一致时行为没法推理。
//
// ## 那缺的是什么：边界的粒度
//
// 允许目录是**起子进程时**作为命令行参数传进去的，子进程启动时定死。而原来
// 它写死成一个全局 notesDir，且 createRuntime 只在启动时跑一次 —— 所以：
//
//   • 边界不跟着会话走（在项目 X 下开的会话仍然只能碰 notesDir）
//   • 和外部 CLI 不一致（那边的 cwd 是跟着项目的，见 provider/registry.ts）
//
// 这个文件解决的就是粒度：**一个项目目录一个 fs server 实例**。
//
// ## 缓存键为什么是目录，不是会话 id
//
// 同一个项目下的多个会话共用一个实例 —— 它们的沙盒边界本来就是同一个，
// 按会话分实例只是白起进程（每个 npx 首次几秒）。
//
// 和 provider/registry.ts 按 (provider, 模型) 缓存是同一条推理：
// 键取「决定行为的那个东西」，不取「谁在用」。
//
// ## 没有项目目录的会话不装文件工具
//
// 照 gpui 的选择（providers.rs 的 fs_shell_tools 对 None 返回空注册表）。
// 理由是那边注释写的：**退回某个默认目录的话，agent 往里写东西用户不会去找。**
// 一个没有明确边界的沙盒不如没有沙盒 —— 它给人「有保护」的错觉。
//
// ## 这挡得住什么
//
// 挡得住：模型判断失误、或读到一段恶意文本（prompt injection）之后想读
// ~/.ssh/id_rsa、写 ~/.zshrc —— 解析后不在项目目录内，工具直接拒绝。
//
// **挡不住**：用户自己批准的危险命令（沙盒只限制工作目录，不是内核级隔离）；
// 外部 CLI 的文件访问（它们用自己的工具，我们只给了 cwd）。所以审批那一层
// 必须还在 —— 两层是配合关系，见 approval.ts。
// ============================================================================

import { loadMcpToolsFromServers as realLoadMcpToolsFromServers } from '../../src/mcp/client'
import { connectMcpWithEnv } from './mcp-connect'
import type { ToolRegistry } from '../../src/types'

export interface FsToolsPool {
  /**
   * 拿这个目录的文件工具。
   *
   * `dir` 为空/undefined 时返回空注册表，**并且不起进程** —— 那是「这个会话
   * 没有工作目录」的情况，见文件头。
   *
   * 建失败（npx 拉包失败、目录不可读）时也返回空注册表，不抛 —— 文件工具
   * 一直是可选的（原来 createRuntime 里那个 try/catch 就是这个意思），
   * 一次网络抖动不该让整轮对话失败。
   */
  forDir(dir: string | undefined): Promise<ToolRegistry>
  /** 关掉所有子进程。app 退出时调。幂等。 */
  disposeAll(): Promise<void>
}

export interface FsToolsPoolDeps {
  loadMcpToolsFromServers: typeof realLoadMcpToolsFromServers
  /** 起 fs server 的命令行。注入是为了测试不真的跑 npx。 */
  specFor: (dir: string) => { command: string; args: string[] }
}

/**
 * 默认的 fs server 命令行：官方 filesystem server + 一个允许目录。
 *
 * 允许目录就是沙箱边界。传绝对路径 —— 相对路径会按子进程的 cwd 解析，
 * 而双击启动时那可能是 `/`（workspace.rs:21 警告的正是这件事：
 * 拿 cwd 当沙盒根等于没有沙盒）。调用方负责给绝对路径。
 */
export function defaultFsSpec(dir: string): { command: string; args: string[] } {
  return { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', dir] }
}

export function createFsToolsPool(deps: Partial<FsToolsPoolDeps> = {}): FsToolsPool {
  const d: FsToolsPoolDeps = {
    loadMcpToolsFromServers: realLoadMcpToolsFromServers,
    specFor: defaultFsSpec,
    ...deps,
  }

  interface Entry {
    tools: ToolRegistry
    close: () => Promise<void>
  }
  const cache = new Map<string, Entry>()
  /**
   * 正在建的那些。
   *
   * 没有这张表的话，同一个目录的两次并发调用会各起一个子进程 —— 后建的那个
   * 覆盖前一个进缓存，前一个变成永远不会被 close 的孤儿。
   * 会话切换时 forDir 可能被连着调好几次，所以这不是理论问题。
   */
  const inflight = new Map<string, Promise<ToolRegistry>>()

  return {
    async forDir(dir) {
      const key = dir?.trim()
      // 没有工作目录 = 不装文件工具，也不起进程。见文件头
      if (!key) return {}

      const hit = cache.get(key)
      if (hit) return hit.tools

      const pending = inflight.get(key)
      if (pending) return pending

      const build = (async (): Promise<ToolRegistry> => {
        try {
          const { tools, close } = await d.loadMcpToolsFromServers(
            [d.specFor(key)],
            connectMcpWithEnv,
          )
          cache.set(key, { tools, close })
          return tools
        } catch (err) {
          // **失败的不进缓存** —— 进了的话一次网络抖动会把「坏实例」永久
          // 缓存住，之后每轮都拿到空工具，而用户看不出为什么
          console.error(
            `[sandbox] ${key} 的文件工具起不来，这个会话没有文件能力：`,
            err instanceof Error ? err.message : err,
          )
          return {}
        } finally {
          inflight.delete(key)
        }
      })()

      inflight.set(key, build)
      return build
    },

    async disposeAll() {
      const entries = [...cache.values()]
      cache.clear()
      // 先清表再关：关的过程中如果有人再问同一个目录，应该重新建一个，
      // 而不是拿到一个正在关闭的实例
      for (const e of entries) {
        await e.close().catch(() => {})
      }
    },
  }
}
