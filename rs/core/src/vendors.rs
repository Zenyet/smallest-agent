// ============================================================================
// vendors.rs —— 模型厂商目录 + 自定义端点
// ----------------------------------------------------------------------------
// 这个文件解决的问题：整个 app 原来写死了 DeepSeek —— Config 里就是
// `api_key` / `base_url` / `model` 三个裸字段，配置页上是
// `DEEPSEEK_API_KEY` 这种键名。想换厂商得手改 base_url，而每家的 key
// 又只能存一个。
//
// ## 为什么一套 OpenAI 兼容的调用就够
//
// 下面列的这些厂商**都提供 OpenAI 兼容端点**（`POST {base}/chat/completions`，
// bearer 认证，同一套 tool_calls 协议）。所以 llm/mod.rs 那套请求构造
// 一个字都不用改，只需要换 (base_url, api_key, model) 三元组。
//
// 这是和「每家写一个适配器」相对的取舍，和 provider/acp.rs 里那条同形：
// 覆盖面换独有能力。代价是拿不到各家的原生特性（Anthropic 的 thinking
// 块、Gemini 的多模态入参），要用那些就得单独走各家 SDK。
//
// ## 模型清单会过期，这是设计的一部分
//
// 各家出新模型的节奏比这个仓库更新的节奏快，而 OpenAI 兼容端点里
// **没有可靠的模型发现接口**（`GET /models` 各家返回的东西差别很大，
// 有的把 embedding 和废弃模型也列出来）。所以：
//
//   • 这里的清单是**起点**，不是权威列表
//   • 想用清单外的模型，走「自定义端点」那一栏自己填
//   • 我没有逐个核实下面每个 id 在今天是否可用 —— 填错的后果是
//     调用时报 model not found，改一行就好，不会静默出错
//
// ## 为什么内置厂商没有「API 端点」这一栏（原来有，删掉了）
//
// 第一版给九家每家配了一个 `*_BASE_URL` 覆盖键，设置页上于是是九对
// 「API Key + API 端点」。那一栏没有意义：
//
//   • `api.deepseek.com` 不会变。把它做成一个空输入框，只会让人
//     停下来想「这儿该填什么」——而正确答案是「什么都不填」
//   • 真正要换端点的场景（第三方聚合站、公司内网代理、本地
//     Ollama / LM Studio / vLLM）根本不是「改 DeepSeek 的地址」：
//     那些地方的 key、计费、模型清单全是另一套，它是**另一个 provider**，
//     不是某一家的变体
//
// 所以九个覆盖键换成一个真正的条目：见下面 CUSTOM_ID 那一段。
// 副作用记一下：`DEEPSEEK_BASE_URL` / `ANTHROPIC_BASE_URL` 这类环境变量
// 在 rs 这边**不再被读取**（TS 版还在用，那是另一套代码）。要指别的地址
// 就用自定义端点，它读的是 CUSTOM_BASE_URL。
// ============================================================================

use serde::{Deserialize, Serialize};

/// 一个模型（静态表里的）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VendorModel {
    /// 发给 API 的那个 id（`deepseek-chat`）
    pub id: &'static str,
    /// 界面上显示的名字（`DeepSeek Chat`）
    pub name: &'static str,
}

