// 唯一允许 import electron 的两个文件之一（另一个是 index.ts）。
// 这里只做「接线」：把纯模块拼起来挂到 ipcMain 上，不放业务逻辑 ——
// 业务逻辑都在能被 vitest 直接测的纯模块里。
import { dialog, ipcMain, type BrowserWindow } from 'electron'
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
import { forgetSessionTitle, getSessionTitles, setSessionTitle } from './session-titles-store'
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
    cancelled: send(CH.cancelled),
  }

  const readConfig = () => loadConfig(buildEnv(process.env, getSettings(), paths))
  const runner = createAgentRunner(makeDefaultRunnerDeps(runtime.registry, emit, readConfig, gate))

  // 停止正在跑的那一轮。返回「有没有受理」——目标没在跑就是 false，不抛错。
  // 受理不等于已停：取消是轮边界的，真停下来时会推 cancelled 事件。
  ipcMain.handle(CH.cancelMessage, (_e, sessionId: string) => {
    const accepted = runner.cancel(sessionId)
    // 卡在审批上的那一轮，光置取消标志没用：它停在 gate 里等一个决定，
    // 根本走不到下一个轮边界去看那个标志，于是要悬到 5 分钟超时才结算
    // （approval.ts 的 DEFAULT_TIMEOUT_MS）—— 用户点了停止却什么都不发生。
    //
    // 所以把它名下悬着的审批一并结算掉（fail-closed 成拒绝）。工具拿到
    // {denied:true} 返回、那一轮推进到下一个轮边界，就看见取消了。
    // 对没有悬着审批的会话是空操作，幂等。
    if (accepted) gate.cancelSession(sessionId)
    return accepted
  })

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
  // 标题同理：listSessions 给的是从第一条消息推出来的默认标题，用户改过的名字
  // 存在 electron-store 里（session-titles.ts）。在这里覆盖一次，理由和项目
  // 映射一样 —— 让「这个会话叫什么」只有一个真相来源。
  ipcMain.handle(CH.listSessions, async () => {
    const metas = decorateSessions(await listSessions(paths.sessionsDir), getProjectsState())
    const titles = getSessionTitles()
    return metas.map((m) => (titles[m.id] ? { ...m, title: titles[m.id] } : m))
  })

  ipcMain.handle(CH.getSessionTitles, () => getSessionTitles())

  // 改名。空字符串 = 恢复自动推导的标题（见 session-titles.ts 的 setSessionTitle）。
  ipcMain.handle(CH.renameSession, (_e, id: string, title: string) => setSessionTitle(id, title))

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

  // 右键菜单。菜单内容来自纯模块 menuFor（可单测），这里只把它交给 renderer。
  //
  // 原来这里是 Menu.popup()：主进程弹原生菜单、等用户选、把动作回传。现在改成
  // renderer 自绘（components/ContextMenu.tsx），原因是原生菜单的外观由 AppKit
  // 画、CSS 碰不到，跟这套设计 token 对不上 —— 见 context-menu.ts 的文件头。
  //
  // 保留这个 IPC 而不是让 renderer 直接 import menuFor：菜单里有哪几项是产品
  // 决定，留在主进程这一侧，将来要按平台或设置调整时只改一处。
  ipcMain.handle(CH.showContextMenu, (_e, target: ContextTarget) => menuFor(target))

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

  ipcMain.handle(CH.deleteSession, async (_e, id: string) => {
    // 正在跑的会话：先停掉再删，不再拒绝用户。
    //
    // 原来这里是抛错（DELETE_BLOCKED），理由是「src/ 冻结，runAgent 没有真正的
    // 取消机制，硬删文件之后 onComplete 的 sessions.save() 还是会照常写回去
    // （src/memory/store.ts 的 save() 不检查会话是否'应该还存在'），于是那个
    // '删掉的'会话会带着新写的文件重新出现在侧栏」。
    //
    // 现在有取消了（main/cancel.ts）。但**顺序不能反**：取消路径上同样会
    // sessions.save()，先删文件的话存盘后落地、会话照样复活。所以要
    // 取消 → 等它彻底停下（含那次存盘）→ 才删。
    //
    // rs 侧撞过同一个坑，用 200ms 定时器兜（ui/src/chat.rs 的注释说明了
    // 为什么不做严格的完成信号：要给 bridge 加一条反向通路，为一个删除时序
    // 不值）。这边不用猜时间 —— runner 就在主进程内，settled() 给的是
    // 那一轮真正的 promise。
    if (runner.runningSessionId() === id) {
      runner.cancel(id)
      // 卡在审批上的话，那一轮停在 gate 里等决定，settled() 会一直悬着。
      // 先把它名下的审批取消掉（fail-closed 结算成拒绝），那一轮才能推进到
      // 下一个轮边界看见取消标志。
      gate.cancelSession(id)
      await runner.settled()
    }
    // 会话被删了，它名下悬着的审批请求也失去意义——不取消的话会占着串行锁直到超时。
    // 上面那个分支里已经调过一次，这里对没在跑的会话兜底；幂等，重复调用无害。
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
    // 标题覆盖同理：会话没了它就是垃圾数据。理由见 session-titles.ts 的
    // forgetSessionTitle —— 不清的话会越攒越多，而且 id 万一重合会让新会话
    // 莫名带上一个旧名字。
    forgetSessionTitle(id)
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

