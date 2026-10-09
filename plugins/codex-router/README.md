# Codex Router

仅在指定 Codex 入口 route 绑定插件。先启用 models-dev，再在插件配置中搜索并添加模型，选择已有 route/service，保存目标的接收协议。默认公开原始模型标识；发生名称冲突时设置明确别名。

```json
{"models":[{"provider":"anthropic","model":"claude-sonnet-4","target":{"type":"service","id":"目标服务的 UUID"}}]}
```

上游地址、API Key、模型映射、重试均使用目标原配置。Codex base URL 已指向入口即可；ChatGPT 登录的模型目录请求可发现新增模型，API Key 模式不承诺自动列入选择器。

入口使用 WebSocket 时开启 route.websocket.enabled。目标接收协议必须声明 llm_protocol；Responses 目标也开启 websocket 时使用原生 WS 上游，否则使用 HTTP/SSE。每个连接串行生成，断开取消活动请求。WS 首版沿用握手限流；需要未支持的逐生成硬预算时，目标生成在连接上游前拒绝。

普通与工具历史可跨 worker/模型重编码；可信身份的临时缓存默认 10 分钟失效，不持久化正文。丢失引用、不可还原的压缩/加密历史要求新建对话；原生加密引用只能回到经验证的相同上游。首版不启用 Anthropic thinking 或模拟服务端搜索，强制搜索明确报错。

当前实施状态、证据与验收缺口见 `docs/codex-router-implementation.md`。关闭插件并恢复入口配置即可回退；不要将本地 mock 测试视为真实提供商验收。
