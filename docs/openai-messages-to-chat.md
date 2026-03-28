# OpenAI Messages/Responses → Chat 适配器

`openai-messages-to-chat` 是统一的 OpenAI 协议兼容层插件，目标是：

- 入站将 `/v1/messages`（可选 `/messages`）请求降级为上游 `/v1/chat/completions`
- 入站将 `/v1/responses`（可选 `/responses`）请求也降级为上游 `/v1/chat/completions`
- 对于 Messages 路径的已适配请求，出站把 Chat Completions 响应（含 SSE）重写为 Messages 风格
- 对于 Responses 路径的已适配请求，出站把 Chat Completions 响应（含 SSE）重写为 Responses 风格

这让你可以在上游统一使用 Chat Completions，同时兼容两类客户端入口（Messages / Responses）。

---

## 1. 典型场景

1. 客户端历史上混用 `/v1/messages` 和 `/v1/responses`，但你的上游只提供 Chat Completions。
2. 你希望保持调用方契约稳定，同时逐步收敛内部协议到单一 Chat 规范。
3. 你需要与 `ai-transformer` 叠加使用，但希望入口层先完成 OpenAI 客户端兼容。

---

## 2. 路由配置示例

```json
{
  "routes": [
    {
      "path": "/v1/openai-compat",
      "pathRewrite": { "^/v1/openai-compat": "/v1" },
      "plugins": [
        {
          "name": "openai-messages-to-chat",
          "options": {
            "strictValidation": true,
            "allowShortPathAlias": true,
            "trimWhitespace": true
          }
        }
      ],
      "upstreams": [
        { "target": "https://api.openai.com", "weight": 100, "priority": 1 }
      ]
    }
  ]
}
```

兼容入口：

- `POST /v1/openai-compat/messages`（或 `/v1/messages`）
- `POST /v1/openai-compat/responses`（或 `/v1/responses`）

---

## 3. 请求侧转换规则

### 3.1 路径改写

- `/v1/messages` → `/v1/chat/completions`
- `/v1/responses` → `/v1/chat/completions`
- 可选短路径别名：`/messages`、`/responses`

### 3.2 Messages 客户端请求

- 按 Messages 兼容规范执行严格校验、字段标准化、工具调用映射。
- 保留历史行为：可将 Chat 响应再改写回 Messages 输出（JSON + SSE）。

### 3.3 Responses 客户端请求

- 将 `input/messages` 统一转换为 Chat 的 `messages`。
- `instructions` 会被注入为系统消息（`role=system`）。
- `max_output_tokens` 在未显式设置 `max_tokens` 时映射到 `max_tokens`。
- `text.format` 在未显式设置 `response_format` 时映射到 `response_format`。
- Responses 专有字段（如 `input`、`instructions`、`previous_response_id`、`conversation`、`response_id`、`reasoning*`、`thinking`、`text`）会在降级后移除，避免上游 Chat 端语义冲突。
- `/v1/responses` 兼容入口按**上游无状态模式**运行：插件会优先使用当前请求的 `input/messages`。当请求带有 `previous_response_id`/`response_id`/`conversation` 时，会尝试从网关进程内兼容缓存恢复历史上下文并拼接当前输入；若引用无法解析且又缺少 `input/messages`，则返回 400。

### 3.4 reasoning/tool-calls 兼容

- 在 reasoning/thinking 语境下，会规范化 assistant 工具调用消息，确保 `reasoning_content` 可用。
- assistant `tool_calls` 若为 object 或 JSON 字符串，会在转发前标准化为数组形态，避免上游 Chat 对结构敏感时出现兼容问题。
- `trimWhitespace=true`（默认）时会裁剪已存在的 `reasoning_content` 前后空白。

---

## 4. 响应侧行为

- 对 **Messages 路径适配的请求**，会将 Chat Completions 响应（JSON + SSE）重写为 Messages 风格输出。
- 对 **Responses 路径适配的请求**，会将 Chat Completions 响应重写回 Responses 风格：
  - 非流式输出：`object: response`，并按 `finish_reason` 映射 `status`（`completed/incomplete/failed`）。
  - 流式输出：补齐常用 `response.*` 生命周期事件（包括 text/tool-call 的 added/delta/done 与 terminal 事件）。
- `/v1/responses/{id}` 等资源型端点及非 POST `/v1/responses` 请求会被明确拒绝（400），避免误导为“已完整代理 Responses 全资源 API”。

---

## 5. 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---:|---|
| `strictValidation` | boolean | `true` | Messages 兼容入口遇到冲突字段时是否直接拒绝 |
| `allowShortPathAlias` | boolean | `true` | 是否允许 `/messages` 与 `/responses` 的短路径别名入口 |
| `trimWhitespace` | boolean | `true` | 对 assistant `reasoning_content` 执行 trim |

---

## 6. 与旧插件关系

`openai-responses-guard` 的核心请求规范化能力已经并入本插件。新部署建议只保留 `openai-messages-to-chat`，避免双插件重复处理。

---

## 7. 测试建议

上线前至少验证：

1. `/v1/messages` 非流式 + SSE 行为
2. `/v1/responses` 请求降级到 Chat 的字段映射
3. reasoning/tool-calls 历史消息续传兼容

相关测试：

- `packages/core/tests/plugins/openai-messages-to-chat.test.ts`
- `packages/core/tests/plugins/openai-messages-to-chat.responses.test.ts`（responses 降级与回升路径验证）
