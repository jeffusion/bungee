# OpenAI Responses Guard（已合并）

`openai-responses-guard` 已并入 `openai-messages-to-chat`。

从当前版本开始，建议统一使用：

- `openai-messages-to-chat`

它已覆盖原守卫能力（responses 请求在 reasoning/tool-calls 场景下的请求侧规范化），并进一步支持：

- 将 `/v1/responses` 请求降级到 `/v1/chat/completions`
- 将上游 Chat Completions 的响应（JSON + SSE）回升为 Responses 风格输出

注意：该合并适配层并不覆盖完整 Responses 资源 API（例如 `/v1/responses/{id}`），这类端点会被明确拒绝。

迁移建议：

1. 从路由配置中移除 `openai-responses-guard`
2. 保留或新增 `openai-messages-to-chat`
3. 若原先依赖 `trimWhitespace`，可在 `openai-messages-to-chat` 中继续配置同名选项

详见：[`openai-messages-to-chat` 文档](./openai-messages-to-chat.md)
