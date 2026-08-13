// 写操作审批闸口。参照 beautifului.dev 的 Approval Card 模式：
// 有后果的动作执行前必须显式确认。
//
// 为什么做成「注册表装饰器」而不是改 agent 循环：src/ 不能改，而 runAgent 直接调
// runTool(tools, name, args) → registry[name].run(args)。把写工具的 run 换掉，
// 闸口就自动落在 agent 循环内部、工具执行之前，src/ 一行不动。
import { randomUUID } from 'node:crypto'
import type { Tool, ToolRegistry } from '../../src/types'
import type { ApprovalDecision, ApprovalRequestEvent } from '../shared/channels'

// 只 gate 真正改动磁盘的工具。只读工具（read_file / list_directory / search_notes …）
// 必须放行，否则每次检索都要点确认，实际没人用得下去。
//
// 这是针对 @modelcontextprotocol/server-filesystem@2026.1.14 手工核对过的硬编码集合——
// 逐一读取该版本 dist/index.js 里全部 14 个工具的 readOnlyHint/destructiveHint 标注，
// 确认恰好这 4 个会改动磁盘。之后升级这个依赖版本，如果它新增了一个可变更磁盘的
// 工具，这里不会自动感知，需要人工重新核对并同步这个集合。
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'create_directory',
  'move_file',
])

// pending() 返回的快照：不只是 requestId，还带上它属于哪个 session/工具/参数。
// Task 13 要用一个共享 gate 服务多个并发 session，session 或窗口被关掉时得知道
// 该清理谁的请求——所以 sessionId 必须能从 pending() 里读出来，不用调用方自己
// 另外维护一份 requestId → sessionId 的映射。
export interface PendingApproval {
  requestId: string
  sessionId: string
  toolName: string
  args: Record<string, unknown>
}

export interface ApprovalGateOptions {
  // 单个审批请求的超时时长（毫秒）。可注入，测试用小值，不用真的等。
  timeoutMs?: number
}

// 默认 5 分钟：用户可能要先读完一段 diff 再决定，不该被系统过早打断。
// 但绝不能没有上限——renderer 窗口被关掉、或者用户压根没点按钮时，
// requestApproval 的 promise 若永不落地，会一路挂住 runTool → runAgent 的工具循环
// → agent-runner.run()，而 agent-runner 的 busy 标志只在 finally 里清，
// promise 不结算它就清不掉：结果是整个 app 永久性拒绝新消息（BUSY），直到重启进程。
// 超时必须存在，而且必须落到 'deny' 而不是 'allow' —— fail-closed 是安全闸口的题眼，
// 说不清楚就当没批准，不能让「没人回应」变成「默认放行」。
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

interface WaitingEntry {
  sessionId: string
  toolName: string
  args: Record<string, unknown>
  settle: (decision: ApprovalDecision) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ApprovalGate {
  requestApproval(event: ApprovalRequestEvent): Promise<ApprovalDecision>
  resolve(requestId: string, decision: ApprovalDecision): void
  pending(): PendingApproval[]
  // 会话/窗口被关掉时，把它名下所有还悬着的请求一次性按「拒绝」结算掉。
  // 对不存在的 sessionId、或者已经没有 pending 请求的 sessionId 调用是空操作，
  // 可以安全地重复调用（幂等）。
  cancelSession(sessionId: string): void
}

export function createApprovalGate(options: ApprovalGateOptions = {}): ApprovalGate {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const waiting = new Map<string, WaitingEntry>()

  // 三个结算入口——用户显式决定 / 超时 / session 取消——都走这一个函数，
  // 保证「只生效一次」：先查 map，查到就先删再结算，查不到直接静默返回。
  // 这样无论超时和显式决定谁先谁后，后到的那个都会因为 map 里已经没有条目
  // 而变成空操作；定时器也总会在结算的同一刻被清掉，不会在结算后还挂着
  // 继续占用 Node 的事件循环。
  function settleOnce(requestId: string, decision: ApprovalDecision): void {
    const entry = waiting.get(requestId)
    if (!entry) return
    waiting.delete(requestId)
    clearTimeout(entry.timer)
    entry.settle(decision)
  }

  return {
    requestApproval(event) {
      return new Promise<ApprovalDecision>((resolve) => {
        const timer = setTimeout(() => {
          settleOnce(event.requestId, 'deny')
        }, timeoutMs)
        waiting.set(event.requestId, {
          sessionId: event.sessionId,
          toolName: event.toolName,
          args: event.args,
          settle: resolve,
          timer,
        })
      })
    },
    resolve(requestId, decision) {
      settleOnce(requestId, decision)
    },
    pending() {
      return [...waiting.entries()].map(([requestId, entry]) => ({
        requestId,
        sessionId: entry.sessionId,
        toolName: entry.toolName,
        // 浅拷贝而不是直接给出引用：entry.args 正是批准后要传给 tool.run 的那个对象，
        // 调用方（比如将来 UI 为了展示而就地规范化/脱敏参数）若改了快照，
        // 会静默改掉真正写进磁盘的内容。
        args: { ...entry.args },
      }))
    },
    cancelSession(sessionId) {
      // 先收集再结算，不在遍历 Map 的同时修改它——虽然 JS 的 Map 允许边遍历边删
      // 当前/已访问过的键，但拆成两步更不容易踩到未来重构带来的边界情况。
      const ids = [...waiting.entries()]
        .filter(([, entry]) => entry.sessionId === sessionId)
        .map(([requestId]) => requestId)
      for (const requestId of ids) settleOnce(requestId, 'deny')
    },
  }
}

export function guardRegistry(
  registry: ToolRegistry,
  sessionId: string,
  gate: ApprovalGate,
  emit: (event: ApprovalRequestEvent) => void,
): ToolRegistry {
  const guarded: ToolRegistry = {}

  for (const [name, tool] of Object.entries(registry)) {
    if (!WRITE_TOOLS.has(name)) {
      guarded[name] = tool
      continue
    }

    // 只换 run，name/description/parameters 原样保留 —— 模型看到的工具定义不能变，
    // 否则它对参数的理解会跟着变。
    const wrapped: Tool = {
      ...tool,
      run: async (args: Record<string, unknown>) => {
        const requestId = randomUUID()
        const event: ApprovalRequestEvent = { sessionId, requestId, toolName: name, args }
        const decision = gate.requestApproval(event)
        emit(event) // 先挂上等待再发事件，避免 Renderer 秒回时 resolver 还没注册
        if ((await decision) === 'deny') {
          // 返回结构化拒绝而不是抛错：runTool 会把抛错包成 {"error":...}，
          // 模型容易理解成「工具坏了」而反复重试；明确告诉它是用户拒绝，它才会换路子。
          // 超时也走这条路径——对模型来说「用户拒绝」和「用户没来得及回应」没有区别，
          // 反正都不能执行。
          return { denied: true, reason: `用户拒绝了 ${name} 操作`, toolName: name }
        }
        return tool.run(args)
      },
    }
    guarded[name] = wrapped
  }

  return guarded
}
