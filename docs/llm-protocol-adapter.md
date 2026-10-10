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

这是 binding 片段；完整配置使用 revisioned ConfigurationAggregateV2 的稳定 ID 和 position，见 [配置文档](configuration.md)。插件激活项为 `{"plugin_name":"llm-protocol-adapter"}`，依赖 `models-dev` 一并激活。不要把 provider ID 当作协议：协议描述线路格式，provider/model 指向能力目录中的精确记录。

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

其他插件只可导入 [`plugins/llm-protocol-adapter/contract.ts`](../plugins/llm-protocol-adapter/contract.ts)，禁止依赖其 server 私有实现。消费方必须在 manifest 声明依赖及服务契约，通过 `host.services` 获取对应进程的服务。

| 服务 | 进程/类型 | 职责 |
|---|---|---|
| `llm-protocol-adapter.conversion.v1`，version 1 | control/local、worker/local | `describe()` 返回矩阵和 rulesVersion；`resolveCapabilities()` 返回能力快照；worker `createSession()` 创建请求级转换会话 |
| `llm-protocol-adapter.history.v1`，version 1 | control/RPC | 提供作用域隔离的临时规范历史，供 worker 续聊共享 |
| `models-dev.capabilities.v1`，version 1 | control/local、worker/local，adapter 消费 | 精确 provider/model 的能力与 reasoning_options 读取 |

control 侧消费已加载目录并发布转换描述/能力服务，不执行请求转换；其 createSession 明确拒绝。worker 的自动 provider 发布实际转换服务；会话拥有单次生成的工具身份映射、响应状态和资源释放。JSON/SSE 处理读取网关统一 BodyHandle/事件视图，通过公共 hook 输出转换结果，不自行读取原始 Response stream、不创建第二套 body parser 或网关。

临时历史由 control 管理，进程重启即丢失，不写 SQL/插件存储。键由 scope 和响应 ID 组成，不同作用域不能互读。默认 TTL 10 分钟，上限 512 条、总计 32 MiB、单条 8 MiB；按最旧记录淘汰，30 秒周期清理。RPC 以不超过 8192 字符的有序片段传输，最多 1024 片，总正文仍受 8 MiB 限制；未完成上传有 30 秒期限和全局 8 MiB 限制。仅完整、成功完成的逻辑生成进入可续聊历史；失败、取消、截断/incomplete 不作为成功历史。

Codex Router 负责模型目录替换、绑定选择、dispatch 和 HTTP/WS 传输决定。它消费 adapter 的公共转换与历史服务，不拥有 codec 或缓存实现。Responses WS 的目标为 Chat/Anthropic 时使用统一 HTTP/SSE 转换；原生 Responses 保持原生传输。

## 严格语义和生命周期

转换不会把不可表示的硬约束悄悄删除。工具定义及调用/返回身份、结构化输出、输入顺序、明确历史和终止状态必须保持语义；未知字段/类型、未解析引用、加密历史、compaction、目标不可表达的格式或角色约束、多个候选不能无损转换时返回具体 param 的错误。生成偏好只有经过校验且有明确省略规则时才可省略，并记录 mapped/omitted 原因；非法值不能当作“未知”继续生成。

Responses→Chat/Anthropic 的已知 `web_search`、`web_search_preview` 声明在 `tool_choice` 缺省、`auto` 或 `none` 时属于明确允许的降级：先校验字段、类型及资源限额，再省略整个搜索声明，记录 `optional_hosted_web_search_unavailable` 和字段位置。不把 OpenAI 缓存搜索改成目标的实时搜索，也不伪造搜索调用或引用。强制搜索及 `required` 继续拒绝；未知搜索参数、非法值、搜索执行历史继续严格报错。普通 function/namespace/custom 工具保持原转换规则，同协议 Responses 保留搜索声明透传。

会话按请求隔离，响应结束、失败、取消及 plugin dispose 都释放。终止状态、工具参数片段和 usage 由状态机统一管理，不能仅看到任一文本片段便宣告 completed。诊断通过宿主既有请求步骤记录，保留逻辑 requestId、字段路径和原因码，不回显正文、工具参数或凭据。

## 推理能力来源和规则版本

推理强度来自 models.dev 的 `reasoning_options`，adapter 再与目标接口的有依据规则求交集。`reasoning: true` 仅代表模型能推理，不代表有强度 selector。手工 capabilityOverrides 仅能限制 tools/images/reasoning/contextWindow，不能创造推理档位或注入 budget。

| 目录状态 | 解释 | 对外强度 |
|---|---|---|
| `missing`、reasoningOptions=null | 上游未提供元数据，未知 | 空，不猜档位/default |
| `known`、reasoningOptions=[] | 上游明确空列表 | 空，保持“已知为空” |
| `invalid`、reasoningOptions=null | 字段存在但非法 | 空，保持非法来源状态 |
| `known` 且有效 effort 列表 | 使用具体字符串档位 | 与接口规则求交集；有依据的 default 必须属于交集 |

`null` 和 `default` 是目录控制值，不是具体强度。未知模型、没有接口规则、交集为空、规则默认值不在交集或 reasoning 被限制时，都返回空 supportedEfforts 和 null defaultEffort。目录 capability 与 catalogVersion 来自同一完整快照；adapter 返回独立 rulesVersion，当前实现为 `2026-10-10.2`。

GLM-5.3 与 GLM-5.3-FLASH 在 Z.ai Chat Completions 接口支持 `low/high/max`，默认 `max`；thinking 只能开启，不能沿用 GLM-5.2 对 medium/xhigh 等值的映射。这是接口规则，并不能替代实际 models.dev 档位数据，最终仍取交集。[Z.ai 官方 Chat Completion 文档](https://docs.z.ai/api-reference/llm/chat-completion)（核对日期 2026-10-10）。

有明确目标 profile 的请求必须核验 selectedEffort。真正出站 attempt 再核验实际 model、协议、目录版本、规则版本及 wire effort；后续模型映射、重试/failover 改变目标不能无声丢失已选强度。Anthropic 的有依据 effort 映射与 adaptive thinking 由规则管理，不从档位臆造 thinking.budget_tokens。

## 验证边界

本轮基线、命令、实际 CLI 证据、目录快照和真实验收缺口见 [验收记录](llm-protocol-adapter-validation.md)。

协议会话、插件作用域、公共服务、历史分片与网关集成测试分别证明本地行为；隔离浏览器测试仅加载本机组件和模拟 API。它们不证明正式配置已经发布，不证明真实提供商、Desktop 人工操作或物理部署验收。专项入口：`bun test plugins/llm-protocol-adapter/server/service.test.ts packages/core/tests/plugins/llm-protocol-adapter.test.ts`、`bun test packages/llms/tests/protocol-session.test.ts`、`bun --cwd packages/ui tests/protocol-adapter.browser.ts`、`bun run check:architecture`。
