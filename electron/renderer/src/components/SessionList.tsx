import { Icon } from './Icon'
import type { SessionGroup } from '../../../shared/channels'

// 侧边栏：顶部动作行（新对话）→「项目」区标签 → 项目行（可折叠）→ 其下嵌套的会话行。
//
// 视觉规则（全走 styles.css 的 token）：字号 13px 及以下、行高统一 h-7、
// 边界用 hairline ring 而不是 border、圆角走 rounded-control/rounded-chip
// 而不是裸 rounded-[Npx]。
//
// 没有 active:scale 之类的点击微交互：按一下整行缩一下在一个每天点几十次的
// 列表里是噪音，不是反馈 —— 选中态本身（背景 + 文字提亮）已经把结果说清楚了。
export function SessionList({
  groups,
  currentId,
  currentProjectId,
  onSelect,
  onCreate,
  onOpenSettings,
  onAddProject,
  onToggleCollapsed,
  onSelectProject,
  onSessionContextMenu,
  onProjectContextMenu,
}: {
  /** 已经按项目分好组的会话（分组逻辑在 main/projects.ts 的 groupSessions 里，可单测） */
  groups: SessionGroup[]
  currentId: string | null
  /** 当前选中的项目：新会话会落在它下面，行上也要有选中态 */
  currentProjectId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onOpenSettings: () => void
  onAddProject: () => void
  onToggleCollapsed: (id: string) => void
  onSelectProject: (id: string) => void
  /** 右键会话：由 App 转给主进程弹原生菜单，选了「删除」再回调到删除逻辑。
   *  组件本身不知道菜单里有什么，只负责报告「哪一项被右键了」。 */
  onSessionContextMenu: (id: string, title: string) => void
  onProjectContextMenu: (id: string, name: string) => void
}) {
  return (
    <aside className="sidebar flex w-56 flex-none flex-col gap-1.5 border-r border-line bg-canvas p-2">
      {/* 顶部一行：窗口拖拽区 + 红绿灯让位 + 右上角的设置齿轮。
          main 进程用 titleBarStyle: 'hiddenInset' 去掉了 macOS 原生标题栏，代价是
          整个窗口失去默认可拖拽区域，必须自己画一块标 -webkit-app-region: drag。
          红绿灯连按钮带边距占左上角约 78px 宽，pl-[78px] 给它让位，
          齿轮挤在右端剩下的空间里。
          齿轮本身要标 no-drag，否则它落在 drag 区里点不动（拖拽区会吃掉点击）。 */}
      <div className="flex h-7 shrink-0 items-center justify-end pl-[78px] [-webkit-app-region:drag]">
        <button
          type="button"
          aria-label="设置"
          title="设置 (⌘,)"
          onClick={onOpenSettings}
          // 裸图标按钮：没有背景、没有边框、不占一整行宽度，只有 hover 时
          // 用文字提亮做反馈。设置是低频入口，不该跟「新对话」抢视觉重量。
          className="flex size-6 cursor-pointer items-center justify-center rounded-chip border-none bg-transparent p-0 text-ink-3 transition-colors duration-150 hover:text-ink [-webkit-app-region:no-drag]"
        >
          <Icon name="settings" size={13} strokeWidth={1.8} />
        </button>
      </div>

      {/* 新对话：跟下面的项目行/会话行同一套外观 —— 无默认背景、文字左对齐、
          只有 hover 时才出背景。以前它是 bg-ink 的实心按钮，在一个全是 hover 态
          的列表顶上显得过重，像整页的主操作；实际它只是一条动作行。 */}
      <button
        type="button"
        className="flex h-7 cursor-pointer items-center gap-1.5 rounded-control border-none bg-transparent px-2 text-left text-[12.5px] text-ink-2 transition-[color,background-color] duration-150 hover:bg-hover hover:text-ink active:bg-surface"
        onClick={onCreate}
      >
        <Icon name="plus" size={12} strokeWidth={1.8} />
        <span className="flex-1">新对话</span>
      </button>

      {/* 「项目」区标签 + 添加入口。标签用 11px/uppercase-ish 的次要色，
          它是分区名而不是可点的项，所以不做 hover 态。 */}
      <div className="mt-1 flex h-6 shrink-0 items-center justify-between px-2">
        <span className="text-[11px] font-semibold tracking-wide text-ink-3">项目</span>
        <button
          type="button"
          aria-label="添加项目"
          title="添加项目（选择本地目录）"
          onClick={onAddProject}
          className="flex size-5 cursor-pointer items-center justify-center rounded-chip border-none bg-transparent p-0 text-ink-3 transition-colors duration-150 hover:text-ink"
        >
          <Icon name="plus" size={11} strokeWidth={1.8} />
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
        {groups.length === 0 && (
          <p className="m-0 px-2 py-1 text-[11.5px] leading-relaxed text-ink-3">
            还没有项目。点上面的 + 选一个本地目录，之后的对话会归到它下面。
          </p>
        )}

        {groups.map((group) => {
          // 未分组那一组没有目录（dir 为 null），它是兜底分类而不是用户建的东西：
          // 不能删、也不该显示目录路径。
          const isProject = group.dir !== null
          const isCurrentProject = isProject && group.id === currentProjectId
          return (
            <div key={group.id} className="project flex flex-col gap-px">
              {/* 项目行：整行一次点击同时做两件事 —— 选中这个项目、并折叠/展开它。
                  这两个语义不冲突，所以没必要拆成两个点击目标：
                  「选中」只有一个消费者（App.tsx 的 create()，决定新会话落在哪个项目），
                  除了行上的选中态之外不改变任何东西；「折叠」才是用户频繁要做的动作。
                  以前折叠只认那个 11px 的角标，点击面积太小还得瞄准。
                  别改回两个目标 —— 角标现在纯粹是折叠状态的视觉指示，不再是按钮。
                  「移除项目」移到右键菜单（见 onContextMenu）。 */}
              <div
                role="button"
                tabIndex={0}
                aria-expanded={!group.collapsed}
                title={group.dir ?? undefined}
                onClick={() => {
                  onSelectProject(group.id)
                  onToggleCollapsed(group.id)
                }}
                onKeyDown={(e) => {
                  // role=button 不像真 <button> 那样自带键盘激活，得自己补
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelectProject(group.id)
                    onToggleCollapsed(group.id)
                  }
                }}
                onContextMenu={(e) => {
                  // 未分组那一组不是用户建的，没有「移除」可做，就不弹菜单
                  if (!isProject) return
                  e.preventDefault()
                  onProjectContextMenu(group.id, group.name)
                }}
                className={`project__row group flex h-7 cursor-pointer items-center gap-1.5 rounded-control px-1.5 text-[12.5px] transition-[color,background-color] duration-150 ${
                  isCurrentProject
                    ? 'project__row--active bg-surface text-ink'
                    : 'text-ink-2 hover:bg-hover'
                }`}
              >
                {/* 收起时把朝下的角标转 -90deg（Icon 的 rotated 就是干这个的）。
                    折叠状态由外层的 aria-expanded 播报，这里只是图形。 */}
                <Icon name="chevron" size={11} strokeWidth={1.8} rotated={group.collapsed} className="text-ink-3" />
                <Icon name="folder" size={12} strokeWidth={1.8} />
                <span className="flex-1 truncate">{group.name}</span>
                {/* 折叠时把会话数摆出来：折起来之后用户看不见里面有几条，
                    这个数字让他不必展开就知道值不值得展开。 */}
                {group.collapsed && group.sessions.length > 0 && (
                  <span className="flex-none text-[11px] text-ink-3">{group.sessions.length}</span>
                )}
              </div>

              {/* 项目下的会话：缩进 + 左侧引导线表达层级（不用色块，那会丢层级感）。
                  折叠时整个 <ul> 不渲染，而不是 display:none —— 长列表下这也省掉
                  几百个不可见节点的渲染开销。 */}
              {!group.collapsed && group.sessions.length > 0 && (
                <ul className="m-0 ml-[13px] flex list-none flex-col gap-px border-l border-line py-px pl-1.5">
                  {group.sessions.map((s) => {
                    const isActive = s.id === currentId
                    return (
                      // session--active 保留作测试锚点
                      // 删除入口是右键菜单，不再是行尾那个 hover 才出现的 ✕。
                      // 那个 ✕ 有两个问题：它占着每一行的右端（哪怕透明也占位），
                      // 而且悬停才出现意味着用户得先发现它存在。原生右键菜单是
                      // 桌面应用里「对这一项做点什么」的既定手势，不用教。
                      <li
                        key={s.id}
                        className={`session flex h-7 cursor-pointer items-center gap-1.5 rounded-control px-2 text-[12.5px] transition-[color,background-color] duration-150 ${
                          isActive ? 'session--active bg-surface text-ink' : 'text-ink-2 hover:bg-hover'
                        }`}
                        onClick={() => onSelect(s.id)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          onSessionContextMenu(s.id, s.title)
                        }}
                      >
                        <span className="flex-1 truncate">{s.title}</span>
                      </li>
                    )
                  })}
                </ul>
              )}

              {/* 空项目：刚添加完目录、还没在里面开对话时，不给一行提示的话
                  那次「添加项目」看起来就像什么都没发生。 */}
              {!group.collapsed && group.sessions.length === 0 && (
                <p className="m-0 ml-[13px] border-l border-line py-1 pl-3 text-[11.5px] text-ink-3">
                  还没有对话
                </p>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