/// 厂商自带的联网搜索怎么开。
///
/// ## 为什么要有这个（这是「一把 key 就能用」的关键）
///
/// 自己实现一套搜索意味着用户**除了模型的 key 还得再去注册一家搜索服务**，
/// 而那不是同类软件的做法 —— 大部分厂商已经在自己的 chat/completions
/// 上提供了服务端搜索，用同一把 key、同一个端点、同一份账单。
///
/// 各家开关的形状不一样（下面三种都是实测/查文档确认过的），
/// 但都只是往请求体里加一个字段，所以统一成这个枚举，
/// 由 llm/wire.rs 在组装请求时展开。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeSearch {
    /// 没有服务端搜索。这类厂商回落到我们自己那个 `web_search` 工具。
    None,
    /// 请求体里一个布尔开关：`"enable_search": true`。
    /// 阿里 DashScope 是这种。
    EnableFlag,
    /// tools 数组里加一项 `{"type": "<t>"}`。
    /// OpenRouter 的 `openrouter:web_search` 是这种，
    /// Anthropic / OpenAI 的 `web_search` 也是这个形状。
    ToolType(&'static str),
    /// tools 数组里加一项 `{"type":"builtin_function","function":{"name":"<n>"}}`。
    /// 月之暗面的 `$web_search` 是这种。
    ///
    /// 注意它和上面那种有个**行为差异**：模型会吐回一个 tool_call，
    /// 需要把 arguments 原样回传，服务端才真正执行搜索。
    /// 我们的循环会把它当成未知工具（registry 里没有），
    /// 于是回一个 error —— 所以这一档目前**只挂给确认能自洽的厂商**。
    BuiltinFunction(&'static str),
}

/// 一个内置厂商。
#[derive(Debug, Clone)]
pub struct Vendor {
    /// 内部 id，配置里引用它
    pub id: &'static str,
    /// 显示名
    pub name: &'static str,
    /// OpenAI 兼容端点的基址。**不含** `/chat/completions`。
    ///
    /// 固定值，没有覆盖键 —— 见文件头那段。要指别的地址用自定义端点。
    pub base_url: &'static str,
    /// 存 API key 用的设置键名。
    ///
    /// 每家一个键，所以用户可以同时配好几家、随时切换而不用来回粘 key ——
    /// 这是原来那套（只有一个 DEEPSEEK_API_KEY）做不到的事。
    pub key_env: &'static str,
    /// 去哪儿领 key。设置页上直接显示，省得用户自己搜
    pub console: &'static str,
    /// 这家自带的联网搜索怎么开。见 NativeSearch。
    pub native_search: NativeSearch,
    pub models: &'static [VendorModel],
}

/// 简写，让下面那张表读起来是一行一个模型。
const fn m(id: &'static str, name: &'static str) -> VendorModel {
    VendorModel { id, name }
}

// --- 各家的模型清单 ---
//
// 顺序有意义：**第一个是该厂商的默认模型**（用户没选时用它）。
// 所以每家第一行放它当前的主力型号，不是最便宜的也不是最贵的。

const DEEPSEEK: &[VendorModel] = &[
    m("deepseek-chat", "DeepSeek Chat"),
    m("deepseek-reasoner", "DeepSeek Reasoner"),
];

const ANTHROPIC: &[VendorModel] = &[
    m("claude-opus-5", "Claude Opus 5"),
    m("claude-sonnet-5", "Claude Sonnet 5"),
    m("claude-fable-5", "Claude Fable 5"),
    m("claude-opus-4-5", "Claude Opus 4.5"),
    m("claude-sonnet-4-5", "Claude Sonnet 4.5"),
    m("claude-haiku-4-5", "Claude Haiku 4.5"),
];

const OPENAI: &[VendorModel] = &[
    m("gpt-5.2", "GPT-5.2"),
    m("gpt-5.1", "GPT-5.1"),
    m("gpt-5", "GPT-5"),
    m("gpt-5-mini", "GPT-5 mini"),
    m("o3", "o3"),
    m("gpt-4o", "GPT-4o"),
];

const GEMINI: &[VendorModel] = &[
    m("gemini-3-pro", "Gemini 3 Pro"),
    m("gemini-2.5-pro", "Gemini 2.5 Pro"),
    m("gemini-2.5-flash", "Gemini 2.5 Flash"),
];

const GROK: &[VendorModel] = &[
    m("grok-4.1", "Grok 4.1"),
    m("grok-4", "Grok 4"),
    m("grok-3", "Grok 3"),
];

const GLM: &[VendorModel] = &[
    m("glm-4.6", "GLM-4.6"),
    m("glm-4.5", "GLM-4.5"),
    m("glm-4.5-air", "GLM-4.5-Air"),
];

const KIMI: &[VendorModel] = &[
    m("kimi-k2-thinking", "Kimi K2 Thinking"),
    m("kimi-k2-0905-preview", "Kimi K2"),
    m("moonshot-v1-128k", "Moonshot v1 128k"),
];

const QWEN: &[VendorModel] = &[
    m("qwen3-max", "Qwen3 Max"),
    m("qwen-max", "Qwen Max"),
    m("qwen-plus", "Qwen Plus"),
    m("qwen-turbo", "Qwen Turbo"),
];

const MINIMAX: &[VendorModel] = &[
    m("minimax-m2", "MiniMax M2"),
    m("abab6.5s-chat", "abab6.5s"),
];

/// 全部内置厂商。
///
/// DeepSeek 排第一是历史原因 —— 它是这个仓库原来唯一支持的那个，
/// 老用户的配置里只有它的 key，让它继续当默认值可以做到「升级之后
/// 什么都不用改」。
pub const ALL: &[Vendor] = &[
    Vendor {
        id: "deepseek",
        name: "DeepSeek",
        base_url: "https://api.deepseek.com/v1",
        key_env: "DEEPSEEK_API_KEY",
        console: "https://platform.deepseek.com/api_keys",
        native_search: NativeSearch::None,  // 搜索在 Responses API 上，不是 chat/completions
        models: DEEPSEEK,
    },
    Vendor {
        id: "anthropic",
        name: "Anthropic",
        // Anthropic 的 OpenAI 兼容层挂在 /v1 下。它**不覆盖**原生 API 的
        // 全部能力（thinking 块、prompt caching 的细粒度控制拿不到），
        // 但 chat + tool_calls 这条路是通的，也就是这个 app 用到的部分。
        base_url: "https://api.anthropic.com/v1",
        key_env: "ANTHROPIC_API_KEY",
        console: "https://console.anthropic.com/settings/keys",
        native_search: NativeSearch::None,  // 原生 API 有 web_search，但 OpenAI 兼容层不透传
        models: ANTHROPIC,
    },
    Vendor {
        id: "openai",
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
        key_env: "OPENAI_API_KEY",
        console: "https://platform.openai.com/api-keys",
        native_search: NativeSearch::None,  // 同上：搜索在 Responses API 那边
        models: OPENAI,
    },
    Vendor {
        id: "gemini",
        name: "Google Gemini",
        // Gemini 的 OpenAI 兼容层，注意路径里那个 openai/
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        key_env: "GEMINI_API_KEY",
        console: "https://aistudio.google.com/apikey",
        native_search: NativeSearch::None,  // google_search 只在原生 API，兼容层没有
        models: GEMINI,
    },
    Vendor {
        id: "grok",
        name: "xAI Grok",
        base_url: "https://api.x.ai/v1",
        key_env: "XAI_API_KEY",
        console: "https://console.x.ai",
        native_search: NativeSearch::None,  // Live Search 是独立参数集，兼容层不支持
        models: GROK,
    },
    Vendor {
        id: "glm",
        name: "智谱 GLM",
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        key_env: "ZHIPU_API_KEY",
        console: "https://open.bigmodel.cn/usercenter/apikeys",
        native_search: NativeSearch::ToolType("web_search"),
        models: GLM,
    },
    Vendor {
        id: "kimi",
        name: "月之暗面 Kimi",
        base_url: "https://api.moonshot.cn/v1",
        key_env: "MOONSHOT_API_KEY",
        console: "https://platform.moonshot.cn/console/api-keys",
        native_search: NativeSearch::None,  // $web_search 要回传 tool_call 才执行，见 BuiltinFunction 的注释
        models: KIMI,
    },
    Vendor {
        id: "qwen",
        name: "阿里通义千问",
        // 阿里的 OpenAI 兼容模式在 compatible-mode 这个路径下。
        // 用国际站（dashscope-intl）的走自定义端点。
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        key_env: "DASHSCOPE_API_KEY",
        console: "https://bailian.console.aliyun.com",
        native_search: NativeSearch::EnableFlag,
        models: QWEN,
    },
    Vendor {
        id: "minimax",
        name: "MiniMax",
        base_url: "https://api.minimax.chat/v1",
        key_env: "MINIMAX_API_KEY",
        console: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
        native_search: NativeSearch::None,
        models: MINIMAX,
    },
];

/// 默认厂商。见 ALL 上面那段关于 DeepSeek 的说明。
pub const DEFAULT_VENDOR: &str = "deepseek";

// ============================================================================
// 自定义端点
// ----------------------------------------------------------------------------
// 上面九家的对立面：地址、key、模型清单全由用户填。覆盖的是内置目录
// 表达不了的那几类：
//
//   • 第三方聚合站（OpenRouter、硅基流动、各种中转）
//   • 公司内网的网关
//   • 本地跑的（Ollama / LM Studio / vLLM）—— 这类通常**不校验 key**，
//     所以 key 那一栏对自定义端点是可空的，见 Selection::apply
//   • 内置某家的另一个站点（阿里国际站、Azure 上的 OpenAI）
//
// 它不是 `Vendor`：`Vendor` 的字段都是 `&'static str`，而这几个值
// 每次都要从设置里读。所以它作为一个特殊 id 存在，由 `entry()` 统一
// 解析成和内置厂商同形的 `VendorEntry`，调用方不用分两条路。
//
// ## 只有一个位
//
// 同时挂 Ollama 和 OpenRouter 的人会不够用。做成可增删的列表需要
// 一个独立文件 + 一个 CRUD 页（像 agents.json 那样），是另一件事；
// 这一个位覆盖的是「我有一个自己的端点」这条主线。
// ============================================================================

/// 自定义端点的厂商 id。**不在 `ALL` 里** —— 它没有静态字段可填。
pub const CUSTOM_ID: &str = "custom";
/// 显示名
pub const CUSTOM_NAME: &str = "自定义端点";
/// 设置键：OpenAI 兼容端点的基址，不含 `/chat/completions`
pub const CUSTOM_BASE_URL: &str = "CUSTOM_BASE_URL";
/// 设置键：API key。可空（本地服务通常不校验）
pub const CUSTOM_API_KEY: &str = "CUSTOM_API_KEY";
/// 设置键：模型 id 清单，分隔符见 `parse_models`
pub const CUSTOM_MODELS: &str = "CUSTOM_MODELS";

/// 设置键：自定义端点的联网搜索开关。
///
/// 自定义端点指向什么我们不知道，所以不能像内置厂商那样写死 ——
/// 但**最常见的那个（OpenRouter）是有服务端搜索的**，而且用同一把 key。
/// 值填 tool 的 type（`openrouter:web_search`），留空表示没有。
pub const CUSTOM_SEARCH_TOOL: &str = "CUSTOM_SEARCH_TOOL";

/// 自定义端点的设置键，按设置页上该出现的顺序。
pub const CUSTOM_KEYS: &[&str] =
    &[CUSTOM_BASE_URL, CUSTOM_API_KEY, CUSTOM_MODELS, CUSTOM_SEARCH_TOOL];

// ============================================================================
// 解析
// ============================================================================

/// 取设置值用的闭包。
///
/// 桌面端传「查 settings.json」，CLI 传「查环境变量」，设置页传
/// 「读输入框当前值」—— 三处的来源不同，但都只需要 key → value 这一个能力。
/// 所以这一层只要一个闭包，vendors 这边不知道值是从哪儿来的。
pub type Lookup<'a> = &'a dyn Fn(&str) -> Option<String>;

/// 取一个值并 trim。空白等于没填 —— 一个只有空格的 key 不该算配好了。
fn val(get: Lookup<'_>, key: &str) -> String {
    get(key).unwrap_or_default().trim().to_string()
}

/// 一个可选模型（显示用，字符串是拥有的）。
///
/// 和 `VendorModel` 的区别只在生命周期：内置的是静态表里的
/// `&'static str`，自定义端点的是用户刚敲进去的 String。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelChoice {
    pub id: String,
    pub name: String,
}

