// 唯一允许 import electron 的两个文件之一（另一个是 index.ts）。
// 这里只做「接线」：把纯模块拼起来挂到 ipcMain 上，不放业务逻辑 ——
// 业务逻辑都在能被 vitest 直接测的纯模块里。
import { dialog, ipcMain, Menu, type BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CH } from '../shared/channels'
import { buildEnv } from './config-env'
import { getSettings, saveSettings } from './settings-store'
import { validateSettingsPatch } from './settings-validate'
import { menuFor, type ContextTarget } from './context-menu'
import { createAgentRunner, makeDefaultRunnerDeps, type AgentEmitter } from './agent-runner'
import { listSessions, deleteSession, newSessionId } from './sessions'
import { getProjectsState, setProjectsState } from './projects-store'
import {
  addProject,
  assignSession,
  decorateSessions,
  forgetSession,
  newProjectId,
  removeProject,
  toggleCollapsed,
} from './projects'
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

// 广播给所有窗口。index.ts 传进来（那边才有 BrowserWindow.getAllWindows()），
// 这个模块不去自己找别的窗口 —— 保持它只认「一个主窗口 + 一个广播函数」。
export type Broadcast = (channel: string, payload: unknown) => void

export function setupIpcHandlers(
  win: BrowserWindow,
  runtime: AgentRuntime,
  paths: UserPaths,
  gate: ApprovalGate,
  isRestarting: () => boolean,
  broadcast: Broadcast,
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
    const next = saveSettings(valid)
    // 广播给所有窗口，不只回给发起这次 invoke 的那个。设置搬进独立窗口之后，
    // 写设置的（设置窗口）和用设置的（主窗口）不再是同一个 renderer ——
    // 「谁写的谁知道」不够了。⚠️ next 里含明文 API Key，永远不要 log 它。
    broadcast(CH.settingsChanged, next)
    return next
  })

  // 会话列表带上项目归属：listSessions 只认磁盘上的会话文件（它不知道项目这回事），
  // 映射活在 electron-store 里，在这里合成一次，让「某个会话属于哪个项目」
  // 只有一个真相来源，而不是让 renderer 自己拿两份数据去对。
  ipcMain.handle(CH.listSessions, async () =>
    decorateSessions(await listSessions(paths.sessionsDir), getProjectsState()),
  )

  // --- 项目分组 ---
  // 每个写操作都返回写完之后的完整状态，并广播同一份出去：renderer 不自己推算
  // 下一个状态（那样两个窗口会各推算一份，迟早分叉）。
  const commitProjects = (next: ReturnType<typeof getProjectsState>) => {
    const saved = setProjectsState(next)
    broadcast(CH.projectsChanged, saved)
    return saved
  }

  ipcMain.handle(CH.getProjects, () => getProjectsState())

  // 添加项目 = 选一个本地目录。用系统原生的目录选择器（不是让用户手打路径）：
  // 打错一个字就是个不存在的目录，而原生选择器只能选到真实存在的东西。
  // 挂在主窗口上（第一个参数）让它在 macOS 上是 sheet 而不是游离的窗口。
  ipcMain.handle(CH.addProject, async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择项目目录',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '添加',
    })
    // 用户取消：返回 null 而不是抛错。取消不是失败，renderer 那边只要原样不动。
    if (result.canceled || result.filePaths.length === 0) return null

    const dir = result.filePaths[0]
    // addProject 对已存在的目录是幂等的（返回原来那个项目），所以重复选同一个
    // 目录不会长出第二个同名项目 —— 原生选择器每次从头开始，用户很容易重复选。
    const { state, project } = addProject(getProjectsState(), {
      dir,
      id: newProjectId(Date.now()),
      createdAt: Date.now(),
    })
    return { state: commitProjects(state), project }
  })

  ipcMain.handle(CH.removeProject, (_e, id: string) => commitProjects(removeProject(getProjectsState(), id)))

  // 右键菜单。菜单内容来自纯模块 menuFor（可单测），这里只负责弹和等结果。
  // popup 的回调式 API 包成 Promise：调用方（renderer 的右键处理）就在等这一个答案，
  // 用户按 Esc 关掉菜单时 popup 直接结束、谁都没点，那就 resolve(null)。
  ipcMain.handle(CH.showContextMenu, async (_e, target: ContextTarget) => {
    const specs = menuFor(target)
    return await new Promise<string | null>((resolve) => {
      let picked: string | null = null
      const menu = Menu.buildFromTemplate(
        specs.map((spec) => ({
          label: spec.label,
          // macOS 会把 role 或 sublabel 之外的破坏性语义画成红色的能力有限，
          // Electron 没有跨平台的 destructive 标记，所以这里不假装有 ——
          // 文案本身（「删除」「移除」）已经把后果说清楚了。
          click: () => {
            picked = spec.action
          },
        })),
      )
      // closed 一定会触发（选了项也会），所以在它里面 resolve 能同时覆盖
      // 「选了」和「按 Esc 取消」两种收尾，不需要两处各写一遍。
      menu.popup({
        window: win,
        callback: () => resolve(picked),
      })
    })
  })

  ipcMain.handle(CH.assignSession, (_e, sessionId: string, projectId: string | null) =>
    commitProjects(assignSession(getProjectsState(), sessionId, projectId)),
  )

  ipcMain.handle(CH.toggleProjectCollapsed, (_e, id: string) =>
    commitProjects(toggleCollapsed(getProjectsState(), id)),
  )

  // 重新挂载（比如手动 reload）后，renderer 要能一次性问出"现在谁在跑、
  // 哪些审批还悬着"——这两样事实活在这个模块级的 runner/gate 里，进程没重启
  // 就一直存在，不该只靠事件推送（推送只有"当时在场"才能收到）。
  ipcMain.handle(CH.getRunnerSnapshot, () => ({
    runningSessionId: runner.runningSessionId(),
    pendingApprovals: gate.pending(),
  }))

  // 新建会话不落盘：空会话没有内容可存，等第一条消息 onComplete 时自然创建文件。
  // 副作用是新会话在列表里要等第一次回答完才出现 —— 前端用乐观更新补上。
  //
  // projectId：新会话落在当前选中的项目下（renderer 传它当前选中的那个）。
  // 项目映射存在 electron-store 里而不是会话文件里，所以这里就能定下来，
  // 不用等文件落盘 —— 这也是它必须走 Electron 层持久化的原因之一。
  ipcMain.handle(CH.createSession, (_e, projectId?: string | null) => {
    const id = newSessionId(Date.now())
    if (projectId) {
      // assignSession 会自己挡掉指向不存在项目的 id（当 null 处理），
      // 所以这里不用再查一遍项目是否还在。
      commitProjects(assignSession(getProjectsState(), id, projectId))
    }
    return id
  })

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
    // 会话删了，它的项目映射也是垃圾了。不清的话会在 electron-store 里越攒越多，
    // 而且将来某个新会话万一拿到同样的 id（进程内的计数器保证不会，但跨重启
    // 时间戳可能重合）会莫名出现在一个它从没被放进去过的项目下。
    // forgetSession 对不存在的 sessionId 原样返回同一个对象，所以用引用比较
    // 就能跳过「这个会话本来就没分组」的常见情况，不必每次删会话都写一次盘、
    // 广播一次没有变化的状态。注意 before 必须只读一次 —— getProjectsState()
    // 每次调用都会 normalize 出一个新对象，拿它跟自己比永远不相等。
    const before = getProjectsState()
    const after = forgetSession(before, id)
    if (after !== before) commitProjects(after)
    return deleteSession(paths.sessionsDir, id)
  })

  ipcMain.handle(CH.loadSession, (_e, id: string) => createJsonSessionStore(paths.sessionsDir).load(id))

  ipcMain.handle(CH.approvalResponse, (_e, requestId: string, decision: 'allow' | 'deny') =>
    gate.resolve(requestId, decision),
  )

  setupProviderHandlers()

  return { runningSessionId: () => runner.runningSessionId() }
}

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

