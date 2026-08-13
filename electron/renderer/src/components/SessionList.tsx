import { Icon } from './Icon'
import type { SessionMeta } from '../../../shared/channels'

export function SessionList({
  sessions,
  currentId,
  onSelect,
  onCreate,
  onDelete,
  onOpenSettings,
}: {
  sessions: SessionMeta[]
  currentId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  onOpenSettings: () => void
}) {
  return (
    <aside className="sidebar flex w-56 flex-none flex-col gap-1.5 border-r border-line bg-canvas p-2">
      {/* 新建按钮：紧凑的 h-7，与列表行高一致。 */}
      <button
        type="button"
        className="flex h-7 cursor-pointer items-center justify-center gap-1 rounded-control border-none bg-ink px-2.5 text-[12px] font-medium text-surface shadow-btn transition-[background-color,transform] duration-150 hover:opacity-90 active:scale-[0.96]"
        onClick={onCreate}
      >
        <Icon name="plus" size={11} strokeWidth={1.8} /> 新对话
      </button>

      {/* 会话列表：每项自己的背景响应 hover/active，不用滑动高光框 */}
      <div className="flex flex-1 flex-col gap-px overflow-y-auto">
        <ul className="m-0 flex list-none flex-col gap-px p-0">
          {sessions.map((s) => {
            const isActive = s.id === currentId
            return (
              // session--active 保留作测试锚点
              <li
                key={s.id}
                className={`session group flex h-7 cursor-pointer items-center gap-1.5 rounded-control px-2 text-[12.5px] transition-[color,background-color,transform] duration-150 active:scale-[0.96] ${
                  isActive ? 'session--active bg-surface text-ink' : 'text-ink-2 hover:bg-hover'
                }`}
                onClick={() => onSelect(s.id)}
              >
                <span className="flex-1 truncate">{s.title}</span>
                <button
                  type="button"
                  className="cursor-pointer border-none bg-transparent px-1 py-0.5 text-ink-2 opacity-0 transition-opacity duration-100 group-hover:opacity-100"
                  aria-label={`删除 ${s.title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(s.id)
                  }}
                >
                  <Icon name="close" size={11} strokeWidth={1.8} />
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      {/* 设置按钮：紧凑样式，与新建按钮对称 */}
      <button
        type="button"
        className="flex h-7 cursor-pointer items-center justify-center gap-1 rounded-control border-none bg-surface px-2.5 text-[12px] text-ink-2 shadow-btn transition-[background-color,transform] duration-150 hover:bg-hover active:scale-[0.96]"
        onClick={onOpenSettings}
      >
        <Icon name="settings" size={11} strokeWidth={1.8} /> 设置
      </button>
    </aside>
  )
}
