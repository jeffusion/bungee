# Codex Router

仅在指定 Codex 入口 route 绑定插件。先启用 models-dev，在入口路由的插件配置中添加绑定，填写原始模型、选择目标提供商与目标模型，再选择已有 route/service，保存目标的接收协议。

`source` 精确匹配 Codex 请求中的 `model`；`provider`/`model` 选择 models.dev 中的目标模型；`target` 选择转发链路。匹配后先将请求的 `model` 改为目标模型，再交给 route/service，其已有模型映射仍可继续改写。返回给 Codex 的模型名称恢复为 `source`。目标模型与转发链路缺一不可。

显式 `source` 可以替换原生目录中的同名模型，保留它的位置并使用目标能力描述；其它原生模型保持原样。新增标识则追加到目录。同一原始标识不允许多个绑定。旧配置按 `alias ?? model` 匹配，保留原冲突检查；`source` 与旧 `alias` 不允许同时设置。

目标模型缺失、缺少上下文长度或不支持文本时，目录隐藏该绑定占用的标识，请求返回模型不可用；不会恢复原生能力或悄悄转回原生上游。models.dev 刷新失败时仍使用最后有效资料。

插件设置页使用与 models-dev、chatgpt-oauth 相同的 `native-static` 原生组件注册机制，浏览共享目录并提供路由管理入口；具体模型绑定在 Codex 入口路由的插件配置表单中编辑并随该路由保存。设置页和表单复用模型目录组件，不使用 iframe。

```json
{"models":[{"source":"gpt-native","provider":"anthropic","model":"claude-sonnet-4","target":{"type":"service","id":"目标服务的 UUID"}}]}
```

上游地址、API Key、模型映射、重试均使用目标原配置。Codex base URL 已指向入口即可；ChatGPT 登录的模型目录请求可发现新增模型，API Key 模式不承诺自动列入选择器。

入口使用 WebSocket 时开启 route.websocket.enabled。目标接收协议必须声明 llm_protocol；Responses 目标也开启 websocket 时使用原生 WS 上游，否则使用 HTTP/SSE。每个连接串行生成，断开取消活动请求。WS 首版沿用握手限流；需要未支持的逐生成硬预算时，目标生成在连接上游前拒绝。

普通与工具历史可跨 worker/模型重编码；可信身份的临时缓存默认 10 分钟失效，不持久化正文。丢失引用、不可还原的压缩/加密历史要求新建对话；原生加密引用只能回到经验证的相同上游。首版不启用 Anthropic thinking 或模拟服务端搜索，强制搜索明确报错。

当前实施状态、证据与验收缺口见 `docs/codex-router-implementation.md`。关闭插件并恢复入口配置即可回退；不要将本地 mock 测试视为真实提供商验收。
