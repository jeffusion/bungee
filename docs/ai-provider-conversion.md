# AI Provider 转换逻辑说明

本文档面向需要独立实现或复刻多家大模型接口互转能力的团队。内容以规范/约定的形式总结现有实现的输入输出行为，无需依赖原项目源码即可理解。阅读后应能直接着手于 Bungee 等系统中的转换器实现与测试。

---

## 1. 总体设计

### 1.1 角色与职责
- **统一入口**：所有请求先根据“客户端声明的源格式”调用对应的格式转换器处理，从而生成目标服务所需的请求体。响应则以“客户端期望的目标格式”选用转换器进行回转。
- **转换器实例**：每种格式（OpenAI、Anthropic、Gemini）有一个独立转换器，负责：
  - 请求体字段改写、消息角色与内容结构转换；
  - 响应体及流式块的逆向映射；
  - 工具调用（function/tool）数据的重写；
  - 思考/推理模式（reasoning/thinking）的参数换算；
  - 特殊状态（如流式过程中的计数器、工具参数拼接等）的生命周期管理。
- **转换器工厂**：缓存（懒创建）以上三种转换器，提供统一调用接口，并在处理流式 chunk 时负责模型切换检测和状态重置。

### 1.2 流式转换生命周期
1. **选择目标格式转换器**（例如客户端期望 OpenAI chunk，它就会使用 OpenAI 转换器）。
2. **模型名传递**：流式转换前将原始模型名注入转换器，确保生成的 chunk 带回客户端原始模型标识。
3. **状态复位规则**：若检测到新流起点（首个 chunk、显式 “message_start” 等）或模型名发生变化，则调用转换器的 `reset_streaming_state` 清除缓存。
4. **专用处理优先**：若转换器提供 `_convert_from_<provider>_streaming_chunk` 等专用方法，则优先使用；否则退回到常规的响应转换。
5. **特殊标记**：若输入 chunk 等于 `[DONE]`、空对象或其他结束标记，直接返回客户端原标记，不做转换。

---

## 2. OpenAI 转换器规范

### 2.1 OpenAI 请求转其他服务
#### → Anthropic
- **模型字段**：`model` 必填，直接透传。
- **消息转换**：
  - System message 独立存入 `system` 字段。
  - User/assistant 消息根据 OpenAI 内容结构生成 Anthropic `content` 数组。多模态内容需保证图片在文本之前；文本中的 `<thinking>…</thinking>` 标签拆分为 `thinking` 类型块。
  - Assistant 的 `tool_calls` 转换为 `tool_use` 内容块，每个函数调用解析 JSON 参数并填入 `input` 对象。
  - Tool 角色消息转写成 user 角色，内容为 `tool_result` 块，指向对应 `tool_use_id`。
- **参数映射**：
  - `max_tokens`：优先使用客户端值，否则读取环境变量 `ANTHROPIC_MAX_TOKENS`，若皆缺失则报错。
  - `stop` → `stop_sequences`（始终为数组）。
  - `temperature`、`top_p`、`stream` 等保持语义一致。
  - `tools` 全部改写为 `{"name","description","input_schema"}` 形式的列表。
- **思考模式**：
  - 当请求出现 `max_completion_tokens` 时视为启用 reasoning。
  - `reasoning_effort`（默认 medium）与 `OPENAI_{LOW|MEDIUM|HIGH}_TO_ANTHROPIC_TOKENS` 环境变量映射到 `thinking.budget_tokens`。
  - 若映射所需环境变量缺失或不是整数应当立即报错提醒配置。

#### → Gemini
- **模型字段**：透传至 `model`。
- **系统消息**：写入 `system_instruction.parts[{"text": ...}]`。
- **消息与角色**：
  - OpenAI 的 user / assistant 消息转换为 `contents` 数组。assistant 文本生成 `role: "model"`；user 为 `role: "user"`。
  - `tool_calls` 变成 `functionCall` 部分，包含 `name` 与 JSON 解码后的 `args`。
  - Tool 角色消息变为 `role: "tool"` 的 `functionResponse`，`tool_call_id` 用于提取函数名（格式为 `call_<name>_<hash>`）。
  - 多模态内容以 `parts` 中的 `{"text": ...}` 或 `{"inlineData": {...}}` 表达。
