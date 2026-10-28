# LLM 协议适配器

`llm-protocol-adapter` 负责 LLM 请求、JSON 响应和 SSE 事件转换，模型能力解析与临时规范历史服务。所有运行时集成均通过 plugins 体系；网关核心只提供公共 hook、BodyHandle、作用域、依赖和服务生命周期。插件没有 settings page。

## 配置和协议矩阵

源协议和目标协议是两个独立必选字段，UI 使用现有 DynamicPluginForm/BSelect 纵向显示。显式 route、service、upstream 或 global binding 必须完整声明协议对：

```json
{
  "name": "llm-protocol-adapter",
  "enabled": true,
  "options": {
    "sourceProtocol": "responses",
    "targetProtocol": "chat_completions"
  }
}
```

这是 binding 片段；完整配置使用 revisioned ConfigurationAggregate 的稳定 ID 和 position，见 [配置文档](configuration.md)。插件激活项为 `{"plugin_name":"llm-protocol-adapter"}`，依赖 `models-dev` 一并激活。不要把 provider ID 当作协议：协议描述线路格式，provider/model 指向能力目录中的精确记录。

| 源 → 目标 | `responses` | `chat_completions` | `anthropic_messages` | `gemini_generate_content` |
|---|---|---|---|---|
| `responses` | 透传 | 转换 | 转换 | 转换 |
| `chat_completions` | 转换 | 透传 | 转换 | 转换 |
| `anthropic_messages` | 转换 | 转换 | 透传 | 转换 |
| `gemini_generate_content` | 不支持 | 转换 | 转换 | 透传 |

矩阵中的转换表示已实现协议路径，具体输入仍需满足严格语义约束。Gemini→Responses 在表单保存、配置编译/发布和插件初始化拒绝。Responses→Gemini 包含请求转换及 JSON/SSE 回包，不表示反向入口也已支持。配置不接受方向合并字段或旧名称、旧字段；同协议保持原生透传。

`runtimeScope: global-and-scoped` 同时支持 provider 服务和显式转换绑定。激活依赖或消费转换服务时，宿主自动初始化 global provider；`initializationKind: automatic-provider` 不要求协议对，也不注册请求变换 hook。显式绑定则需要必选协议对并执行声明的转换。这一区分防止 Codex Router 的依赖激活自动改写所有路由。

转换绑定匹配 POST 的 `/responses`、`/chat/completions`、`/messages` 和 `/models/{model}:generateContent|streamGenerateContent`。实际入口协议必须与 sourceProtocol 一致；入口模型缺失、重复转换以及不支持的模型目录/count_tokens端点明确拒绝。插件改写协议路径，路由/service 继续拥有上游选择、认证、重试和转发。

转换目标为 Gemini 时，插件生成 `/v1beta/models/{model}:generateContent`，流式使用 `streamGenerateContent?alt=sse`；入口已有的协议版本段会被替换，网关挂载前缀保留给路由规则处理。Responses 客户端可以使用 `/responses` 或 `/v1/responses`，不需要发送 Gemini 的版本路径。此转换的上游基址不应重复包含 `/v1beta`。

## 公共服务和进程职责

其他插件只可导入 [`plugins/llm-protocol-adapter/contract.ts`](../../plugins/llm-protocol-adapter/contract.ts)，禁止依赖其 server 私有实现。消费方必须在 manifest 声明依赖及服务契约，通过 `host.services` 获取对应进程的服务。

| 服务 | 进程/类型 | 职责 |
|---|---|---|
| `llm-protocol-adapter.conversion.v1`，version 1 | control/local、worker/local | `describe()` 返回矩阵和 rulesVersion；`resolveCapabilities()` 返回能力快照；worker `createSession()` 创建请求级转换会话；`inspectAgentMessages()`、`replaceAgentMessageEncryptedContent()` 检查及替换协作内容；worker `relayAgentMessage()` 执行受宿主约束的原生中继 |
| `llm-protocol-adapter.history.v1`，version 1 | control/RPC | 提供作用域隔离的临时规范历史，供 worker 续聊共享 |
| `models-dev.capabilities.v1`，version 1 | control/local、worker/local，adapter 消费 | 精确 provider/model 的能力与 reasoning_options 读取 |

