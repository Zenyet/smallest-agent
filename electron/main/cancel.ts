// ============================================================================
// cancel.ts —— 取消令牌（轮边界）
// ----------------------------------------------------------------------------
// electron/README.md 的「已知限制」里有两条，它们是同一个问题：
// 「无 agent 取消」和「正在跑的会话不能删」（DELETE_BLOCKED）。
// README 把原因记成 src/agent.ts 的限制（「它不接受 AbortSignal」）——
// 那个结论是错的。
//
// ## 不改 src/ 也能取消：第 4 个接缝
//
// runAgent 的签名确实不收 AbortSignal。但 callModel 是**注入**的
// （src/agent.ts:27 的 AgentDeps.callModel），而 ReAct 循环每轮的第一件事
// 就是调它（agent.ts:53），且 runAgent **不捕获** callModel 的抛错。
//
// 所以包一层「进来先查令牌，已取消就抛」的装饰器，循环就会在下一轮入口停下，
// 异常一路上抛到 agent-runner 的 try/catch。src/ 一行不改。
//
// 这是现有的第 4 个接缝，和 README 记的那三个（loadConfig(env)、
// loadMcpToolsFromServers 的 connect 参数、runAgent 的 onTurn/onComplete）
// 同一性质，只是之前没人用过。
//
// ## 为什么不在工具边界取消
//
// 直觉上「工具执行前查令牌、抛错」粒度更细。但 runTool 把所有抛错吃掉
// 包成 {"error":...}（src/tools/index.ts:27-32），抛进去只会让模型下一轮
// 读到「工具坏了」然后换个参数重试 —— 循环根本不会停。
//
// 这和 approval.ts 选择返回 {denied:true} 而不是抛错是同一个坑，
// 那边的注释（approval.ts 的 deny 分支）已经写明：明确告诉模型是用户拒绝，
// 它才会换路子。工具边界的取消要走「装饰注册表 + 返回 {cancelled:true}」，
// 而长工具（shell）还得自己接 signal 才能真停 —— 那是后续子项目的事。
//
// ## 粒度与代价
//
// 取消只在**轮边界**生效。点了取消之后：当前这一轮的模型请求会跑完
// （流式的话文字还会继续吐一会儿），这一轮已经开跑的工具也会跑完，
// 到下一轮 callModel 入口才停。长工具下用户可能等几十秒。
//
// 打断「正在流的模型请求」要把 abortSignal 传给 SDK 的 streamText /
// generateText（src/llm.ts:115、:125）。但 makeCallModel(config, registry,
// onText) 没有 signal 参数，零修改下只能在这边另写一份带 signal 的版本 ——
// 那会把 toSdkMessages 那堆逐形状翻译（llm.ts:26-64）复制一份，
// 以后 src/llm.ts 改了这边不会跟着变。不做。
//
// 对应 rs/core/src/cancel.rs。那边多一个 `cancelled().await`（让 HTTP 层能
// 把请求和取消放在一起 select），这边不需要：TS 侧不打断正在流的请求，
// 没有「等取消发生」的场景，只有「查一下取消了没」。
// ============================================================================

import type { CallModel } from '../../src/types'

/// 取消导致的错误。
///
/// **单独一个类型**而不是复用 Error 加字符串匹配，是为了让上层能区分
/// 「用户主动停的」和「真出错了」：
///   • UI 不该把它显示成红色报错
///   • 重试层不该重试它（见 withCancel 的装饰位置说明）
///
/// 字符串匹配会把「网络挂了」这类真错误误判成取消，静默变成「已停止」，
/// 用户以为是自己点的 —— 测试里专门有这条。
export class Cancelled extends Error {
  constructor() {
    super('已取消')
    this.name = 'Cancelled'
  }
}

/**
 * 取消令牌。
 *
 * **一次性**：取消之后不能重置。每轮对话新建一个 —— 复用会让「上一轮的取消」
 * 泄漏到下一轮，而这种 bug 只在用户快速点停止再发送时才出现，很难查。
 * （rs 侧 cancel.rs 的注释记了同一条）
 */
export class CancelToken {
  #cancelled = false
  /**
   * 取消发生时要叫醒的人。
   *
   * ## 为什么光有 isCancelled() 不够
   *
   * 内置 agent 是「每轮入口查一次」，轮询就够。但 ACP provider 那边不一样：
   * 它阻塞在 `await session.nextUpdate()` 上等子进程说话。用户点停止时，
   * 如果那个 CLI 正好在闷头干活（不发通知），轮询要等到它下次开口才生效 ——
   * 而「正在跑长工具」恰恰是最想停下来的时刻。
   *
   * 所以给一条主动通路：取消发生时立刻回调，ACP 那边在回调里发
   * `session/cancel` 通知，不用等下一条更新。
   */
  #listeners = new Set<() => void>()

