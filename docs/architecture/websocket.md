# WebSocket 代理与 Responses 计量

## 启用与边界

路由通过 `websocket: { enabled: true }`，缺省关闭。管理 UI 的路由「转发」页面提供开关。普通 HTTP 请求继续走现有 HTTP 网关。

```json
{
  "path": "/v1/responses",
  "service": "openai",
  "websocket": { "enabled": true }
}
```

上游 target 继续填写 HTTP(S) URL；WS 转发会转换为对应的 ws/wss 连接。

数据路径为客户端 → ingress → 固定 revision 的 worker → 上游。只接受 RFC 6455 GET Upgrade；两个出站握手各自生成 Key/Accept，不复用客户端密钥。上游完成握手后才 Upgrade 下游；拒绝握手返回受限大小的 HTTP 响应。保留文本/二进制消息类型、内容、顺序、完整消息边界和合法子协议选择，不保留底层分片布局。不协商消息压缩、不自动跟随重定向、不在已建立的连接上重试或迁移。

路由匹配、路径改写、请求 header/query 规则、上游选择、握手限流使用现有 Gateway Hooks。body 改写或依赖 body 的表达式不适用于无 HTTP body 的握手，明确返回 422。HTTP 的 body/SSE 转换、缓存、响应 body 改写和重试 Hook 不作用于 WS 消息；扩展应注册专用 `onWebSocketHandshake` / `onWebSocketObservation`。

## 身份、预算与凭据

Ingress 清除外部伪造的内部头，签名 requestId、principal、原始 URL 和可信 peer。Worker 使用还原后的 Request 执行业务，但保留原始 Bun Request 完成 native Upgrade。匿名/Key 的保护范围由现有 admission 策略决定。连接获准后保持原授予身份及 revision，撤销与配置更新影响新连接；已有连接遵守旧 worker 的有限排空。

握手不使用 URL 中的 token，也不新增浏览器 ticket。现有 admission 的 inspect/preview/admit 保持原顺序；若有效 Token 预算需要读取请求 JSON，握手以 `422 websocket_budget_unsupported` 拒绝，绝不先 debit 或建立上游连接。其他需要读取 JSON 的策略同样失败关闭。不提供逐生成的硬预算预留，不能用消息统计代替预算授权。

托管凭据保持 endpointId、contributionId、bindingId、revision 和 attemptId 的精确绑定；签发前后校验目标 HTTPS origin/path/GET 白名单，先剥离客户端凭据，再应用声明的出站头和 credential lease，不跟随重定向。ChatGPT OAuth 插件提供 `/v1/responses` → `/backend-api/codex/responses` 的握手映射，以及 Codex/SIWC Responses 的独立 GET profile。它不把 Chat Completions 消息转换成 Responses WS 消息；客户端需要发送对应的 Responses 协议。

## 插件公共契约

`WebSocketGatewayPlugin` 与其他内置/外部插件一样实现 Plugin.register，通过 `onGatewayWebSocket` 调用，启动时要求恰好一个 provider。

- `onWebSocketHandshake`：只修改握手 URL/Headers，按 route/global、service、upstream 阶段执行。
- `onWebSocketObservation`：只读 open/message/incomplete/close 事件，包含连接身份、routeId、upstreamId、upstreamUrl、servingRevision 和合作式 `isActive()` 租约。
- `WebSocketMessageView`：消息种类和字节数；`json()` 按需解析一次、共享且深冻结；二进制/非法 JSON 返回 undefined。与 HTTP BodyHandle 分离。

观察者按具体插件实例与作用域隔离，每个实例有独立、有序的队列。单个消费者 8 MiB / 64 待投递事件，进程观察队列总预算 64 MiB，每次调用 250 ms。超时/异常/溢出关闭该观察分支，发送 incomplete，保留 close 清理；转发与其他观察者继续。租约到期后的异步回调不能再改变有效业务状态。关闭时对观察队列设置有限清理窗口；统计不能追上时保留不完整语义，不能把丢失数据当成完整统计。

## 每次生成的 Token 统计

token-metering 识别 `/v1/responses` 与 `/backend-api/codex/responses`，消费共享 JSON 观察。一次 `response.create` 是一次逻辑生成，`response.created` / `response.in_progress` 绑定 response.id；stream_id lane 与默认 FIFO 分别关联，允许事件交错。只有 created/in_progress 会消费待绑定 create；未知终态独立处理，不能取走新 create，以免旧终态重放吞掉未完成生成。上游自行创建的 successor response 也独立计量。

收到终态 response.completed / failed / incomplete 后才结算，优先使用官方 `response.usage.input_tokens/output_tokens` 和缓存/推理细节。相同 response ID 的近期终态不重复结算；最近 ID 缓存有界滚动，绑定的 request/attempt UUID 由连接 ID 和 response ID 派生，持久化 stats 的唯一 attempt_id 对旧事件重放继续去重。超过 256 次生成不会停用计量。缺失 usage、断连、观察失败均标记 incomplete/unknown，不使用增量 input 猜测整个上下文，不把未知记成零，不污染普通 WS 的 LLM 数据。

继续通过统一 token-metering service → token-stats 保存和查询，不新增私有 Token 数据库。连接日志只记 connectionId、revision、路由/上游、字节/消息数、时长与关闭码；每次生成拥有独立统计 ID。握手鉴权 header 和消息正文不进入连接日志。

## 资源与关闭

使用 Bun native server 和 npm `ws@8.22.0` 客户端（安装别名 `@bungee/ws-client`，避开 Bun 的 `ws` 内建替代）。默认每桥接实例最多 64 连接、16 并发握手，握手 10 秒；单消息 2 MiB，单连接发送积压 8 MiB，进程共享发送积压 64 MiB，上游提前消息最多 16 条，拒绝 HTTP body 最多 64 KiB。发送积压预算不等于进程 RSS 上限；parser、JSON 对象、TLS 和内核缓冲还需考虑连接/消息上限。

慢下游暂停 npm ws 读取，在 Bun drain 后恢复；Bun send 返回 -1 代表已排队，不能再次发送。Bun 无接收 pause 时，慢上游触及发送预算以 1013 关闭，不能无限排队。控制帧由两跳协议栈分别处理，普通关闭码/原因安全转发。

旧 worker 停止新握手，已有会话继续使用旧配置；仍使用 publication.drain_timeout_ms（默认 300000）。在窗口结束前预留 close 确认与观察清理时间，以 1012 关闭剩余会话；1 秒后强制结束未确认 peer。真实 native close 及观察清理完成后才释放 owner/admission lease；worker 的清理屏障包括 WS 生命周期。

Bun 1.4.2 的已知边界：服务端 maxPayloadLength 超限可能由 Bun 直接关闭为 1006，应用无法再发送 1009；Bun 没有公开服务端 fragment-count 上限。npm ws 出站接收侧限制 1024 fragments，入站服务端只有 native 消息大小限制。未声称具备双向分片计数保护，也没有为改善关闭码扩大 payload 上限。

## 验证方法与协议来源

[真实进程测试](../../tests/websocket-gateway-real-process.test.ts)使用构建后的 master/ingress/worker 与隔离 SQLite，检查连接内生成计量、重复终态、断连及配置发布排空。TLS 夹具仅用于测试；不通过关闭证书校验建立连接。执行与证据边界见[开发指南](../guides/development.md)。本地 loopback 和 mock 契约不能证明远端提供商或所有客户端兼容。

官方协议参考：[Responses WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)、[Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)。公开 API 协议不能单独证明 ChatGPT/OAuth 远端兼容。
