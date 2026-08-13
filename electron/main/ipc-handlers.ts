// 唯一允许 import electron 的两个文件之一（另一个是 index.ts）。
// 这里只做「接线」：把纯模块拼起来挂到 ipcMain 上，不放业务逻辑 ——
// 业务逻辑都在能被 vitest 直接测的纯模块里。
import { ipcMain, type BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CH } from '../shared/channels'
import { buildEnv } from './config-env'
import { getSettings, saveSettings } from './settings-store'
import { validateSettingsPatch } from './settings-validate'
import { createAgentRunner, makeDefaultRunnerDeps, type AgentEmitter } from './agent-runner'
import { listSessions, deleteSession, newSessionId } from './sessions'
import type { ApprovalGate } from './approval'
import { loadConfig } from '../../src/config'
import { createJsonSessionStore } from '../../src/memory/store'
import type { AgentRuntime } from './agent-runtime'
import type { UserPaths } from './config-env'
import {
  detectClaudeConfig,
  detectCodexConfig,
  detectGeminiConfig,
  extractClaudeSecret,
  extractCodexSecret,
  type ProviderDetection,
} from './provider-detect'

export function setupIpcHandlers(
  win: BrowserWindow,
  runtime: AgentRuntime,
  paths: UserPaths,
  gate: ApprovalGate,
  isRestarting: () => boolean,
): { runningSessionId: () => string | null } {
  const send = (channel: string) => (payload: unknown) => {
    // 窗口可能已被关闭，发送前检查，避免 "Object has been destroyed"
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }

  const emit: AgentEmitter = {
    chunk: send(CH.messageChunk),
    toolCall: send(CH.toolCall),
    complete: send(CH.messageComplete),
    verdict: send(CH.verdict),
    cacheHit: send(CH.cacheHit),
    error: send(CH.error),
    approvalRequest: send(CH.approvalRequest),
  }

  const readConfig = () => loadConfig(buildEnv(process.env, getSettings(), paths))
  const runner = createAgentRunner(makeDefaultRunnerDeps(runtime.registry, emit, readConfig, gate))

  ipcMain.handle(CH.sendMessage, (_e, sessionId: string, message: string) => {
    // 重启过程中拒绝新工作：防止 restartApp 的守卫检查通过后、app.quit() 的
    // before-quit 事件循环间隙里到达的 sendMessage 启动新 turn——那会孤儿化该 turn。
    if (isRestarting()) {
      throw new Error('应用正在重启，无法处理新消息')
    }
    return runner.run(sessionId, message)
  })
  ipcMain.handle(CH.getSettings, () => getSettings())
  ipcMain.handle(CH.saveSettings, (_e, raw: unknown) => {
    const { valid, dropped } = validateSettingsPatch(raw)
    if (dropped.length > 0) {
      console.warn(`[settings] 跳过了未知的配置项: ${dropped.join(', ')}`)
    }
    return saveSettings(valid)
  })

  ipcMain.handle(CH.listSessions, () => listSessions(paths.sessionsDir))

  // 重新挂载（比如手动 reload）后，renderer 要能一次性问出"现在谁在跑、
  // 哪些审批还悬着"——这两样事实活在这个模块级的 runner/gate 里，进程没重启
  // 就一直存在，不该只靠事件推送（推送只有"当时在场"才能收到）。
  ipcMain.handle(CH.getRunnerSnapshot, () => ({
    runningSessionId: runner.runningSessionId(),
    pendingApprovals: gate.pending(),
  }))

  // 新建会话不落盘：空会话没有内容可存，等第一条消息 onComplete 时自然创建文件。
  // 副作用是新会话在列表里要等第一次回答完才出现 —— 前端用乐观更新补上。
  ipcMain.handle(CH.createSession, () => newSessionId(Date.now()))

  ipcMain.handle(CH.deleteSession, (_e, id: string) => {
    // 正在被 agent 处理的会话不能删：src/ 冻结，runAgent 没有真正的取消机制，
    // 硬删文件之后 onComplete 的 sessions.save() 还是会照常写回去（src/memory/store.ts
    // 的 save() 不检查会话是否"应该还存在"），下一次任何会话的 onMessageComplete
    // 触发 listSessions() 刷新，这个"删掉的"会话就会带着新写的文件重新出现在侧栏——
    // 删除等于白删。与其伪造一个假删除，不如直接拒绝并说清楚理由，等它跑完再删。
    if (runner.runningSessionId() === id) {
      throw new Error('该会话正在处理中，暂时无法删除。请等待它跑完（如果卡在审批上，去把那个操作拒绝掉），再重试删除。')
    }
    // 会话被删了，它名下悬着的审批请求也失去意义——不取消的话会占着串行锁直到超时。
    // （到这里时按上面的检查，这个 sessionId 不可能是正在运行的那个，
    // pending() 里也不会有它的条目，这行调用是防御性的，保持幂等无害。）
    gate.cancelSession(id)
    return deleteSession(paths.sessionsDir, id)
  })

  ipcMain.handle(CH.loadSession, (_e, id: string) => createJsonSessionStore(paths.sessionsDir).load(id))

  ipcMain.handle(CH.approvalResponse, (_e, requestId: string, decision: 'allow' | 'deny') =>
    gate.resolve(requestId, decision),
  )

  // Provider detection（第一阶段）：只报告存在性和可用性，不返回密钥。
  // ⚠️ 永远不 log 返回值——虽然这里还没密钥，但养成习惯。
  ipcMain.handle(CH.detectProviders, async () => {
    const home = homedir()
    const detections: ProviderDetection[] = []

    // 读取文件内容。任何一个失败都不影响其它的探测。
    const readSafe = async (path: string): Promise<string | null> => {
      try {
        return await readFile(path, 'utf-8')
      } catch {
        return null
      }
    }

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
    const readSafe = async (path: string): Promise<string | null> => {
      try {
        return await readFile(path, 'utf-8')
      } catch {
        return null
      }
    }

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

  return { runningSessionId: () => runner.runningSessionId() }
}

