// ============================================================================
// facts-store.ts —— 桌面端的记忆入口（薄转发层）
// ----------------------------------------------------------------------------
// 真正的读写在 src/memory/facts-store.ts，CLI 和桌面端**共用那一份**。
//
// 这个文件曾经是一份独立实现（写 userData/memory.json），结果是两个真相：
// 同一个 key 在 CLI 那边是「杭州」、这边是「广州」，用户以为是同一个记忆。
// 见 src/memory/facts-store.ts 的文件头。
//
// 现在它只剩两件事：
//   1. 转发（保持 ipc-handlers 的 import 路径不变）
//   2. 从旧的 userData/memory.json 迁移一次 —— 那份是用户真实的记忆，
//      不能因为改路径就丢
//
// 为什么留着这个文件而不是让 ipc-handlers 直接 import src/：迁移需要
// app.getPath('userData')，那是 Electron 独有的。把这一点 Electron 依赖
// 关在这里，src/ 那份就仍然能在纯 Node 下被 vitest 跑。
// ============================================================================

import { app } from 'electron'
import { join } from 'node:path'
import { migrateFrom } from '../../src/memory/facts-store'

export {
  getFacts,
  getFactsStrict,
  rememberFact,
  forgetFactByKey,
  factsFile,
} from '../../src/memory/facts-store'

/**
 * 一次性迁移：userData/memory.json → ~/.smallest-agent/facts.json。
 *
 * 幂等 —— 迁移完旧文件还在（刻意不删，见 migrateFrom 的注释），所以
 * 每次启动都会再跑一遍。合并逻辑靠 updatedAt 判胜负，重跑不会覆盖更新的
 * 数据：旧文件那条时间戳永远不会变得比现在这条新。
 *
 * 在 index.ts 启动时调一次。放在这里而不是模块顶层的副作用：
 * app.getPath() 要等 app ready，而模块 import 发生得更早。
 */
export function migrateLegacyFacts(): void {
  try {
    migrateFrom(join(app.getPath('userData'), 'memory.json'))
  } catch {
    // 迁移失败不该阻止应用启动。最坏情况是用户丢掉桌面端记的那几条
    // （旧文件还在，可以手工恢复），而不是打不开 app
  }
}

/**
 * 会话删了，它记下的事实**不删**。
 *
 * 和 forgetSessionTitle / forgetSession 那几个刻意不同：标题和项目映射是
 * 「关于这个会话的元数据」，会话没了它们就是垃圾。而事实是「关于用户和
 * 项目的知识」—— 它只是**在**那个会话里被记下，不属于那个会话。
 *
 * 删掉一个会话不该让 agent 忘记你在哪。sourceSessionId 会指向一个不存在的
 * 会话，那没关系：它只给人排查用，不参与任何逻辑。
 *
 * 这个函数存在只是为了把上面这段推理写在代码里 —— 免得后来有人看到
 * deleteSession 里少了一句 forget 就顺手补上。
 */
export function factsSurviveSessionDeletion(): void {
  // 刻意的空实现，见上面
}
