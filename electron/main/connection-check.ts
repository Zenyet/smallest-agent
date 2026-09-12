import type { DesktopSettings } from './config-env'
import { entry, resolveSelection, exists } from './vendors'
import { loadConfig } from '../../src/config'
import { makeCallModel } from '../../src/llm'
import type { CallModel, Config } from '../../src/types'
import type { ConnectionCheck } from '../shared/settings'

/** One user-triggered request, no tools, history, cache, fallback, or settings mutation. */
export async function checkConnection(
  vendorId: string, settings: DesktopSettings,
  makeCall: (config: Config) => CallModel = config => makeCallModel(config, {}),
  timeoutMs = 15000,
): Promise<ConnectionCheck> {
  if (!exists(vendorId)) throw new Error('未知的模型服务')
  const get = (key: string) => settings[key]
  const model = entry(vendorId, get)?.models[0]?.id ?? ''
  let result: Omit<ConnectionCheck, 'model' | 'checkedAt'>
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resolved = resolveSelection({ vendorId, model }, get)
    const config = loadConfig({
      DEEPSEEK_API_KEY: resolved.apiKey || 'local-no-key',
      DEEPSEEK_BASE_URL: resolved.baseUrl, DEEPSEEK_MODEL: resolved.model,
      LLM_PROTOCOL: resolved.protocol, MAX_RETRIES: '0', STREAM: '0',
    })
    const response = await makeCall({ ...config, nativeSearch: { kind: 'none' } })([
      { role: 'user', content: 'Reply with OK only.' },
    ], controller.signal)
    result = response.text.trim() ? { ok: true, message: '最小文本请求成功；图片和工具能力需另行确认。' }
      : { ok: false, message: '服务已响应，但没有返回可用的文本。' }
  } catch (err) {
    // Do not echo remote error bodies: they can include request headers or credentials.
    const status = typeof err === 'object' && err !== null && 'statusCode' in err ? err.statusCode : undefined
    result = { ok: false, message: controller.signal.aborted ? '连接超时，请检查网络或服务地址后重试。'
      : status === 401 || status === 403 ? '认证或访问被拒绝，请检查 API Key 和模型权限。'
      : status === 429 ? '请求受到限流或额度限制，请检查服务账户后重试。'
      : status === 404 ? '未找到端点或测试模型，请检查服务配置。'
      : '验证失败，请检查凭据、模型名称和服务地址。' }
  } finally { clearTimeout(timer) }
  return { ...result, model, checkedAt: Date.now() }
}
