// 右键菜单的「内容」——纯数据，不碰 electron。
//
// 为什么拆出来：菜单该有哪几项、文案怎么写、哪一项是破坏性操作，这些是会变的产品决定，
// 值得单测；而 Menu.popup() 那一下是 electron 的 API，vitest 在纯 Node 里加载不了。
// 所以这里只产出模板数据，ipc-handlers.ts 拿着它去构造真正的菜单。
//
// 为什么用原生菜单而不是自己画一个 HTML 浮层：原生免费拿到贴边时的自动翻转、
// Esc 和点击别处关闭、以及跟系统一致的字号和高亮色。自绘的话这些都要重做一遍，
// 而且在 macOS 上很容易一眼看出「这是网页做的」。

export type ContextTarget =
  | { kind: 'session'; id: string; title: string }
  | { kind: 'project'; id: string; name: string }

export interface MenuItemSpec {
  label: string
  /** 回传给 renderer 的动作标识 */
  action: 'delete-session' | 'remove-project'
  /** macOS/Windows 上会把这类项画成红色 */
  destructive?: boolean
}

// 会话：只有删除。项目：只有移除（且不动它下面的会话——这点必须在文案里说清，
// 否则「移除项目」听起来像会连着对话一起删）。
export function menuFor(target: ContextTarget): MenuItemSpec[] {
  if (target.kind === 'session') {
    return [{ label: '删除会话', action: 'delete-session', destructive: true }]
  }
  return [{ label: '移除项目（保留其中的对话）', action: 'remove-project', destructive: true }]
}
