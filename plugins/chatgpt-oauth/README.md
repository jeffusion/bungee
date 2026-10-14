# ChatGPT OAuth 插件

插件将 ChatGPT 账号用作 Bungee 的托管上游，提供账号登录、凭据管理、请求适配和额度展示。

## 账号与凭据

| 账户来源 | 登录方式 | 上游 |
| --- | --- | --- |
| `chatgpt-siwc` | 使用 ChatGPT 登录（SIWC） | `https://api.openai.com` |
| `chatgpt` | Codex OAuth 设备码或浏览器登录 | `https://chatgpt.com` |

新增账号默认选择 SIWC，重新登录沿用账号所属的认证类型。两种来源分别管理凭据和请求权限，不能互换账号引用。

凭据由插件控制面通过 Bungee 的 SecretStore 保存。服务和路由绑定只保存 `accountRef`，不保存令牌。`accountRef` 必须是无首尾空白、长度不超过 128 的非空字符串。SIWC 使用 `Authorization`；Codex OAuth 使用 `Authorization` 和 `Chatgpt-Account-Id`。插件按凭据到期时间刷新令牌。

## 登录与绑定

1. 在 ChatGPT 账号页面点击「添加账号」，选择登录方式并点击「开始登录」。
2. SIWC 和 Codex 浏览器登录：打开授权地址，完成授权后，将完整回调 URL 提交到登录窗口。回调必须保留全部查询参数，不能只提交 `code`。
3. Codex 设备码登录：打开验证地址并输入设备码，等待插件确认授权结果。
4. 账号保存后，点击「用于服务」或「用于路由」准备上游绑定草稿；保存编辑器中的配置后，绑定才生效。

关闭登录窗口不会取消认证会话。需要停止时使用「取消登录」；会话进入账号保存状态后不能取消。回调输入在提交或关闭窗口时清空，不写入浏览器存储或绑定草稿。

SIWC 使用 PKCE、state 和 nonce 校验授权过程，并验证返回的身份。重新登录必须与已有账号身份匹配。授权地址、回调 URL 和令牌属于敏感认证数据，不应写入日志或文档。

## 上游接口

插件的上游地址使用账户来源对应的 origin，不添加 `/v1`、`/codex` 或 `/backend-api/codex` 前缀。

| 客户端入口 | Codex OAuth 上游路径 | SIWC 上游路径 |
| --- | --- | --- |
| `POST /responses` | `/backend-api/codex/responses` | `/v1/responses` |
| `POST /v1/chat/completions` | `/backend-api/codex/responses` | `/v1/responses` |
| `GET /v1/models` | `/backend-api/codex/models` | `/v1/models` |
| `POST /alpha/search` | `/backend-api/codex/alpha/search` | 不支持 |

Responses 的 WebSocket 握手使用 `/responses`，按账户来源映射到对应上游路径。插件不提供 Chat Completions 的 WebSocket 消息转换。入口 `/v1/responses` 明确拒绝；原生 Codex `/backend-api/codex/responses` 和 `POST /backend-api/codex/alpha/search` 保持原生处理。

客户端使用路由前缀时，需先通过 Bungee 的路径规则将请求改写到插件入口。例如 `/codex/alpha/search` 使用 `path_rewrite: { "^/codex/alpha/search$": "/alpha/search" }` 改写。

独立搜索接口用于 `web.run` 的搜索、打开网页和页面内查找等操作。插件保留搜索请求和 JSON 响应正文，不进行 Responses 转换或 SSE 聚合。搜索请求使用 JSON 头，透传 `X-Codex-Turn-Metadata`。各接口的凭据授权范围和请求头策略以 [manifest](manifest.json) 为准。

## 请求适配与限制

SIWC 的 Responses 和 Chat Completions 请求使用 `store:false`、`stream:true` 调用上游；客户端可接收流式结果或聚合后的 JSON。

SIWC 要求客户端发送完整对话：字符串 `input` 转为用户消息数组，system 消息转为 developer，`previous_response_id` 被拒绝。不支持的后台、对话句柄、输出上限、采样、元数据等字段会被移除，具体字段见 [请求适配实现](server/adapter.ts)。工具仅支持 function 和 custom，不支持托管 MCP、tool search、原生 computer、image generation、file search 或 code interpreter。

SIWC 模型列表按 `visibility:list` 过滤；Codex OAuth 模型列表还要求 `supported_in_api:true`。上游协议、模型可用性和额度受提供方服务及账户权限约束。

## 用量与额度

Codex OAuth 账号支持用量查询、重置额度展示和使用，以及按账号开启或关闭自动重置。重置结果未知时需明确处理或重试同一操作，不能重复提交新的兑换请求。

SIWC 账号提供 [ChatGPT](https://chatgpt.com) 用量入口，不通过 Codex 接口查询用量或重置额度，也不提供自动重置。

## 插件开发与验证

插件 server 通过公开 `@jeffusion/bungee-core/plugin` SDK 使用 Bungee 的共享 BodyHandle。模型列表和经转换的 HTTP 错误使用 `bodyHandle.json()`，Responses 流式转换和非流式聚合使用 `bodyHandle.events()`。代理正文读取、解压和 SSE 分帧遵循 [插件正文契约](../../docs/reference/plugin-api.md#正文与-sse)，插件不为代理正文建立独立读取链路。

原生 Codex Responses 保留事件正文、工具和加密字段；HTTP 错误保留原生正文和响应头。流式响应支持 `text/event-stream`、`application/octet-stream` 及缺少 Content-Type，输出使用 `text/event-stream`。

协议完成以合法的 `response.completed` 为准；`response.incomplete` 和 `response.failed` 保留对应结果。完成事件到达后关闭连接可同时记录协议完成和传输取消；完成事件前断开、EOF 或 `[DONE]` 均不能证明协议完成。

针对性测试：

```sh
bun test --isolate plugins/chatgpt-oauth/tests/unit/adapter.test.ts \
  plugins/chatgpt-oauth/tests/integration/adapter-routing.test.ts \
  plugins/chatgpt-oauth/tests/unit/siwc-adapter.test.ts \
  plugins/chatgpt-oauth/tests/unit/ui/siwc-account-model.test.ts \
  plugins/chatgpt-oauth/tests/unit/ui/account-automation.test.ts
```

这些测试覆盖请求适配、独立搜索、凭据权限、正文转发、登录交互和 manifest 契约。真实账号授权和上游可用性需要单独验证。

## 来源与许可证

OAuth/PKCE 流程参考 [Pi 的 MIT 实现](https://github.com/earendil-works/pi/blob/main/packages/ai/src/auth/oauth/openai-chatgpt.ts)。Codex 协议适配的来源说明及许可证见 [LICENSE](LICENSE)。
