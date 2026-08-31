import 'dotenv/config'
import { app, BrowserWindow, Menu, ipcMain } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CH } from '../shared/channels'
import { buildEnv } from './config-env'
import { getSettings, saveSettings } from './settings-store'
import { ownServerSpec } from './mcp-paths'
import { createFsToolsPool } from './fs-tools'
import { createRuntime, type AgentRuntime } from './agent-runtime'
import { setupIpcHandlers, setupProviderHandlers } from './ipc-handlers'
import { createApprovalGate } from './approval'
import { toErrorEvent } from './errors'
import { buildMenuTemplate } from './app-menu'
import { loadConfig } from '../../src/config'
import type { RuntimeStatusEvent } from '../shared/channels'

// ESM 主进程没有 __dirname，用 import.meta.url 还原（和 mcp-server.ts 同样的手法）
const here = dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

// 首次导航等待的上限：正常情况下（dev server / 本地文件）远用不到这么久，
// 这只是防止"从未 finish 也从未 fail"的极端情况把启动挂死。
const RENDERER_LOAD_TIMEOUT_MS = 15000

// 等 win 的首次导航"有个结果"——成功、失败、或等超时——三者谁先到就 resolve，
// 且只 resolve 一次。不管结果是什么都要放行：拿不到渲染进程也要让主进程的
// try/catch 跑起来，失败要在终端里看得见，而不是把整个启动卡死在这一步。
function waitForInitialLoad(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    if (!win.webContents.isLoading()) {
      resolve()
      return
    }

    let settled = false
    const settle = (reason: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      win.webContents.removeListener('did-finish-load', onFinish)
      win.webContents.removeListener('did-fail-load', onFail)
      if (reason !== 'finished') {
        console.error(`[startup] renderer 首次加载未正常完成（${reason}），主进程继续往下走`)
      }
      resolve()
    }

    const onFinish = () => settle('finished')
    // did-fail-load 在某些 Electron 版本里也会因为子资源（图片/脚本请求被中止等）
    // 触发，用 isMainFrame 过滤掉，避免一次无关的子资源 abort 误判成"首次导航失败"。
    const onFail = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      _validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame) return
      settle(`did-fail-load: ${errorCode} ${errorDescription}`)
    }

    win.webContents.once('did-finish-load', onFinish)
    win.webContents.on('did-fail-load', onFail)
    const timer = setTimeout(() => settle('timeout'), RENDERER_LOAD_TIMEOUT_MS)
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    // 跟 styles.css 的 --color-page 一致。窗口在 renderer 画出来之前先显示这个底色，
    // 不一致的话启动瞬间会闪一下别的颜色。（之前这里是 #05070C，是移植参考站
    // token 之前的旧调色板，一直没跟着改。）
    backgroundColor: '#17181a',
    // hiddenInset：去掉 macOS 那条白色原生标题栏，只留左上角三个圆点，
    // 标题栏区域交给我们自己画。不用 frame: false —— 那样连红绿灯按钮都没了，
    // 得自己实现关闭/最小化，代价远大于收益。
    titleBarStyle: 'hiddenInset',
    // Windows/Linux 上 titleBarStyle 无效，用 overlay 把系统按钮画成深色，
    // 免得深色界面顶上贴一条亮色控件条。
    titleBarOverlay: { color: '#17181a', symbolColor: '#a5a8ad', height: 36 },
    webPreferences: {
      preload: join(here, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 开发时连 vite dev server（热重载），生产时加载构建产物
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(join(here, '../renderer/index.html'))
  }
  return win
}


// 广播给所有窗口。设置改动必须走这条路而不是只回给发起 invoke 的那个窗口：
// 两个 renderer 之后，"谁写的谁知道"已经不够了 —— 主窗口得从广播里听说。
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

