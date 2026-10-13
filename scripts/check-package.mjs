// macOS release smoke test: uses the shipped Electron and dependencies, offline.
// node scripts/check-package.mjs path/to/App.app [path/to/cached/embedding-model]
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, openSync, readSync, closeSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

const runtime = process.argv[2] === '--runtime'
const appPath = process.argv[runtime ? 3 : 2]
assert(appPath, 'Usage: node scripts/check-package.mjs App.app [embedding-model-directory]')
const resources = join(resolve(appPath), 'Contents', 'Resources')
const archive = join(resources, 'app.asar')
const modelDir = process.argv[runtime ? 4 : 3]

if (!runtime) {
  // Read only the ASAR header, so an accidentally bundled model cannot exhaust RAM.
  const fd = openSync(archive, 'r')
  let header
  try {
    const prefix = Buffer.alloc(16)
    readSync(fd, prefix, 0, 16, 0)
    const data = Buffer.alloc(prefix.readUInt32LE(12))
    readSync(fd, data, 0, data.length, 16)
    header = JSON.parse(data.toString())
  } finally {
    closeSync(fd)
  }
  assert.deepEqual(Object.keys(header.files).sort(), ['node_modules', 'out', 'package.json'])
  function audit(files, parent = '') {
    for (const [name, entry] of Object.entries(files)) {
      const path = `${parent}/${name}`
      assert(!/^\.env(?:\.|$)/.test(name) && name !== '.cache', `Unexpected private/cache file: ${path}`)
      assert(!path.endsWith('.map'), `Unexpected source map: ${path}`)
      if (path.includes('/onnxruntime-node/bin/napi-') && !entry.files) {
        assert(path.includes(`/darwin/${process.arch}/`), `Foreign native library: ${path}`)
      }
      if (entry.files) audit(entry.files, path)
    }
  }
  audit(header.files)
  const modules = header.files.node_modules.files
  for (const name of ['onnxruntime-web', 'shiki', '@shikijs', '@fontsource', '@fontsource-variable', 'react-markdown']) {
    assert(!modules[name], `Unexpected build-only dependency: ${name}`)
  }
  console.log('PASS: archive allowlist, caches, native architecture and build-only dependencies')
  const cwd = mkdtempSync(join(tmpdir(), 'smallest-agent-package-'))
  try {
    const executable = join(resolve(appPath), 'Contents', 'MacOS', basename(appPath, '.app'))
    const args = [fileURLToPath(import.meta.url), '--runtime', resolve(appPath)]
    if (modelDir) args.push(resolve(modelDir))
    const result = spawnSync(executable, args, {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' },
      stdio: 'inherit',
      timeout: 90_000,
    })
    if (result.error) throw result.error
    assert.equal(result.status, 0, `Packaged runtime failed (${result.signal ?? result.status})`)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
} else {
  assert(process.versions.electron, 'The smoke test must run in the packaged Electron')
  const require = createRequire(join(archive, 'package.json'))
  const transformers = await import(pathToFileURL(join(archive, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs')).href)
  assert.equal(typeof transformers.pipeline, 'function')
  assert.equal(typeof require('@huggingface/transformers').pipeline, 'function')

  // Minimal ONNX Identity graph: float32 [2], opset 13, IR version 8.
  const model = Buffer.from('CAg6VQoZCgVpbnB1dBIGb3V0cHV0IghJZGVudGl0eRINcGFja2FnZS1zbW9rZVoTCgVpbnB1dBIKCggIARIECgIIAmIUCgZvdXRwdXQSCgoICAESBAoCCAJCAhAN', 'base64')
  const ort = require('onnxruntime-node')
  const session = await ort.InferenceSession.create(model, { executionProviders: ['cpu'] })
  try {
    const result = await session.run({ input: new ort.Tensor('float32', Float32Array.from([1, 2]), [2]) })
    assert.deepEqual(Array.from(result.output.data), [1, 2])
  } finally {
    await session.release()
  }
  const png = await require('sharp')({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer()
  assert(png.length > 0)
  console.log('PASS: Transformers ESM/CJS, native ONNX inference and sharp')

  // Use the wire protocol so the test itself needs no copy of the bundled SDK.
  const child = spawn(process.execPath, [join(archive, 'out/main/mcp-server.js')], {
    env: { ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const lines = createInterface({ input: child.stdout })
  const messages = lines[Symbol.asyncIterator]()
  const timeout = setTimeout(() => child.kill(), 15_000)
  async function request(id, method, params = {}) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    for (;;) {
      const { value, done } = await messages.next()
      assert(!done, `MCP exited before answering ${method}`)
      const message = JSON.parse(value)
      if (message.id !== id) continue
      assert(!message.error, JSON.stringify(message.error))
      return message.result
    }
  }
  try {
    await request(1, 'initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'package-smoke', version: '1.0.0' },
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const tools = await request(2, 'tools/list')
    assert(tools.tools.some(tool => tool.name === 'list_skills'))
    const result = await request(3, 'tools/call', { name: 'list_skills', arguments: {} })
    assert(!result.isError, JSON.stringify(result))
    const text = result.content.find(item => item.type === 'text')?.text
    assert(text && JSON.parse(text).length > 0, 'Packaged skill files are missing')
  } finally {
    clearTimeout(timeout)
    lines.close()
    child.stdin.end()
    child.kill()
  }
  console.log('PASS: packaged MCP subprocess and skill files')

  if (modelDir) {
    transformers.env.allowRemoteModels = false
    transformers.env.useFSCache = false
    const extractor = await transformers.pipeline('feature-extraction', modelDir, { dtype: 'q8', device: 'cpu', local_files_only: true })
    try {
      const output = await extractor(['query: 打包体积优化', 'passage: 保留本地知识库检索'], { pooling: 'mean', normalize: true })
      const vectors = output.tolist()
      assert.equal(vectors.length, 2)
      assert(vectors[0].length > 1)
      for (const vector of vectors) {
        assert(vector.every(Number.isFinite))
        assert(Math.abs(Math.hypot(...vector) - 1) < 0.001)
      }
      console.log(`PASS: offline embedding pipeline (2 × ${vectors[0].length})`)
    } finally {
      await extractor.dispose()
    }
  }
}
