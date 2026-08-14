import { describe, it, expect } from 'vitest'
import { buildMenuTemplate, findByAccelerator } from '../../electron/main/app-menu'

const build = (platform: NodeJS.Platform, onOpenSettings = () => {}) =>
  buildMenuTemplate({ platform, appName: 'Smallest Agent', onOpenSettings })

describe('buildMenuTemplate', () => {
  it('macOS 上 ⌘, 挂在菜单项上（原生做法，不是网页内监听）', () => {
    const item = findByAccelerator(build('darwin'), 'Command+,')
    expect(item).toBeTruthy()
    expect(item?.label).toBe('设置…')
  })

  it('Windows/Linux 上用 Ctrl+,（⌘ 在那两个平台不存在）', () => {
    const template = build('win32')
    expect(findByAccelerator(template, 'Command+,')).toBeUndefined()
    expect(findByAccelerator(template, 'Control+,')?.label).toBe('设置…')
  })

  it('点设置项调 onOpenSettings', () => {
    let opened = 0
    const item = findByAccelerator(build('darwin', () => opened++), 'Command+,')
    item?.click?.()
    expect(opened).toBe(1)
  })

  it('macOS 上第一个菜单是应用名菜单，设置项在它下面（系统惯例）', () => {
    const template = build('darwin')
    expect(template[0].label).toBe('Smallest Agent')
    expect(template[0].submenu?.some((i) => i.label === '设置…')).toBe(true)
  })

  it('Windows/Linux 上设置项挂在「文件」下（那两个平台没有应用名菜单）', () => {
    const template = build('win32')
    const file = template.find((i) => i.label === '文件')
    expect(file?.submenu?.some((i) => i.label === '设置…')).toBe(true)
  })

  it('设置项只出现一次，不会两个菜单里各挂一个（⌘, 会打开两次或行为不定）', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const flat = JSON.stringify(build(platform))
      expect(flat.split('设置…').length - 1).toBe(1)
    }
  })

  it('带编辑菜单：没有它 macOS 上连 ⌘V 都不能用，设置窗口会变成粘不进 key 的死框', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const edit = build(platform).find((i) => i.label === '编辑')
      const roles = edit?.submenu?.map((i) => i.role)
      expect(roles).toContain('paste')
      expect(roles).toContain('copy')
      expect(roles).toContain('selectAll')
    }
  })
})
