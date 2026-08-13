// 本项目唯一的图标出口。规范见 .claude/skills/icons/SKILL.md —— 简述：
//   24×24 viewBox / fill=none / stroke=currentColor / 圆头圆角 / 尺寸跟字号。
// 不用 emoji 当图标：跨平台画风不一致、尺寸基线不受控、颜色继承不了 currentColor，
// 和一套线性图标放一起永远像贴上去的。设计语言取自 beautifului.dev，
// 那个站 45 个图标零 emoji、全手绘 inline SVG，我们照做。
//
// 加图标就往下面的 PATHS 里加一条路径，不要在组件里散写 <svg>。
import type { ReactNode } from 'react'

// 只存路径，<svg> 外壳统一在下面渲染一次 —— 避免属性在各处漂移。
// 路径都在 24×24 网格里画。
const PATHS: Record<string, ReactNode> = {
  // 工具调用：扳手
  tool: (
    <path d="M14.7 6.3a4 4 0 0 0 5 5L21 21H3l1.3-9.7a4 4 0 0 0 5-5L7 4l2-2 2.5 2.5L14 2l2 2z" />
  ),

  // 警告 / 工具失败：三角内叹号
  warn: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),

  // 核查通过：圆内对勾
  verified: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </>
  ),

  // 裸对勾（步骤已完成）
  check: <path d="M4 12.5l5 5L20 6.5" />,

  // 错误 / 拒绝：圆内叉
  error: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),

  // 关闭 / 删除：叉
  close: <path d="M5 5l14 14M19 5L5 19" />,

  // 新建：加号
  plus: <path d="M12 5v14M5 12h14" />,

  // 设置：齿轮（简化成六向齿 + 中心圆，13px 下细齿会糊）
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2v3M12 19v3M4.2 6.5l2.6 1.5M17.2 16l2.6 1.5M4.2 17.5l2.6-1.5M17.2 8l2.6-1.5" />
    </>
  ),

  // 折叠展开：朝下的角标。收起状态由调用方旋转 -90deg（那个站的做法）
  chevron: <path d="M6 9l6 6 6-6" />,

  // 缓存命中：闪电
  cache: <path d="M13 2 4 14h6l-1 8 9-12h-6z" />,

  // 来源 / 文档
  doc: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </>
  ),

  // 进行中的步骤：实心圆点（唯一的实心图标，见下面 SOLID）
  dot: <circle cx="12" cy="12" r="5" />,

  // 未开始的步骤：空心圆
  circle: <circle cx="12" cy="12" r="5" />,

  // 思考中：星芒（实心更清楚）
  think: <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />,

  // 搜索：放大镜（快速搜索框、检索来源）
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>
  ),

  // 重试：环形箭头
  retry: <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />,

  // 前一个 / 后一个：< >（分页器）
  prev: <path d="M15 18l-6-6 6-6" />,
  next: <path d="M9 6l6 6-6 6" />,

  // 发送：向上箭头（作为按钮图标，非文字）
  send: <path d="M12 19V5M5 12l7-7 7 7" />,

  // 复制
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2.5" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
}

// 实心图标：这两个用描边画出来在 12-13px 下会糊成一团，填充更清楚。
// 整套里就这么两个例外，别扩散。
const SOLID = new Set(['dot', 'think'])

export type IconName = keyof typeof PATHS

export function Icon({
  name,
  size = 13,
  className,
  rotated = false,
  strokeWidth,
}: {
  name: IconName
  /** px。跟着旁边的字号走：正文 13 用 13，次要 12 用 12，密集行 11.5 用 11。
   *  图标比旁边的字大就会显脏。 */
  size?: number
  className?: string
  /** chevron 收起状态用：旋转 -90deg。带过渡，展开/收起有动画。 */
  rotated?: boolean
  /** stroke 宽度。默认 2.2（正文图标），导航图标用 1.8 更轻盈。 */
  strokeWidth?: number
}) {
  const solid = SOLID.has(name)
  return (
    <svg
      // aria-hidden：图标是装饰性的，语义由旁边的文字或按钮自己的 aria-label 承担
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      // stroke=currentColor 是关键：颜色由父元素的 text-* 决定，
      // 所以 text-ink-2 的行里图标自动是次要色、text-red 的错误行里自动变红。
      // 不要在这里写颜色值。
      fill={solid ? 'currentColor' : 'none'}
      stroke={solid ? 'none' : 'currentColor'}
      strokeWidth={strokeWidth ?? '2.2'}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 transition-transform duration-200 ${className ?? ''}`}
      style={rotated ? { transform: 'rotate(-90deg)' } : undefined}
    >
      {PATHS[name]}
    </svg>
  )
}
