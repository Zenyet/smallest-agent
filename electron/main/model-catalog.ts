import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ALL,
  CUSTOM_API_KEY,
  CUSTOM_BASE_URL,
  CUSTOM_ID,
  apiKeySetting,
  find,
  type ModelChoice,
} from './vendors'
import type { DesktopSettings } from './config-env'

export interface ModelCatalogResult {
  vendorId: string
  models: ModelChoice[]
  fetchedAt: number
  cached?: boolean
  error?: string
}

interface VendorEndpoint {
  vendorId: string
  baseUrl: string
  apiKey: string
  cacheHint?: string
}

interface CachedCatalog {
  models: ModelChoice[]
  fetchedAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000
const MAX_PAGES = 20
const MAX_MODELS = 2_000
const cache = new Map<string, CachedCatalog>()

// --- 磁盘持久化缓存 ----------------------------------------------------------
//
// 内存缓存重启就丢：第一次拉完之后如果没写盘，下次启动又得对每家厂商重打一遍
// 请求（慢），而且一旦离线/端点抽风就直接掉回 vendors.ts 里那几个手写的精选。
//
// 所以拉取结果落一份到磁盘。语义上它和内存缓存不同：
//   • 内存缓存：进程内、5 分钟 TTL，过 TTL 就重新拉（保证「打开选择器」时是新的）
//   • 磁盘缓存：跨进程、**没有 TTL**，只在 API 请求失败时当兜底用。
//     拿到它的结果标 cached:true，前端可以照常渲染，只是可能不是最新的。
//
// 这样「配了 key 的厂商」的模型清单就是全量、自动、跨重启可用的，不再需要
// 手动在 vendors.ts 里维护那一堆清单 —— 那里留下的只作为「既没 key 又没缓存」
// 的最后兜底（厂商注册信息 id/baseUrl/keyEnv 本身仍然必须手写，无法自动化）。

const DISK_FILE = 'model-catalog.json'
let diskDir: string | null = null
// 从磁盘加载的那份缓存。只在 initModelCatalogCache 里灌一次，之后 fetchModels
// 成功时同步更新（见 refreshModelCatalog）。
const diskCache = new Map<string, CachedCatalog>()

/** 主进程启动时调用一次：把 userData 目录传进来并加载已有的磁盘缓存。 */
export function initModelCatalogCache(dir: string): void {
  diskDir = dir
  diskCache.clear()
  try {
    const file = join(dir, DISK_FILE)
    if (!existsSync(file)) return
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const entry = value as Partial<CachedCatalog>
      if (Array.isArray(entry.models) && typeof entry.fetchedAt === 'number') {
        diskCache.set(key, { models: entry.models as ModelChoice[], fetchedAt: entry.fetchedAt })
      }
    }
  } catch {
    // 缓存文件损坏/读不出来：忽略，下次成功拉取会覆盖。不该阻止启动。
  }
}

function persistDiskCache(): void {
  if (!diskDir) return
  try {
    mkdirSync(diskDir, { recursive: true })
    const payload: Record<string, CachedCatalog> = {}
    for (const [key, value] of diskCache) payload[key] = value
    writeFileSync(join(diskDir, DISK_FILE), JSON.stringify(payload, null, 2))
  } catch {
    // 写盘失败（磁盘只读/权限）：缓存只是增强，不是必需，吞掉。
  }
}

function endpointFor(settings: DesktopSettings, vendorId: string): VendorEndpoint | null {
  if (vendorId === CUSTOM_ID) {
    const baseUrl = (settings[CUSTOM_BASE_URL] ?? '').trim().replace(/\/+$/, '')
    if (!baseUrl) return null
    return {
      vendorId,
      baseUrl,
      apiKey: (settings[CUSTOM_API_KEY] ?? '').trim(),
      cacheHint: (settings.CUSTOM_MODELS ?? '').trim(),
    }
  }

  const vendor = find(vendorId)
  const keySetting = apiKeySetting(vendorId)
  if (!vendor || !keySetting) return null
  const apiKey = (settings[keySetting] ?? '').trim()
  if (!apiKey) return null
  return { vendorId, baseUrl: vendor.baseUrl.replace(/\/+$/, ''), apiKey }
}

function cacheKey(endpoint: VendorEndpoint): string {
  const keyDigest = createHash('sha256').update(endpoint.apiKey).digest('hex')
  return `${endpoint.vendorId}\0${endpoint.baseUrl}\0${keyDigest}\0${endpoint.cacheHint ?? ''}`
}

