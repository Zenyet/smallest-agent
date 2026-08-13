import { useState } from 'react'
import { Icon } from './Icon'
import type { SourceHit } from '../sources'

// 按不同文件名分组，每组内保留全部命中片段（一个笔记可能命中多个不同片段，
// 各有不同的相似度和长度）。命中数组本身已按调用顺序（即检索时间顺序），
// 分组时保留该顺序：先遇到哪个文件，哪个文件的组就排在前面。
interface SourceGroup {
  source: string
  chunks: Array<{ score: number; chars: number }>
}

function groupBySource(hits: SourceHit[]): SourceGroup[] {
  const order: string[] = []
  const bySource = new Map<string, Array<{ score: number; chars: number }>>()
  for (const hit of hits) {
    let bucket = bySource.get(hit.source)
    if (!bucket) {
      bucket = []
      bySource.set(hit.source, bucket)
      order.push(hit.source)
    }
    bucket.push({ score: hit.score, chars: hit.chars })
  }
  return order.map((source) => ({ source, chunks: bySource.get(source)! }))
}

// 答案末尾的检索片段列表。折叠成「N 个文件 · M 个片段」，点开按文件分组展示。
// hits 为空时不渲染 —— 没有 search_notes 的普通回答不该带一个空壳条。
//
// 诚实说明：这里显示的是本轮 search_notes 检索到的所有片段，不代表模型答案
// 实际引用了它们（比如模型用更好的查询重搜后，第一次检索的废弃片段依然会出现）。
// 等有了 citation 数据才能精确标注答案用了哪些来源，现在的文案必须说清楚
// 这是「本轮检索到」而不是「答案引用」。
export function SourceList({ hits }: { hits: SourceHit[] }) {
  const [open, setOpen] = useState(false)
  if (hits.length === 0) return null

  const groups = groupBySource(hits)

  return (
    // sources 保留作测试锚点，不带样式
    <div className="sources mt-1.5 overflow-hidden rounded-control bg-canvas shadow-hairline">
      <button
        type="button"
        className="sources__head flex h-7 w-full items-center gap-1.5 px-2 text-left text-[12px] text-ink-2 transition-colors duration-100 hover:bg-hover-2"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="text-ink-3">
          <Icon name="doc" size={12} />
        </span>
        <span>
          本轮检索到 {groups.length} 个文件 · {hits.length} 个片段
        </span>
        <span className="ml-auto">
          <Icon name="chevron" size={12} className="text-ink-3" rotated={!open} />
        </span>
      </button>
      {open && (
        <ul className="sources__list m-0 list-none px-2 pb-2">
          {groups.map((group) => (
            <li
              // 用文件名作 key：groupBySource 保证它在本次分组里唯一，比数组下标稳
              key={group.source}
              className="sources__group border-t border-line py-1 text-[11.5px] first:border-t-0"
            >
              <div className="flex items-center gap-2">
                <span className="flex-1 truncate font-mono text-ink-2">{group.source}</span>
                <span className="text-ink-3">{group.chunks.length} 个片段</span>
              </div>
              {group.chunks.length > 1 && (
                <ul className="mt-1 mb-0 ml-4 list-none text-ink-3">
                  {group.chunks.map((chunk, j) => (
                    <li key={j} className="sources__hit py-0.5">
                      相似度 {chunk.score.toFixed(2)} · 片段 {chunk.chars} 字
                    </li>
                  ))}
                </ul>
              )}
              {group.chunks.length === 1 && (
                <div className="mt-0.5 text-ink-3">
                  相似度 {group.chunks[0].score.toFixed(2)} · 片段 {group.chunks[0].chars} 字
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
