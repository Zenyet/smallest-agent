// ============================================================================
// cache.ts —— 磁盘缓存：省 token、加速重复查询
// ----------------------------------------------------------------------------
// Stage 4a 加入的「callModel 纯包装」。核心思路：
//   相同的（model + messages）→ 相同的输出，没必要每次都联网。
//   把 ModelResult 序列化成 JSON 文件存到磁盘，命中时直接返回，不再调 API。
//
// 关键设计：
//   • cacheKey 用 sha256(model + messages) 做文件名，每个模型 id 独立命名，
//     换模型不会误命中旧缓存。
//   • 文件读取失败（写入中断、磁盘错误等）当作未命中自愈，而不是崩溃整次调用。
//   • withCache 是对外的包装层，接受 keyPrefix（通常是 model id）以区分不同模型。
// ============================================================================

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CallModel, ModelResult } from './types'

// 缓存的最小接口：get/set，便于在测试里替换成内存实现，
// 不必真正读写磁盘。
export interface ResultCache {
  get(key: string): Promise<ModelResult | undefined>
  set(key: string, value: ModelResult): Promise<void>
}

// 生成缓存 key：sha256(model prefix + 消息 JSON)，取前 32 位十六进制。
// 用量是响应元数据，不参与请求缓存键。
// prefix 通常是 model id（如 "deepseek-chat"），保证不同模型的缓存互不干扰——
// 即使 messages 完全相同，不同模型的输出也可能不同，必须分开存。
export function cacheKey(prefix: string, messages: unknown): string {
  return createHash('sha256')
    .update(`${prefix}\n${JSON.stringify(Array.isArray(messages) ? messages.map(({ usage, usages, ...message }) => message) : messages)}`)
    .digest('hex')
    .slice(0, 32)
}

// 创建一个基于本地文件系统的缓存实例，每个缓存条目是 <dir>/<key>.json。
// resolve() 把相对路径转为绝对路径，避免工作目录变化时出错。
export function createDiskCache(dir: string): ResultCache {
  const base = resolve(dir)
  const fileFor = (key: string) => join(base, `${key}.json`)
  return {
    async get(key) {
      const file = fileFor(key)
      if (!existsSync(file)) return undefined
      try {
        return JSON.parse(await readFile(file, 'utf8')) as ModelResult
      } catch {
        // 文件损坏（如写入中断）当作未命中，自愈而非让整次调用炸掉
        return undefined
      }
    },
    async set(key, value) {
      // recursive: true 确保目录不存在时自动创建，第一次写入不会报错。
      await mkdir(base, { recursive: true })
      await writeFile(fileFor(key), JSON.stringify(value), 'utf8')
    },
  }
}

// 给任意 callModel 套上缓存逻辑：命中直接返回，未命中调 API 后写入缓存。
// keyPrefix 传入 model id，使不同模型共用同一个 ResultCache 实例但 key 不碰撞。
// onHit 回调可用于打日志或统计命中率，不影响主流程。
export function withCache(
  callModel: CallModel,
  cache: ResultCache,
  keyPrefix: string,
  onHit?: () => void,
): CallModel {
  // signal 透传：这一层也是装饰器，漏了内层就拿不到（见 types.ts 的
  // CallModel 注释 —— 整条链上任何一层漏掉都会让「停止」失效）
  return async (messages, signal) => {
    const key = cacheKey(keyPrefix, messages)
    const hit = await cache.get(key)
    if (hit) {
      onHit?.()
      return hit  // 缓存命中：不联网，直接返回已有结果
    }
    const result = await callModel(messages, signal)
    // 写缓存失败（如磁盘满）会抛出，但这属于环境问题而非业务问题，
    // 让它向上传播比静默吞掉更容易排查。
    await cache.set(key, result)
    return result
  }
}
