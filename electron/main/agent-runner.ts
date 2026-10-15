import { OVERVIEW_READ_TOOLS, PROJECT_OVERVIEW_PROMPT } from '../shared/project-task'
import { userMessage } from '../../src/attachments'
import type { ContentPart } from '../../src/types'
// 请求级装配 + 串行锁。每条消息走一次这里。
// 串行的理由：会话文件是「读-改-写」，并发会互相覆盖；个人使用也没有并发收益。
import { runAgent as realRunAgent } from '../../src/agent'
import { makeCallModel } from '../../src/llm'
import { createJsonSessionStore } from '../../src/memory/store'
import { makeSummarizer } from '../../src/memory/summarize'
import { type Summarize } from '../../src/memory/compact'
import { makeVerifier, type Verdict, type VerifyInput } from '../../src/verify'
import { loadConfig as realLoadConfig } from '../../src/config'
import { buildCallModel as realBuildCallModel } from './call-model'
import { toErrorEvent } from './errors'
import { createApprovalGate, type ApprovalGate, type GuardMode } from './approval'
import { CancelToken, isCancelled } from './cancel'
import { createBuiltinProvider } from './provider/builtin'
import type { Provider, TurnEvent } from './provider/types'
import type { FsToolsPool } from './fs-tools'
import { applyAgent, filterTools, type AgentDef } from './agents'
import { makeRememberTool } from '../../src/tools/remember'
import { makeRecallTool } from '../../src/tools/recall'
import { makeForgetTool } from '../../src/tools/forget'
import { factsFor, renderFacts, scopeFor, type Fact, type FactScope } from '../../src/memory/facts'
import { makeExtractor, rememberSucceeded, resolveScope, type Extract } from '../../src/memory/extract'
import { estimateTokens } from '../../src/memory/compact'
import { makeTaskTool } from './subagent'
import type { SessionStore } from '../../src/memory/store'
import type { CallModel, Config, Message, ToolRegistry } from '../../src/types'
import type {
  ApprovalRequestEvent,
  CacheHitEvent,
  CancelledEvent,
  ErrorEvent,
  MessageChunkEvent,
  MessageCompleteEvent,
  ToolCallEvent,
  VerdictEvent,
} from '../shared/channels'

export interface AgentEmitter {
  chunk: (e: MessageChunkEvent) => void
  toolCall: (e: ToolCallEvent) => void
  complete: (e: MessageCompleteEvent) => void
  verdict: (e: VerdictEvent) => void
  cacheHit: (e: CacheHitEvent) => void
  error: (e: ErrorEvent) => void
  approvalRequest: (e: ApprovalRequestEvent) => void
  cancelled: (e: CancelledEvent) => void
}

export interface RunnerDeps {
  loadConfig: (options?: { allowMissingApiKey?: boolean }) => Config
  makeSessionStore: (dir: string) => SessionStore
  buildCallModel: (
    config: Config,
    registry: ToolRegistry,
    onText: (d: string) => void,
    onCacheHit: () => void,
  ) => CallModel
  makeSummarize: (config: Config) => Summarize
  verify: (config: Config, input: VerifyInput) => Promise<Verdict>
  runAgent: typeof realRunAgent
  registry: ToolRegistry
  emit: AgentEmitter
  // 写工具审批闸口。按 session 装饰 registry 必须在 run() 里做（每条请求一次），
  // 不能在 makeDefaultRunnerDeps 里做一次——那时候还没有 sessionId。
  gate: ApprovalGate
  /**
   * 跨会话事实记忆的读写。不传 = 没有记忆功能（CLI 那条路、旧测试）。
   *
   * 做成可注入的依赖而不是直接 import facts-store：那个文件 import electron
   * （要 app.getPath），而这个 runner 的测试是在纯 Node 下跑的。
   */
  facts?: {
    getAll: () => Fact[]
    remember: (input: { key: string; value: string; scope: FactScope; sessionId?: string }) => void
    /**
     * 删一条。给 forget 工具用 —— 模型也需要能改正自己记错的东西，
     * 不能只有设置面板那一个入口（见 src/tools/forget.ts 的文件头）。
     */
    forget: (key: string, scope: FactScope) => void
  }
  /**
   * 每轮结束后自动抽取事实。不传 = 只靠模型主动调 remember。
   *
   * ## 为什么是工厂而不是现成的 Extract
   *
   * 收 config 才能每轮用**当前**的配置建 —— 用户在设置里换了模型或 key，
   * 下一轮就该生效。第一版写的是 `makeExtractor(makeCallModel(loadConfig(), {}))`，
   * 那个 loadConfig() 在装配那一刻求值，配置被永久定死。
   * makeSummarize / verify 都是收 config 的工厂，正是为了避开这个。
   *
   * 和 facts 分开两个依赖：facts 是存储，这个是「怎么抽」—— 后者要一次
   * 模型调用，测试里几乎总要塞假的，混在一起会让只关心存储的测试
   * 也被迫提供一个假抽取器。
   */
  makeExtract?: (config: Config) => Extract
  /**
   * 这一轮该由哪个 provider 跑。返回 null / 不传 = 用内置 agent。
   *
   * **可选**是有意的：绝大多数测试只关心内置那条路，不传就是原来的行为，
   * 那 19 条锁 runner 契约的测试因此一行不用改。真实装配在
   * makeDefaultRunnerDeps 里接上（见那边）。
   *
   * 传 sessionId 而不是让 runner 自己读 providers 状态：那份状态活在
   * electron-store 里，而 runner 是纯逻辑、测试里不该被迫去 mock 一个 store。
   */
  resolveProvider?: (sessionId: string) => Provider | null
  /**
   * 这个会话的工作目录（外部 CLI 的 cwd）。不传 = 没有项目目录。
   *
   * 和 resolveProvider 分开而不是打包成一个「会话上下文」：cwd 的真相在
   * 项目分组那边（projects-store），provider 的真相在 providers-store，
   * 两个来源，合成一个对象只会让「谁该更新它」变模糊。
   */
  resolveCwd?: (sessionId: string) => string | undefined
  /**
   * 这个会话的权限模式（只对内置 agent 有意义 —— 外部 CLI 自带权限模型）。
   * 不传 = 'ask'，也就是原来的行为。
   */
  resolvePermission?: (sessionId: string) => GuardMode
  /** 文件工具池：按项目目录懒建 + 缓存，见 fs-tools.ts */
  fsPool?: FsToolsPool
  /**
   * 这个会话绑的自定义 agent（系统提示 + 工具白名单）。返回 undefined = 没绑。
   *
   * 可选：不传就是没有自定义 agent 的行为，所以现有测试不用改。
   */
  resolveAgent?: (sessionId: string) => AgentDef | undefined
  /**
   * 能被派活的子 agent 有哪些（停用的调用方先滤掉）。
   *
   * 和 resolveAgent 分开：那个答「这个会话用哪套预设」（一个），
   * 这个答「可以派给谁」（一批）。同一份数据两种用途，见 subagent.ts 的文件头。
   *
   * 空数组 / 不传 = 不给 task 工具（一个调了必然报错的工具比没有更糟）。
   */
  resolveSubagents?: (sessionId: string) => AgentDef[]
}

