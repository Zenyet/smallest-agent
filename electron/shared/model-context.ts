/** Verified model limits; exact IDs only. Unknown aliases must not inherit limits.
 * Sources and exceptions: docs/product/2026-09-09-context-ring.md. */
const limits: Record<string, Record<string, number>> = {
  openai: { 'gpt-5.2': 400000, 'gpt-5.1': 400000, 'gpt-5': 400000, 'gpt-5-mini': 400000, o3: 200000, 'gpt-4o': 128000 },
  anthropic: { 'claude-opus-5': 1000000, 'claude-sonnet-5': 1000000, 'claude-haiku-4-5': 200000 },
  gemini: { 'gemini-2.5-pro': 1048576, 'gemini-2.5-flash': 1048576 },
  glm: { 'glm-4.6': 200000, 'glm-4.5': 128000, 'glm-4.5-air': 128000 },
  qwen: { 'qwen3-max': 262144, 'qwen-max': 32768, 'qwen-plus': 1000000, 'qwen-turbo': 131072 },
  minimax: { 'minimax-m2': 204800 },
  grok: { 'grok-3': 1000000 },
}
export function modelContext(provider: string, model: string, declared?: number): number | undefined {
  if (Number.isSafeInteger(declared) && declared! > 0) return declared
  const vendor = provider === 'claude-code' ? 'anthropic' : provider === 'codex' ? 'openai' : provider
  const id = vendor === 'anthropic' && ['claude-opus-5[1m]', 'claude-sonnet-5[1m]'].includes(model) ? model.replace('[1m]', '') : model
  return limits[vendor]?.[id]
}
export function contextPercent(used?: number, capacity?: number): number | undefined {
  if (used == null || !Number.isFinite(used) || used < 0 || !capacity || !Number.isFinite(capacity) || capacity <= 0) return undefined
  return Math.min(100, Math.max(0, used / capacity * 100))
}
