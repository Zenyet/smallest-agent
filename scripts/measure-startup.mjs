// Measures a real Electron process with an empty profile, without API keys.
// Usage: node scripts/measure-startup.mjs [path/to/packaged/executable] [runs=3]
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const executable = process.argv[2] ? resolve(process.argv[2])
  : createRequire(import.meta.url)('electron')
const runs = Number(process.argv[3] ?? 3)
if (!Number.isInteger(runs) || runs < 1 || runs > 100) throw Error('runs must be an integer from 1 to 100')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const samples = []
for (let run = 0; run < runs; run++) {
  const temp = await mkdtemp(join(tmpdir(), 'smallest-startup-'))
  const appData = join(temp, 'AppData', 'Roaming')
  const localAppData = join(temp, 'AppData', 'Local')
  await Promise.all([mkdir(appData, { recursive: true }), mkdir(localAppData, { recursive: true })])
  // Retain Windows loader/command lookup variables, but no API credentials or
  // real user profile. The renderer and settings store use the temporary profile.
  const systemEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SYSTEMDRIVE'].includes(key.toUpperCase())))
  const start = performance.now()
  const child = spawn(executable, [
    '--inspect=0', `--user-data-dir=${join(temp, 'profile')}`,
    ...(!process.argv[2] ? [join(root, 'out/main/index.js')] : []),
  ], {
    cwd: temp,
    env: {
      ...systemEnv, HOME: temp, USERPROFILE: temp, APPDATA: appData, LOCALAPPDATA: localAppData,
      TMPDIR: tmpdir(), TEMP: tmpdir(), TMP: tmpdir(), LANG: 'en_US.UTF-8', SMALLEST_STARTUP_TRACE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '', socket, seq = 0
  const pending = new Map()
  child.on('error', (error) => { output += error.message })
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  const deadline = start + 30_000
  try {
    let url
    while (!(url = output.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)?.[0])) {
      if (performance.now() > deadline || child.exitCode !== null) throw Error(`Inspector unavailable: ${output}`)
      await sleep(10)
    }
    const inspectorMs = Math.round(performance.now() - start)
    socket = new WebSocket(url)
    await new Promise((r, j) => {
      socket.addEventListener('open', r, { once: true })
      socket.addEventListener('error', j, { once: true })
    })
    socket.addEventListener('message', (e) => {
      const message = JSON.parse(e.data)
      if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) }
    })
    const evaluate = async (expression) => {
      let timer
      const result = await new Promise((r, reject) => {
          const id = ++seq
          timer = setTimeout(() => { pending.delete(id); reject(Error('Inspector request timed out')) }, 5000)
          pending.set(id, r)
          socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
            expression, awaitPromise: true, returnByValue: true,
          } }))
      }).finally(() => clearTimeout(timer))
      if (result.error || result.result?.exceptionDetails) throw Error(JSON.stringify(result))
      return result.result.result.value
    }
    const electron = "process.getBuiltinModule('module').createRequire(process.cwd()+'/probe.cjs')('electron')"
    let visibleMs, readyMs, metrics
    while (performance.now() < deadline) {
      const window = await evaluate(`(() => {
        let e; try { e = ${electron} } catch { return null }
        const w = e.BrowserWindow.getAllWindows()[0];
        return w ? {visible:w.isVisible(),loaded:!w.webContents.isLoading(),url:w.webContents.getURL()} : null
      })()`).catch((error) => {
        if (/Promise was collected|context/.test(error.message)) return null
        throw error
      })
      if (window?.visible && visibleMs === undefined) visibleMs = Math.round(performance.now() - start)
      if (window?.loaded && window.url.endsWith('index.html')) {
        metrics = await evaluate(`${electron}.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(`(async () => ({
          status: await window.electronAPI.getRuntimeStatus(),
          inputReady: !!document.querySelector('textarea:not(:disabled)'),
          navigation: performance.getEntriesByType('navigation')[0]?.toJSON(),
          paint: performance.getEntriesByType('paint').map(p => ({name:p.name,ms:Math.round(p.startTime)})),
        }))()` )})`)
        if (metrics.status.phase === 'failed') throw Error(metrics.status.detail)
        if (metrics.status.phase === 'ready' && metrics.inputReady && visibleMs !== undefined) {
          readyMs = Math.round(performance.now() - start)
          break
        }
      }
      await sleep(20)
    }
    if (readyMs === undefined) throw Error(`Chat never became usable: ${JSON.stringify(metrics)}\n${output}`)
    const stages = Object.fromEntries([...output.matchAll(/\[startup-timing\] ([\w-]+) (\d+)ms/g)].map(m => [m[1], Number(m[2])]))
    const sample = {run:run+1,inspectorMs,visibleMs,readyMs,rendererLoadMs:Math.round(metrics.navigation.loadEventEnd),stages,paint:metrics.paint}
    samples.push(sample)
    console.log(JSON.stringify(sample))
    await evaluate(`${electron}.app.quit()`)
  } finally {
    socket?.close()
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([once(child, 'exit'), sleep(1000)])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
const median = (key) => [...samples].sort((a,b) => a[key]-b[key])[Math.floor(samples.length/2)][key]
console.log(JSON.stringify({medianVisibleMs:median('visibleMs'),medianReadyMs:median('readyMs'),runs:samples.length}))
