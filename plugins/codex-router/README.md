# Codex Router

在指定 Responses 入口 route 绑定插件。先启用 models-dev，再在入口路由的插件配置中选择“新增模型”或“添加模型替换”。新增只选择非 OpenAI 目标模型，自动使用相同的模型 ID 作为 source；替换从 OpenAI 目录选择原始模型，再选择非 OpenAI 目标模型。两种方式共用目标类型（路由或服务）、转发目标和目标接收协议。切换目标类型会清空已选目标，不改变模型和协议。

`source` 精确匹配客户端请求中的 `model`；`provider`/`model` 选择 models.dev 中的目标模型；`target` 选择转发链路。匹配后先将请求的 `model` 改为目标模型，再交给 route/service，其已有模型映射仍可继续改写。目标链路改写上游名称时，可在模型映射规则中填写独立的 `catalogModel`，使最终校验继续使用精确目录身份，见[映射配置](../model-mapping/README.md#上游名称和目录身份)。返回给客户端的模型名称恢复为 `source`。目标模型与转发链路缺一不可。

原始模型和目标模型复用 models.dev 的分页搜索选择器。原始目录固定为 OpenAI，目标提供商支持过滤并排除 OpenAI；原始模型可切换为手动输入，用于目录未收录的官方模型标识。`sourceProvider` 只记录目录来源，不参与路由匹配。新增模式下，改变目标模型会同步改变 source，无需单独填写标识或别名；替换模式下，原始模型和目标模型独立。切换模式保留转发目标、协议和原始模型草稿，概览显示对应的新增或替换行为。

模型匹配不依赖 Codex 客户端身份，其它 Responses 客户端也可使用此入口。插件接受 Responses 生成请求，目标支持 Responses、Chat Completions、Anthropic Messages、Gemini GenerateContent；不提供 Chat Completions 或 Messages 生成入口。插件同时提供 Codex 模型目录适配和会话处理。

显式 `source` 可以替换原生目录中的同名模型，保留它的位置并使用目标能力描述；其它原生模型保持原样。新增标识则追加到目录。同一原始标识不允许多个绑定。未声明 source 时按 `alias ?? model` 匹配；`source` 与 `alias` 不允许同时设置。

目标模型缺失、缺少上下文长度或不支持文本时，目录隐藏该绑定占用的标识，请求返回模型不可用；不会恢复原生能力或悄悄转回原生上游。models.dev 刷新失败时仍使用最后有效资料。

模型绑定直接在入口路由的插件配置表单中编辑并随该路由保存。插件不提供独立设置页，目录管理使用 models-dev 插件。

```json
{"models":[{"source":"gpt-native","sourceProtocol":"responses","provider":"anthropic","model":"claude-sonnet-4","target":{"type":"service","id":"目标服务的 UUID","protocol":"anthropic_messages"}}]}
```

上游地址、API Key、模型映射、重试均使用目标原配置。Codex base URL 已指向入口即可；ChatGPT 登录的模型目录请求可发现新增模型，API Key 模式不承诺自动列入选择器。

模型生成和协作中继均使用 Bungee 的[内部调度端点规则](../../docs/reference/plugin-api.md#内部调度与准备)。端点由目标协议确定：Responses `/responses`、Chat Completions `/v1/chat/completions`、Anthropic Messages `/v1/messages`、Gemini `/v1beta/models/{model}:generateContent`（流式使用 `streamGenerateContent?alt=sse`）。服务目标直接使用端点；路由目标在端点前加目标路由路径，再执行目标路由的规则。入口路由的路径及 `path_rewrite` 不用于外部目标。公共 OpenAI Responses 上游基址包含 `/v1`；ChatGPT OAuth 使用 origin，由提供商插件改写实际后端路径。Chat 和 Anthropic 的上游基址不应重复包含端点已有的 `/v1`。

入口使用 WebSocket 时开启 route.websocket.enabled。目标接收协议必须在插件绑定的 `target.protocol` 中声明；Responses 目标也开启 websocket 时使用原生 WS 上游，否则使用 HTTP/SSE。缺少协议时拒绝保存，不从 route/service 推断。每个连接串行生成，断开取消活动请求。WS 实现沿用握手限流；需要未支持的逐生成硬预算时，目标生成在连接上游前拒绝。

普通与工具历史可跨 worker/模型重编码；可信身份的临时缓存默认 10 分钟失效，不持久化正文。丢失引用、不可还原的压缩/加密历史要求新建对话；原生加密引用只能回到经验证的相同上游。协作任务的处理见下节；强制服务端搜索明确报错。

## Agent 协作与原生中继

外部模型调用 `collaboration.spawn_agent`、`send_message`、`followup_task` 时，转换结果保留 namespace、名称、call_id，并设置 `encrypted_function_args: []`。Codex 因此将任务作为明文交给接收方。仅这些工具的 `message` 参数移除原生加密声明，其它参数约束保持；不改写工具命名空间。JSON、流式 item 和最终 output 使用同一标记。明文 `agent_message` 保留作者、接收方和正文顺序，以普通 user 消息进入外部模型，不获得 system/developer 权限。

OpenAI 主 Agent 已返回真实密文时，可在入口插件中配置独立的中继目标和模型：

```json
{
  "models": [{"source":"gpt-native","provider":"zai","model":"glm-5.3-flash","target":{"type":"service","id":"外部模型服务的 UUID","protocol":"chat_completions"}}],
  "collaborationRelay": {
    "target": {"type":"route","id":"原生 Codex 路由的 UUID","protocol":"responses"},
    "model": "原生 Codex 模型标识"
  }
}
```

协作中继在同一表单的独立面板中启用。先选择目标类型和目标，再从 models.dev 的 OpenAI 目录搜索选择中继模型；目录选择不代表目标账号拥有调用权限。中继固定使用 Responses，表单不提供协议字段。

整个中继配置可省略；一旦配置，target 和 model 均必填。中继目标必须具有能够访问原生 Codex 后端的身份，普通 OpenAI 兼容端点并不具备密文恢复能力。凭据、模型映射及故障处理仍由目标链路管理；插件不默认选择中继模型，也不回退到主 Agent 或子 Agent 的模型。

仅外部转换路径遇到已识别的加密协作消息时启动中继。每条消息只发送自身完整协作项，强制原生模型调用唯一的 `relay_external_agent_payload` 工具取回字符串 payload，然后替换对应内容，再执行外部生成。内部工具事件不发送给客户端。多个协作项按输入顺序处理；同一项包含多个密文块时明确拒绝，避免将无法区分的结果误作无损恢复。原生 Responses 保持透传；加密推理、compaction 和任意私有历史不通过中继恢复。

中继是一次额外的模型推理调用，具有独立授权、准入、usage 和结算，并关联父请求。最终目标未授权或 WS 要求不支持的硬预算时，中继前拒绝；中继失败不执行最终生成。中继成功后最终生成失败，已发生的中继消耗仍结算。本地协议拒绝不计为上游健康故障。中继不是密码学解密接口，也不能保证任意模型普遍逐字还原任务。

成功结果进入适配器的有界临时缓存，默认 10 分钟；隔离键包含可信调用身份、实际原生凭据作用域、入口、配置版本、配置及实际模型、目标/upstream 和协作项摘要。跨 worker 复用已完成结果，同 worker 合并在途调用；跨 worker 同时首次未命中可以各自产生调用。匿名 HTTP 不共享缓存，匿名 WS 仅使用连接内缓存，关闭即清理。401、失败、截断、取消不缓存成功，429 按账户、入口、中继目标及实际模型作用域退避 60 秒，该范围内其他协作任务也等待退避结束。

单个等待者取消只解除自身等待，所有等待者退出才取消共享中继；首个调用的服务端租约保留到共享操作收尾，使回调与缓存写入保持有效。HTTP 和每次 WS 生成使用同一准备流程，WS 预热不启动中继。附属请求不记录正文；`auxiliary_resolution` 日志记录实际模型、upstream 和是否复用结果，不包含账户作用域、任务、密文或凭据。

## 模型目录与调度

目录模板对应 Codex CLI 0.160.1；保留原生字段与顺序，display_name 使用目标目录名称，slug 使用原始模型标识。capabilityOverrides 只能限制已支持的能力，不能制造上下文长度、服务端搜索或签名 thinking 支持。目录使用上游模型快照，每次返回前合并当前绑定能力，返回 `private, no-store`；泛用 data[] 仍保持形状。

每个 worker 在内存中缓存上游模型快照及上游 ETag，有效期为成功刷新后的 10 分钟，读取不续期。快照按入口路由及配置修订、调用身份、原始账户标识和客户端版本隔离，最多 32 条，序列化 UTF-8 正文合计最多 32 MiB，按最近使用淘汰，不持久化。单个目录超出总字节预算时仍正常返回目录，清除该身份旧快照并跳过缓存。不同 worker 可以各自拉取快照；重建、销毁或重置插件时清空。过期快照仅用于重新验证，不在上游失败时作为成功结果返回。

快照有效期内直接返回合并目录；过期或请求指定 `Cache-Control: no-cache`、`max-age=0` 时，使用缓存的上游 ETag 发送 `If-None-Match`。上游返回 304 时复用快照并续期 10 分钟，没有对应快照和上游 ETag 的 304 明确报错；上游未提供 ETag 时完整获取目录。客户端传入的目录条件请求头不直接转发，上游 401/403 清除对应快照。缓存响应仍由宿主检查当前访问权限，不连接提供商或预留上游预算。

`/models` 的 ETag 是实际返回 JSON 的 UTF-8 正文 SHA-256，带双引号，相同正文保持相同标识。此标识与上游 ETag 分别保存。control 进程仅临时保存目录标识，通过插件 RPC 供所有 worker 查询；记录按入口路由及配置修订、调用身份、原始账户标识和客户端发布版本隔离。凭据只参与隔离摘要，不保存或输出原文；账户请求头不授予权限。GET 从 `client_version` 查询参数取得版本，POST 从转发前的 `version` 请求头取得版本。目录标识关联时，三段数字版本统一去除预发布后缀和构建元数据，例如 `0.162.0-alpha.17.2` 与 `0.162.0` 对应；其它版本字符串保持原样，不同主、次、修订版本分别隔离。上游快照仍按完整查询版本隔离，不共用不同版本查询的正文或上游 ETag。公开入口的无令牌请求也支持共享目录标识；宿主按 ingress 已确认的保护要求授权，保护入口拒绝匿名调用。保护状态尚未确认、发布中或发布失败时，匿名请求不能发布或查询目录标识，生成响应省略通知头。

`/responses` 的 `X-Models-Etag` 改写为对应目录记录，原生透传和绑定目标均使用入口目录标识。版本无法确定、记录缺失或共享服务不可用时移除上游通知头，生成正文与完成状态保持不变。目录变化通过客户端启动和定时获取 `/models` 后的缓存刷新发现，不在生成请求中额外获取目录，也不保留上游即时目录通知。

目录标识最多保留 512 条，按最近使用淘汰；每次成功发布后的有效期为 10 分钟，查询不延长有效期。control 重建或销毁时清空，不写数据库或复用历史缓存。

内部调度只使用编译时 gateway_target 引用，客户端不能通过参数指定任意 URL。每个请求最多调度一次；入口与最终 scope 都参与保护校验，最终 route/service/upstream 的原有规则继续执行。

## 转换字段与损耗

原生 Responses 透传不执行转换路径的偏好降级。Chat／Anthropic／Gemini 目标经共享 Responses codec 重编码，具体可表示性不同：

| 输入 | 转换行为 |
| --- | --- |
| tools 与 additional_tools.tools | 合并注册；namespace function/custom 使用无碰撞名称并恢复逻辑名称 |
| 重复工具 | 同身份同定义去重，冲突拒绝；重复项仍计入工具预算 |
| custom 工具 | 包装单个字符串 input，回程恢复原文；不承诺目标原生执行 grammar |
| reasoning.effort | 按 models.dev 的有效档位和目标协议映射，无型号白名单；Gemini 取 minimal/low/medium/high 交集写入 thinkingLevel；未知默认值不补 none，不猜 thinking budget |
| system/developer 消息 | Gemini 按出现顺序归集到 systemInstruction，接受中途追加指令并记录诊断；规范历史保留原顺序 |
| parallel_tool_calls | Gemini 接受 true 并诊断省略；false 转成每次响应至多调用一个工具的提示并记录诊断，不保证提供商严格串行 |
| reasoning_summary_delivery=sequential_cutoff | 验证后省略交付偏好 |
| reasoning.summary、context=all_turns、text.verbosity | 验证后省略目标不可表示的生成偏好 |
| prompt_cache_key、client_metadata | 校验后不转发转换目标，不作为身份或路由依据 |
| include_usage | 校验布尔值，Chat 流请求 usage，Anthropic 使用协议自身事件 |
| include | 只接受 reasoning.encrypted_content 输出请求，转换结果不生成加密内容 |
| text.format | 保留可表示的格式约束；严格 JSON Schema 等不可表示约束明确拒绝 |
| access_programs 缺省、{} 或 cyber=standard | 接受；显式配置经校验后省略，目标使用自身策略 |
| cyber=daybreak_blue/red | 拒绝，不通过外部模型降级获取该权限 |
| 自动／none／缺省 web_search 声明 | 可省略；required 或强制指定服务端搜索拒绝 |
| 未知字段、未知输入类型、多候选 SSE、不可还原历史 | 明确错误，不丢弃语义后伪造成功 |

Gemini 工具 thoughtSignature 经公开 call_id 的 `__thought__` 后缀往返，完整历史和 previous_response_id 续聊都恢复原 functionCall/functionResponse.id 与签名；未签名调用不伪造签名。文本及推理 Part 的签名通过尾部 reasoning.encrypted_content 的网关私有载体保留；完整历史必须回传此项及未经修改的文本与项 ID。Router 将 Gemini 历史交给共享 codec 严格校验，不自行解析载体；原生 OpenAI 密文仍拒绝，不新增多模态或持久化。详见[适配器边界](../../docs/reference/llm-protocol-adapter.md#严格语义和生命周期)。

工具 JSON 不完整、流截断、取消和 incomplete 不写入成功连接历史。Anthropic 不能无损表达某些结构化输出及中途 developer 指令，也不支持 Router 的签名 thinking 续聊。转换诊断只记录字段路径、mapped/omitted、稳定原因码和请求 ID，不回显正文或参数值。

Chat 目标要求工具结果紧随对应的 assistant 工具调用。工具执行期间插入的 system/developer 指令由共享转换器暂存，整批结果收齐后再输出，保留正文、权限角色和指令之间的顺序；这会调整指令相对于工具结果的位置，不承诺逐项顺序无损。原始规范历史不变，无法安全归并的交错历史明确拒绝。详见[适配器历史规则](../../docs/reference/llm-protocol-adapter.md#严格语义和生命周期)。

## 历史缓存

历史通过 canonical 插件 RPC 在 control 进程临时保存，不持久化正文或写命令日志。隔离键包含可信身份、入口、配置版本与绑定；无可信身份的 HTTP 请求应提供完整历史。

| 资源 | 默认上限 |
| --- | --- |
| 完整历史 | 512 条、32 MiB 总量、8 MiB 单条、10 分钟 TTL |
| 待组装 RPC 分块 | 128 项、8 MiB 总量、30 秒 TTL |
| 匿名 WS 连接内历史 | 32 条、8 MiB、10 分钟 TTL，关闭释放 |

普通与工具历史可以重编码；失效引用、compaction 或不可还原跨目标历史要求新建对话。原生加密历史只允许回到经缓存验证的相同 provider/model/target/upstream；每次选择与 failover 都检查来源，不因相同 URL 就放宽来源要求。

## WebSocket 会话

`response.create` 派生独立请求 ID 并重新执行绑定与最终链路；同一连接串行生成，busy 时拒绝新生成。`generate:false` 仅预热连接内输入，不访问提供商也不产生生成统计。response.cancel 和断连取消活动生成。

生成请求的 HTTP 错误通过 WS error 事件返回，保留状态码，并解析宿主字符串错误及上游对象错误中的 code、type、message、param。标识符和字段路径须通过校验；消息先清理常见凭据形式和控制字符，再截断到 512 字符，不转发完整错误对象、响应头或堆栈。非 JSON、未知结构及无效字段使用通用错误兜底。模式脱敏不能保证识别任意未标注的裸凭据，上游仍不应在错误消息中回显秘密。

HTTP 上游经共享 SSE BodyHandle 转成 WS JSON；启用 WS 的 Responses 目标可使用原生上游连接。发送 drain、消息预算、关闭期限和连接排空使用 Bungee 的[WebSocket transport](../../docs/architecture/websocket.md)。逐生成硬预算未支持时在上游连接前拒绝，不能用统计代替授权。

## 来源与验证方法

Gemini 工具签名参考 [LiteLLM 固定提交 cfe0100e1fca613e7b1af27dd1fe4807ca4d1d1a](https://github.com/BerriAI/litellm/tree/cfe0100e1fca613e7b1af27dd1fe4807ca4d1d1a)，不代表整体无损兼容。

工具提取与转换约束的参考来源：cc-switch `b4a079430ce85a604e10d97d4b7530774e00e112`、new-api `7aa3531ef4c247ad4891c06cc8ed9d0ffb73fecc`、sub2api `3a6fd1c9db07203ca308aaba69e502bc1f35b307`。访问模式依据 [OpenAI Daybreak](https://developers.openai.com/api/docs/guides/daybreak)，不授予目标权限。

明文协作标记参考 [OmniRoute 的协作修复](https://github.com/diegosouzapw/OmniRoute/pull/14447)，原生工具中继参考 [codex-router 固定提交](https://github.com/duolahypercho/codex-router/blob/2d2b3d2ee063a16e5172c21176c74058f0be4be4/src/router.mjs#L1964-L2042)。

[脱敏 fixtures](../../tests/fixtures/codex-requests/README.md)和[集成测试](../../tests/integration/codex-router-real-process.test.ts)覆盖请求形状、协议约束、调度与协作行为。目录和模型上游使用 fixtures，真实提供商兼容性需单独验证。可选 CLI 检查通过 `BUNGEE_CODEX_CLI_PROBE=1` 启用，使用隔离配置和凭据；运行方法见[开发指南](../../docs/guides/development.md)。
