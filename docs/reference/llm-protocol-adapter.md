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
| `responses` | 透传 | 转换 | 转换 | 不支持 |
| `chat_completions` | 转换 | 透传 | 转换 | 转换 |
| `anthropic_messages` | 转换 | 转换 | 透传 | 转换 |
| `gemini_generate_content` | 不支持 | 转换 | 转换 | 透传 |

矩阵中的转换表示已实现协议路径，具体输入仍需满足严格语义约束。Responses↔Gemini 在表单保存、配置编译/发布和插件初始化拒绝。配置不接受方向合并字段或旧名称、旧字段；同协议保持原生透传。

`runtimeScope: global-and-scoped` 同时支持 provider 服务和显式转换绑定。激活依赖或消费转换服务时，宿主自动初始化 global provider；`initializationKind: automatic-provider` 不要求协议对，也不注册请求变换 hook。显式绑定则需要必选协议对并执行声明的转换。这一区分防止 Codex Router 的依赖激活自动改写所有路由。

转换绑定匹配 POST 的 `/responses`、`/chat/completions`、`/messages` 和 `/models/{model}:generateContent|streamGenerateContent`。实际入口协议必须与 sourceProtocol 一致；入口模型缺失、重复转换以及不支持的模型目录/count_tokens端点明确拒绝。插件改写协议路径，路由/service 继续拥有上游选择、认证、重试和转发。

## 公共服务和进程职责

其他插件只可导入 [`plugins/llm-protocol-adapter/contract.ts`](../../plugins/llm-protocol-adapter/contract.ts)，禁止依赖其 server 私有实现。消费方必须在 manifest 声明依赖及服务契约，通过 `host.services` 获取对应进程的服务。

| 服务 | 进程/类型 | 职责 |
|---|---|---|
| `llm-protocol-adapter.conversion.v1`，version 1 | control/local、worker/local | `describe()` 返回矩阵和 rulesVersion；`resolveCapabilities()` 返回能力快照；worker `createSession()` 创建请求级转换会话；`inspectAgentMessages()`、`replaceAgentMessageEncryptedContent()` 检查及替换协作内容；worker `relayAgentMessage()` 执行受宿主约束的原生中继 |
| `llm-protocol-adapter.history.v1`，version 1 | control/RPC | 提供作用域隔离的临时规范历史，供 worker 续聊共享 |
| `models-dev.capabilities.v1`，version 1 | control/local、worker/local，adapter 消费 | 精确 provider/model 的能力与 reasoning_options 读取 |

control 侧消费已加载目录并发布转换描述/能力服务，不执行请求转换；其 createSession 明确拒绝。worker 的自动 provider 发布实际转换服务；会话拥有单次生成的工具身份映射、响应状态和资源释放。JSON/SSE 处理读取网关统一 BodyHandle/事件视图，通过公共 hook 输出转换结果，不自行读取原始 Response stream、不创建第二套 body parser 或网关。

临时历史由 control 管理，进程重启即丢失，不写 SQL/插件存储。键由 scope 和响应 ID 组成，不同作用域不能互读。默认 TTL 10 分钟，上限 512 条、总计 32 MiB、单条 8 MiB；按最旧记录淘汰，30 秒周期清理。RPC 以不超过 8192 字符的有序片段传输，最多 1024 片，总正文仍受 8 MiB 限制；未完成上传有 30 秒期限和全局 8 MiB 限制。仅完整、成功完成的逻辑生成进入可续聊历史；失败、取消、截断/incomplete 不作为成功历史。

Codex Router 负责模型目录替换、绑定选择、dispatch 和 HTTP/WS 传输决定。它消费 adapter 的公共转换与历史服务，不拥有 codec 或缓存实现。Responses WS 的目标为 Chat/Anthropic 时使用统一 HTTP/SSE 转换；原生 Responses 保持原生传输。