/// 一个厂商解析之后的样子 —— 内置九家和自定义端点在这里同形。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VendorEntry {
    pub id: String,
    pub name: String,
    /// 已经去掉末尾斜杠。llm/mod.rs 拼的是 `{base}/chat/completions`
    pub base_url: String,
    pub models: Vec<ModelChoice>,
    /// 这一家自带的联网搜索怎么开。
    ///
    /// 拥有的 String 而不是 NativeSearch：自定义端点那档的 tool type
    /// 是用户填的，不是 'static。
    pub search: SearchSupport,
}

/// NativeSearch 的「拥有」版本。理由见 VendorEntry::search。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum SearchSupport {
    /// 默认：没有服务端搜索。这个默认值让「不关心搜索」的调用方
    /// （测试、CLI）不用显式写这个字段
    #[default]
    None,
    EnableFlag,
    ToolType(String),
    BuiltinFunction(String),
}

impl SearchSupport {
    fn from_native(n: NativeSearch) -> Self {
        match n {
            NativeSearch::None => SearchSupport::None,
            NativeSearch::EnableFlag => SearchSupport::EnableFlag,
            NativeSearch::ToolType(t) => SearchSupport::ToolType(t.to_string()),
            NativeSearch::BuiltinFunction(n) => SearchSupport::BuiltinFunction(n.to_string()),
        }
    }
    pub fn is_some(&self) -> bool {
        !matches!(self, SearchSupport::None)
    }
}

