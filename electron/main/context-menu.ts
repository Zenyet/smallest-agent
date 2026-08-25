// 右键菜单的「内容」——纯数据，不碰 electron。
//
// 为什么拆出来：菜单该有哪几项、文案怎么写、哪一项是破坏性操作，这些是会变的产品决定，
// 值得单测；而渲染那一下（现在是 renderer 自绘的浮层）不该跟内容混在一起。
//
// ## 为什么从原生菜单换成了自绘
//
// 原来这里用的是 Menu.popup()。原生菜单白给贴边翻转、Esc、点击别处关闭，
// 以及跟系统一致的外观 —— 但它的间距、行高、圆角、底色全由 AppKit 画，
// CSS 碰不到，所以跟这套设计 token 对不上（gpui 侧同样为此自绘了一份，
// 见 rs/ui/src/context_menu.rs 的文件头）。
//
// 换掉之后那些「白给」的东西并没有全丢：Web 的 popover 属性自带 light
// dismiss（点外面 / Esc 自动关）和 top layer，CSS anchor positioning 管贴边
// 翻转。真正要自己补的只有方向键遍历和 role 语义，见 ContextMenu.tsx。
//
// 代价是丢了 VoiceOver 对系统菜单的原生支持 —— 这是这次换法的实际损失。

export type ContextTarget =
  | { kind: 'session'; id: string; title: string }
  | { kind: 'project'; id: string; name: string }

export interface MenuItemSpec {
  label: string
  /** 回传给 renderer 的动作标识 */
  action: 'delete-session' | 'remove-project' | 'rename-session'
  /** 画成红色（renderer 侧用 text-red） */
  destructive?: boolean
}

// 会话：重命名 + 删除。项目：只有移除（且不动它下面的会话——这点必须在文案里说清，
// 否则「移除项目」听起来像会连着对话一起删）。
//
// 重命名排在删除前面：它是更常用的动作，而且删除放在最后能减少误点
// （菜单弹出时指针在顶部）。顺序和文案跟 gpui 侧的 sidebar.rs 一致。
export function menuFor(target: ContextTarget): MenuItemSpec[] {
  if (target.kind === 'session') {
    return [
      { label: '重命名', action: 'rename-session' },
      { label: '删除会话', action: 'delete-session', destructive: true },
    ]
  }
  return [{ label: '移除项目（保留其中的对话）', action: 'remove-project', destructive: true }]
}
