# OpenAI Messages ↔ Chat Completions 兼容插件

`openai-messages-to-chat` 是一个**调用方兼容层插件**：

- 入站把 `/v1/messages`（或可选 `/messages`）请求改写为上游 `/v1/chat/completions`
- 出站把 Chat Completions 响应（含 SSE）再改写回调用方期望的 Messages 风格

这意味着：调用方始终可以按 Messages 语义接入，而上游可以继续使用 Chat Completions。

---

## 1. 典型使用场景

1. 旧调用方只会发 `/v1/messages`，但你的上游只提供 `/v1/chat/completions`
2. 你希望逐步迁移客户端，不想一次性改所有 SDK/网关入口
3. 你需要在同一路由上叠加 `ai-transformer`（例如继续转发到 Anthropic），但对调用方保持 Messages 输出

---

## 2. 路由配置示例

### 2.1 仅适配到 OpenAI Chat Completions

```json
{
  "routes": [
    {
      "path": "/v1/messages-proxy",
      "pathRewrite": { "^/v1/messages-proxy": "/v1" },
      "plugins": [
        {
          "name": "openai-messages-to-chat",
          "options": {
            "strictValidation": true,
            "allowShortPathAlias": true
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

调用方请求：

- `POST /v1/messages-proxy/messages`
- 或（开启 `allowShortPathAlias` 时）`POST /v1/messages-proxy/messages` + pathRewrite 后的 `/messages`

---

### 2.2 与 ai-transformer 组合（OpenAI 语义入站，Anthropic 上游）

```json
{
  "routes": [
    {
      "path": "/v1/messages-to-anthropic",
      "pathRewrite": { "^/v1/messages-to-anthropic": "/v1" },
      "plugins": [
        {
          "name": "openai-messages-to-chat"
        },
        {
          "name": "ai-transformer",
          "options": {
            "from": "openai",
            "to": "anthropic"
          }
        }
      ],
      "upstreams": [
        { "target": "https://api.anthropic.com", "weight": 100, "priority": 1 }
      ]
    }
  ]
}
```

插件执行顺序设计为：

- 请求阶段：`openai-messages-to-chat` 先执行（stage -10），再到 `ai-transformer`
- 响应阶段：`openai-messages-to-chat` 后执行（stage 10）作为最终对外输出适配层

---

## 3. 请求转换规则

### 3.1 路径改写

- `/v1/messages` → `/v1/chat/completions`
- 可选：`/messages` → `/v1/chat/completions`（`allowShortPathAlias=true`）

### 3.2 字段处理

- `model`、`messages`、`temperature`、`top_p`、`max_tokens`、`tools`、`tool_choice` 等按 Chat 请求透传
- 内容块标准化：
  - `input_text` / `output_text` → `text`
  - `input_image` → `image_url`
  - `thinking` / `reasoning` / `reasoning_content` 内容块会标准化为文本语义
- 工具对话兼容（新增）：
  - assistant `content[].type = tool_use` 会映射为 `assistant.tool_calls`
  - user `content[].type = tool_result` 会映射为 OpenAI `role = tool` 消息（`tool_call_id = tool_use_id`）
  - 同一条 user 消息中的非 `tool_result` 内容会保留为独立 user 内容块
  - 当 assistant 同时包含 `thinking` 与 `tool_use` 时，会补充 `assistant.reasoning_content` 以兼容要求推理字段的上游
- tools 标准化（新增）：
  - 支持 OpenAI Chat 工具格式：`{ "type": "function", "function": {...} }`
  - 支持 Anthropic 风格工具格式：`{ "name": "...", "input_schema": {...} }`（自动映射到 Chat 工具格式）
  - 支持 `tools` 传入为 JSON 字符串（会先反序列化）
- `tool_choice` 标准化（新增）：
  - 支持 `auto` / `none` / `required`
  - 支持 Anthropic 风格 `{ "type": "tool", "name": "..." }`，自动映射为 Chat 的 function 选择器

### 3.3 严格校验（默认开启）

默认 `strictValidation=true`，遇到明显冲突语义字段会直接返回 `400`，避免猜测式转换。

冲突字段（当前实现）包括：

- Responses 风格：`input`, `instructions`, `max_output_tokens`, `previous_response_id`, `conversation`, `response_id`
- Threads 资源风格：`thread_id`, `assistant_id`, `run_id`, `attachments`

当 `strictValidation=false` 时，这些冲突字段会被剔除后继续转发。

---

## 4. 响应转换规则（重点）

> 这是本插件的关键：保证调用方看到的是 Messages 风格，而不是 Chat Completions 风格。

### 4.1 非流式 JSON

上游典型输入（Chat）：

```json
{
  "id": "chatcmpl_xxx",
  "object": "chat.completion",
  "choices": [
    {
      "message": { "role": "assistant", "content": "ok" },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 9,
    "completion_tokens": 3,
    "total_tokens": 12
  }
}
```

调用方输出（Messages 风格）：

```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "content": [{ "type": "text", "text": "ok" }],
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 9,
    "output_tokens": 3
  }
}
```

当响应包含 `tool_use` 时，插件会保证存在 `reasoning_content` 字段（无可用推理文本时为空字符串），用于兼容后续要求该字段的 Responses/Thinking 上下文续传。

### 4.2 流式 SSE

上游 `chat.completion.chunk` 会被改写为 Messages 事件序列，例如：

- `event: message_start`
- `event: content_block_start`
- `event: content_block_delta`
- `event: message_delta`
- `event: message_stop`

即：调用方可以继续按 Messages SSE 协议消费流。

兼容性保障：

- `message_delta` 事件会始终携带 `usage` 对象
- 当上游未返回 usage，或发生流式传输异常触发终止兜底时，usage 会回填为 `{ "input_tokens": 0, "output_tokens": 0 }`
- `message_start.message` 会补充 `reasoning_content`（默认空字符串），便于客户端从 SSE 重建对话并继续走要求该字段的接口

---

## 5. 配置项说明

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---:|---|
| `strictValidation` | boolean | `true` | 是否拒绝 Responses/Threads 风格冲突字段 |
| `allowShortPathAlias` | boolean | `true` | 是否将 `/messages` 也视为兼容入口 |

---

## 6. 已知边界

1. 这是 **Messages ↔ Chat Completions 兼容层**，不是完整 Responses/Assistants 语义桥接器。
2. 当请求语义同时混入 Responses 或 Threads 资源字段时，建议保持 `strictValidation=true`，由调用方显式纠正输入。
3. 插件设计目标是“对调用方保持 Messages 契约稳定”，而不是覆盖所有 OpenAI 产品面接口差异。

---

## 7. 验证建议

上线前建议最少验证这三类请求：

1. 非流式普通对话
2. 流式 SSE 对话
3. 包含冲突字段的非法请求（确认返回 400）

对应工程内测试：

- `packages/core/tests/plugins/openai-messages-to-chat.test.ts`
