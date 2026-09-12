import type { Fact, FactScope } from '../../src/memory/facts'

export function createFactEdits(store: {
  read: () => Fact[]
  forget: (key: string, scope: FactScope) => Fact[]
  remember: (input: { key: string; scope: FactScope; value: string; sessionId?: string }) => Fact[]
}) {
  const removed = new Map<string, Fact>()
  const id = (key: string, scope: FactScope) => JSON.stringify([key, scope])
  return {
    forget(key: string, scope: FactScope, expectedUpdatedAt?: number) {
      const existing = store.read().find(f => f.key === key && f.scope === scope)
      if (existing && expectedUpdatedAt !== undefined && existing.updatedAt !== expectedUpdatedAt) throw new Error('这条记忆已更新，请刷新后重试。')
      const after = store.forget(key, scope)
      if (existing) {
        removed.set(id(key, scope), existing)
        if (removed.size > 50) removed.delete(removed.keys().next().value!)
      }
      return after
    },
    restore(key: string, scope: FactScope) {
      const previous = removed.get(id(key, scope))
      if (!previous) throw new Error('这次删除已无法撤销。')
      if (store.read().some(f => f.key === key && f.scope === scope)) throw new Error('同名记忆已重新建立，未覆盖新内容。')
      const after = store.remember({ key, scope, value: previous.value, sessionId: previous.sourceSessionId })
      removed.delete(id(key, scope))
      return after
    },
    update(key: string, scope: FactScope, value: string) {
      if (!value?.trim()) throw new Error('记忆内容不能为空')
      const previous = store.read().find(f => f.key === key && f.scope === scope)
      if (!previous) throw new Error('这条记忆已被移除，请刷新后重试。')
      return store.remember({ key, scope, value: value.trim(), sessionId: previous.sourceSessionId })
    },
  }
}
