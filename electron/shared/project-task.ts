export type ProjectTaskStatus = 'running' | 'review' | 'accepted' | 'failed' | 'stopped'

export interface ProjectTaskSource {
  path: string
  excerpt: string
  truncated: boolean
}

export interface ProjectTask {
  id: string
  sessionId: string
  projectId: string
  projectPath: string
  projectName: string
  prompt: string
  status: ProjectTaskStatus
  createdAt: number
  updatedAt: number
  revision: number
  toolCount: number
  sources: ProjectTaskSource[]
  answer?: string
  error?: string
}

export interface ProjectTaskChanged {
  sessionId: string
  task: ProjectTask | null
}

export const PROJECT_OVERVIEW_PROMPT = `请理解当前项目，形成一份有依据的项目说明。
先查看目录，再读取 README、项目配置和关键入口文件；只读取与目标有关的文本文件。
不要读取密钥、.env、依赖目录、构建产物或用户凭据。不要修改文件、执行命令或访问网络。
输出 Markdown，包含：
1. 项目解决什么问题，适合谁。
2. 目录与关键模块，各自负责什么。
3. 如何运行和验证；只写文件中能够确认的命令，注明“未执行”。
4. 一条核心使用流程如何经过这些模块。
5. 尚未确认的问题和建议继续阅读的文件。
每个重要结论注明相对于项目目录的来源路径；区分文件事实与推断。
资料不足时明确说明，不要编造实现、测试结果或读取记录。`

export const OVERVIEW_READ_TOOLS = new Set([
  'list_directory', 'directory_tree', 'search_files', 'get_file_info', 'read_file', 'read_text_file',
])