- **生成配置**：`generationConfig` 必须存在；`temperature`、`topP`、`maxOutputTokens`（来源于 `max_tokens` 或 `ANTHROPIC_MAX_TOKENS`）、`stopSequences` 等按语义映射。
- **结构化输出**：若 OpenAI 请求使用 `response_format.type = json_schema`，则附加 `response_mime_type = "application/json"` 与 `response_schema`。
- **思考模式**：`max_completion_tokens` + `reasoning_effort` 触发，依赖 `OPENAI_{LOW|MEDIUM|HIGH}_TO_GEMINI_TOKENS` 计算 `generationConfig.thinkingConfig.thinkingBudget`。

### 2.2 非流式响应回写
#### Anthropic → OpenAI
- 需要使用原始模型名（由调用者预先注入）。
- `content` 数组中的：
  - `tool_use` 转换为 OpenAI `tool_calls`。
  - `thinking` 块和文本按照出现顺序合并到最终 `message.content` 中；若存在多个块，用字符串拼接。
- `stop_reason` 映射：
  - `end_turn` → `stop`
  - `max_tokens` → `length`
  - `stop_sequence` → `stop`
  - `tool_use` → `tool_calls`
- `usage` 字段拆成 `prompt_tokens` 和 `completion_tokens`。

#### Gemini → OpenAI
- 聚合 `candidates[0].content.parts` 中的文本，累积到 `message.content`。
- 如果包含 `functionCall`，解析为 `tool_calls`，生成 `call_<name>_<random>` 风格的 ID。
- `finishReason` 通过映射得到 OpenAI 的 `finish_reason`（`STOP`→`stop`、`MAX_TOKENS`→`length`、安全类 → `content_filter`）。
- `usageMetadata` 转换为 OpenAI `usage`。

### 2.3 流式块转换
- **Gemini chunk → OpenAI**
  - 保持固定的 `chat.completion.chunk` 结构，携带一个稳定的 `id`。
  - 文本增量写入 `delta.content`；函数调用增量生成递增的 `tool_call` ID。
  - 终止 chunk 检查 `finishReason`，若存在工具调用则强制设为 `tool_calls`。
  - 若 Gemini chunk 包含 `usageMetadata`，附加到 OpenAI chunk 的 `usage`。
- **Anthropic SSE → OpenAI chunk**
  - 支持输入为 SSE 字符串或预解析 JSON 事件。
  - `content_block_start`/`delta`/`stop` 事件依次转换为 OpenAI chunk 的 `delta` 内容与 `finish_reason`。
  - 工具调用参数通过累积 `partial_json` 片段拼接成完整 JSON。
  - `message_stop` 输出 `finish_reason = stop` 并重置内部状态以便下一次流式会话。

---

## 3. Anthropic 转换器规范

### 3.1 Anthropic 请求转其他服务
#### → OpenAI
- **系统消息**：写入 OpenAI `messages[0]` 的 `role = system`。
- **消息转换**：
  - User 消息若包含 `tool_result` 块，则拆成 OpenAI `role = tool` 的消息，每项匹配对应 `tool_call_id`。
  - Assistant 消息若首个块是 `tool_use`，转写为 `tool_calls`；否则把文本/多模态内容转换成 OpenAI 结构。
  - 在写入完成后执行一次校验，移除没有收到 Tool 回复的 `tool_call`，避免 OpenAI API 拒绝。
- **参数映射**：`max_tokens`、`temperature`、`top_p` 原样；`stop_sequences` → `stop`（数组）；`tools` 转换为 OpenAI function 工具集合。
- **思考模式**：
  - 当请求携带 `thinking.type = enabled` 时，读取 `budget_tokens` 并根据 `ANTHROPIC_TO_OPENAI_LOW/HIGH_REASONING_THRESHOLD` 推断 `reasoning_effort`（low/medium/high）。
  - `max_completion_tokens` 优先取客户端 `max_tokens`，否则读取 `OPENAI_REASONING_MAX_TOKENS`。若两者皆缺失则报错。

#### → Gemini
- **系统消息**：放入 `system_instruction`.
- **消息内容**：每个 Anthropic 消息转换为 Gemini `contents`：
  - `role` 映射：`assistant`→`model`，`user`→`user`，`tool`→`tool`。
  - 内容块转换成 `parts`，包括文本、base64 图像、`tool_use` → `functionCall`、`tool_result` → `functionResponse`。
  - 为了后续匹配工具结果，需要维护工具调用 ID 与函数名映射。