/// 这个 id 是不是一个认识的厂商（含自定义端点）。
pub fn exists(id: &str) -> bool {
    id == CUSTOM_ID || find(id).is_some()
}

pub fn find(id: &str) -> Option<&'static Vendor> {
    ALL.iter().find(|v| v.id == id)
}

/// 显示名。自定义端点也有，所以调用方不用自己特判。
pub fn name_of(id: &str) -> Option<&'static str> {
    if id == CUSTOM_ID {
        return Some(CUSTOM_NAME);
    }
    find(id).map(|v| v.name)
}

/// 存这家 API key 的设置键名。
///
/// 有这个函数是为了让调用方不必再写 `if id == CUSTOM_ID` —— 原来
/// providers.rs 和设置页各写了一遍「哪个键存 key」，两处都得跟着改。
pub fn api_key_setting(vendor_id: &str) -> Option<&'static str> {
    if vendor_id == CUSTOM_ID {
        return Some(CUSTOM_API_KEY);
    }
    find(vendor_id).map(|v| v.key_env)
}

/// 内置厂商的默认模型 = 它清单里的第一个。自定义端点没有静态默认值。
pub fn default_model(vendor_id: &str) -> Option<&'static str> {
    find(vendor_id).and_then(|v| v.models.first().map(|m| m.id))
}

/// 所有内置厂商的 key 键名，给设置页生成输入框用。
pub fn key_envs() -> Vec<&'static str> {
    ALL.iter().map(|v| v.key_env).collect()
}

/// 把用户填的模型清单切成一个个 id。
///
/// 分隔符收得比较宽（中英文逗号、分号、换行）：这一栏的内容通常是从
/// 某个文档里粘过来的，粘进来是什么样不好预测，而**不认识分隔符的后果**
/// 是整串被当成一个模型 id，然后调用时报 model not found —— 一个
/// 完全看不出原因的错。
///
/// 刻意**不**按空格切：`qwen2.5:14b` 这类 id 里没有空格，但用户可能
/// 顺手写成 `llama3.1 (本地)`，按空格切会得到一个叫 `(本地)` 的模型。
pub fn parse_models(raw: &str) -> Vec<ModelChoice> {
    let mut out: Vec<ModelChoice> = Vec::new();
    for part in raw.split([',', '，', ';', '；', '\n', '\r']) {
        let id = part.trim();
        if id.is_empty() {
            continue;
        }
        // 重复的去掉：清单是手填的，粘两遍很常见，而两个同名项在
        // 选择器里会一起高亮（当前值是按 id 比的），看着像 bug
        if out.iter().any(|m| m.id == id) {
            continue;
        }
        out.push(ModelChoice {
            id: id.to_string(),
            // 没有别的名字可用。自定义端点的 id 本身就是用户认得的东西
            name: id.to_string(),
        });
    }
    out
}

/// 解析某一家。认不出 id 返回 None。
pub fn entry(id: &str, get: Lookup<'_>) -> Option<VendorEntry> {
    if id == CUSTOM_ID {
        return Some(VendorEntry {
            id: CUSTOM_ID.to_string(),
            name: CUSTOM_NAME.to_string(),
            // 末尾斜杠要去掉：llm/mod.rs 拼的是 `{base}/chat/completions`，
            // 用户粘进来的地址常带一个斜杠，不去就成了 `//chat/completions`
            base_url: val(get, CUSTOM_BASE_URL)
                .trim_end_matches('/')
                .to_string(),
            models: parse_models(&val(get, CUSTOM_MODELS)),
            search: match val(get, CUSTOM_SEARCH_TOOL).as_str() {
                "" => SearchSupport::None,
                t => SearchSupport::ToolType(t.to_string()),
            },
        });
    }
    let v = find(id)?;
    Some(VendorEntry {
        id: v.id.to_string(),
        name: v.name.to_string(),
        base_url: v.base_url.to_string(),
        models: v
            .models
            .iter()
            .map(|m| ModelChoice {
                id: m.id.to_string(),
                name: m.name.to_string(),
            })
            .collect(),
        search: SearchSupport::from_native(v.native_search),
    })
}