control 侧消费已加载目录并发布转换描述/能力服务，不执行请求转换；其 createSession 明确拒绝。worker 的自动 provider 发布实际转换服务；会话拥有单次生成的工具身份映射、响应状态和资源释放。JSON/SSE 处理读取网关统一 BodyHandle/事件视图，通过公共 hook 输出转换结果，不自行读取原始 Response stream、不创建第二套 body parser 或网关。

临时历史由 control 管理，进程重启即丢失，不写 SQL/插件存储。键由 scope 和响应 ID 组成，不同作用域不能互读。默认 TTL 10 分钟，上限 512 条、总计 32 MiB、单条 8 MiB；按最旧记录淘汰，30 秒周期清理。RPC 以不超过 8192 字符的有序片段传输，最多 1024 片，总正文仍受 8 MiB 限制；未完成上传有 30 秒期限和全局 8 MiB 限制。仅完整、成功完成的逻辑生成进入可续聊历史；失败、取消、截断/incomplete 不作为成功历史。

Codex Router 负责模型目录替换、绑定选择、dispatch 和 HTTP/WS 传输决定。它消费 adapter 的公共转换与历史服务，不拥有 codec 或缓存实现。Responses WS 的目标为 Chat/Anthropic/Gemini 时使用统一 HTTP/SSE 转换；原生 Responses 保持原生传输。