export interface RunOptions { projectOverview?: boolean }

export interface AgentRunner {
  run(sessionId: string, input: string, attachments?: ContentPart[], options?: RunOptions): Promise<void>
  /** 某个会话是不是正在跑。 */
  isBusy(sessionId: string): boolean
  /** 哪些会话正在跑（按开始顺序）。前端用它重建 blockedBy 横幅、停止按钮。 */
  runningSessionIds(): string[]
  /**
   * 请求停止某个会话正在跑的那一轮。
   *
   * 返回「有没有受理」：目标没在跑就返回 false（不报错 —— 用户可能在
   * cancelled 事件到达前又点了一次）。受理了也**不代表已经停了**，
   * 取消是轮边界的，见 cancel.ts 的文件头。
   */
  cancel(sessionId: string): boolean
  /**
   * 等某个会话那一轮彻底结束（含取消路径上的存盘）。没在跑就立刻返回。
   *
   * 删除正在跑的会话需要它：取消路径上会 sessions.save()，先删文件的话
   * 存盘后落地、会话又「复活」。
   */
  settled(sessionId: string): Promise<void>
}

export function makeDefaultRunnerDeps(
  registry: ToolRegistry,
  emit: AgentEmitter,
  loadConfig: RunnerDeps['loadConfig'] = (options) => realLoadConfig(undefined, options),
  gate: ApprovalGate = createApprovalGate(),
): RunnerDeps {
  return {
    loadConfig,
    makeSessionStore: createJsonSessionStore,
    buildCallModel: realBuildCallModel,
    makeSummarize: (config) => makeSummarizer(makeCallModel(config, {})),
    verify: (config, input) => makeVerifier(makeCallModel(config, {}))(input),
    // 抽取用**主模型**、空工具表。
    //
    // 空工具表是要紧的：抽取只要一段 JSON，给它工具会让它试着去调
    // （摘要和核查那两个也是空表，同一个理由）。
    //
    // 用主模型而不是 fallbackModel：抽取的质量直接决定记忆的质量，而记错
    // 一条会污染之后每一次对话。省钱的地方在「多数轮次不调用」
    // （runTurn 里那三道短路），不在「用更差的模型」。
    makeExtract: (config) => makeExtractor(makeCallModel(config, {})),
    runAgent: realRunAgent,
    registry,
    emit,
    gate,
  }
}