/// 模型选择器要显示的全部条目。
///
/// 内置九家**总是**在列（哪怕没配 key），自定义端点只在填了模型清单时出现 ——
/// 没填的话它一个模型都没有，出现在列表里也是个空组。
///
/// 「列出来的能不能真的用」不在这里判断：那是 `Selection::apply` 的事，
/// 它会报出缺的具体是什么（key 还是地址）。列表这边宽松、调用那边严格，
/// 是因为反过来会得到「我的模型填了怎么不出现」这种查不下去的现象。
pub fn catalog(get: Lookup<'_>) -> Vec<VendorEntry> {
    let mut out: Vec<VendorEntry> = ALL.iter().filter_map(|v| entry(v.id, get)).collect();
    if let Some(c) = entry(CUSTOM_ID, get)
        && !c.models.is_empty()
    {
        out.push(c);
    }
    out
}

/// 这家配好了没有。
///
/// 判据按类型不同：
///   • 内置厂商：填了 key 就算（地址是固定的）
///   • 自定义端点：地址 + 至少一个模型。**不要求 key** ——
///     本地跑的 Ollama / LM Studio 不校验 authorization
pub fn is_configured(vendor_id: &str, get: Lookup<'_>) -> bool {
    if vendor_id == CUSTOM_ID {
        let Some(e) = entry(CUSTOM_ID, get) else {
            return false;
        };
        return !e.base_url.is_empty() && !e.models.is_empty();
    }
    api_key_setting(vendor_id).is_some_and(|k| !val(get, k).is_empty())
}

/// 第一个配好的厂商。
///
/// 顺序是 `ALL` 的顺序，自定义端点排最后 —— 内置九家优先保证了
/// 「老配置（只有 DeepSeek key）行为不变」，而自定义端点是个显式选择，
/// 用户配了它通常也会去选它的模型，不需要靠这个兜底顺序抢到第一。
pub fn first_configured(get: Lookup<'_>) -> Option<String> {
    ALL.iter()
        .map(|v| v.id)
        .chain(std::iter::once(CUSTOM_ID))
        .find(|id| is_configured(id, get))
        .map(|id| id.to_string())
}

/// 一次调用要用哪个厂商、哪个模型。
///
/// ## 为什么是独立结构体而不是直接改 Config
///
/// Config 是**进程级**的（从环境变量读一次），而厂商和模型是**每个会话**
/// 各自选的。塞进 Config 意味着切会话要改全局配置，而那份配置还被
/// 缓存目录、会话目录之类的东西共用着。
///
/// 所以这一层单独存在：Config 提供除了这三个字段之外的一切，
/// Selection 覆盖这三个。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    /// 内置厂商的 id，或者 `CUSTOM_ID`
    pub vendor_id: String,
    pub model: String,
}

