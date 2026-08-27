// ============================================================================
// ModelPicker.tsx —— composer 左下角的模型选择器
// ----------------------------------------------------------------------------
// 移植自 gpui 的 render_builtin_model_picker（chat.rs）+ picker.rs 的外观。
//
// 为什么模型选在这儿而不是设置页：「这条消息谁来答」的时刻就是准备提问的
// 时刻，信息该出现在用户视线所在的地方（gpui 侧那段注释的原话）。设置页里
// 只填凭据（哪家的 key），换模型是高频动作，不该每次都开一个窗口。
//
// ## 选项 id 是 `厂商id/模型id`
//
// 一次点击同时决定 base_url 和模型 —— 这两件事在内置 agent 里是绑在一起的
// （换厂商必然换端点）。分成两级选择器（先选厂商再选模型）要多一次点击，
// 而九家 × 三四个模型一共三十几项，一个带分组头的列表装得下。
//
// ## 触发按钮只显示模型名
//
// composer 那行放不下「Anthropic · Claude Opus 5」，厂商信息由展开列表里的
// 分组头给出（同 gpui）。
//
// 浮层用 popover 属性：点外面 / Esc 自动关、自动进 top layer。和
// ContextMenu.tsx 同一个理由，见那个文件的文件头。
// ============================================================================

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { VendorEntry } from '../../../main/vendors'