转换会话显式选择 `agentMessageDelivery: 'plaintext'` 后，可以规范化明文 `agent_message` 并为三类 collaboration 调用设置空的加密参数标记；缺省仍严格检查。实际密文必须先通过协作检查和精确字段替换，不能按字符串外观猜成明文。原生中继、缓存隔离和额外消耗见 [Codex Router](../../plugins/codex-router/README.md#agent-协作与原生中继)。

中继解析使用共享 BodyHandle 的 JSON/SSE 视图，要求成功完成、唯一的指定 function_call 以及只含字符串 payload 的参数；允许原生 reasoning 事件，但不把它作为任务内容。缺失参数、多个调用、普通答案、拒绝、截断、未知事件或异常终态均失败。缓存复用现有临时历史 RPC，转换正文不走控制进程 RPC；共享操作通过 provider 的后台授权帧和租约管理，dispose 取消在途工作。

## 严格语义和生命周期

转换不会把不可表示的硬约束悄悄删除。工具定义及调用/返回身份、结构化输出、输入顺序、明确历史和终止状态必须保持语义；影响内容或控制语义的未知字段/类型、未解析引用、加密历史、compaction、目标不可表达的格式或角色约束、多个候选不能无损转换时返回具体 param 的错误。生成偏好只有经过校验且有明确省略规则时才可省略，并记录 mapped/omitted 原因；非法值不能当作“未知”继续生成。

会话目录身份为 `deepseek` 的 Responses→Chat Completions 转换，将出站消息中的 `developer` 角色映射为 `system`，保留各条消息的内容和顺序；规范历史仍保留原角色。该处理依据 [DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion) 的角色契约，不匹配具体型号，不增加配置字段，也不改写其他提供商或原生 Responses 透传的角色。若后续切换目标使已执行的角色映射不再适用，或最终 DeepSeek 消息仍包含 `developer`，末端校验明确拒绝，不在只读校验阶段重新改写正文。

Chat Completions 上游 `usage` 及其 details 对象是可扩展的辅助统计，不使用封闭字段名单作为响应准入条件。适配器校验核心 token 计数及实际读取的缓存、推理细项，接受可选细项的缺省或 `null`；未消费的统计字段不参与转换决策，不因其出现而中断正文或完成事件。原始统计仍由既有上游 BodyHandle 观察与计量链路读取，转换不修改该对象，也不向 Responses 输出新增未经目标协议定义的字段；这不表示所有上游统计细分均能无损转换。该边界参考 [OpenAI Chat usage](https://platform.openai.com/docs/api-reference/chat/object) 和 [AI SDK DeepSeek 的开放 usage schema](https://github.com/vercel/ai/blob/39aae5425e9f9a25acce413cc7e6823c2b5a73c5/packages/deepseek/src/chat/deepseek-chat-api-types.ts)，不放宽正文、工具、终态或其他协议的既有校验。

Responses→Chat/Anthropic 的已知 `web_search`、`web_search_preview` 声明在 `tool_choice` 缺省、`auto` 或 `none` 时属于明确允许的降级：先校验字段、类型及资源限额，再省略整个搜索声明，记录 `optional_hosted_web_search_unavailable` 和字段位置。不把 OpenAI 缓存搜索改成目标的实时搜索，也不伪造搜索调用或引用。强制搜索及 `required` 继续拒绝；未知搜索参数、非法值、搜索执行历史继续严格报错。普通 function/namespace/custom 工具保持原转换规则，同协议 Responses 保留搜索声明透传。

会话按请求隔离，响应结束、失败、取消及 plugin dispose 都释放。终止状态、工具参数片段和 usage 由状态机统一管理，不能仅看到任一文本片段便宣告 completed。诊断通过宿主既有请求步骤记录，保留逻辑 requestId、字段路径和原因码，不回显正文、工具参数或凭据。

## 推理能力来源和规则版本

推理强度来自 models.dev 的 `reasoning_options`，adapter 按目标协议生成字段映射，不维护 provider/model 推理白名单。已有协议下新增模型只需更新目录数据和绑定配置；目标端必须实现所声明协议的 effort 参数。`reasoning: true` 仅代表模型能推理，不代表有强度 selector。手工 capabilityOverrides 仅能限制 tools/images/reasoning/contextWindow，不能创造推理档位或注入 budget。

| 目录状态 | 解释 | 对外强度 |
|---|---|---|
| `missing`、reasoningOptions=null | 上游未提供元数据，未知 | 空，不猜档位/default |
| `known`、reasoningOptions=[] | 上游明确空列表 | 空，保持“已知为空” |
| `invalid`、reasoningOptions=null | 字段存在但非法 | 空，保持非法来源状态 |
| `known` 且有效 effort 列表 | 使用具体字符串档位 | 公布目标协议可表达的档位，不依赖默认值是否已知 |

`null` 和 `default` 是目录控制值，不是具体强度；toggle 和 budget_tokens 也不能转换成档位。未知模型、缺少有效 effort 元数据、目标协议不能表达 effort 或 reasoning 被限制时，返回空 supportedEfforts。当前消费的 models.dev API 格式没有独立默认等级字段，defaultEffort 保持 null，Codex 目录的 default_reasoning_level 同样为 null，不用具体档位 none 代替未知默认值。目录 capability 与 catalogVersion 来自同一完整快照；adapter 返回独立 rulesVersion，用于会话与出站校验。

显式 effort 按原值写入 Responses 的 reasoning.effort、Chat Completions 的 reasoning_effort 或 Anthropic Messages 的 output_config.effort。未选择 effort 时不注入默认等级；适配器不因模型名称自动开启 thinking、adaptive 或设置 budget，推理开关沿用目标端默认行为。Gemini 的 thinking level/budget 不能仅凭通用 effort 列表推导。

有明确目标 profile 的转换请求必须核验 selectedEffort。真正出站 attempt 再核验实际 model、协议、目录版本、规则版本及 wire effort；后续模型映射、重试/failover 改变目标不能无声丢失已选强度。不将不同档位折叠成相近值，也不从档位臆造 thinking.budget_tokens。字段映射依据 [OpenAI Responses](https://platform.openai.com/docs/api-reference/responses)、[Chat Completions](https://platform.openai.com/docs/api-reference/chat/completions) 和 [Anthropic effort](https://platform.claude.com/docs/en/build-with-claude/effort) 的协议定义；提供商的额外约束仍需实际验证，不能由兼容协议名称推断全部行为。

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
