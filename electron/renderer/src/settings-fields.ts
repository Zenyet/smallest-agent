import { ALL, CUSTOM_ID, CUSTOM_NAME } from '../../main/vendors'
import type { IconName } from './components/Icon'
import { RESTART_KEYS, SETTING_DEFAULTS } from '../../shared/settings'
export { ALL, CUSTOM_ID, CUSTOM_NAME, SETTING_DEFAULTS }
export type SectionId = 'provider' | 'agents' | 'memory' | 'general' | 'advanced'
export const SECTIONS: { id: SectionId; label: string; description: string; icon: IconName }[] = [
  { id: 'provider', label: '模型连接', description: '管理内置 Agent 可用的服务。当前对话使用哪个模型，在输入框中选择。', icon: 'globe' },
  { id: 'agents', label: 'Agent 与工具', description: '管理可选的执行引擎，以及内置 Agent 的辅助能力。', icon: 'bot' },
  { id: 'memory', label: '记忆与资料', description: '管理长期记住的内容，以及回答时可检索的本地资料。', icon: 'think' },
  { id: 'general', label: '对话偏好', description: '偏好会自动保存，从内置 Agent 的下一轮对话开始生效。', icon: 'settings' },
  { id: 'advanced', label: '高级与诊断', description: '调整执行边界，查看各项能力的运行状态。', icon: 'sliders' },
]
export const ADVANCED_MODEL_KEYS = ['TEMPERATURE'] as const
export const BOOLEAN_FIELDS = new Set(['STREAM', 'LLM_CACHE', 'SUBAGENT', 'AUTO_EXTRACT_FACTS'])
export const AUTO_FIELDS = new Set([...BOOLEAN_FIELDS, 'MAX_TURNS', 'MAX_RETRIES', 'MAX_CONTEXT_TOKENS', 'KEEP_RECENT', 'TEMPERATURE'])
export const GROUPS: Partial<Record<SectionId, [string, string[]][]>> = {
  general: [['回答与缓存', ['STREAM', 'LLM_CACHE']]],
  agents: [['子任务', ['SUBAGENT']], ['网络搜索', ['BRAVE_API_KEY', 'TAVILY_API_KEY']]],
  memory: [['自动记忆', ['AUTO_EXTRACT_FACTS']], ['笔记资料', ['NOTES_DIR', 'EMBEDDING_MODEL', 'HF_ENDPOINT']]],
  advanced: [['执行限制', ['MAX_TURNS', 'MAX_RETRIES']], ['上下文与采样', ['MAX_CONTEXT_TOKENS', 'KEEP_RECENT', 'TEMPERATURE']]],
}
const LABELS: Record<string, string> = {
  CUSTOM_BASE_URL: '服务地址', CUSTOM_API_KEY: 'API Key', CUSTOM_MODELS: '模型清单', CUSTOM_SEARCH_TOOL: '服务端搜索工具',
  BRAVE_API_KEY: 'Brave Search API Key', TAVILY_API_KEY: 'Tavily API Key', NOTES_DIR: '笔记目录',
  EMBEDDING_MODEL: '嵌入模型', HF_ENDPOINT: '模型下载镜像', STREAM: '逐字显示回答', LLM_CACHE: '复用相同请求的答案',
  SUBAGENT: '允许拆分子任务', AUTO_EXTRACT_FACTS: '自动整理记忆', MAX_TURNS: '最大执行轮数',
  MAX_RETRIES: '失败重试次数', MAX_CONTEXT_TOKENS: '历史压缩阈值', KEEP_RECENT: '保留最近消息', TEMPERATURE: '采样温度',
}
export function label(key: string) { return LABELS[key] ?? (key.endsWith('_API_KEY') ? 'API Key' : key) }
const HINTS: Record<string, string> = {
  CUSTOM_BASE_URL: 'OpenAI 兼容地址，例如 http://localhost:11434/v1。', CUSTOM_API_KEY: '本地服务不校验凭据时可留空。',
  CUSTOM_MODELS: '填写服务支持的模型 ID，用逗号或换行分隔。', CUSTOM_SEARCH_TOOL: '仅在服务文档要求时填写。',
  NOTES_DIR: '留空使用启动环境或默认的 ./notes。', EMBEDDING_MODEL: '首次使用时可能需要下载模型。',
  HF_ENDPOINT: '使用默认下载源时可留空。', STREAM: '生成过程中即可阅读答案。',
  LLM_CACHE: '请求内容一致时读取本地缓存，减少重复调用。', SUBAGENT: '允许把任务交给已配置的子 Agent，会增加模型用量。',
  AUTO_EXTRACT_FACTS: '整理长期偏好和项目约定；符合条件的对话会增加一次模型调用。',
  MAX_TURNS: '一次任务最多连续执行的轮数。', MAX_RETRIES: '临时网络错误的额外重试次数。',
  MAX_CONTEXT_TOKENS: '估算 token 数超过阈值后压缩较早的历史。', KEEP_RECENT: '压缩时完整保留的最近消息条数。',
  TEMPERATURE: '较低值更稳定；实际支持范围取决于服务。',
}
export function hint(key: string) { return HINTS[key] }
export const REQUIRED: readonly string[] = []
export const RESTART_REQUIRED = RESTART_KEYS
