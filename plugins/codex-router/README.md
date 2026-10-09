# Codex Router

仅在指定 Codex 入口 route 绑定插件。先启用 models-dev，再在插件配置中搜索并添加模型，选择已有 route/service，保存目标的接收协议。默认公开原始模型标识；发生名称冲突时设置明确别名。

```json
{"models":[{"provider":"anthropic","model":"claude-sonnet-4","target":{"type":"service","id":"目标服务的 UUID"}}]}
```

上游地址、API Key、模型映射、重试均使用目标原配置。Codex base URL 已指向入口即可；ChatGPT 登录的模型目录请求可发现新增模型，API Key 模式不承诺自动列入选择器。

当前实施状态、证据与验收缺口见 `docs/codex-router-implementation.md`。关闭插件并恢复入口配置即可回退；不要将本地 mock 测试视为真实提供商验收。
