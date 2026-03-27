# OpenAI Responses Guard 插件

`openai-responses-guard` 用于在 `/v1/responses` 请求进入上游前，做最小化的 reasoning 兼容修正。

核心行为：

- 仅处理 `/v1/responses`（或 `/responses`）请求
- 仅在 reasoning/thinking 上下文启用（如 `reasoning` / `reasoning_effort` / `enable_thinking` / `thinking`）
- 对 `input` / `messages` 中 assistant 工具调用项保证存在 `reasoning_content`
  - 识别 `tool_calls`（数组 / 对象 / JSON 字符串）
  - 识别 `content` 内工具调用块（如 `tool_use` / `tool_call` / `function_call` / `*_call`）
  - 已有字符串：可选 trim
  - 缺失字段：尝试从 `<thinking>...</thinking>` 或 `thinking/reasoning` 内容块提取
  - 提取不到：补空字符串 `""`

该插件不会把 Responses 请求降级成 Chat Completions，也不会改写响应协议。

---

## 1. 典型场景

当同一路由有多个 upstream：

- 某些 upstream 走适配器链路
- 某些 upstream 原生支持 `/v1/responses`

为避免原生 Responses upstream 在 reasoning + tool-calls 历史场景下因缺少 `reasoning_content` 报错，可以把本插件挂在 route 级别作为统一守卫层。

---

## 2. 配置示例

```json
{
  "routes": [
    {
      "path": "/v1/responses-proxy",
      "pathRewrite": { "^/v1/responses-proxy": "/v1" },
      "plugins": [
        {
          "name": "openai-responses-guard",
          "options": {
            "trimWhitespace": true
          }
        }
      ],
      "upstreams": [
        { "target": "https://responses-a.example.com", "weight": 50, "priority": 1 },
        { "target": "https://responses-b.example.com", "weight": 50, "priority": 1 }
      ]
    }
  ]
}
```

---

## 3. 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---:|---|
| `trimWhitespace` | boolean | `true` | 是否对已有 `reasoning_content` 执行 `trim()` |

---

## 4. 已知边界

1. 仅处理请求侧，不处理响应/流式重写。
2. 仅在 reasoning 上下文启用，避免对普通 Responses 请求过度注入字段。
3. 该插件是兼容守卫，不替代 `ai-transformer` 或 `openai-messages-to-chat` 的协议转换职责。