app.whenReady().then(async () => {
  ipcMain.handle(CH.ping, () => 'pong')

  // openSettings 跟 ping 一样尽早注册、不等 createRuntime：设置窗口的入口
  // （侧边栏齿轮、⌘,）在启动画面期间就该能用 —— 启动失败最常见的原因就是
  // 没配 API Key，那时候设置窗口正是用户唯一的出路。


  // 菜单同理，在 createRuntime 之前就装上，否则启动那几十秒里 ⌘, 是死键。
  // 加速键挂在菜单项上而不是 globalShortcut（那是系统级的，会把 ⌘, 从别的
  // 应用手里抢走）—— 见 app-menu.ts 顶部的说明。
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate({
        platform: process.platform,
        appName: app.getName(),
        // 菜单在 createWindow 之前就装上（启动那几十秒里 ⌘, 不能是死键），
        // 所以不能在这儿捕获窗口引用 —— 点的时候再去取。设置在右栏渲染，
        // 主进程只负责喊一声，切视图是 renderer 的事（App.tsx 的 showSettings）。
        onOpenSettings: () => {
          const win = BrowserWindow.getAllWindows()[0]
          if (!win || win.isDestroyed()) return
          // 设置在主窗口里，所以顺手把窗口带到前面来 —— ⌘, 可能是在别的
          // 应用里按的（菜单是全局的），那时光发事件用户看不到任何反应。
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
          win.webContents.send(CH.openSettings)
        },
      }) as Electron.MenuItemConstructorOptions[],
    ),
  )

  const win = createWindow()
  // 最近一次状态的快照。sendStatus 只在状态真的变化时调用一次，是"推送"；
  // 但 renderer 可能在状态已经变了之后才去问（reload 之后的重新挂载就是这样）——
  // 推送错过了就永远错过，这个变量让 CH.getRuntimeStatus 能随时"拉"到当下的真相，
  // 不用假设 renderer 一直在场、从没错过任何一次 send。
  let lastStatus: RuntimeStatusEvent = { phase: 'embedding', detail: '启动中…' }
  const sendStatus = (status: RuntimeStatusEvent) => {
    lastStatus = status
    // 广播而不是只发主窗口：设置窗口也要知道 phase —— 它在 phase 落定
    // （ready 或 failed）之前不敢拉设置，否则 getSettings 的 handler 还没注册，
    // invoke 会砸在 "No handler registered" 上，面板永远停在「读取设置中…」。
    // broadcast 内部逐个查 isDestroyed，不会碰已销毁的窗口。
    broadcast(CH.runtimeStatus, status)
  }
  // 尽早注册，跟 CH.ping 一样不等 waitForInitialLoad——reload 场景下 renderer 会在
  // 主进程早已跑过 createRuntime 之后才重新挂载，这时候它问的第一件事就是"现在到哪了"，
  // 这个 handler 必须一直在，不能等到 setupIpcHandlers 才出现。
  ipcMain.handle(CH.getRuntimeStatus, () => lastStatus)

  // loadConfig 之类的同步异常几乎瞬间抛出，可能比 renderer 的 JS bundle
  // 加载执行、React 挂载、useEffect 订阅 onRuntimeStatus 更快 —— 这种情况下
  // webContents.send 发出的第一条状态事件会因为对侧还没 ipcRenderer.on
  // 监听而直接被 Electron 丢弃（不会排队），状态栏永远停在初始的「启动中…」。
  // 等页面首次加载完成再往下走，保证 renderer 一定已经订阅上。
  // （若这次导航从未成功——dev server 没起来、生产包路径错了——waitForInitialLoad
  // 也会在 did-fail-load / 超时后放行，不会让下面的 try/catch 永远够不到。）
  await waitForInitialLoad(win)

  let runtime: AgentRuntime | undefined
  let quitting = false
  // setupIpcHandlers 的返回值。before-quit 要用它收子进程，而那个 handler
  // 注册得比 setupIpcHandlers 早（启动失败也要能干净退出），所以留个可变引用
  let runnerRef: ReturnType<typeof setupIpcHandlers> | null = null
  let restarting = false // 防止重启过程中接受新工作
  // 整个 app 共享一个 gate：审批请求不区分是哪个 session 发起的连接,
  // 但取消（窗口关闭/退出/删除会话）需要按 sessionId 定点清理，所以在这里
  // 建一次，往下传给 ipc-handlers，而不是让每次 sendMessage 各建一个。
  const gate = createApprovalGate()

  // 窗口被关掉后，所有还悬着的审批请求都失去了意义——没有 UI 能再回应它们了。
  // 不主动取消的话，它们会占着 agent-runner 的串行锁直到 5 分钟超时。
  // pending() 遍历 + 按 sessionId 去重后逐个 cancelSession：gate 本身不记录
  // "有哪些 session 存在过"，只能从当前悬着的请求反推。
  const cancelAllPending = () => {
    const sessionIds = new Set(gate.pending().map((p) => p.sessionId))
    for (const id of sessionIds) gate.cancelSession(id)
  }

  // MCP 是子进程，不关掉的话应用退出后它们会挂着 —— preventDefault 拦住默认退出流程，
  // 等 close() 真正结束再手动 quit，避免 stdio 子进程在 quit 竞态中来不及收到关闭信号就被留下。
  // quitting 标志防重入：手动调用 app.quit() 会让 before-quit 再触发一次。
  app.on('before-quit', (event) => {
    cancelAllPending()
    // 外部 CLI 的 npx 子进程也要收 —— 和 MCP 同一个理由。它们的 stderr 是
    // inherit，父进程没了不会自己退，会变成孤儿留在系统里。
    // 放在 quitting 判断**之前**：这一句是同步的、幂等的，而下面那个分支
    // 在 runtime 为空时会直接 return（启动失败的路径），那时子进程同样要收
    runnerRef?.disposeProviders()
    if (quitting || !runtime) return
    quitting = true
    event.preventDefault()
    void runtime.close().finally(() => app.quit())
  })

  win.on('close', cancelAllPending)

  try {
    const paths = {
      sessionsDir: join(app.getPath('userData'), 'sessions'),
      cacheDir: join(app.getPath('userData'), 'llm-cache'),
    }
    const config = loadConfig(buildEnv(process.env, getSettings(), paths))

    const pathsInput = {
      isDev,
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
      projectRoot: join(here, '../..'), // out/main → 仓库根
      notesDir: config.notesDir,
    }

    runtime = await createRuntime(
      config,
      // fs server 不在这里了：它的允许目录是沙箱边界，要跟着会话所属的
      // 项目变，所以按目录懒建（见 fs-tools.ts）
      { own: ownServerSpec(pathsInput) },
      sendStatus,
      {},
      // 每次搜索时重新读设置，而不是在这里取一次值 —— 用户可能跑起来之后
      // 才去填 key，取值的话得重启才生效（其它设置项都是即时的）。
      () => {
        const s = getSettings()
        return { brave: s.BRAVE_API_KEY, tavily: s.TAVILY_API_KEY }
      },
    )

    const fsPool = createFsToolsPool()

    // win 用来发 agent 事件（chunk/toolCall/approval 这些只有主窗口关心）；
    // broadcast 用来发设置和项目的变更（所有窗口都要知道）。两者分开传，
    // 免得 ipc-handlers 自己去 import electron 的 BrowserWindow 找别的窗口。
    const runnerInterface = setupIpcHandlers(win, runtime, paths, gate, () => restarting, broadcast, fsPool)
    // before-quit 在这之前就注册了（它要能处理「启动到一半就退出」），
    // 所以用一个可变引用把它接上，而不是把注册挪到这儿
    runnerRef = runnerInterface

    // 健康路径的重启：只允许在没有活跃工作（运行中的 turn 或待审批）时调用。
    // Task 14 把 restartApp 移到失败态专用是为了避免不加防护的"随时可 quit"——
    // 这里在成功路径重新注册它，但加上守卫：如果有 turn 在跑或审批悬着，拒绝并告知原因，
    // 避免重启把那些状态孤儿化（审批会超时、turn 会被中断但 onComplete 不会调用）。
    //
    // TOCTOU 防护：检查和 quit 之间有事件循环间隙（before-quit 的 runtime.close() 是 async），
    // 这期间新的 sendMessage 可能到达。restarting 标志在检查通过后立即设置、传给 handlers，
    // 让 sendMessage 在那个窗口期也能看到"正在重启"并拒绝新工作，关上了竞态的门。
    ipcMain.handle(CH.restartApp, () => {
      const ids = runnerInterface.runningSessionIds()
      if (ids.length > 0) {
        throw new Error('有会话正在处理中，无法重启。请等待它完成或拒绝待审批的操作后重试。')
      }
      const pending = gate.pending()
      if (pending.length > 0) {
        throw new Error('有待审批的写操作，无法重启。请先处理审批后重试。')
      }
      // 检查通过，立即设置标志关闭新工作入口，然后启动退出序列
      restarting = true

      // 兜底：before-quit 里 await runtime.close()，而 close() 要等 MCP 子进程真的退出。
      // 万一它挂住（子进程不响应信号、transport 卡死），app 会活着但 restarting 永远是 true——
      // 拒绝所有新消息、UI 上还没有任何提示，正是一个静默死锁。
      // 复审把这个判为「病态边缘情况、可接受」，但「罕见」不等于「不该有出路」：
      // 这跟 Task 9 花两轮修掉的那类静默挂死是同一种。超时后强制退出，
      // 宁可少做一次干净的 MCP 清理（进程都要没了，OS 会回收），也不留一个假活的窗口。
      const forceQuit = setTimeout(() => {
        console.error('[restart] 退出序列超时（8s），强制退出')
        app.exit(0)
      }, 8000)
      forceQuit.unref?.() // 别让这个定时器自己拖住事件循环

      app.relaunch()
      app.quit()
    })
  } catch (err) {
    // 关键路径：loadConfig（如缺 DEEPSEEK_API_KEY）在 createRuntime 之外、
    // try 块最前面就可能同步抛出 —— 这里必须兜底，否则渲染进程永远停在「启动中…」，
    // 且这个异常会变成主进程里看不见的 unhandled rejection（打包后更是无从排查）。
    const failure = toErrorEvent('default', err)
    sendStatus({ phase: 'failed', detail: failure.message })

    // 走到这里说明 setupIpcHandlers 没跑过，那些 handler 都还没注册。
    // 不补上的话，renderer 侧对应的 ipcRenderer.invoke 会因为
    // "No handler registered" 而 reject，且 App.tsx 目前的调用方式会让它成为静默的
    // unhandled rejection——用户点发送后毫无反馈，跟卡在启动界面几乎无法区分。
    // 补一个最小可用版本：设置项照常可读写；发消息则明确回一条 error 事件。
    //
    // 这条路径现在更重要了：设置搬进独立窗口之后，启动失败时用户唯一的出路
    // 就是 ⌘, 开设置去改配置（最常见的失败原因正是没配 API Key）。
    // 所以除了读写设置，provider 探测/导入也要补上 —— 面板挂载时就会调
    // detectProviders，而「从 Claude Code 导入」往往是修好这次失败最快的办法。
    ipcMain.handle(CH.getSettings, () => getSettings())
    ipcMain.handle(CH.saveSettings, (_e, patch) => {
      const next = saveSettings(patch)
      // 广播，跟健康路径一致：设置窗口自己也订阅这条，靠它把 needsRestart 的
      // 比较基线推进（否则保存成功后重启警告不会消失）。
      broadcast(CH.settingsChanged, next)
      return next
    })
    setupProviderHandlers()
    ipcMain.handle(CH.sendMessage, (_e, sessionId: string) => {
      if (!win.isDestroyed()) win.webContents.send(CH.error, { ...failure, sessionId })
    })

    // 启动失败时的重启：只在 failed 状态下注册，避免健康运行时误触。
    // 重启整个应用而不是 window.location.reload()（只会重载 renderer，主进程还是失败态），
    // 也不试图在进程内重跑 createRuntime（那要处理部分成功的清理、已注册的 IPC handler 等）。
    // app.relaunch() + app.quit() 是 Electron 文档推荐的应用重启方式，干净且用户预期明确。
    // 注意：relaunch() 会复用启动时的 CLI 参数（如 --remote-debugging-port），对开发流程友好。
    ipcMain.handle(CH.restartApp, () => {
      app.relaunch()
      app.quit()
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// macOS 上关掉所有窗口不退出应用（dock 图标还在，⌘Tab 回来能继续）。
// 注意这里的"所有窗口"现在包括设置窗口：只剩设置窗口开着时不算 all-closed，
// 应用照常活着，符合预期。
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