- **生成配置**：`temperature` → `temperature`，`top_p` → `topP`，`top_k` → `topK`，`max_tokens` → `maxOutputTokens`，`stop_sequences` → `stopSequences`。若原请求没有 `max_tokens`，使用 `ANTHROPIC_MAX_TOKENS` 或报错。
- **思考模式**：`thinking.budget_tokens` 转写为 `generationConfig.thinkingConfig.thinkingBudget`，若未提供预算则设置为 `-1` 表示“动态思考”。
- **工具**：转换成 `functionDeclarations` 列表，并递归清理 JSON Schema 中的非标准字段。

### 3.2 非流式响应回写
#### OpenAI → Anthropic
- `tool_calls` → `tool_use`。
- 文本与 `<thinking>` 标签拆分为 `text` 与 `thinking` 内容块，保留原顺序。
- `finish_reason` 映射（stop→end_turn，length→max_tokens，content_filter→stop_sequence，tool_calls→tool_use）。
- `usage` 以 `input_tokens` / `output_tokens` 表达。

#### Gemini → Anthropic
- `candidates[0]` 的文本、工具调用分别映射为 `text` 和 `tool_use` 块。
- 若包含函数调用则 `stop_reason` 设为 `tool_use`，否则通过映射表转换 `finishReason`。
- `usageMetadata` 的 token 计数写入 `usage`.

### 3.3 流式块转换
- **OpenAI chunk → Anthropic SSE**
  - 首次接收非空 delta 时发送 `event: message_start`。
  - 文本增量生成 `event: content_block_delta` JSON，类型 `text_delta`。
  0 工具调用 JSON 片段逐步追加到缓存，同时发送 `input_json_delta`。
  - 完成时发送 `content_block_stop`、`message_delta`（附带 token usage 与 `stop_reason`），最后是 `message_stop`。
- **Gemini chunk → Anthropic SSE**
  - `message_start` 初始化，并根据是否已发送文本指定内容块索引。
  - 文本转为 `content_block_delta(text_delta)`；函数调用添加 `tool_use` 块，并在结束时写出参数 JSON。
  - `finishReason` 若涉及工具使用则映射为 `tool_use`，否则按表转换。
  - 返回值通常是 SSE 事件字符串组成的数组，按顺序下发给客户端。

### 3.4 内容与工具辅助策略
- 将 Anthropic 的文本/图像转换成通用结构，以便对接 OpenAI/Gemini。
- 工具调用 ID 映射采用多重策略：显式记录、从 ID 中解析函数名、借助全局状态管理器等，确保工具结果能找到对应调用。
- 对 JSON Schema 做深度清洗，去除不被 Gemini 接受的关键词。

---

## 4. Gemini 转换器规范

### 4.1 Gemini 请求转其他服务
#### → OpenAI
- 需要从外部提前注入目标模型名；转换器会用此模型名构建 OpenAI 请求。
- `systemInstruction` 或 `system_instruction` 中的 `parts` 转写成 OpenAI system message。
- `contents` 按角色处理：
  - `model` 角色的 `functionCall` → OpenAI `tool_calls`，文本转为 OpenAI 消息内容。
  - `user` 和 `tool` 角色中的 `functionResponse` 通过对话历史映射恢复原始 `tool_call_id`，再写入 OpenAI `role = tool` 消息。
  - 其它多模态内容转换为 OpenAI 熟悉的文本、图片结构。
- `generationConfig` 字段映射：`temperature`/`topP`/`topK`/`maxOutputTokens`/`stopSequences`。
- **思考模式**：`thinkingConfig.thinkingBudget` 经 `GEMINI_TO_OPENAI_{LOW|HIGH}_REASONING_THRESHOLD` 推算 `reasoning_effort`。`max_completion_tokens` 优先取 `maxOutputTokens`，否则依赖 `OPENAI_REASONING_MAX_TOKENS`。
- `stream` 标记保留下发，以便上层区分流式与否。

