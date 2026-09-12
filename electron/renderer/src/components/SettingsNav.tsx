import { SettingsButton } from './settings/SettingsControls'
// ============================================================================
// SettingsNav.tsx —— 设置打开时的侧边栏
// ----------------------------------------------------------------------------
// 移植自 rs/ui/src/sidebar.rs 的 render_settings_nav。
//
// ## 为什么是「换掉侧边栏」而不是「设置自带一列导航」
//
// 上一版是后者：会话列表留在最左，设置面板在右栏里再长出自己的 160px 导航。
// 结果窗口里横着两列导航，加起来 384px 全是目录，真正的表单被挤到剩下的
// 空间里；而且用户在设置里的时候并不需要切会话。
//
// gpui 侧（跟着 waku）是整体换掉：侧边栏那一栏在设置打开时变成分区导航，
// 内容区变成表单。224px 只有一组导航，表单拿到整个内容区。
// 见 rs/ui/src/pane.rs 的文件头 —— 那里记着「224px 放不下两组导航」。
//
// ## 为什么不做成独立窗口（第一版是那样，用户明确否掉过）
//
// 单例/聚焦/重复打开/关闭时机全要自己管，两个窗口之间还要同步状态；
// macOS 上 ⌘, 开新窗口会切 Space，把用户正在看的对话挪走。
// 内嵌页面这些问题都不存在 —— 它就是同一棵树上的另一个分支。
// ============================================================================

import { Icon } from './Icon'
import { SECTIONS, type SectionId } from '../settings-fields'

export function SettingsNav({
  active,
  onSelect,
  onClose,
}: {
  active: SectionId
  onSelect: (id: SectionId) => void
  onClose: () => void
}) {
  return (
    // w-56 / border-r / bg-canvas / p-2 都照 SessionList 的外壳抄 ——
    // 这两个组件占的是同一个位置，换的时候那一栏的宽度和边框不该跳。
    <aside className="flex w-56 flex-none flex-col gap-1.5 border-r border-line bg-canvas p-2">
      {/* 红绿灯让位 + 窗口拖拽区。SessionList 顶上是同一条，同样的理由：
          红绿灯只在左上角，让侧边栏自己让位就够，不用整个 app 顶一条横条。 */}
      <div className="h-7 shrink-0 [-webkit-app-region:drag]" />

      {/* 返回：设置是个页面，得有出口。放在顶部而不是底部 ——
          「返回」是导航动作，和下面的分区列表是同一层级的东西。 */}
      <SettingsButton
        type="button"
        onClick={onClose}
        className="flex h-7 flex-none cursor-pointer items-center gap-1.5 rounded-control border-none bg-transparent px-2 text-left text-[12.5px] text-ink-2 transition-[color,background-color] duration-150 hover:bg-hover hover:text-ink"
      >
        <Icon name="back" size={13} strokeWidth={1.8} />
        <span className="flex-1">返回对话</span>
      </SettingsButton>

      {/* 组头。和 SessionList 里「项目」那条同一个规格（h-6 / 11px /
          semibold / ink-3），两栏切换时这一行不该跳。 */}
      <div className="mt-1 flex h-6 shrink-0 items-center px-2">
        <span className="text-[11px] font-semibold tracking-wide text-ink-3">设置</span>
      </div>

      <nav aria-label="设置分类" className="flex flex-1 flex-col gap-1 overflow-y-auto">
        {SECTIONS.map((section) => {
          const isActive = section.id === active
          return (
            <SettingsButton
              key={section.id}
              type="button"
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onSelect(section.id)}
              // 当前分区给底 + 提亮。这里的规则和会话行**不同**：会话行的
              // 选中态由右侧内容表达，所以那边 active 不给底、只有 hover；
              // 而分区导航的「我在哪一页」只有这一个地方能说。
              //
              // 底用 hover-2 而不是 surface —— surface 压在 canvas 上只差一点，
              // 扫一眼看不出自己在哪页（gpui 侧改过同一处）。
              className={`flex h-10 flex-none cursor-pointer items-center gap-2.5 rounded-control border-none px-3 text-left text-[13px] transition-[color,background-color] duration-150 ${
                isActive
                  ? 'bg-hover-2 font-medium text-ink'
                  : 'bg-transparent text-ink-2 hover:bg-hover hover:text-ink'
              }`}
            >
              <Icon name={section.icon} size={13} strokeWidth={1.8} />
              <span className="flex-1 truncate">{section.label}</span>
            </SettingsButton>
          )
        })}
      </nav>
    </aside>
  )
}
