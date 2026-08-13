// 探测本机已有的 AI provider 配置（Claude Code / Codex / Gemini）。
// 只在用户主动点击导入时才读取密钥，否则只报告「存在 / 可用性」。
//
// ⚠️ 安全注意：这个模块处理的配置中可能包含 API key / auth token。
// 永远不要 log/stringify/echo 包含密钥的对象——只记录「检测到什么 provider」。

export interface ProviderDetection {
  provider: 'claude' | 'codex' | 'gemini'
  available: boolean // 是否有可直接用的密钥
  reason?: string // 不可用时的原因
  model?: string // 检测到的模型名
  baseUrl?: string // 检测到的 base URL
}

export interface ProviderSecret {
  apiKey: string
  baseUrl?: string
  model?: string
}

// 从文件内容探测 Claude Code 配置（~/.claude/settings.json）。
// 返回 null 表示文件不存在或格式错误；永远不抛异常。
export function detectClaudeConfig(content: string | null): ProviderDetection | null {
  if (!content) return null

  try {
    const data = JSON.parse(content)
    const token = data?.env?.ANTHROPIC_AUTH_TOKEN
    const baseUrl = data?.env?.ANTHROPIC_BASE_URL
    const model = data?.model

    if (typeof token === 'string' && token.trim() !== '') {
      return {
        provider: 'claude',
        available: true,
        model: typeof model === 'string' ? model : undefined,
        baseUrl: typeof baseUrl === 'string' ? baseUrl : undefined,
      }
    }

    // 文件存在但没有密钥
    return {
      provider: 'claude',
      available: false,
      reason: '配置文件存在，但未找到 ANTHROPIC_AUTH_TOKEN',
    }
  } catch {
    // JSON 解析失败
    return null
  }
}

// 提取 Claude Code 的密钥（仅在用户点击导入时调用）。
// 返回 null 表示无法提取；永远不抛异常。
export function extractClaudeSecret(content: string | null): ProviderSecret | null {
  if (!content) return null

  try {
    const data = JSON.parse(content)
    const token = data?.env?.ANTHROPIC_AUTH_TOKEN
    const baseUrl = data?.env?.ANTHROPIC_BASE_URL
    const model = data?.model

    if (typeof token !== 'string' || token.trim() === '') return null

    return {
      apiKey: token.trim(),
      baseUrl: typeof baseUrl === 'string' && baseUrl.trim() !== '' ? baseUrl.trim() : undefined,
      model: typeof model === 'string' && model.trim() !== '' ? model.trim() : undefined,
    }
  } catch {
    return null
  }
}

// 从文件内容探测 Codex 配置（auth.json + config.toml）。
// authContent: ~/.codex/auth.json
// configContent: ~/.codex/config.toml
export function detectCodexConfig(authContent: string | null, configContent: string | null): ProviderDetection | null {
  if (!authContent) return null

  try {
    const auth = JSON.parse(authContent)
    const authMode = auth?.auth_mode
    const apiKey = auth?.OPENAI_API_KEY

    // 读取 config.toml 里的 model（顶层 `model =` 行）。
    // 不引完整 TOML 解析器：我们只关心顶层的一个键，用正则足够。
    // [projects."..."] 那些段落不影响我们要的 `model =`。
    let model: string | undefined
    if (configContent) {
      const match = /^model\s*=\s*"([^"]+)"/m.exec(configContent)
      if (match) model = match[1]
    }

    // auth_mode 是 "chatgpt" 表示 OAuth 登录态，access_token 只能用于 ChatGPT API，
    // 不是通用的 OpenAI API key。OPENAI_API_KEY 字段可能是 null 或空字符串。
    if (authMode === 'chatgpt') {
      return {
        provider: 'codex',
        available: false,
        reason: 'OAuth 登录态（ChatGPT），access_token 不能当通用 API key 用',
        model,
      }
    }

    // 其它 auth_mode（比如 'apikey'）且 OPENAI_API_KEY 非空，才算可用
    if (typeof apiKey === 'string' && apiKey.trim() !== '') {
      return {
        provider: 'codex',
        available: true,
        model,
      }
    }

    // 文件存在但没有可用密钥
    return {
      provider: 'codex',
      available: false,
      reason: 'auth.json 存在，但 OPENAI_API_KEY 为空或 null',
      model,
    }
  } catch {
    return null
  }
}

// 提取 Codex 的密钥（仅在 available: true 且用户点击导入时调用）。
export function extractCodexSecret(authContent: string | null, configContent: string | null): ProviderSecret | null {
  if (!authContent) return null

  try {
    const auth = JSON.parse(authContent)
    const apiKey = auth?.OPENAI_API_KEY

    if (typeof apiKey !== 'string' || apiKey.trim() === '') return null

    let model: string | undefined
    if (configContent) {
      const match = /^model\s*=\s*"([^"]+)"/m.exec(configContent)
      if (match) model = match[1]
    }

    return {
      apiKey: apiKey.trim(),
      model,
    }
  } catch {
    return null
  }
}

// 从文件内容探测 Gemini 配置（~/.gemini/settings.json）。
export function detectGeminiConfig(content: string | null): ProviderDetection | null {
  if (!content) return null

  try {
    const data = JSON.parse(content)
    // Gemini 的 settings.json 只有 theme / selectedAuthType，没有存密钥。
    // 即使文件存在，也标记为不可用。
    return {
      provider: 'gemini',
      available: false,
      reason: 'settings.json 不存储密钥，无法导入',
    }
  } catch {
    return null
  }
}