  /** 请求取消。多次调用无害。 */
  cancel(): void {
    if (this.#cancelled) return
    this.#cancelled = true
    for (const cb of this.#listeners) {
      // 一个监听者抛错不该拦住其它的 —— 它们各自独立
      try {
        cb()
      } catch (err) {
        console.error('[cancel] 监听者抛错：', err)
      }
    }
    // 只叫一次，之后不再需要它们
    this.#listeners.clear()
  }

  /**
   * 订阅取消。返回退订函数。
   *
   * 已经取消了就**立刻**同步回调 —— 否则「订阅晚了一步」会静默丢掉这次取消。
   */
  onCancel(cb: () => void): () => void {
    if (this.#cancelled) {
      cb()
      return () => {}
    }
    this.#listeners.add(cb)
    return () => this.#listeners.delete(cb)
  }

  isCancelled(): boolean {
    return this.#cancelled
  }

  /** 已取消就抛 Cancelled，否则什么都不做。 */
  throwIfCancelled(): void {
    if (this.#cancelled) throw new Cancelled()
  }

  /**
   * 把这个令牌接到 fetch 的 AbortSignal 上。
   *
   * ## 为什么必须有这个
   *
   * 前面那几个方法（isCancelled / throwIfCancelled / onCancel）都只能在
   * **我们自己的代码**里生效。但一轮里最长的那段等待是「等模型响应」——
   * 那是一次 HTTP 请求，在 SDK 里面、在 undici 里面，我们的循环压根没有
   * 执行权。轮询查不到它，onCancel 回调也没有能打断它的手段。
   *
   * 结果就是用户报的「点停止无效」：令牌置位了、cancel() 返回 true，
   * 而那次请求继续跑到底（流式回答的绝大部分时间都在这儿），要等它自己
   * 结束、循环回到顶部才看见取消 —— 用户已经等了几十秒。
   *
   * AbortSignal 是唯一能真正中断进行中的 fetch 的机制。签名做成
   * 「返回一个 signal」而不是「接受一个 controller」，是为了让调用方
   * （call-model.ts）不用自己管 controller 的生命周期。
   *
   * 已经取消的话返回一个**已经 aborted** 的 signal —— 那时 fetch 会立刻
   * 拒绝，不会真的发出去。
   */
  signal(): AbortSignal {
    const controller = new AbortController()
    if (this.#cancelled) {
      controller.abort()
      return controller.signal
    }
    // 不保存退订函数：令牌是一次性的（每轮新建），而这个 signal 的生命周期
    // 和它一样长。cancel() 里 listeners.clear() 会统一收掉。
    this.onCancel(() => controller.abort())
    return controller.signal
  }
}

/**
 * 判断一个错误是不是取消。
 *
 * 顺着 cause 链找而不是只看顶层：错误经过几层包装后，顶层的 message
 * 可能完全看不出是取消（rs 侧用 anyhow 的 chain 做同一件事）。
 *
 * ## 两种取消
 *
 * 1. **我们自己抛的** `Cancelled` —— 循环在轮边界/工具之间查出来的。
 *    用 instanceof 判，不比字符串 —— 那会把 `new Error('已取消')` 误判。
 *
 * 2. **fetch 被 abort 抛的** `AbortError` —— signal 生效时由 undici/SDK 抛，
 *    我们碰不到那个类，只能认 `name`。它是 DOMException 而不是我们的类，
 *    所以 instanceof 那条永远漏掉它。
 *
 *    不认它的后果是整条修复白做：signal 成功中断了请求（好事），但抛出的
 *    错误被判成「真故障」，走 emit.error —— 用户点停止，屏幕上出现一条红色
 *    「出错了」。他会以为自己弄坏了什么，而这本来就是他要的结果。
 *
 *    只认 `name === 'AbortError'` 这个精确值，不做模糊匹配：这是 WHATWG
 *    规定的名字，不是我们随便挑的字符串。
 */
export function isCancelled(err: unknown): boolean {
  // 自引用的 cause 会让遍历死循环（测试里有这条），用 seen 兜住
  const seen = new Set<unknown>()
  let cur = err
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    if (cur instanceof Cancelled) return true
    // AbortError：fetch 被 signal 中断时抛的。见上面第 2 点。
    if ((cur as { name?: string })?.name === 'AbortError') return true
    seen.add(cur)
    cur = cur instanceof Error ? cur.cause : undefined
  }
  return false
}

/**
 * 把 callModel 包成「每轮入口查一次取消」。
 *
 * ## 必须套在最外层
 *
 * 现有装饰链是 `withFallback(withCache(withRetry(makeCallModel)))`
 * （call-model.ts 的 build()，由内往外套，再按需包 fallback）。
 * withCancel 要套在 buildCallModel 的**返回值之外**，不进那个函数。
 *
 * 两个理由，都不只是洁癖：
 *   • 套在 withRetry 里面：取消抛的异常会被当成可重试的失败，
 *     反复退避几轮才放弃 —— 用户点了停止还要等
 *   • 套在 withFallback 里面：取消会触发「主模型失败，换备用模型」，
 *     于是取消反而多打一次请求
 */
export function withCancel(inner: CallModel, token: CancelToken): CallModel {
  return async (messages) => {
    token.throwIfCancelled()
    // ## 光有上面那个前置检查是不够的
    //
    // 那一句只能拦住「还没开始的请求」。真正的问题是**已经在飞的**那次
    // 请求：流式回答的绝大部分时间都花在等它，而它在 SDK/undici 里面，
    // 我们的循环没有执行权 —— 用户点停止，令牌置位了，那次请求照样跑到底。
    // 这就是「点停止无效」的根因。
    //
    // 把令牌接成 AbortSignal 传下去，SDK 会一路交给 fetch，
    // 于是取消能真正中断它。
    //
    // 注意 signal 每次调用都新建一个：CallModel 可能被重试层调用多次
    // （withRetry），而 AbortSignal 一旦 aborted 就永久有效 —— 复用一个的话
    // 第一次取消之后这个 callModel 就永久不可用了。令牌本身是一次性的
    // （每轮新建），所以「新建的 signal 立刻反映当下的取消状态」是对的。
    return inner(messages, token.signal())
  }
}
