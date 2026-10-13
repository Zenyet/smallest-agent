import { ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CH } from '../shared/channels'
import {
  detectClaudeConfig, detectCodexConfig, detectGeminiConfig,
  extractClaudeSecret, extractCodexSecret, type ProviderDetection,
} from './provider-detect'

// Provider 探测/导入单独成一个函数：启动失败路径（index.ts 的 catch）也要注册它们。
// 设置搬进独立窗口之后，启动失败时用户唯一的出路就是开设置改配置，而面板一挂载
// 就会调 detectProviders，「从 Claude Code 导入」往往是修好这次失败最快的办法 ——
// 那条路径上没有这两个 handler 的话，面板一打开就先吃一个 reject。
//
// 只依赖 homedir 和文件读取，不需要 runtime/paths/gate，所以能在两条路径上共用。

export function setupProviderHandlers(): void {
  // 读取文件内容。任何一个失败都不影响其它的探测。
  const readSafe = async (path: string): Promise<string | null> => {
    try {
      return await readFile(path, 'utf-8')
    } catch {
      return null
    }
  }

  // Provider detection（第一阶段）：只报告存在性和可用性，不返回密钥。
  // ⚠️ 永远不 log 返回值——虽然这里还没密钥，但养成习惯。
  ipcMain.handle(CH.detectProviders, async () => {
    const home = homedir()
    const detections: ProviderDetection[] = []

    const [claudeContent, codexAuthContent, codexConfigContent, geminiContent] = await Promise.all([
      readSafe(join(home, '.claude', 'settings.json')),
      readSafe(join(home, '.codex', 'auth.json')),
      readSafe(join(home, '.codex', 'config.toml')),
      readSafe(join(home, '.gemini', 'settings.json')),
    ])

    const claudeDetect = detectClaudeConfig(claudeContent)
    if (claudeDetect) detections.push(claudeDetect)

    const codexDetect = detectCodexConfig(codexAuthContent, codexConfigContent)
    if (codexDetect) detections.push(codexDetect)

    const geminiDetect = detectGeminiConfig(geminiContent)
    if (geminiDetect) detections.push(geminiDetect)

    return detections
  })

  // Provider import（第二阶段）：用户点击导入时才读密钥。
  // ⚠️ 安全：这个 handler 返回密钥，永远不 log 返回值或参数。
  ipcMain.handle(CH.importProvider, async (_e, provider: 'claude' | 'codex') => {
    const home = homedir()

    if (provider === 'claude') {
      const content = await readSafe(join(home, '.claude', 'settings.json'))
      return extractClaudeSecret(content)
    }

    if (provider === 'codex') {
      const [authContent, configContent] = await Promise.all([
        readSafe(join(home, '.codex', 'auth.json')),
        readSafe(join(home, '.codex', 'config.toml')),
      ])
      return extractCodexSecret(authContent, configContent)
    }

    return null
  })
}