function normalizeModelList(value: unknown, vendorId: string): ModelChoice[] {
  if (!value || typeof value !== 'object') return []
  // 各家端点的返回形状不统一：最常见是 { data: [...] }（OpenAI 兼容）、
  // { models: [...] }（Gemini / 部分网关），也有直接返回裸数组的。
  // 三种都认，免得某家换了个包裹形式就整页空白。
  let rows: unknown[]
  if (Array.isArray(value)) {
    rows = value
  } else {
    const record = value as Record<string, unknown>
    rows = Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.models)
        ? record.models
        : []
  }
  const out: ModelChoice[] = []
  const seen = new Set<string>()

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const model = raw as Record<string, unknown>
    if (vendorId === 'gemini') {
      const methods = Array.isArray(model.supportedGenerationMethods)
        ? model.supportedGenerationMethods
        : []
      if (methods.length > 0 && !methods.includes('generateContent')) continue
    }

    // id 的来源按稳定程度排：id（OpenAI/Anthropic）→ slug（OpenRouter/LiteLLM
    // 那类聚合网关，id 常是 hash 而 slug 才是人能认的）→ name（Gemini）。
    const idRaw = typeof model.id === 'string'
      ? model.id
      : typeof model.slug === 'string'
        ? model.slug
        : typeof model.name === 'string'
          ? model.name
          : ''
    const id = idRaw.trim().replace(/^models\//, '')
    if (!id || seen.has(id) || /(?:embedding|whisper|transcri|moderation|dall-e|tts|speech|realtime|audio|image-generation)/i.test(id)) {
      continue
    }

    // 显示名：display_name / displayName → name → id。name 那档是给
    // 「有独立 name 字段但没 display 系」的端点用的，比直接露 id 友好。
    const name =
      (typeof model.display_name === 'string' && model.display_name) ||
      (typeof model.displayName === 'string' && model.displayName) ||
      (typeof model.name === 'string' && model.name) ||
      id
    seen.add(id)
    out.push({ id, name })
    if (out.length >= MAX_MODELS) break
  }

  return out
}

function appendQuery(url: URL, key: string, value: string | undefined): void {
  if (value) url.searchParams.set(key, value)
}

async function fetchPage(url: URL, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`模型目录请求失败（HTTP ${response.status}）`)
  }
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object') throw new Error('模型目录响应格式无效')
  return body as Record<string, unknown>
}

async function fetchModels(endpoint: VendorEndpoint): Promise<ModelChoice[]> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  let base: URL
  let pageToken: string | undefined

  if (endpoint.vendorId === 'gemini') {
    // Gemini API key stays in a header so it cannot appear in URL logs or errors.
    base = new URL('https://generativelanguage.googleapis.com/v1beta/models')
    headers['x-goog-api-key'] = endpoint.apiKey
  } else {
    base = new URL(`${endpoint.baseUrl}/models`)
    if (endpoint.vendorId === 'anthropic') {
      headers['x-api-key'] = endpoint.apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else if (endpoint.apiKey) {
      headers.Authorization = `Bearer ${endpoint.apiKey}`
    }
  }

  const all: ModelChoice[] = []
  const seen = new Set<string>()
  let afterId: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(base)
    if (endpoint.vendorId === 'gemini') {
      url.searchParams.set('pageSize', '1000')
      appendQuery(url, 'pageToken', pageToken)
    } else if (endpoint.vendorId === 'anthropic') {
      url.searchParams.set('limit', '1000')
      appendQuery(url, 'after_id', afterId)
    }

    const body = await fetchPage(url, headers)
    for (const model of normalizeModelList(body, endpoint.vendorId)) {
      if (seen.has(model.id)) continue
      seen.add(model.id)
      all.push(model)
      if (all.length >= MAX_MODELS) break
    }
    if (all.length >= MAX_MODELS) break

    const nextToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined
    const hasMore = body.has_more === true
    const lastId = typeof body.last_id === 'string' ? body.last_id : undefined
    if (endpoint.vendorId === 'gemini' && nextToken) {
      pageToken = nextToken
      continue
    }
    if (endpoint.vendorId === 'anthropic' && hasMore && lastId) {
      afterId = lastId
      continue
    }
    break
  }

  if (all.length === 0) throw new Error('服务没有返回可用模型')
  return all
}

/**
 * Query configured built-in providers from their model-list endpoint.
 * Errors are returned per provider so one unavailable vendor never blocks the others.
 */
export async function refreshModelCatalog(
  settings: DesktopSettings,
  vendorIds: readonly string[],
  force = false,
): Promise<ModelCatalogResult[]> {
  const now = Date.now()
  const uniqueIds = [...new Set(vendorIds)]
  return Promise.all(uniqueIds.map(async (vendorId): Promise<ModelCatalogResult> => {
    const endpoint = endpointFor(settings, vendorId)
    if (!endpoint) return { vendorId, models: [], fetchedAt: now }

    const key = cacheKey(endpoint)
    const cached = cache.get(key)
    if (!force && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return { vendorId, models: cached.models.map((model) => ({ ...model })), fetchedAt: cached.fetchedAt, cached: true }
    }

    try {
      const models = await fetchModels(endpoint)
      const fetchedAt = Date.now()
      cache.set(key, { models, fetchedAt })
      diskCache.set(key, { models, fetchedAt })
      persistDiskCache()
      while (cache.size > 100) cache.delete(cache.keys().next().value as string)
      return { vendorId, models, fetchedAt }
    } catch (error) {
      // 请求失败（离线/端点抽风/超时）先回退磁盘缓存：上次成功拉到的全量
      // 比 vendors.ts 里几个手写的精选要完整得多。没有缓存才报错。
      const diskCached = diskCache.get(key)
      if (diskCached && diskCached.models.length > 0) {
        return {
          vendorId,
          models: diskCached.models.map((model) => ({ ...model })),
          fetchedAt: diskCached.fetchedAt,
          cached: true,
        }
      }
      return {
        vendorId,
        models: [],
        fetchedAt: now,
        error: error instanceof Error ? error.message : '模型目录读取失败',
      }
    }
  }))
}

export function configuredModelVendorIds(settings: DesktopSettings): string[] {
  return [...ALL.map((vendor) => vendor.id), CUSTOM_ID].filter((id) => endpointFor(settings, id) !== null)
}
