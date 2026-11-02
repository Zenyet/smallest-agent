import { constants } from 'node:fs'
import { opendir, open, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import type { ProjectTaskSource } from '../../shared/project-task'

const EXCLUDED = new Set(['node_modules', 'vendor', 'target', 'dist', 'dist-electron', 'build', 'out', 'coverage', '__pycache__', 'venv', 'env'])
const TEXT = new Set(['.md', '.txt', '.json', '.toml', '.yaml', '.yml', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.rs', '.py', '.go', '.java', '.swift', '.html', '.css', '.sql', '.sh'])
const SENSITIVE = /(?:^|[._-])(?:env|secret|secrets|credential|credentials|token|tokens|password|passwords|private|id_rsa|id_ed25519)(?:$|[._-])/i
const MAX_ENTRIES = 2000
const MAX_FILES = 24
const MAX_CHARACTERS = 24000

export interface ProjectScan {
  files: string[]
  sources: ProjectTaskSource[]
  scannedAt: number
  scanNote: string
}

function priority(path: string) {
  const name = basename(path).toLowerCase()
  if (/^readme(?:\.|$)/.test(name)) return 0
  if (['package.json', 'cargo.toml', 'pyproject.toml', 'go.mod', 'makefile', 'dockerfile'].includes(name)) return 1
  if (/^(?:main|index|app|lib|server|cli|agent)\./.test(name)) return 2
  if (/config|test|spec/.test(name)) return 3
  return 4
}

export async function scanProject(projectPath: string, signal?: AbortSignal): Promise<ProjectScan> {
  const root = await realpath(projectPath)
  const candidates: string[] = []
  const directories: { path: string; depth: number; rules: { base: string; matcher: Ignore }[] }[] = [{ path: root, depth: 0, rules: [] }]
  let entries = 0
  let limited = false
  let skipped = 0
  for (let i = 0; i < directories.length && entries < MAX_ENTRIES; i++) {
    signal?.throwIfAborted()
    const current = directories[i]
    // Respect root and nested .gitignore files without invoking any project command.
    const rules = [...current.rules]
    let ignoreFile
    try {
      ignoreFile = await open(join(current.path, '.gitignore'), constants.O_RDONLY | constants.O_NOFOLLOW)
      const buffer = Buffer.alloc(65536)
      const { bytesRead } = await ignoreFile.read(buffer, 0, buffer.length, 0)
      rules.push({ base: current.path, matcher: ignore().add(buffer.subarray(0, bytesRead).toString('utf8')) })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (i === 0) throw new Error('无法读取项目 .gitignore，请检查权限后继续。', { cause: error })
        skipped++
        continue
      }
    } finally { await ignoreFile?.close() }
    // opendir is bounded during traversal, including repositories with huge directories.
    let dir
    try { dir = await opendir(current.path) } catch (error) {
      if (i === 0) throw error
      skipped++
      continue
    }
    for await (const entry of dir) {
      signal?.throwIfAborted()
      if (++entries > MAX_ENTRIES) { limited = true; break }
      const name = entry.name
      if (name.startsWith('.') || EXCLUDED.has(name) || SENSITIVE.test(name) || entry.isSymbolicLink()) continue
      const path = join(current.path, name)
      if (rules.some(({ base, matcher }) => matcher.ignores(relative(base, path).split('\\').join('/') + (entry.isDirectory() ? '/' : '')))) continue
      if (entry.isDirectory()) {
        if (current.depth < 5) directories.push({ path, depth: current.depth + 1, rules })
        else limited = true
      } else if (entry.isFile() && (TEXT.has(extname(name).toLowerCase()) || ['Makefile', 'Dockerfile', 'go.mod'].includes(name))) {
        if (/lock(?:\.json|\.yaml)?$|\.min\.|\.map$|\.d\.ts$/.test(name)) continue
        candidates.push(relative(root, path).split('\\').join('/'))
      }
    }
  }
  if (entries >= MAX_ENTRIES) limited = true
  candidates.sort((a, b) => priority(a) - priority(b) || a.split('/').length - b.split('/').length || a.localeCompare(b))
  const sources: ProjectTaskSource[] = []
  let remaining = MAX_CHARACTERS
  for (const path of candidates) {
    signal?.throwIfAborted()
    if (sources.length >= MAX_FILES || remaining <= 0) break
    let file
    try {
      const full = join(root, path)
      const actual = relative(root, await realpath(full))
      if (actual.startsWith(`..`) || isAbsolute(actual)) { skipped++; continue }
      file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = await file.stat()
      if (!stat.isFile()) continue
      const buffer = Buffer.alloc(12004)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (buffer.subarray(0, bytesRead).includes(0)) { skipped++; continue }
      const text = buffer.subarray(0, bytesRead).toString('utf8')
      const excerpt = text.slice(0, Math.min(3000, remaining))
      if (!excerpt.trim()) continue
      sources.push({ path, excerpt, truncated: stat.size > bytesRead || text.length > excerpt.length })
      remaining -= excerpt.length
    } catch { skipped++ } finally { await file?.close() }
  }
  signal?.throwIfAborted()
  if (sources.length === 0) throw new Error('未找到可读取的项目文本文件。请检查目录和读取权限。')
  const files = candidates.slice(0, 200)
  return {
    files, sources, scannedAt: Date.now(),
    scanNote: `抽样读取 ${sources.length} 个文件，共 ${MAX_CHARACTERS - remaining} 个字符；目录清单保留 ${files.length} 项。${limited ? '已达到扫描深度或数量上限。' : ''}${skipped ? `另有 ${skipped} 项未能读取或已跳过。` : ''}这是扫描时的项目快照，未执行命令或测试。`,
  }
}
