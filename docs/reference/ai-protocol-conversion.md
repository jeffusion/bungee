# AI 协议转换参考

Bungee 的协议转换实现位于 `packages/llms`。本页描述转换入口和主要语义，适用于插件作者；配置和启用流程见[插件指南](../guides/plugin-development.md)。转换不等于目标提供商完整支持源协议，不能将本地结构转换视为远端兼容证明。

## 入口与分工

插件导入 `@jeffusion/bungee-llms/plugin-api`，公开门面导出 AIConverter、ProtocolTransformerRegistry、六个方向转换器、OpenAIProtocolConversion、Messages normalizer、Responses codec 及 token-accounting 服务。完整清单见[门面](../../packages/llms/src/plugin-api.ts)。

`ai-transformer` 在 register(hooks) 中调用转换器，不将转换器的 onBeforeRequest/processStreamChunk 方法当成插件 SDK Hook。网络正文通过宿主 BodyHandle 读取；decoded、JSON 和 SSE 使用共享计算。转换后的封套明确填写 event，修改后清除 raw，见[正文架构](../architecture/http-body.md)。

| 方向 | 实现入口 |
| --- | --- |
| OpenAI → Anthropic | [OpenAIToAnthropicConverter](../../packages/llms/src/protocol-converters/openai-to-anthropic.converter.ts) |
| OpenAI → Gemini | [OpenAIToGeminiConverter](../../packages/llms/src/protocol-converters/openai-to-gemini.converter.ts) |
| Anthropic → OpenAI | [AnthropicToOpenAIConverter](../../packages/llms/src/protocol-converters/anthropic-to-openai.converter.ts) |
| Anthropic → Gemini | [AnthropicToGeminiConverter](../../packages/llms/src/protocol-converters/anthropic-to-gemini.converter.ts) |
| Gemini → OpenAI | [GeminiToOpenAIConverter](../../packages/llms/src/protocol-converters/gemini-to-openai.converter.ts) |
| Gemini → Anthropic | [GeminiToAnthropicConverter](../../packages/llms/src/protocol-converters/gemini-to-anthropic.converter.ts) |

方向描述请求目标；响应回转为客户端期望的结构。转换上下文携带模型、请求 ID 和流状态，不能跨请求共享可写的增量状态。

## 请求语义

| 概念 | 处理 |
| --- | --- |
| system/developer | 按目标协议的系统指令、instructions 或消息结构表达；可表示性由具体路径校验 |
| assistant/user | 文本及支持的多模态内容块转换，不能假定任意内容类型可无损映射 |
| function/tool | 工具定义、调用 ID、JSON 参数与结果匹配；Responses namespace/custom 使用专用 codec |
| 停止序列 | OpenAI stop 与 Anthropic stop_sequences／Gemini generationConfig 对应 |
| 输出上限 | 按显式输入映射，不以缺字段自动建立统一默认；count_tokens 专用路径例外见实现 |
| 推理／thinking | 保留可表示的明确 effort 或预算，不能猜测签名历史和目标能力 |
| 模型列表 | 独立转换模型字段，不能凭列表显示推断所有生成能力 |

OpenAI→Anthropic 接收 Chat Completions 与 Responses，目标路径为 `/v1/messages`。OpenAI→Gemini 的常规转换器处理 Chat Completions，Responses 不是该方向的通用入口。Anthropic→OpenAI 的 API 模式可选 chat_completions 或 responses；count_tokens 有单独处理，不等于提供商原生 Token 计算。

Anthropic 的显式 thinking.effort／output_config.effort 仅在目标模型支持时映射；只有 budget_tokens 时不能据此反推任意 reasoning_effort。Responses codec 和通用转换器的能力不同，Router 的签名 thinking 与历史限制见[Codex Router](../../plugins/codex-router/README.md)。

## 响应与流

非流式响应转换文本、工具调用、finish/stop reason 与 usage。流式转换维护 message/content/tool 的索引和增量状态，最后通过 flushStream 收尾。输入一个事件可以输出零个或多个封套，不能假定每个 TCP chunk 等于一个 SSE 事件。

| 源结束原因 | 常见目标表示 |
| --- | --- |
| Anthropic end_turn / stop_sequence | OpenAI stop |
| Anthropic max_tokens | OpenAI length |
| Anthropic tool_use | OpenAI tool_calls |
| OpenAI stop / tool_calls / length | Anthropic end_turn / tool_use / max_tokens |

实际转换还需按具体协议事件处理，不通过 `[DONE]` 或空块单独推断成功。Responses codec 对工具参数截断、多候选和不可表示约束有明确错误；不能用空 delta 冒充成功结束。HTTP 状态、传输完成和业务终态是不同观测。

模型名称回写与原始 token usage 观察属于不同边界；计量服务在 inbound 转换前观察真实 attempt，缓存与 reasoning 分项不能重复累加。费用来自独立定价服务，不由转换器生成。

## Messages／Responses 兼容入口

[openai-messages-to-chat](openai-messages-to-chat.md)适配为 Chat 上游，具有自己的进程内历史与入口限制。[Codex Router](../../plugins/codex-router/README.md)提供目标引用调度、身份隔离的临时历史及托管 WS 会话。两者不是完整 Responses 资源服务器，不能将一处支持的历史能力套到另一入口。

## 核对方法

字段变更需要检查请求、JSON 响应、SSE 增量、工具往返、缺字段和错误语义。对每个方向检查实际注册器、目标路径、上下文及请求之间的状态隔离；不要复制另一个转换器的未核实字段行为。源码测试位于 llms、插件及 core 的转换测试目录，真实提供商验证需单独记录使用的协议和模型范围。操作入口见[开发指南](../guides/development.md)。