#### → Anthropic
- `model` 使用外部注入的原始模型名。
- 角色映射：`model`→`assistant`，`user` 保持 `user`，`tool`（functionResponse）转换为 `user` 带 `tool_result`。
- `parts` 转换策略：
  - 文本 → `{"type": "text"}` 或 `{"type": "thinking"}`（若 `thought: true`）。
  - 图片（inlineData） → `{"type": "image", "source": {"type": "base64", ...}}`。
  - `functionCall` → `tool_use` 块，并通过历史映射或散列生成 `id`。
  - `functionResponse` → `tool_result`，从内容中获取文本化结果。
- 参数映射与思考模式规则同 4.1.1，并在缺失 `maxOutputTokens` 时回退到 `ANTHROPIC_MAX_TOKENS`。
- 工具声明转换为 Anthropic `{"name","description","input_schema"}` 列表。

### 4.2 非流式响应回写
#### OpenAI → Gemini
- OpenAI `choices[0]` 的文本与工具调用分别转换为 `parts` 的 `{"text": ...}` 和 `{"functionCall": {...}}`。
- `finish_reason` → `finishReason` 映射，其中 `tool_calls` 被翻译为 `MODEL_REQUESTED_TOOL`。
- `usage` 变为 `usageMetadata`。

#### Anthropic → Gemini
- `content` 块中的文本、thinking、tool_use 分别转为 `text`（思考内容附加 `thought: true`）、`functionCall`。
- 若 `stop_reason` 是 `tool_use`，`finishReason` 固定为 `STOP`（Gemini 视为成功完成）。
- 使用信息同样写入 `usageMetadata`。

### 4.3 流式块转换
- **OpenAI chunk → Gemini**
  - 收集所有工具调用增量直至流结束，再输出完整的 `functionCall`。
  - 普通文本增量立即输出包含单个文本 `part` 的 chunk。
  - 完成时，根据 OpenAI `finish_reason` 转换为 Gemini 的 `finishReason`；若带 usage，则填入 `usageMetadata`。
- **Anthropic chunk → Gemini**
  - 文本增量实时输出；工具调用参数缓存到会话状态。
  - 遇到 `message_delta`（包含 `stop_reason`）时，根据缓存的工具信息生成最终 chunk，同时回写 usage。
  - 支持在同一流中多次开启/结束工具调用。
- **Gemini chunk → Gemini**
  - 仅在需要对 chunk 做额外处理时使用；若源/目标同为 Gemini，通常可直接透传上游响应。

### 4.4 Schema 与内容辅助
- JSON Schema 类型值需要从 Gemini 的大写标识转换为目标服务期望的小写。
- 对于字符串形式的整数（`minItems` 等），确保转换为真实整数。
- 生成一致的工具调用 ID：优先使用历史映射；如果不存在，则按 `call_<name>_<序号>` 生成。
- 把 Gemini 的多模态内容映射到目标服务支持的结构，并注意当内容为空时提供占位文本以避免 API 报错。

---

## 5. 环境变量与配置

| 环境变量 | 用途 |
| --- | --- |
| `ANTHROPIC_MAX_TOKENS` | Anthropic 请求的 `max_tokens` 兜底值，同时作为 OpenAI→Gemini 时 `maxOutputTokens` 的默认来源。 |
| `OPENAI_LOW_TO_ANTHROPIC_TOKENS`, `OPENAI_MEDIUM_TO_ANTHROPIC_TOKENS`, `OPENAI_HIGH_TO_ANTHROPIC_TOKENS` | 将 OpenAI `reasoning_effort` 映射到 Anthropic `thinking.budget_tokens`。 |
| `OPENAI_LOW_TO_GEMINI_TOKENS`, `OPENAI_MEDIUM_TO_GEMINI_TOKENS`, `OPENAI_HIGH_TO_GEMINI_TOKENS` | 将 OpenAI `reasoning_effort` 映射到 Gemini `thinkingBudget`。 |
| `ANTHROPIC_TO_OPENAI_LOW_REASONING_THRESHOLD`, `ANTHROPIC_TO_OPENAI_HIGH_REASONING_THRESHOLD` | 将 Anthropic `budget_tokens` 反推 OpenAI `reasoning_effort` 等级。 |
| `GEMINI_TO_OPENAI_LOW_REASONING_THRESHOLD`, `GEMINI_TO_OPENAI_HIGH_REASONING_THRESHOLD` | 将 Gemini `thinkingBudget` 反推 OpenAI `reasoning_effort` 等级。 |
| `OPENAI_REASONING_MAX_TOKENS` | 当上游未提供 `max_completion_tokens` / `maxOutputTokens` 时，为 OpenAI reasoning 模型提供兜底的最大输出 token。 |