export function createAgentRunner(deps: RunnerDeps): AgentRunner {
  // 按会话并发 —— 全局锁的理由只有「会话文件是读-改-写」，但文件本身是
  // 按会话分的，不同会话的请求根本不冲突。串行锁让用户没法同时问两个问题，
  // 完全是设计缺陷不是限制。
  /** 正在跑的会话 ID 集合。 */
  const running = new Set<string>()
  /** sessionId → 它那一轮的取消令牌（一次性，每轮新建）。 */
  const tokens = new Map<string, CancelToken>()
  /** sessionId → 它那一轮的 promise，给 settled(id) 用。 */
  const inFlight = new Map<string, Promise<void>>()
  // 轮次序号，全局单调递增。只用来判断「一个异步结果回来时，它那一轮还是
  // 这个会话最近的一轮吗」—— 事后核查移到锁外之后需要这个判据，
  // 见 runTurn 末尾。用序号而不是时间戳：同一毫秒内开两轮时时间戳分不开。
  let seq = 0
  /** sessionId → 它最近开的那一轮的序号。 */
  const lastTurnOf = new Map<string, number>()

  /**
   * 只在比磁盘长时写，否则跳过。
   *
   * 孤儿轮次的存盘可能晚到几十秒（用户点完停止立刻又问了一句、新一轮已经
   * 答完存过盘了）。这时「短的覆盖长的」会把新的对话内容整个吃掉。读一次
   * 磁盘比一比：长了才写。
   *
   * 为什么「长度」是可靠的判据：会话文件只追加、永不变短（除了编辑重发，
   * 而那在有孤儿时不会发生 —— 停止后紧跟着的编辑是另一回事，这里按用户
   * 此刻的意图优先）。长度相等说明已经有人写过一样的，也不必重复写。
   */
  async function saveIfLonger(stores: SessionStore, id: string, messages: Message[]): Promise<void> {
    try {
      const current = await stores.load(id).catch(() => [] as Message[])
      if (messages.length > current.length) await stores.save(id, messages)
    } catch {
      // 存盘失败不该让取消路径再抛一层。这份是「尽力而为」——它是
      // 半截对话的存档，丢了用户会少看一段，但不该变成一次错误
    }
  }

  async function runTurn(sessionId: string, input: string, token: CancelToken, attachments?: ContentPart[], options: RunOptions = {}): Promise<void> {
    const mySeq = ++seq
    lastTurnOf.set(sessionId, mySeq)
    // 这一轮的提问时刻。取消路径存盘时要用它给 user 消息打戳 ——
    // 那里是几十秒之后，用当时的 Date.now() 会把提问标晚。
    const askedAt = Date.now()

    /**
     * 我还是这个会话最新的那一轮吗。
     *
     * 用户点停止时 cancel() 会把序号推进一格，于是这一轮立刻变成「孤儿」——
     * 它可能还在 SDK 里飘几秒（那次 HTTP 请求不由我们说停就停）。孤儿必须
     * 彻底闭嘴：再发 chunk 会让文字继续往界面上冒，再发 complete 会把
     * running 重新点亮，再写盘会把用户已经放弃的那轮存进历史。
     *
     * 这道闸就是「点了就停」能成立的前提 —— 见 cancel() 里的长注释。
     */
    const isCurrent = () => lastTurnOf.get(sessionId) === mySeq

    // 取消路径上也要存盘（保住已经产生的那几轮），所以 sessions 得在
    // try 外面拿得到。config 同理。
    let sessions: SessionStore | undefined
    let produced: Message[] | undefined

    /**
     * 这一轮已经流出去的正文和工具轨迹，runner 自己攒一份。
     *
     * ## 为什么 runner 必须自己攒
     *
     * 写盘是 runner 的职责，但「已经产生了什么」原来只有两个地方知道：
     * runAgent 内部那个 messages 数组（src/ 冻结，拿不到），和 renderer
     * 累积的那份（那不是权威副本）。所以取消时 runner 只能存下用户的提问，
     * **流出来的半截回答直接丢了** —— 用户看着屏幕上有半段文字，刷新之后
     * 那段就没了。而「上次干到哪儿了」正是他最想回看的东西。
     *
     * 攒的东西同时解决另一个 bug：编辑重发按「第几条 user」定位磁盘位置
     * （truncate.ts），如果取消的轮次在磁盘上缺失，界面上的第 4 个气泡
     * 在磁盘上可能只是第 2 条 user —— 一砍就把后面几轮全砍了。
     * 只要每一轮都落盘（哪怕不完整），两边的 user 计数就始终对齐。
     */
    const streamedUsage: import('../../src/types').TokenUsage[] = []
    let streamedText = ''
    const streamedTools: Message[] = []
    /**
     * 这一轮模型自己调过 remember 吗。
     *
     * 用来短路自动提取：模型已经记了就不必再花一次调用去抽 —— 那是
     * 「两道保险」里省钱的关键（见 src/memory/extract.ts 的文件头）。
     */
    let calledRemember = false
    /** 进入这一轮时磁盘上的历史。catch 里做基准用，见那边的注释。 */
    let history: Message[] = []
    // 事后核查的入料。带出 try 是为了让核查在**锁外**跑 —— 见下面
    // finally 之后那段。
    let pendingVerify: { config: Config; input: VerifyInput } | null = null
    /**
     * 自动提取的入料。和 pendingVerify 一样带出 try —— 提取也要在锁外跑
     * （它是一次完整的模型调用），理由见下面 finally 之后那段。
     */
    let pendingExtract: { config: Config; answer: string } | null = null
    try {
        // 外部 CLI 自己管理登录和模型调用，不能先用内置模型的 Key 校验拦截。
        const externalProvider = options.projectOverview ? null : deps.resolveProvider?.(sessionId)
        const baseConfig = deps.loadConfig({ allowMissingApiKey: Boolean(externalProvider) })
        const config = options.projectOverview
          ? { ...baseConfig, systemPrompt: PROJECT_OVERVIEW_PROMPT, nativeSearch: undefined, autoExtractFacts: false }
          : baseConfig
        sessions = deps.makeSessionStore(config.sessionsDir)
        history = await sessions.load(sessionId)

        // 上层已取消（窗口关了 / 用户在 IPC 往返期间按了停止）—— 往下跑没意义。
        // 静默返回不发事件：这不是错误，也不该往历史里塞东西。
        if (token.isCancelled()) return

        // 这一轮由谁来跑：外部 CLI（ACP）还是内置 agent。
        //
        // 回落到内置而不是报错：resolveProvider 返回 null 的情况是「那个
        // provider 被删了 / 配置改坏了」，而用户此刻只是想问句话。
        // 静默回落 + 内置能答，好过让这一轮失败。
        //
        // 内置每轮新建而不是构造 runner 时建一个：它无状态（历史每轮显式传），
        // 重建的代价只是建一个 client；而缓存它反而要处理「MCP 工具热插进来
        // 之后什么时候失效」。外部反过来 —— 那边按 (provider, 模型) 缓存，
        // 见 provider/registry.ts。
        // 文件工具按这个会话的工作目录取。没有工作目录（未分组会话）返回空注册表。
        const cwd = deps.resolveCwd?.(sessionId)
        const fsTools = externalProvider ? {} : (await deps.fsPool?.forDir(cwd)) ?? {}

        // 记忆工具按轮建，理由和 fsTools 一样：它们要知道「这一轮属于哪个
        // 会话、哪个项目」。在 createRuntime 里建一次的话 sessionId 和
        // projectScope 会被启动那一刻的值定死 —— 那时候连会话都还没选。
        const projectScope = scopeFor(cwd)
        const memoryTools: ToolRegistry = deps.facts && !externalProvider
          ? (() => {
              const remember = makeRememberTool({
                persist: (input) => deps.facts!.remember(input),
                sessionId,
                projectScope,
              })
              const recall = makeRecallTool({
                getAllFacts: () => deps.facts!.getAll(),
                projectScope,
              })
              const forget = makeForgetTool({
                forget: (key, scope) => deps.facts!.forget(key, scope),
                getAllFacts: () => deps.facts!.getAll(),
                projectScope,
              })
              return {
                [remember.name]: remember,
                [recall.name]: recall,
                [forget.name]: forget,
              }
            })()
          : {}

        const composedRegistry: ToolRegistry = options.projectOverview
          ? Object.fromEntries(Object.entries(fsTools).filter(([name]) => OVERVIEW_READ_TOOLS.has(name)))
          : { ...deps.registry, ...fsTools, ...memoryTools }
        if (options.projectOverview && (!cwd || !['read_file', 'read_text_file'].some((name) => name in composedRegistry))) {
          throw new Error('项目文件工具不可用，请检查本地目录与文件工具连接后重试')
        }

        // 这家厂商自带服务端搜索的话，撤掉我们自己那个 web_search。
        //
        // 留着两个的后果不是「多一个选择」而是**更差**：模型会在两条路之间
        // 乱挑，而我们那个在没配 Brave/Tavily 时只能搜维基百科 —— 厂商自带
        // 的是全网。给它一个更差的同名选项没有意义。
        //
        // fetch_url 不撤：抓具体网址和搜索是两件事，服务端搜索不覆盖
        // 「把这个链接读一下」。
        //
        // 放在每轮而不是启动时：用户可以在 composer 上随时换厂商，
        // 从智谱切到 DeepSeek 之后我们的 web_search 得回来。
        if (config.nativeSearch && config.nativeSearch.kind !== 'none') {
          delete composedRegistry.web_search
        }

        // 这个会话绑的自定义 agent（一套预设：系统提示 + 工具白名单）。
        //
        // 只对内置 provider 生效 —— 外部 CLI 有它自己的系统提示，我们插不进去
        // （见 agents.ts 的文件头「为什么它不是一个新的 Provider」）。
        //
        // 顺序要紧：**在**撤 web_search 之后过白名单。反过来的话，一个白名单里
        // 写了 web_search 的 agent 在智谱那种自带搜索的厂商下会把它加回来，
        // 而那个工具此刻不该存在。
        const agent = options.projectOverview || externalProvider ? undefined : deps.resolveAgent?.(sessionId)
        const agentConfig = agent ? applyAgent(agent, config) : config
        const turnRegistry = agent ? filterTools(agent, composedRegistry) : composedRegistry

        // ## 把记下的事实注入系统提示
        //
        // 注入系统提示而不是往 history 前面插一条消息 —— 后者会引入一个真实的
        // bug：onComplete 把整个 messages 存回磁盘，下一轮它就在 history 里了，
        // 然后又插一次 → 每轮重复一份，越滚越多。而 builtin.ts 存盘时有
        // `filter(m => m.role !== 'system')`，走系统提示自动免疫。
        //
        // （现有那个 `【之前对话摘要】` 就是插 history 的，它是 role:'user'、
        //  会被持久化 —— 所以它污染了标题推导，那个 bug 上一轮才修。）
        //
        // 预算从 maxContextTokens 里**扣掉**：不扣的话记忆会挤占历史，
        // 而 compactMessages 不知道系统提示里多了东西，两边加起来超窗。
        // 取 1/8 且不超过 800 —— 记忆是配角，不该吃掉历史的位置。
        const factsBudget = Math.min(800, Math.floor(agentConfig.maxContextTokens / 8))
        const memoryBlock = deps.facts && !options.projectOverview && !externalProvider
          ? renderFacts(factsFor(deps.facts.getAll(), projectScope), factsBudget)
          : ''
        const turnConfig = memoryBlock
          ? {
              ...agentConfig,
              systemPrompt: `${agentConfig.systemPrompt}\n\n${memoryBlock}`,
              // 历史的预算要减去记忆实际占的那部分
              maxContextTokens: Math.max(
                1000,
                agentConfig.maxContextTokens - estimateTokens([{ role: 'system', content: memoryBlock }]),
              ),
            }
          : agentConfig

        const provider =
          externalProvider ??
          createBuiltinProvider({
            buildCallModel: deps.buildCallModel,
            makeSummarize: deps.makeSummarize,
            runAgent: deps.runAgent,
            registry: turnRegistry,
            gate: deps.gate,
            onApprovalRequest: (event) => deps.emit.approvalRequest(event),
            permission: options.projectOverview ? 'readonly' : deps.resolvePermission?.(sessionId),
            // 在审批装饰之后造 task 工具 —— 见 builtin.ts 里那个字段的注释。
            //
            // 每轮重造而不是缓存：子 agent 清单可以在设置里改，
            // 而缓存它就要处理失效通知。
            makeTaskTool: (guardedRegistry, turnCfg) => {
              const subagents = options.projectOverview ? [] : deps.resolveSubagents?.(sessionId) ?? []
              if (subagents.length === 0) return null
              return makeTaskTool({
                agents: subagents,
                baseConfig: turnCfg,
                baseRegistry: guardedRegistry,
                buildCallModel: (c, r) => deps.buildCallModel(c, r, () => {}, () => {}),
                runAgent: deps.runAgent,
                token,
                onProgress: (result) =>
                  deps.emit.toolCall({
                    sessionId,
                    turn: 0,
                    toolName: `task:${result.agent}`,
                    args: { task: result.task },
                    output: result.ok ? result.output : `失败：${result.output}`,
                  }),
              })
            },
          })

        // provider 产出的事件翻译成 IPC 事件。
        //
        // 这一层留在 runner 里而不是让 provider 直接发 IPC：provider 只该知道
        // 「发生了什么」，不该知道有哪些频道、哪个频道要带 sessionId。
        // 现有的 8 个频道一个都没动 —— renderer 侧零改动的前提。
        const onEvent = (e: TurnEvent) => {
          // 孤儿轮次闭嘴：用户点停止之后这一轮可能还在飘，它吐出来的
          // 文字/工具结果不该再上界面（见 isCurrent 的注释）
          if (!isCurrent()) return
          switch (e.kind) {
            case 'usage':
              streamedUsage.push(e.usage)
              deps.emit.chunk({ sessionId, text: '', usage: e.usage })
              break
            case 'delta':
              // 攒一份：取消时要靠它把「已经流出来的半截回答」写进历史
              streamedText += e.text
              deps.emit.chunk({ sessionId, text: e.text })
              break
            case 'tool-call':
              // 只有**成功**的 remember 才算 —— 失败的调用不能触发短路，
              // 否则那条事实两条路都记不上（见 rememberSucceeded 的注释）
              if (e.name === 'remember' && rememberSucceeded(e.output)) calledRemember = true
              // 同上。存成磁盘的形状（带 toolCalls 的 assistant + tool 结果），
              // 这样 hydrate.ts 那套还原算法不用为「中断的轮次」开特例。
              //
              // toolCallId 用 name+序号拼：真实的 id 由模型给，而 TurnEvent
              // 没带它（那个字段在 src/agent.ts 内部）。这里只要求「同一轮内
              // 唯一、且 assistant.toolCalls 和 tool 消息能对上」——
              // hydrate 靠顺序分组，不解析这个 id。
              {
                const callId = `${e.name}-${streamedTools.length}`
                streamedTools.push({
                  role: 'assistant',
                  content: '',
                  toolCalls: [{ id: callId, name: e.name, args: e.args }],
                })
                streamedTools.push({
                  role: 'tool',
                  content: e.output,
                  toolCallId: callId,
                  name: e.name,
                })
              }
              deps.emit.toolCall({
                sessionId,
                turn: e.turn,
                toolName: e.name,
                args: e.args,
                output: e.output,
                elapsedMs: e.elapsedMs,
              })
              break
            case 'cache-hit':
              deps.emit.cacheHit({ sessionId })
              break
            case 'notice':
              // 外部 CLI 的状态提示（「正在起子进程」之类）。现在还没有 provider
              // 会发它 —— 内置 agent 没有这类状态。等 ACP 接进来时它需要一条
              // 显示通路，那时再决定是新开一个频道还是复用 chunk；在此之前
              // 记一行日志，比静默丢掉好排查
              console.log(`[provider] ${e.text}`)
              break
          }
        }

        const { answer, evidence } = await provider.runTurn({
          question: input,
          attachments,
          sessionId,
          history,
          // 应用过自定义 agent 预设的那份（没绑 agent 时就是原样）
          config: turnConfig,
          cwd: deps.resolveCwd?.(sessionId),
          emit: onEvent,
          token,
          // 存盘也要过闸：用户点停止之后这一轮的答案不该进历史 ——
          // 他已经放弃它了，写进去下次打开还会看到
          onComplete: (messages) => (isCurrent() ? sessions!.save(sessionId, messages) : Promise.resolve()),
        })

        // 孤儿的答案丢掉。不判的话它会把 running 重新点亮 ——
        // 用户点了停止、界面恢复了，几秒后又冒出一条完整回答
        if (!isCurrent()) return

        deps.emit.complete({ sessionId, text: answer })

        // 只在真的调过工具时核查：纯聊天没有证据可比对，白花一次模型调用。
        // 外部 CLI 永远走这条短路 —— 它自己管工具，我们拿不到可比对的证据
        // （见 provider/types.ts 里 TurnResult.evidence 的注释）
        //
        // ⚠️ 这里只**记下要核查什么**，不在这里 await。核查是一次完整的
        // LLM 调用（可能好几秒），而此刻 complete 已经发出去了 —— 前端认为
        // 这轮结束、composer 恢复可用。如果核查在锁内跑，这几秒里前端和
        // 主进程的认知是矛盾的：用户去另一个会话发消息会撞上 busy，吃一个
        // 「上一个问题还在处理中」，而屏幕上那个会话明明已经答完了，
        // 他根本找不到是谁在处理。真实的 bug，见 tests/electron/turn-state.test.ts。
        //
        // 存盘已经在 provider.runTurn 的 onComplete 里落完了，这一轮对状态的
        // 影响到此为止；核查只是给答案贴个质量标注，没有理由占着串行锁。
        if (!externalProvider && evidence.length > 0) {
          pendingVerify = { config, input: { question: input, answer, evidence } }
        }

        // 自动提取事实。同样只记下入料，在锁外跑（见 pendingVerify 那段的理由）。
        //
        // ## 三道短路，为的是不给多数轮次白花一次调用
        //
        // 绝大多数轮次里用户什么持久事实都没说（「帮我改这个文件」「这段
        // 代码什么意思」）。每轮都提取意味着请求数翻倍，而收获接近零。
        //
        //   1. 功能关了 —— 用户在设置里可以关掉（AUTO_EXTRACT_FACTS）
        //   2. 模型已经自己调过 remember —— 它记了就不必再抽一遍
        //   3. 用户这句话太短 —— 12 个字符以下几乎不可能包含一条完整事实
        //      （「好的」「继续」「谢谢」「跑一下测试」），而这类短消息在
        //      真实对话里占很大比例
        if (
          !externalProvider &&
          deps.facts &&
          deps.makeExtract &&
          turnConfig.autoExtractFacts !== false &&
          !calledRemember &&
          input.trim().length >= 12
        ) {
          pendingExtract = { config: turnConfig, answer }
        }
      } catch (err) {
        // 取消和真错误分流。用 isCancelled 顺 cause 链判类型，不比字符串 ——
        // 否则「网络挂了」会被静默显示成「已停止」，用户以为是自己点的。
        if (isCancelled(err)) {
          // ## 中断的那一轮也要完整落盘
          //
          // 原来这里只存 `[...history, user]` —— 用户的提问进去了，**已经流
          // 出来的那半截回答丢了**。用户看着屏幕上有半段文字，刷新之后只剩
          // 自己的问题，那半段凭空消失。
          //
          // 现在把 runner 自己攒的那份一起写进去（streamedText / streamedTools，
          // 见它们的声明）。顺序按磁盘的约定排：
          //   user → [带 toolCalls 的 assistant → tool 结果]* → 有正文的 assistant
          // 这样 hydrate.ts 那套还原算法不用为中断的轮次开特例。
          //
          // 半截回答后面缀一个「（已停止）」标记：不加的话下次打开看到一句
          // 半途而止的话，分不清是「当时被我停掉了」还是「模型就答成这样」。
          //
          // **这段必须在 isCurrent() 判断之外**：用户点停止时 cancel() 已经
          // 把序号推进了，isCurrent() 此刻是 false —— 放进去的话这段永远
          // 跑不到，而它恰恰是取消路径唯一的存盘机会。
          if (sessions) {
            const partial: Message[] = [
              userMessage(input, attachments, askedAt),
              ...streamedTools,
              ...((streamedText || streamedUsage.length)
                ? [{
                    role: 'assistant' as const,
                    content: `${streamedText}\n\n_（已停止）_`,
                    usages: streamedUsage,
                    timestamp: Date.now(),
                  }]
                : []),
            ]
            // 用**进入这一轮时读到的** history 当基准，而不是此刻重新读盘。
            //
            // 重新读的话有个覆盖风险：孤儿的 catch 可能晚到几十秒，而用户
            // 点完停止立刻又问了一句、那一轮已经答完存过盘了。这时读到的
            // 磁盘里已经含新一轮，往后追加自己这半截 → 顺序错乱
            // （第二个提问排在第一个中断轮次的前面）。
            //
            // 拿进入时的 history 当基准，再用 saveIfLonger 挡住「短的覆盖长的」，
            // 两条一起保证孤儿写不坏后来者。
            produced = [...history, ...partial]
            await saveIfLonger(sessions, sessionId, produced)
          }
          // ⚠️ **不**在这里 emit.cancelled —— 用户点停止时 cancel() 已经
          // 同步发过了（那是「点了就停」的关键，见那边的注释）。这里再发
          // 一次是重复事件。
          //
          // 而如果走到这里但 isCurrent() 仍为真，说明取消来自别处
          // （窗口关闭、删除会话时的 gate.cancelSession），那条路没人发过
          // 事件，得由这里补上。
          if (isCurrent()) deps.emit.cancelled({ sessionId })
        } else if (isCurrent()) {
          // 孤儿的报错也丢掉：用户已经放弃这一轮了，给他一条红色报错
          // 只会让他以为「停止」把什么弄坏了
          deps.emit.error(toErrorEvent(sessionId, err))
        }
      } finally {
        // 只有还是当前那一轮才清 —— 否则会把 cancel() 之后**新开的**那一轮
        // 的锁误删掉（用户点停止、立刻重新提问，那是很自然的操作）。
        // cancel() 已经替孤儿清过一次了。
        if (isCurrent()) {
          running.delete(sessionId)
          tokens.delete(sessionId)
          inFlight.delete(sessionId)
        }
      }

      // --- 锁已经放了，事后核查在这里跑 ---
      //
      // 为什么在锁外：见上面 pendingVerify 那段。简述 —— 核查是一次完整的
      // LLM 调用，而 complete 已经发出去了；占着锁的话用户去别的会话发消息
      // 会吃一个「上一个问题还在处理中」，而那个会话明明已经答完。
      //
      // 代价是这里要自己处理两件锁内不用管的事：
      //
      // 1. **贴错消息**。核查回来时下一轮可能已经开跑了，那时 reducer 的
      //    withAssistant 会把 verdict 贴到**新那轮**的回答上（它只认「最后
      //    一条 assistant」）。所以先确认这个会话最近开的还是我这一轮，
      //    不是就丢掉 —— verdict 是给答案贴的质量标注，对话都往下走了，
      //    一个迟到的标注没有价值，贴错位置反而是错的信息。
      //
      // 2. **核查自己失败**。原来它在 try 里，抛出会走 catch 分支 emit.error，
      //    于是用户看到一条红色报错、而回答好好地在屏幕上 —— 那是误报。
      //    答案已经交付了，核查失败只该让标注缺席，不该变成这一轮的错误。
      if (pendingVerify) {
        try {
          const verdict = await deps.verify(pendingVerify.config, pendingVerify.input)
          // 判断必须在核查**返回之后**做，不能在调用之前 —— 之前那一刻
          // 从 finally 到这里没有 await，单线程下不可能有别的轮插进来，
          // 检查恒为真、是死代码。真正的窗口是核查那几秒。
          if (isCurrent()) {
            deps.emit.verdict({ sessionId, ...verdict })
          }
        } catch {
          // 静默跳过，理由见上面第 2 点
        }
      }

      // --- 自动提取事实（也在锁外）---
      //
      // 和核查同一套约束：一次完整的模型调用，所以不能占着锁；回来时可能
      // 已经不是当前那一轮了，所以要判 isCurrent()；失败必须静默 ——
      // 提取是增强，它坏掉不该有任何用户可见的后果。
      //
      // 顺序在核查之后：核查的结果要贴到消息上（用户看得见），提取只是往
      // 磁盘写。让看得见的那个先到。
      //
      // ## isCurrent() 挡得住什么、挡不住什么
      //
      // 挡得住「同一会话开了新一轮」—— 那时旧轮的抽取结果属于一段已经被
      // 覆盖的对话（用户可能正是因为答得不对才重问的），写进去会污染记忆。
      //
      // **挡不住取消**：cancel() 第一行是 `tokens.get(sessionId)`，而这里
      // 已经在 finally 之后，tokens 早清空了 —— cancel 返回 false，序号也
      // 不推进。所以用户点停止之后，这个抽取仍然会写一次。
      //
      // 这是已知且有界的：最多一条事实，而且用户在设置的记忆页看得见、
      // 能删。要彻底堵住得让 cancel 能触达锁外任务（每轮一个独立的
      // AbortController），那是另一个改动 —— verify 也有同一个缺口。
      if (pendingExtract && deps.makeExtract && deps.facts) {
        try {
          // 用这一轮那份 config 建 —— 它已经应用过自定义 agent 的预设
          const found = await deps.makeExtract(pendingExtract.config)({
            userMessage: input,
            answer: pendingExtract.answer,
            existing: deps.facts.getAll(),
          })

          // 回来时这一轮可能已经被取消、或者用户又问了新的 —— 那时写进去的
          // 事实属于一段用户已经放弃的对话
          if (isCurrent()) {
            const projectScope = scopeFor(deps.resolveCwd?.(sessionId))
            for (const f of found) {
              deps.facts.remember({
                key: f.key,
                value: f.value,
                scope: resolveScope(f.scope, projectScope),
                sessionId,
              })
            }
            // 提取到东西时报一个工具调用事件 —— 让用户**看得见**记忆被改了。
            //
            // 这一条是刻意的：自动提取在背后写用户的长期记忆，不给任何反馈
            // 的话它就是个隐形的副作用。而记忆写错的代价是污染之后每一次
            // 对话（见设置面板那一页的理由），所以宁可多一张卡片。
            if (found.length > 0) {
              deps.emit.toolCall({
                sessionId,
                turn: 0,
                toolName: 'remember',
                args: { auto: true },
                output: found.map((f) => `记下：${f.value}`).join('\n'),
              })
            }
          }
        } catch {
          // 静默 —— 见上面
        }
      }
  }

  return {
    /** 某个会话是不是正在跑。 */
    isBusy: (sessionId: string) => running.has(sessionId),
    /** 哪些会话正在跑（数组，按开始顺序）。 */
    runningSessionIds: () => Array.from(running),

    cancel(sessionId) {
      const token = tokens.get(sessionId)
      if (!token) return false

      // ## 点了就停，不等那一轮自己收尾
      //
      // 原来这里只做 `token.cancel()` —— 置个标志，然后**等**那一轮自己
      // 走到某个检查点、抛出、被 catch、才 emit.cancelled。实测那个延迟很长：
      // 用户点了 11 次停止，那一轮才终于抛出来（日志里 22 行取消请求夹在
      // 一次 provider 和一次 catch 之间）。界面全程显示「Agent 正在处理」，
      // 所以用户以为按钮是摆设 —— 他没有错，那个行为就是错的。
      //
      // 为什么延迟躲不掉：这一轮的执行权此刻在别人手里 —— SDK 内部、
      // undici 内部、某个工具的 await 里。我们能做的只是「请求它停」，
      // 而它什么时候回来看这个请求不由我们决定。前几轮我一直在往这条路上
      // 加检查点（轮边界、工具之间、AbortSignal），那只能缩短延迟，
      // 消除不了它。
      //
      // 所以换个方向：**不缩短延迟，而是让延迟不再可见**。这一轮此刻就被
      // 宣布死亡 —— 锁释放、事件发出、界面立刻恢复。那个还在飘的请求成了
      // 孤儿：它之后无论抛错还是返回答案，都会被 lastTurnOf 那道闸拦掉
      // （见 runTurn 的 finally 和 emitIfCurrent）。
      //
      // 代价是那次 HTTP 请求可能还在后台跑几秒（AbortSignal 会尽快掐掉它，
      // 但不保证立刻）。那是**不可见**的代价：不占锁、不发事件、不写盘。
      // 用户要的是「立刻能接着用」，不是「后台绝对干净」。
      token.cancel()

      // 同步宣布死亡。顺序要紧：先移出 running（锁立刻可用），再发事件。
      running.delete(sessionId)
      tokens.delete(sessionId)
      inFlight.delete(sessionId)
      // 把序号推进一格 —— 这是那道闸的钥匙。孤儿轮次手里的 mySeq 从此
      // 不再等于 lastTurnOf，它发的任何东西都会被丢掉。
      lastTurnOf.set(sessionId, ++seq)
      deps.emit.cancelled({ sessionId })
      return true
    },

    /** 等这个会话那一轮彻底结束（存盘完成）。没在跑时立刻返回。 */
    settled: (sessionId: string) => inFlight.get(sessionId) ?? Promise.resolve(),

    run(sessionId, input, attachments, options) {
      // 按 session 拒绝，不是全局：**同一个**会话并发会互相覆盖（会话文件是
      // 读-改-写、整体覆写），不同会话之间没有共享状态，可以同时跑。
      if (running.has(sessionId)) {
        deps.emit.error({ sessionId, code: 'BUSY', message: '上一个问题还在处理中，请稍候' })
        return Promise.resolve()
      }
      // ⚠️ 锁必须在这里**同步**拿到，不能挪进 runTurn。那边第一句 await
      // （sessions.load）之前有一个事件循环空档，同一会话连发两条的话两次
      // 检查都会通过，然后两轮并发读-改-写同一个文件、后写的覆盖前写的。
      const token = new CancelToken()
      running.add(sessionId)
      tokens.set(sessionId, token)
      // 存下 promise：settled(id) 要能从外面拿到它，删除正在跑的会话靠它
      // 等存盘落完（见 settled 的注释）。runTurn 内部有 await，所以这一句
      // 一定在它的 finally 之前跑到。
      const promise = runTurn(sessionId, input, token, attachments, options)
      inFlight.set(sessionId, promise)
      return promise
    },
  }
}
