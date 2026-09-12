import { describe, it, expect } from 'vitest'
import { runAgent } from '../src/agent'
import { CancelToken, Cancelled, isCancelled } from '../electron/main/cancel'
import type { ModelResult, ToolRegistry } from '../src/types'

// ============================================================================
// 取消在工具执行期间的响应速度
//
// 背景：用户报「暂停不了请求」。排查发现 agent 循环只在 callModel 入口查
// 取消（withCancel 套在 callModel 外面），而工具执行不经过 callModel ——
// 用户点停止时如果卡在一个慢工具上（web_search 拉不动、read_file 读大文件），
// 那个请求要一直跑到工具返回、下一次 callModel 入口才看见取消标志。
//
// 而用户按停止正是因为等不及它跑完。
//
// 修法：在循环头 + 工具之间各查一次，卡在任何地方都能在几百毫秒内响应。
// ============================================================================

describe('取消在工具执行期间', () => {
  it('工具运行前查一次，第一个慢工具开始前就能拦住', async () => {
    const token = new CancelToken()
    let slowToolStarted = false

    const slowTool = {
      name: 'slow',
      description: 'A slow tool',
      parameters: {},
      // 这个工具要跑 10 秒，但根本不该被调到 —— 循环在它开始前就该看见取消
      run: async () => {
        slowToolStarted = true
        await new Promise((r) => setTimeout(r, 10_000))
        return 'never'
      },
    }

    const tools: ToolRegistry = { slow: slowTool }

    // 模型让 agent 去调那个慢工具
    const fakeModel = async (): Promise<ModelResult> => ({
      text: 'calling slow tool',
      toolCalls: [{ id: 'c1', name: 'slow', args: {} }],
      serverToolCalls: [],
    })

    // 模型调完之后、agent 开始执行工具之前就取消
    //
    // 真实场景：用户看到「正在搜索」就意识到它会卡很久，马上点停止 ——
    // 这时 LLM 已经返回了（所以 callModel 里的 withCancel 拦不住），
    // 但第一个工具还没开始跑
    const promise = runAgent('test', {
      callModel: fakeModel,
      tools,
      config: { systemPrompt: '', maxTurns: 3 },
      token,
    })

    // 模拟用户在 agent 刚拿到模型输出、准备调工具时点停止
    token.cancel()

    await expect(promise).rejects.toThrow(Cancelled)
    // 关键断言：慢工具根本没被调到
    expect(slowToolStarted).toBe(false)
  })

  it('模型让调 5 个工具、第 2 个很慢时，在它开始前能停下来', async () => {
    const token = new CancelToken()
    const called: string[] = []

    const tools: ToolRegistry = {
      fast: {
        name: 'fast',
        description: 'fast',
        parameters: {},
        run: async () => {
          called.push('fast')
          // 第一个 fast 执行完立即取消，这样下一个工具开始前必定看到取消标志
          if (called.length === 1) {
            token.cancel()
          }
          return 'fast done'
        },
      },
      slow: {
        name: 'slow',
        description: 'slow',
        parameters: {},
        run: async () => {
          called.push('slow')
          await new Promise((r) => setTimeout(r, 10_000))
          return 'slow done'
        },
      },
    }

    let callCount = 0
    const fakeModel = async (): Promise<ModelResult> => {
      callCount++
      // 第一次调用：返回要调 5 个工具的指令
      if (callCount === 1) {
        return {
          text: 'calling tools',
          // fast、slow、fast、fast、fast
          toolCalls: [
            { id: 'c1', name: 'fast', args: {} },
            { id: 'c2', name: 'slow', args: {} },
            { id: 'c3', name: 'fast', args: {} },
            { id: 'c4', name: 'fast', args: {} },
            { id: 'c5', name: 'fast', args: {} },
          ],
          serverToolCalls: [],
        }
      }
      // 后续调用（如果取消失败，agent 会继续）：直接返回答案，避免无限循环
      return {
        text: 'final answer',
        toolCalls: [],
        serverToolCalls: [],
      }
    }

    const promise = runAgent('test', {
      callModel: fakeModel,
      tools,
      config: { systemPrompt: '', maxTurns: 3 },
      token,
    })

    await expect(promise).rejects.toThrow(Cancelled)
    // 第一个 fast 调到了，slow 和后面的三个 fast 都没调到
    expect(called).toEqual(['fast'])
  })

  // withCancel 已经套在 callModel 外面（builtin.ts），那里也会查。
  // 但「准备进入下一轮」和「调模型」之间可能有几百毫秒（压缩、装配提示），
  // 在循环头多查一次能让停止更快响应
  it('每轮开头也查一次，不只在 callModel 入口', async () => {
    const token = new CancelToken()
    const calls: string[] = []

    let turn = 0
    const fakeModel = async (): Promise<ModelResult> => {
      turn++
      calls.push(`model-turn-${turn}`)
      if (turn === 1) {
        // 第一轮：调一个快工具
        return {
          text: 'first turn',
          toolCalls: [{ id: 'c1', name: 'fast', args: {} }],
          serverToolCalls: [],
        }
      } else {
        return {
          text: 'second turn',
          toolCalls: [],
          serverToolCalls: [],
        }
      }
    }

    const tools: ToolRegistry = {
      fast: {
        name: 'fast',
        description: 'fast',
        parameters: {},
        run: async () => {
          calls.push('tool-fast')
          // 工具执行完之后、进入第二轮之前取消
          token.cancel()
          return 'ok'
        },
      },
    }

    const promise = runAgent('test', {
      callModel: fakeModel,
      tools,
      config: { systemPrompt: '', maxTurns: 3 },
      token,
    })

    await expect(promise).rejects.toThrow(Cancelled)
    // 第一轮模型调了、工具调了，但第二轮模型没调到 —— 循环头拦住了
    expect(calls).toEqual(['model-turn-1', 'tool-fast'])
  })

  // 没传 token 的情况（老测试、或者不需要取消的场景）仍然能跑
  it('不传 token 时正常工作', async () => {
    const fakeModel = async (): Promise<ModelResult> => ({
      text: 'answer',
      toolCalls: [],
      serverToolCalls: [],
    })

    const answer = await runAgent('test', {
      callModel: fakeModel,
      tools: {},
      config: { systemPrompt: '', maxTurns: 3 },
      // 不传 token
    })

    expect(answer).toBe('answer')
  })
})

// ## 这一条锁的是「取消要走取消分支，不是错误分支」
//
// 循环里抛的 Cancelled 会一路冒到 agent-runner 的 catch。那边用 isCancelled()
// 顺 cause 链判类型来分流：取消 → emit.cancelled（不显示成报错），
// 真错误 → emit.error（红色报错）。
//
// 判错的后果是用户点了停止、屏幕上出现一条红色「出错了」—— 他会以为自己
// 的操作弄坏了什么，而这本来就是他要的结果。
describe('取消抛出的异常能被 runner 认出来', () => {
  it('循环里抛的 Cancelled 被 isCancelled 识别', async () => {
    const token = new CancelToken()
    token.cancel()

    const fakeModel = async (): Promise<ModelResult> => ({ text: 'x', toolCalls: [] })

    let caught: unknown
    try {
      await runAgent('test', {
        callModel: fakeModel,
        tools: {},
        config: { systemPrompt: '', maxTurns: 3 },
        token,
      })
    } catch (err) {
      caught = err
    }

    expect(isCancelled(caught)).toBe(true)
  })
})