所有转换器在读取上述环境变量时都要求取值为有效整数，缺失或格式错误应尽早抛出异常而非静默忽略。

---

## 6. 模型列表转换

除聊天接口外，统一服务还提供与 OpenAI/Anthropic/Gemini 兼容的模型列表端点。实践中可以沿用以下策略快速转换渠道返回的原始模型信息。

### 6.1 统一规则
- **通用过滤**：当源为 Gemini 时，只保留 `supportedGenerationMethods` 包含 `generateContent` 的生成式模型，过滤掉嵌入等其它用途模型。
- **名称标准化**：Gemini 模型名通常带有 `models/` 前缀，对 OpenAI/Anthropic 兼容层需要去掉该前缀；输出 Gemini 格式时则确保补上。
- **时间戳处理**：缺失的 `created` 字段可回退到当前时间，或在 Anthropic 格式（`created_at`）中使用 ISO8601 字符串并追加 `Z`。

### 6.2 目标为 OpenAI
- OpenAI 原生模型直接透传。
- Anthropic 模型转换为 `{"id","object":"model","created","owned_by":"anthropic"}`，其中 `created` 为秒级时间戳，可由 `created_at` 字符串解析或退回当前时间。
- Gemini 模型转换为 `{"id": <去前缀后名称>,"object":"model","created":<当前时间戳>,"owned_by":"google"}`。

### 6.3 目标为 Anthropic
- Anthropic 原生模型直接透传。
- OpenAI 模型映射为 `{"type":"model","id":...,"display_name":...,"created_at":<ISO8601>}`，`display_name` 缺省时与 `id` 相同。
- Gemini 模型映射为 `{"type":"model","id":<去前缀名称>,"display_name":<displayName 或名称>,"created_at":<当前时间 ISO8601>}`。

### 6.4 目标为 Gemini
- Gemini 原生模型保留 `name` 字段，其余信息可省略。
- OpenAI/Anthropic 模型转换为 `{"name": "models/<原始 id>"}`，保持 Gemini 的命名约定。

---

## 7. 测试与验证建议

1. **请求转换测试**  
   - 针对三种源格式，构造覆盖常见分支的请求：普通文本、多模态、工具调用、思考模式、缺失必填字段等。  
   - 验证生成的目标请求中字段名称、角色、数组/对象结构均符合目标服务 API 规范。  
   - 刻意移除或设置非法环境变量，确认能捕获并报错。

2. **响应与流式转换测试**  
   - 为每组源→目标格式准备:  
     a. 普通完成响应；  
     b. 带工具调用响应；  
     c. 带思考内容响应；  
     d. 长度/安全类 finish reason；  
     e. 流式场景中出现工具调用增量、文本增量和结束事件的组合。  
   - 断言转换结果满足目标格式的数据结构与语义（例如 OpenAI chunk 的 `delta`、Anthropic SSE 事件顺序、Gemini `parts` 列表不为空）。

3. **状态重置与模型切换**  
   - 模拟在同一转换器实例上连续处理不同模型的请求，确认每次都重新初始化状态（如工具调用计数器、stream ID）。  
   - 对流式转换输入两个对话的连续 chunk 序列，检查第二个对话开头是否生成新的开始事件。

4. **跨链路一致性**  
   - 往返测试：例如 OpenAI→Anthropic→OpenAI，验证转换后字段基本回到原状（允许因平台差异产生细微格式调整）。  
   - 工具调用 ID 与函数名在来回转换过程中保持对应关系。

5. **错误处理**  
   - 空数据、`[DONE]`、未知事件类型、JSON 解析失败等情况应返回合理的占位响应（如空 delta）并记录警告日志。  
   - 当目标平台缺少必需字段时应返回明确错误，提示调用方补充。

---

通过以上规范，可在不阅读原项目源码的前提下，实现功能等价的 AI 接口转换层，并为后续扩展或引入其他模型供应商打下基础。若引入新的格式，建议复制现有转换器的结构：清晰区分请求/响应/流式流程、环境变量约束以及多模态与工具调用处理，保持整体一致性。***
