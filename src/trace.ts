// ============================================================================
// trace.ts —— 把每一轮 ReAct 循环的快照打印成人类可读的 trace
// ----------------------------------------------------------------------------
// 职责：纯「展示层」，不做任何逻辑判断，只负责把 TurnInfo 格式化成字符串。
// agent.ts 通过 onTurn 回调把每轮快照推过来，trace.ts 负责渲染。
//
// showText 选项是流式场景下的去重开关：
//   流式时 cli.ts 已经实时打印了文本（通过 onText delta），
//   onTurn 回调里再打一遍就重复了——传 showText:false 可跳过文本部分，
//   只打工具调用和结果，保持终端输出整洁。
// ============================================================================

import type { TurnInfo } from './agent'

// formatTurn：把单轮快照格式化为多行字符串，供打印或测试断言用。
// showText 默认 true（非流式时需要在这里展示文本）；
// 流式时由调用方传 false，避免和 onText 的实时输出重复。
export function formatTurn(info: TurnInfo, opts: { showText?: boolean } = {}): string {
  const showText = opts.showText ?? true
  const lines: string[] = [`── turn ${info.turn} ──`]
  if (showText && info.result.text) lines.push(`🤖 ${info.result.text}`)
  // 工具调用声明（模型「想」调什么）
  for (const call of info.result.toolCalls) {
    lines.push(`🔧 调用 ${call.name}(${JSON.stringify(call.args)})`)
  }
  // 工具实际执行结果（「做」了之后看到了什么）
  for (const tr of info.toolResults) {
    lines.push(`📦 ${tr.name} → ${tr.output}`)
  }
  return lines.join('\n')
}

// printTurn：formatTurn 的 console.log 快捷封装，cli.ts 直接调这个。
export function printTurn(info: TurnInfo, opts: { showText?: boolean } = {}): void {
  console.log(formatTurn(info, opts))
}