export function ModelPicker({
  catalog,
  currentVendor,
  currentModel,
  onPick,
}: {
  catalog: VendorEntry[]
  currentVendor: string
  currentModel: string
  /** 一次给出厂商和模型 —— 它们绑在一起，见文件头 */
  onPick: (vendorId: string, modelId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const id = useId()

  // popover 是命令式 API，要和 React 的声明式状态对上就得在 effect 里同步
  // （和 ContextMenu.tsx 同一个手法）。
  useEffect(() => {
    const el = ref.current
    if (!el) return
    try {
      if (open) {
        if (!el.matches(':popover-open')) el.showPopover()
      } else if (el.matches(':popover-open')) {
        el.hidePopover()
      }
    } catch {
      // jsdom 没实现 popover；测试里只断言列表内容，不断言浮层行为
    }
  }, [open])

  // 平台的 light dismiss 只改 DOM、不通知 React —— 不听这个事件的话
  // open 还是 true，下次点触发按钮会以为「已经开着」而关不掉。
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState === 'closed') setOpen(false)
    }
    el.addEventListener('toggle', onToggle)
    return () => el.removeEventListener('toggle', onToggle)
  }, [])

  // 当前模型的显示名。找不到（自定义端点的清单刚被删掉一项）就显示 id 本身，
  // 而不是一个空标签。
  const currentName =
    catalog
      .filter((e) => e.id === currentVendor)
      .flatMap((e) => e.models)
      .find((m) => m.id === currentModel)?.name ?? currentModel

  // 浮层往上开：composer 在窗口底部，往下开会掉到窗口外面。
  // 用触发按钮的位置算，而不是 CSS anchor —— anchor 在 jsdom 里没有，
  // 而这点算术两边都能跑。
  //
  // 存进 state 而不是在 render 里直接 getBoundingClientRect()：那样读的是
  // **上一帧**的 ref —— 首帧 triggerRef.current 还是 null（ref 要等 DOM 挂载
  // 之后才有值），style 里就一个坐标都没有，浮层退回 UA 的居中。
  // 在 layout effect 里量、量完再落到 style 上，才保证首次打开就在对的位置。
  const [pos, setPos] = useState<{ left: string; bottom: string } | null>(null)
  // 不按 open 门控：layout effect 本来就是挂载之后才跑，那时候 ref 已经有值了，
  // 不用等 open 变 true。依赖 open 只是为了「每次开合都重新量一次」——
  // 折叠侧栏之类的操作会挪动触发按钮，重开一次就该用新位置。
  useLayoutEffect(() => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    // bottom 而不是 top：往上开。+6 是和触发按钮之间的间隙。
    setPos({ left: `${r.left}px`, bottom: `${window.innerHeight - r.top + 6}px` })
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="模型"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        // ghost：composer 那行不该出现第三个有底的控件（已经有发送键了）。
        // h-6 而不是 h-7：这一行只有 ~26px 高，默认尺寸会顶开它。
        className="flex h-6 max-w-[190px] shrink-0 cursor-pointer items-center gap-1 rounded-chip border-none bg-transparent px-1.5 text-[11.5px] text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
      >
        <span className="truncate">{currentName || '选择模型'}</span>
        <Icon name="chevron" size={10} strokeWidth={1.8} className="flex-none" />
      </button>

      <div
        ref={ref}
        popover="auto"
        role="listbox"
        aria-label="模型"
        id={id}
        // margin / top / right 三个都在对付 UA 样式里的
        // `[popover] { inset: 0; margin: auto; width/height: fit-content }`：
        //
        //   • auto margin 会把浮层推离我们指定的坐标
        //   • top:0 留着就是过约束 —— top / bottom / height 三个都非 auto 时
        //     CSS 会丢掉 bottom 保留 top，浮层被钉在**视口顶端**。这就是
        //     「模型浮层跑到窗口最上面去了」那个 bug 的全部原因：place() 设的
        //     是 bottom，而 bottom 正是被丢掉的那一个。
        //   • right:0 同理（我们设 left），顺手一起让开。
        //
        // 放在 place() 外面而不是里面：place() 只回答「开在哪」，这三个是
        // 把平台默认值让开，跟触发按钮的位置无关。
        style={{ margin: 0, top: 'auto', right: 'auto', ...pos }}
        // 规格和右键菜单同一套（overlay 底 + line_strong 边 + card 圆角），
        // 这样应用里所有浮层是一个语言。
        className="fixed max-h-[320px] min-w-[200px] flex-col overflow-y-auto rounded-card border border-line-strong bg-overlay p-1 text-[12px] shadow-overlay open:flex"
      >
        {catalog.map((entry, gi) => (
          <div key={entry.id} className="contents">
            {/* ## 一级（厂商）和二级（模型）怎么分开
                上一版是「11px semibold ink-3 的组头 + 12px ink-2 的模型行」，
                两级长得几乎一样。字号和颜色在这里都靠不住：
                ink-2(#a5a8ad) 和 ink-3(#9a9da3) 差不到一档，
                11px 和 12px 在这个尺寸下也看不出来。

                所以换成三个跟字色无关的信号，任何一个单独都够用：
                  ① 组与组之间一条出血分隔线（结构分隔，最强）
                  ② 模型行比组头缩进 6px（层级用位置表达）
                  ③ 组头吸顶（滚动时一直在场）
                CJK 厂商名（「月之暗面 Kimi」）让 uppercase 用不上 ——
                它只作用于拉丁部分，混排出来「ANTHROPIC」和「智谱 GLM」
                两种形状，比不做更乱。 */}
            {gi > 0 && <div className="-mx-1 my-1 h-px flex-none bg-line" />}
            {/* 吸顶：九家三十多个模型装在 320px 的滚动区里，滚到中间就不知道
                自己在哪一家了。-mx-1 px-3 是为了让它的底色铺到浮层边缘 ——
                浮层有 4px padding，不出血的话行会从组头两侧的缝里透出来。
                px-3 抵掉那 4px 之后文字仍和不缩进时对齐。 */}
            <div className="sticky top-0 z-10 -mx-1 flex h-[22px] flex-none items-center bg-overlay px-3 text-[10.5px] font-semibold tracking-[0.09em] text-ink-3">
              {entry.name}
            </div>
            {entry.models.map((m) => {
              const isCurrent = entry.id === currentVendor && m.id === currentModel
              return (
                <button
                  key={`${entry.id}/${m.id}`}
                  type="button"
                  role="option"
                  aria-selected={isCurrent}
                  onClick={() => {
                    setOpen(false)
                    onPick(entry.id, m.id)
                  }}
                  // 当前项：accent-tint 底 + 勾。两种编码互相兜底 ——
                  // 底色在扫视时先被看到，勾在对比度不足时仍然可辨。
                  // pl-3.5 而不是 px-2：比组头缩进 6px，层级用位置表达。
                  // 缩的是 padding 不是 margin —— 选中态的底色要铺满浮层宽度
                  className={`flex h-[26px] flex-none cursor-pointer items-center justify-between gap-2 rounded-chip border-none pr-2 pl-3.5 text-left text-[12px] transition-colors duration-100 ${
                    isCurrent
                      ? 'bg-accent-tint text-ink'
                      : 'bg-transparent text-ink-2 hover:bg-overlay-hover hover:text-ink'
                  }`}
                >
                  <span className="truncate">{m.name}</span>
                  {isCurrent && (
                    <Icon name="check" size={11} strokeWidth={2.2} className="flex-none text-accent-ink" />
                  )}
                </button>
              )
            })}
          </div>
        ))}
        {catalog.length === 0 && (
          <div className="px-2 py-1.5 text-[11.5px] text-ink-3">
            还没配任何模型 —— 去设置里填一把 API Key。
          </div>
        )}
      </div>
    </>
  )
}
