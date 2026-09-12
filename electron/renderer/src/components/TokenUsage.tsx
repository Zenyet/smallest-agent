import { useId } from 'react'
import { ContextRing } from './Icon'
import { contextPercent } from '../../../shared/model-context'
import type { TokenUsage } from '../../../../src/types'
import { summarizeUsage } from '../../../../src/usage'
import type { ChatMessage } from '../chat-reducer'
import { SettingsDisclosure } from './settings/SettingsControls'

const format = (n?: number) => n == null ? '未上报' : n.toLocaleString('zh-CN')
export function TurnUsage({ records }: { records?: TokenUsage[] }) {
  if (!records?.length) return null
  const usage = summarizeUsage(records)
  const cacheRate = records.every(r => r.inputTokens != null && r.cacheReadTokens != null) && usage.inputTokens
    ? Math.round((usage.cacheReadTokens ?? 0) / usage.inputTokens * 100) : undefined
  return <div className="usage-summary">
    <SettingsDisclosure className="usage-details" title={`Token · 输入 ${format(usage.inputTokens)} / 输出 ${format(usage.outputTokens)}${usage.localHits ? ` · 本地缓存 ${usage.localHits} 次` : ''}${usage.partial ? ' · 部分数据' : ''}`}>
      <dl className="usage-grid">
        <dt>输入 Token</dt><dd>{format(usage.inputTokens)}</dd>
        <dt>输出 Token</dt><dd>{format(usage.outputTokens)}</dd>
        <dt>总 Token</dt><dd>{format(usage.totalTokens)}</dd>
        <dt>服务端缓存读取</dt><dd>{format(usage.cacheReadTokens)}{cacheRate != null ? ` · 输入命中率 ${cacheRate}%` : ''}</dd>
        <dt>推理 Token</dt><dd>{format(usage.reasoningTokens)}</dd>
        <dt>本地回答缓存</dt><dd>{usage.localHits} / {usage.requests} 次调用</dd>
      </dl>
      <p>统计本次回答的主 Agent 调用（含工具循环）。缓存读取属于输入、推理属于输出，不重复相加。本地缓存命中不产生新请求。</p>
      <p>不含摘要、记忆抽取、答案核查及子 Agent 的额外调用；失败或中断请求未返回的用量也不包含。以服务商账单为准。</p>
    </SettingsDisclosure>
  </div>
}
export function ContextUsage({ messages, draft, model, vendor, capacity, external = false }: {
  messages: ChatMessage[]; draft: string; model: string; vendor: string; capacity?: number; external?: boolean
}) {
  const id = useId()
  const latest = [...messages].reverse().find(m => m.usages?.length)?.usages?.at(-1)
  // Never present another provider/model's request as the selected model's usage.
  const matches = !external && latest?.model === model && latest?.vendorId === vendor
  const context = matches ? latest?.contextTokens ?? (latest?.localCacheHit ? undefined : latest?.inputTokens) : undefined
  const percent = contextPercent(context, capacity)
  const label = percent == null ? '—' : percent > 0 && percent < 1 ? '<1%' : `${Math.floor(percent)}%`
  const cjk = (draft.match(/[一-鿿㐀-䶿]/g) ?? []).length
  const estimate = cjk + Math.ceil((draft.length - cjk) / 4)
  const description = `${model || '当前模型'} · ${context == null ? '用量未上报' : `最近请求 ${format(context)} Token`} / ${capacity ? `${format(capacity)} Token 容量` : '容量未知'}`
  return <div className={`context-meter ${percent != null && percent >= 95 ? 'is-critical' : percent != null && percent >= 80 ? 'is-warning' : ''}`}>
    <button type="button" className="context-meter-trigger" aria-label={`上下文占用 ${label}，${description}`} aria-describedby={id}>
      <ContextRing percent={percent} /><span>{label}</span>
    </button>
    <div className="context-meter-tooltip" role="tooltip" id={id}>
      <strong>上下文容量</strong><span>{model || '当前模型'}</span>
      <span>{context == null ? '等待当前模型用量' : `${format(context)} Token 已用`} / {capacity ? `${format(capacity)} Token` : '容量未知'}</span>
      {context != null && capacity != null && <span>{context > capacity ? '已达到或超过模型容量' : `剩余 ${format(capacity - context)} Token`} · 最近请求输入</span>}
      {draft && <span>草稿约 {format(estimate)} Token，未计入圆环</span>}
      <small>{external ? '此 CLI 暂未接入上下文用量。' : '圆环依据最近请求的实际输入，不含新草稿和之后生成的回复。'}容量来自模型资料或 Provider 配置，不是历史压缩阈值。</small>
    </div>
  </div>
}