impl Selection {
    /// 把选择应用到一份 Config 上，返回改过的副本。
    ///
    /// `get` 用来读凭据（key、自定义端点的地址）。每轮都读一次而不是
    /// 缓存：用户可以在设置里填一把新 key，那之后**这一轮**就该用上。
    ///
    /// 缺东西时返回 Err 而不是静默回落到默认厂商 —— 静默回落的后果是
    /// 用户选了 Anthropic、界面上显示 Anthropic，实际却在用 DeepSeek
    /// 回答，而这个错完全看不见。报错要说清缺的是**哪一样**。
    pub fn apply(
        &self,
        config: &crate::types::Config,
        get: Lookup<'_>,
    ) -> anyhow::Result<crate::types::Config> {
        let entry = entry(&self.vendor_id, get)
            .ok_or_else(|| anyhow::anyhow!("没有叫「{}」的厂商", self.vendor_id))?;

        if entry.base_url.is_empty() {
            // 只有自定义端点会走到这儿（内置的地址是常量）
            anyhow::bail!("自定义端点还没填地址（设置 → 模型），比如 http://localhost:11434/v1");
        }
        if self.model.trim().is_empty() {
            anyhow::bail!("{} 还没选模型（对话框左下角）", entry.name);
        }

        let key = api_key_setting(&self.vendor_id)
            .map(|k| val(get, k))
            .unwrap_or_default();
        // key 对内置厂商是必填，对自定义端点不是 —— 本地跑的服务
        // （Ollama / LM Studio / vLLM 默认配置）根本不看 authorization，
        // 在那儿要求填一把假 key 是纯粹的阻碍。
        if key.is_empty() && self.vendor_id != CUSTOM_ID {
            let console = find(&self.vendor_id).map(|v| v.console).unwrap_or_default();
            anyhow::bail!(
                "还没填 {} 的 API Key（设置 → 模型），去 {} 领一个",
                entry.name,
                console
            );
        }

        Ok(crate::types::Config {
            api_key: key,
            base_url: entry.base_url,
            model: self.model.clone(),
            // 换厂商就换搜索能力 —— 有的自带，有的要回落到我们自己那个工具
            native_search: entry.search,
            // 备用模型跟着主模型走。
            //
            // 不保留 Config 里原来那个 fallback_model：它可能是**另一个厂商**
            // 的模型 id（用户以前配的 deepseek-chat），拿着它去 Anthropic
            // 的端点降级只会得到 model not found —— 降级路径本来是为了
            // 兜住故障，结果自己成了故障源。
            //
            // 同厂商内的降级要支持的话，得让用户按厂商配备用模型，
            // 那是另一件事。现在退化成「不切换」，和 config.rs 里
            // fallback 没设时的行为一致。
            fallback_model: self.model.clone(),
            ..config.clone()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// 造一个 Lookup 的后备表。测试里到处要用。
    fn store(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn every_vendor_has_models_and_a_default() {
        for v in ALL {
            assert!(!v.models.is_empty(), "{} 没有模型", v.id);
            assert!(default_model(v.id).is_some(), "{} 取不到默认模型", v.id);
        }
    }

    #[test]
    fn vendor_ids_are_unique() {
        // id 撞了的话 find 会静默返回第一个，用户选的是另一个
        let mut ids: Vec<&str> = ALL.iter().map(|v| v.id).collect();
        ids.sort();
        let before = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), before, "厂商 id 有重复");
    }

    #[test]
    fn key_envs_are_unique() {
        // 两家共用一个键名会让填了 A 的 key 之后 B 也显示已配置
        let mut envs = key_envs();
        envs.sort();
        let before = envs.len();
        envs.dedup();
        assert_eq!(envs.len(), before, "key 键名有重复");
    }

    #[test]
    fn custom_id_does_not_collide_with_a_builtin() {
        // 撞了的话自定义端点会被当成那家内置厂商，地址来源全错
        assert!(find(CUSTOM_ID).is_none());
        assert!(exists(CUSTOM_ID));
        assert!(!exists("nope"));
    }

    #[test]
    fn custom_keys_do_not_collide_with_vendor_keys() {
        for k in CUSTOM_KEYS {
            assert!(!key_envs().contains(k), "{k} 同时是某家的 key 键名");
        }
    }

    #[test]
    fn base_urls_have_no_trailing_slash_and_no_endpoint() {
        for v in ALL {
            assert!(!v.base_url.ends_with('/'), "{} 的 base_url 多了斜杠", v.id);
            // llm/mod.rs 会自己拼 /chat/completions，这里带上就成了
            // .../chat/completions/chat/completions
            assert!(
                !v.base_url.contains("chat/completions"),
                "{} 的 base_url 不该含端点路径",
                v.id
            );
            assert!(v.base_url.starts_with("https://"), "{} 不是 https", v.id);
        }
    }

    #[test]
    fn default_vendor_exists() {
        assert!(find(DEFAULT_VENDOR).is_some());
    }

    #[test]
    fn unknown_vendor_is_not_found() {
        assert!(find("nope").is_none());
        assert!(default_model("nope").is_none());
    }

    #[test]
    fn builtin_endpoint_ignores_any_setting() {
        // 这是这次改动的核心：`DEEPSEEK_BASE_URL` 不再是一个口子。
        // 留着它就等于有两条路能决定地址，而设置页上不再有那一栏 ——
        // 一个看不见却仍然生效的覆盖比没有覆盖更难查。
        let s = store(&[("DEEPSEEK_BASE_URL", "https://sneaky.example.com/v1")]);
        let e = entry("deepseek", &|k| s.get(k).cloned()).expect("认识 deepseek");
        assert_eq!(e.base_url, "https://api.deepseek.com/v1");
    }

    #[test]
    fn custom_entry_comes_from_settings() {
        let s = store(&[
            ("CUSTOM_BASE_URL", "http://localhost:11434/v1"),
            ("CUSTOM_MODELS", "llama3.1, qwen2.5:14b"),
        ]);
        let e = entry(CUSTOM_ID, &|k| s.get(k).cloned()).expect("认识 custom");
        assert_eq!(e.name, CUSTOM_NAME);
        assert_eq!(e.base_url, "http://localhost:11434/v1");
        let ids: Vec<&str> = e.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["llama3.1", "qwen2.5:14b"]);
    }

    #[test]
    fn custom_base_url_drops_a_trailing_slash() {
        // 粘进来的地址常带斜杠，不去掉就拼成 //chat/completions
        let s = store(&[("CUSTOM_BASE_URL", "  https://openrouter.ai/api/v1/  ")]);
        let e = entry(CUSTOM_ID, &|k| s.get(k).cloned()).unwrap();
        assert_eq!(e.base_url, "https://openrouter.ai/api/v1");
    }

    #[test]
    fn parse_models_accepts_several_separators_and_dedupes() {
        // 这一栏的内容多半是粘过来的，认不出分隔符的后果是整串被当成
        // 一个模型 id，报一个看不出原因的 model not found
        let out = parse_models("a, b；c\nd;e，a\n\n  ");
        let ids: Vec<&str> = out.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "c", "d", "e"]);
    }

    #[test]
    fn parse_models_keeps_ids_with_slashes_and_colons() {
        // OpenRouter 的 id 带斜杠（anthropic/claude-3），Ollama 的带冒号
        // （qwen2.5:14b）。按这些字符切会把一个 id 切成两个不存在的
        let out = parse_models("anthropic/claude-3,qwen2.5:14b");
        let ids: Vec<&str> = out.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["anthropic/claude-3", "qwen2.5:14b"]);
    }

    #[test]
    fn catalog_lists_builtins_always_and_custom_only_when_it_has_models() {
        let empty = store(&[]);
        let c = catalog(&|k| empty.get(k).cloned());
        assert_eq!(c.len(), ALL.len(), "没配自定义端点时不该多一个空组");
        assert!(c.iter().all(|e| e.id != CUSTOM_ID));

        let s = store(&[("CUSTOM_MODELS", "my-model")]);
        let c = catalog(&|k| s.get(k).cloned());
        assert_eq!(c.len(), ALL.len() + 1);
        let last = c.last().unwrap();
        assert_eq!(last.id, CUSTOM_ID);
        assert_eq!(last.models.len(), 1);
    }

    #[test]
    fn is_configured_looks_at_the_key_for_builtins_and_at_url_plus_models_for_custom() {
        let s = store(&[
            ("DEEPSEEK_API_KEY", "sk-ds"),
            ("OPENAI_API_KEY", "   "),
            ("CUSTOM_BASE_URL", "http://localhost:1234/v1"),
        ]);
        let get = |k: &str| s.get(k).cloned();
        assert!(is_configured("deepseek", &get));
        // 空白不算配好 —— 否则一个空串会让 OpenAI 显示成可用
        assert!(!is_configured("openai", &get));
        // 有地址没模型：选不出模型来，等于还没配完
        assert!(!is_configured(CUSTOM_ID, &get));

        let s2 = store(&[
            ("CUSTOM_BASE_URL", "http://localhost:1234/v1"),
            ("CUSTOM_MODELS", "m"),
        ]);
        // key 不是必需的：本地服务不校验 authorization
        assert!(is_configured(CUSTOM_ID, &|k| s2.get(k).cloned()));
    }

    #[test]
    fn first_configured_prefers_builtin_order_then_custom() {
        // 设置页打开时要落在「已经配好」的那一家上，而不是无脑第一家 ——
        // 只配了 Anthropic 的人否则会看到一个空的 DeepSeek 表单，
        // 像是他的 key 丢了。
        let s = store(&[("ANTHROPIC_API_KEY", "sk-ant"), ("OPENAI_API_KEY", "  ")]);
        assert_eq!(
            first_configured(&|k| s.get(k).cloned()).as_deref(),
            Some("anthropic")
        );

        // 只有自定义端点时也要能找到它，否则 app 起不来
        let s = store(&[("CUSTOM_BASE_URL", "http://x/v1"), ("CUSTOM_MODELS", "m")]);
        assert_eq!(
            first_configured(&|k| s.get(k).cloned()).as_deref(),
            Some(CUSTOM_ID)
        );

        let empty = store(&[]);
        assert!(first_configured(&|k| empty.get(k).cloned()).is_none());
    }

    fn base_config() -> crate::types::Config {
        crate::types::Config {
            api_key: "old-key".into(),
            base_url: "https://old.example.com/v1".into(),
            model: "old-model".into(),
            temperature: 0.0,
            max_turns: 10,
            system_prompt: "sp".into(),
            native_search: Default::default(),
            embedding_model: "em".into(),
            notes_dir: "./notes".into(),
            hf_endpoint: None,
            local_model_path: None,
            session_id: "s".into(),
            sessions_dir: "./.sessions".into(),
            max_context_tokens: 2000,
            keep_recent: 6,
            fallback_model: "old-fallback".into(),
            max_retries: 2,
            cache_enabled: true,
            cache_dir: "./.cache".into(),
            stream: true,
        }
    }

    #[test]
    fn apply_swaps_the_three_fields() {
        let s = store(&[("ANTHROPIC_API_KEY", "sk-ant-xxx")]);
        let sel = Selection {
            vendor_id: "anthropic".into(),
            model: "claude-opus-5".into(),
        };
        let out = sel
            .apply(&base_config(), &|k| s.get(k).cloned())
            .expect("该成功");
        assert_eq!(out.api_key, "sk-ant-xxx");
        assert_eq!(out.base_url, "https://api.anthropic.com/v1");
        assert_eq!(out.model, "claude-opus-5");
        // 其余字段原样保留
        assert_eq!(out.sessions_dir, "./.sessions");
        assert_eq!(out.max_turns, 10);
    }

    #[test]
    fn apply_points_fallback_at_the_same_model() {
        let s = store(&[("ANTHROPIC_API_KEY", "k")]);
        let sel = Selection {
            vendor_id: "anthropic".into(),
            model: "claude-opus-5".into(),
        };
        let out = sel
            .apply(&base_config(), &|k| s.get(k).cloned())
            .expect("该成功");
        // 留着旧的 fallback（另一个厂商的模型 id）会让降级路径自己变成故障源
        assert_eq!(out.fallback_model, "claude-opus-5");
    }

    #[test]
    fn apply_without_a_key_errors_and_says_where_to_get_one() {
        let s = store(&[("OPENAI_API_KEY", "   ")]);
        let sel = Selection {
            vendor_id: "openai".into(),
            model: "gpt-5".into(),
        };
        let err = sel
            .apply(&base_config(), &|k| s.get(k).cloned())
            .expect_err("没 key 该报错");
        let msg = err.to_string();
        // 报错要能直接指路，否则用户得自己搜控制台在哪
        assert!(msg.contains("OpenAI"), "要说明是哪家：{msg}");
        assert!(msg.contains("platform.openai.com"), "要给领 key 的地址：{msg}");
    }

    #[test]
    fn apply_uses_the_custom_endpoint_and_allows_an_empty_key() {
        // 本地 Ollama：有地址、有模型、没有 key，这必须能跑
        let s = store(&[
            ("CUSTOM_BASE_URL", "http://localhost:11434/v1"),
            ("CUSTOM_MODELS", "llama3.1"),
        ]);
        let sel = Selection {
            vendor_id: CUSTOM_ID.into(),
            model: "llama3.1".into(),
        };
        let out = sel
            .apply(&base_config(), &|k| s.get(k).cloned())
            .expect("本地端点不该被要求填 key");
        assert_eq!(out.base_url, "http://localhost:11434/v1");
        assert_eq!(out.api_key, "");
        assert_eq!(out.model, "llama3.1");
    }

    #[test]
    fn apply_passes_the_custom_key_through_when_there_is_one() {
        let s = store(&[
            ("CUSTOM_BASE_URL", "https://openrouter.ai/api/v1"),
            ("CUSTOM_API_KEY", "sk-or-1"),
            ("CUSTOM_MODELS", "anthropic/claude-3"),
        ]);
        let sel = Selection {
            vendor_id: CUSTOM_ID.into(),
            // 带斜杠的 id（OpenRouter 那种）要原样发出去
            model: "anthropic/claude-3".into(),
        };
        let out = sel
            .apply(&base_config(), &|k| s.get(k).cloned())
            .expect("该成功");
        assert_eq!(out.api_key, "sk-or-1");
        assert_eq!(out.model, "anthropic/claude-3");
    }

    #[test]
    fn apply_without_a_custom_base_url_errors_and_shows_an_example() {
        let s = store(&[("CUSTOM_MODELS", "m")]);
        let sel = Selection {
            vendor_id: CUSTOM_ID.into(),
            model: "m".into(),
        };
        let err = sel
            .apply(&base_config(), &|k| s.get(k).cloned())
            .expect_err("没地址该报错");
        let msg = err.to_string();
        // 「地址」这件事没有默认值可猜，报错里得给个样子
        assert!(msg.contains("地址"), "{msg}");
        assert!(msg.contains("localhost"), "要给个例子：{msg}");
    }

    #[test]
    fn apply_with_an_empty_model_errors() {
        // 界面上到不了这个状态（选择器里没有空项），但手改
        // providers.json 能。空 model 发出去是个看不懂的 400
        let s = store(&[("DEEPSEEK_API_KEY", "k")]);
        let sel = Selection {
            vendor_id: "deepseek".into(),
            model: "  ".into(),
        };
        assert!(sel.apply(&base_config(), &|k| s.get(k).cloned()).is_err());
    }

    #[test]
    fn vendors_with_native_search_are_marked_and_others_are_not() {
        // 这条锁的是「一把 key 就能用」：至少要有厂商自带搜索，
        // 否则用户又得去注册第二家服务 —— 那正是要避免的事
        let any = ALL.iter().any(|v| v.native_search != NativeSearch::None);
        assert!(any, "该有厂商自带服务端搜索");

        // 智谱和阿里是查过文档确认的两种形状
        assert_eq!(
            find("glm").unwrap().native_search,
            NativeSearch::ToolType("web_search")
        );
        assert_eq!(find("qwen").unwrap().native_search, NativeSearch::EnableFlag);
        // DeepSeek 的搜索在 Responses API 上，chat/completions 没有 ——
        // 标错的后果是发一个它不认识的字段
        assert_eq!(find("deepseek").unwrap().native_search, NativeSearch::None);
    }

    #[test]
    fn entry_carries_search_support_through() {
        let s = store(&[]);
        let e = entry("qwen", &|k| s.get(k).cloned()).unwrap();
        assert_eq!(e.search, SearchSupport::EnableFlag);
        assert!(e.search.is_some());

        let e = entry("deepseek", &|k| s.get(k).cloned()).unwrap();
        assert!(!e.search.is_some());
    }

    #[test]
    fn custom_endpoint_search_tool_comes_from_settings() {
        // OpenRouter 是自定义端点里最常见的那个，而它有服务端搜索
        let s = store(&[
            ("CUSTOM_BASE_URL", "https://openrouter.ai/api/v1"),
            ("CUSTOM_MODELS", "anthropic/claude-3"),
            ("CUSTOM_SEARCH_TOOL", "openrouter:web_search"),
        ]);
        let e = entry(CUSTOM_ID, &|k| s.get(k).cloned()).unwrap();
        assert_eq!(
            e.search,
            SearchSupport::ToolType("openrouter:web_search".into())
        );
    }

    #[test]
    fn apply_carries_native_search_into_the_config() {
        // 漏了这一步的后果是**静默不搜**：请求成功，只是没联网
        let s = store(&[("DASHSCOPE_API_KEY", "k")]);
        let sel = Selection {
            vendor_id: "qwen".into(),
            model: "qwen3-max".into(),
        };
        let out = sel.apply(&base_config(), &|k| s.get(k).cloned()).unwrap();
        assert_eq!(out.native_search, SearchSupport::EnableFlag);
    }

    #[test]
    fn apply_with_unknown_vendor_errors() {
        let s = store(&[]);
        let sel = Selection {
            vendor_id: "nope".into(),
            model: "x".into(),
        };
        // 静默回落到默认厂商会让界面显示的和实际用的不一致
        assert!(sel.apply(&base_config(), &|k| s.get(k).cloned()).is_err());
    }
}
