// 应用菜单模板。纯模块，不 import electron —— index.ts 负责把它交给
// Menu.buildFromTemplate。这样「⌘, 挂在哪个菜单项上、加速键写对没写对」
// 这件事能被 vitest 直接断言，而不是只能靠手动开一次应用来验证。
//
// 为什么用菜单加速键而不是 globalShortcut：globalShortcut 是系统级的，
// 会把 ⌘, 从别的应用手里抢走（用户在浏览器里按 ⌘, 会打开我们的设置窗口），
// 这是 Electron 文档明确点出的滥用。菜单项的 accelerator 只在本应用聚焦时生效，
// 正是 macOS 上「⌘, 打开偏好设置」的原生做法。

// 只描述我们用到的那几个字段。Electron 的 MenuItemConstructorOptions 结构上兼容
// 这个形状（index.ts 那边直接传过去），但这里不 import 它，保持本模块零 electron 依赖。
export interface MenuTemplateItem {
  label?: string
  role?: string
  accelerator?: string
  click?: () => void
  submenu?: MenuTemplateItem[]
  type?: 'separator'
}

// macOS 的第一个菜单是应用名菜单，「设置…」按平台惯例排在「关于」下面、
// 「服务」上面。Windows/Linux 没有这个菜单，⌘, 也不是那两个平台的惯例，
// 所以设置项挂到「文件」菜单下，加速键用 Ctrl+,。
export function buildMenuTemplate(input: {
  platform: NodeJS.Platform
  appName: string
  onOpenSettings: () => void
}): MenuTemplateItem[] {
  const { platform, appName, onOpenSettings } = input
  const isMac = platform === 'darwin'

  const settingsItem: MenuTemplateItem = {
    label: '设置…',
    accelerator: isMac ? 'Command+,' : 'Control+,',
    click: onOpenSettings,
  }

  const template: MenuTemplateItem[] = []

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        settingsItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }

  template.push({
    label: '文件',
    submenu: isMac ? [{ role: 'close' }] : [settingsItem, { type: 'separator' }, { role: 'quit' }],
  })

  // 编辑菜单不是装饰：不给的话 macOS 上连 ⌘C/⌘V/⌘A 都不能用（Electron 的
  // 复制粘贴走的是菜单 role，没有菜单就没有默认加速键），设置窗口里那些
  // 输入框会变成粘不进 API key 的死框。
  template.push({
    label: '编辑',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  })

  template.push({
    label: '视图',
    submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
  })

  template.push({
    label: '窗口',
    submenu: isMac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'close' }],
  })

  return template
}

// 测试和 index.ts 共用：从模板里按加速键找出那个菜单项。
// index.ts 不需要它，但让测试能不依赖菜单结构的具体嵌套层数去断言。
export function findByAccelerator(
  template: MenuTemplateItem[],
  accelerator: string,
): MenuTemplateItem | undefined {
  for (const item of template) {
    if (item.accelerator === accelerator) return item
    if (item.submenu) {
      const found = findByAccelerator(item.submenu, accelerator)
      if (found) return found
    }
  }
  return undefined
}
