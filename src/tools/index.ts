// ============================================================================
// tools/index.ts —— 工具执行的「统一入口」
// ----------------------------------------------------------------------------
// agent 循环在 Act 阶段调用这里的 runTool，根据工具名在注册表里查找并执行。
// 本地工具和 MCP 工具对 agent 循环完全透明——只要注册进 ToolRegistry，
// runTool 就能用同一套逻辑驱动；这是工具系统「可插拔」设计的关键体现。
// ============================================================================

import type { ToolRegistry } from '../types'

// 按名字查找工具、执行、把结果序列化成 JSON 字符串返回给模型。
// 错误也以 JSON 形式返回，而非抛出——让 agent 循环不中断，模型能看到错误并自行决定重试或放弃。
export async function runTool(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = registry[name]
  // 名字不在注册表里 = 模型幻想了一个不存在的工具（hallucination），以 JSON 错误告知，不 throw。
  if (!tool) {
    return JSON.stringify({ error: `unknown tool: ${name}` })
  }
  try {
    const output = await tool.run(args)
    // 统一序列化：模型下一轮读到的 tool 消息 content 永远是 JSON 字符串。
    return JSON.stringify(output)
  } catch (err) {
    // 捕获工具执行时的异常，同样包成 JSON 而非上抛——保持 agent 循环的健壮性。
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