转换会话显式选择 `agentMessageDelivery: 'plaintext'` 后，可以规范化明文 `agent_message` 并为三类 collaboration 调用设置空的加密参数标记；缺省仍严格检查。实际密文必须先通过协作检查和精确字段替换，不能按字符串外观猜成明文。原生中继、缓存隔离和额外消耗见 [Codex Router](../../plugins/codex-router/README.md#agent-协作与原生中继)。

直接绑定 Responses→Gemini 的适配器自动选择明文协作策略，与 Codex Router 的外部转换会话一致。协作工具的 message 参数移除原生加密声明，JSON/SSE 回包保留 encrypted_function_args=[]，明文 agent_message 以携带作者和接收方元数据的 user 消息进入 Gemini。已有真实密文仍拒绝；直接绑定不提供 Router 的原生中继配置。

中继解析使用共享 BodyHandle 的 JSON/SSE 视图，要求成功完成、唯一的指定 function_call 以及只含字符串 payload 的参数；允许原生 reasoning 事件，但不把它作为任务内容。缺失参数、多个调用、普通答案、拒绝、截断、未知事件或异常终态均失败。缓存复用现有临时历史 RPC，转换正文不走控制进程 RPC；共享操作通过 provider 的后台授权帧和租约管理，dispose 取消在途工作。

## 严格语义和生命周期

转换不会把不可表示的硬约束悄悄删除。工具定义及调用/返回身份、结构化输出、输入顺序、明确历史和终止状态必须保持语义；影响内容或控制语义的未知字段/类型、未解析引用、加密历史、compaction、目标不可表达的格式或角色约束、多个候选不能无损转换时返回具体 param 的错误。生成偏好只有经过校验且有明确省略规则时才可省略，并记录 mapped/omitted 原因；非法值不能当作“未知”继续生成。

会话目录身份为 `deepseek` 的 Responses→Chat Completions 转换，将出站消息中的 `developer` 角色映射为 `system`，保留各条消息的内容和顺序；规范历史仍保留原角色。该处理依据 [DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion) 的角色契约，不匹配具体型号，不增加配置字段，也不改写其他提供商或原生 Responses 透传的角色。若后续切换目标使已执行的角色映射不再适用，或最终 DeepSeek 消息仍包含 `developer`，末端校验明确拒绝，不在只读校验阶段重新改写正文。

Chat Completions 上游 `usage` 及其 details 对象是可扩展的辅助统计，不使用封闭字段名单作为响应准入条件。适配器校验核心 token 计数及实际读取的缓存、推理细项，接受可选细项的缺省或 `null`；未消费的统计字段不参与转换决策，不因其出现而中断正文或完成事件。原始统计仍由既有上游 BodyHandle 观察与计量链路读取，转换不修改该对象，也不向 Responses 输出新增未经目标协议定义的字段；这不表示所有上游统计细分均能无损转换。该边界参考 [OpenAI Chat usage](https://platform.openai.com/docs/api-reference/chat/object) 和 [AI SDK DeepSeek 的开放 usage schema](https://github.com/vercel/ai/blob/39aae5425e9f9a25acce413cc7e6823c2b5a73c5/packages/deepseek/src/chat/deepseek-chat-api-types.ts)，不放宽正文、工具、终态或其他协议的既有校验。

Responses→Chat/Anthropic/Gemini 的已知 `web_search`、`web_search_preview` 声明在 `tool_choice` 缺省、`auto` 或 `none` 时属于明确允许的降级：先校验字段、类型及资源限额，再省略整个搜索声明，记录 `optional_hosted_web_search_unavailable` 和字段位置。不把 OpenAI 缓存搜索改成目标的实时搜索，也不伪造搜索调用或引用。强制搜索及 `required` 继续拒绝；未知搜索参数、非法值、搜索执行历史继续严格报错。普通 function/namespace/custom 工具保持原转换规则，同协议 Responses 保留搜索声明透传。

Responses 的 `include` 接受 `reasoning.encrypted_content` 和 `output.encrypted_content` 两项输出偏好。跨协议转换不生成 OpenAI 原生加密输出，逐项记录 `target_encrypted_output_unavailable` 后省略；未知项返回原始 `include[n]` 路径，输入中的实际密文仍按历史校验规则拒绝。`output.encrypted_content` 用于 [Codex 的输出 token 重放](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs)，不构成解密或丢弃已有密文的授权；原生 Responses 透传保持原字段。

会话按请求隔离，响应结束、失败、取消及 plugin dispose 都释放。终止状态、工具参数片段和 usage 由状态机统一管理，不能仅看到任一文本片段便宣告 completed。诊断通过宿主既有请求步骤记录，保留逻辑 requestId、字段路径和原因码，不回显正文、工具参数或凭据。

Responses→Gemini 的工具调用将 thoughtSignature 编入公开 call_id 的 `__thought__` 后缀；回传完整工具历史或 previous_response_id 续聊时，恢复原始 functionCall/functionResponse.id 和调用签名。未携带签名的调用不伪造签名，namespace/custom 与明文协作标记沿用现有工具映射。parallel_tool_calls=true 校验后省略并记录诊断；false 转成“每次响应至多调用一个工具”的 systemInstruction 提示并记录 gemini_serial_tool_calls_prompt_only，不能保证提供商严格串行。

Responses→Gemini 的 function/custom 工具结果支持内嵌 PNG、JPEG、WebP 图片：`output` 数组中的 `input_image.image_url` 必须是对应 MIME 类型的 Base64 data URL，图片写入 `functionResponse.parts[].inlineData`，结构化结果通过 `$ref` 保持图片与文本的顺序和工具调用身份，规范历史保留原始内容。此路径要求目标支持 [Gemini 多模态工具结果](https://ai.google.dev/gemini-api/docs/generate-content/function-calling#multimodal)。外部 URL、文件引用、非法编码和未知字段明确拒绝，不下载图片；请求字节和内容项数量受既有限额约束。可选 `detail` 仅接受 auto/low/high，经校验后记录 `gemini_tool_image_detail_unavailable` 并省略，不承诺目标端采用相同的图片处理精度，图片字节不变。其它协议对的图片工具结果支持范围保持不变。

Responses→Gemini 的普通 user 消息同样支持上述内嵌图片，按图文顺序生成 `contents[].parts[].inlineData`，复用相同的 MIME、Base64 和资源限额校验，保留规范历史。`detail: low/high` 映射为每张图片的 `mediaResolution.level=MEDIA_RESOLUTION_LOW/HIGH` 并记录 `gemini_image_media_resolution`；auto 或缺省沿用目标默认值，显式 auto 记录 `gemini_image_detail_auto`。此映射要求目标支持 [Gemini 逐 Part 图片精度](https://ai.google.dev/gemini-api/docs/generate-content/media-resolution)，不承诺不同提供商使用相同的 token 数。图片字段错误返回原始消息及内容项路径，不用过滤后的签名历史索引替代。

Responses→Gemini 按出现顺序归集所有 system/developer 消息到 systemInstruction，包括用户消息之后追加的指令。中途指令记录 gemini_mid_conversation_instructions_consolidated；正文与指令各自的相对顺序保留，但指令在原对话中的位置不再保留。规范历史保持原顺序，生成的单工具提示不写入历史。该兼容策略不放宽未知内容、原生密文、工具参数或其它协议对的校验。

普通文本和推理 Part 的签名及边界通过尾部 reasoning 项的 encrypted_content 携带。`bungee_gemini:` 是网关私有 opaque 格式，包含版本、输出项引用、Part 长度、内容摘要与原始签名，不表示 OpenAI 能解析该数据。流式文本照常发送，晚到签名不修改已发 item_id。客户端须完整回传 output，包括该 reasoning 项，且保留被签名文本与项 ID；回放严格校验引用、内容摘要、编码和资源限额。只对 Responses→Gemini 恢复此格式，原生 OpenAI 密文和 compaction 仍拒绝，不新增持久化存储。

Gemini usageMetadata 的辅助统计（如 promptTokensDetails、cacheTokensDetails、trafficType）不作为正文准入条件。实际消费的核心计数仍严格校验；toolUsePromptTokenCount 计入 input_tokens，thoughtsTokenCount 计入 output_tokens 及 reasoning_tokens，并核对 totalTokenCount。原始细项继续由既有上游计量链路读取，不伪造 Responses 不支持的细分字段。

工具签名桥接参考 [LiteLLM 固定提交 cfe0100](https://github.com/BerriAI/litellm/tree/cfe0100e1fca613e7b1af27dd1fe4807ca4d1d1a)，只采用可表示的工具身份与签名路径，不承诺整体无损兼容。

## 推理能力来源和规则版本

推理强度来自 models.dev 的 `reasoning_options`，adapter 按目标协议生成字段映射，不维护 provider/model 推理白名单。已有协议下新增模型只需更新目录数据和绑定配置；目标端必须实现所声明协议的 effort 参数。`reasoning: true` 仅代表模型能推理，不代表有强度 selector。手工 capabilityOverrides 仅能限制 tools/images/reasoning/contextWindow，不能创造推理档位或注入 budget。

| 目录状态 | 解释 | 对外强度 |
|---|---|---|
| `missing`、reasoningOptions=null | 上游未提供元数据，未知 | 空，不猜档位/default |
| `known`、reasoningOptions=[] | 上游明确空列表 | 空，保持“已知为空” |
| `invalid`、reasoningOptions=null | 字段存在但非法 | 空，保持非法来源状态 |
| `known` 且有效 effort 列表 | 使用具体字符串档位 | 公布目标协议可表达的档位，不依赖默认值是否已知 |

`null` 和 `default` 是目录控制值，不是具体强度；toggle 和 budget_tokens 也不能转换成档位。未知模型、缺少有效 effort 元数据、目标协议不能表达 effort 或 reasoning 被限制时，返回空 supportedEfforts。当前消费的 models.dev API 格式没有独立默认等级字段，defaultEffort 保持 null，Codex 目录的 default_reasoning_level 同样为 null，不用具体档位 none 代替未知默认值。目录 capability 与 catalogVersion 来自同一完整快照；adapter 返回独立 rulesVersion，用于会话与出站校验。

显式 effort 按原值写入 Responses 的 reasoning.effort、Chat Completions 的 reasoning_effort、Anthropic Messages 的 output_config.effort 或 Gemini 的 generationConfig.thinkingConfig.thinkingLevel。未选择 effort 时不注入默认等级；适配器不因模型名称自动开启 thinking、adaptive 或设置 budget，推理开关沿用目标端默认行为。Gemini 仅公布目录明确列出的 minimal/low/medium/high 交集，按原值映射 thinkingLevel；none/xhigh/max、toggle 与 budget_tokens 不生成档位，也不换算 budget。

有明确目标 profile 的转换请求必须核验 selectedEffort。真正出站 attempt 再核验实际 model、协议、目录版本、规则版本及 wire effort；后续模型映射、重试/failover 改变目标不能无声丢失已选强度。不将不同档位折叠成相近值，也不从档位臆造 thinking.budget_tokens。字段映射依据 [OpenAI Responses](https://platform.openai.com/docs/api-reference/responses)、[Chat Completions](https://platform.openai.com/docs/api-reference/chat/completions)、[Gemini thinking levels](https://ai.google.dev/api/generate-content#ThinkingConfig) 和 [Anthropic effort](https://platform.claude.com/docs/en/build-with-claude/effort) 的协议定义；提供商的额外约束仍需实际验证，不能由兼容协议名称推断全部行为。

本地 `DataAdmissionError` 在每次 attempt 的故障分类前按公共错误契约归一化，保留安全的状态、原因和字段位置。插件独立打包导致构造器身份不同，也不得将本地协议拒绝累计为上游故障或触发熔断。

## 最终模型身份校验

模型目录身份契约由 [`models-dev/contract.ts`](../../plugins/models-dev/contract.ts) 定义：`CatalogModelReference` 是精确的 provider/model，`ModelIdentityDeclaration` 包含 wireModel 和 catalogModel，注解键为 `models-dev.model-identity`。[模型映射](../../plugins/model-mapping/README.md#上游名称和目录身份)可以声明不同于目录名称的上游名称，不使用内置模型别名或大小写推断。

`createSession()` 接受可选 modelIdentity 和原 route 的 restrictions；`validateAttempt()` 接受最终 modelIdentity，结果的 model 保持实际上游名称，catalogModel 返回解析后的目录身份（无资料时为 null），并保留 catalogVersion/rulesVersion。声明读取和会话创建都转换为安全的本地错误；只释放成功创建的会话。

发送前依次检查协议及最终 URL、声明结构、wireModel 与实际模型完全一致、目录身份以及已选推理参数。Gemini 从最终 URL 的终端 `/models/{encodedModel}:generateContent|streamGenerateContent` 段读取模型，允许基址前缀；正文 model 不参与判断。解析失败明确拒绝，没有入口名称回退。其它协议以最终正文的 model 为准；validateAttempt 的 model 参数必须与提取出的实际模型一致。没有声明时只进行原有精确目录解析。

同一目录身份复用会话锁定的能力快照；目录刷新不会改变活动生成。真正换模型按最终 provider/model 重新解析，继续应用原 route 限制；新目标目录版本必须等于锁定版本。入口没有 profile 且未选 effort 时，首次有效声明锁定快照；已经选 effort 且无法证明原生同模型时，晚到声明不能额外放行。

同协议绑定也建立校验会话，保留请求及响应的原生表示。透传豁免要求目录身份及 effort 都未改变；入口没有目录且没有声明时，保留原有同名、同 effort 的原生透传规则。映射、故障切换和修复重试均执行最终校验；不会重新编码、自动降级或扩展为工具、图片、上下文长度与计费的全面末端校验。

| 本地 422 错误码 | 条件 |
| --- | --- |
| `llm_adapter_invalid_model_identity` | 声明结构非法 |
| `llm_adapter_model_identity_mismatch` | wireModel 或调用方 model 参数与实际名称不同 |
| `llm_adapter_model_identity_unavailable` | 声明目录身份不可解析 |
| `llm_adapter_model_identity_catalog_changed` | 新目标目录版本不同于会话快照 |
| `llm_adapter_unsupported_reasoning` | 最终目标不能兑现已选推理参数 |

## 验证入口

本地协议、作用域、公共服务、历史 RPC 和隔离 Gateway 测试位于各模块的 `tests/unit`、`tests/integration`。表单验证位于 `packages/ui/tests/browser`。执行 `bun run test:affected --base origin/main` 与 `bun run check:architecture`；完整回归使用 `bun run test`。测试入口负责先构建再运行所需检查，流程见[开发指南](../guides/development.md)。

隔离进程与 mock 上游的通过结果不代表真实提供商或 Codex Desktop 已验收；真实验收需单独核验模型、协议、工具执行和出站参数。
