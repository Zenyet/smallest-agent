# 上下文圆环

输入框右下角显示 20px SVG 圆环，100% 为完整圆周；80% 橙色、95% 红色。未知用量或容量展示破折号，不伪装成零。鼠标悬停或键盘聚焦显示模型、已用/容量、剩余量和草稿估算。

分子为最近一次已完成请求的输入 Token；不是累计账单，不包括随后输出与新草稿。分母是当前 Provider + 精确模型 ID 对应的模型容量，不使用 MAX_CONTEXT_TOKENS（历史压缩阈值）。更换模型或 Provider 后，之前模型的数据不再作为该模型的用量。旧记录没有 vendorId 时等待新请求。外部 CLI 尚无用量接入，显示容量和未上报状态。

容量优先读取模型描述 contextWindow，其次读取核查后的目录。不通过名称前缀猜测未知型号。外部 providers.json 的每个 models 条目支持正整数 contextWindow，以适配实际服务配置。当前内置自定义端点仍没有容量编辑入口，未知型号保持未知。

核查日期：2026-09-09。静态目录不保证永久同步厂商更新；更改别名或部署参数时需要更新。资料来源：

- [OpenAI GPT-5.2](https://developers.openai.com/api/docs/models/gpt-5.2)、[GPT-5.1](https://developers.openai.com/api/docs/models/gpt-5.1)、[GPT-5](https://developers.openai.com/api/docs/models/gpt-5)、[GPT-5 mini](https://developers.openai.com/api/docs/models/gpt-5-mini)：400,000；[o3](https://developers.openai.com/api/docs/models/o3)：200,000；[GPT-4o](https://developers.openai.com/api/docs/models/gpt-4o)：128,000。
- [Claude 模型目录](https://platform.claude.com/docs/en/models/overview)：Opus 5、Sonnet 5 为 1M，Haiku 4.5 为 200K。未确认的旧别名不填。
- [Gemini 2.5 Pro](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro)、[Flash](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash)：输入上限 1,048,576。这里以官方输入上限作为输入容量。
- [GLM 4.6](https://docs.z.ai/guides/llm/glm-4.6)：200K；[GLM 4.5 / Air](https://docs.z.ai/guides/llm/glm-4.5)：128K。
- [Qwen3 Max](https://help.aliyun.com/zh/model-studio/model-qwen3-max)：262,144；[Qwen Max](https://help.aliyun.com/zh/model-studio/qwen-max)：32,768；[Qwen Plus](https://help.aliyun.com/zh/model-studio/qwen-plus)：1,000,000；[Qwen Turbo](https://help.aliyun.com/zh/model-studio/qwen-turbo)：131,072。取页面当前别名，不取旧快照。
- [MiniMax M2](https://platform.minimax.io/docs/guides/text-generation)：204,800。
- [Grok 模型迁移](https://docs.x.ai/developers/migration/may-15-retirement)：grok-3 已转发到 1M 容量的 Grok 4.3。
- [DeepSeek 当前入口](https://api-docs.deepseek.com/) 已转到 V4 型号，旧 chat/reasoner 当前容量无法确认，因此未用旧 64K/128K 数据冒充当前容量。Kimi 及其余未确认型号同样保留未知。
