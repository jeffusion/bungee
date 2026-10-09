# Codex Router 实施记录

基线：PR #76，`a570e6b946bee886249d0daef35e4ae8488d1adc`。开发从独立 `codex/codex-router` 分支开始，原工作区无改动。未部署，未激活生产配置。

依赖恢复：Bun 1.4.2，`BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/bungee-bun-cache bun install --frozen-lockfile`，锁文件未改。受限沙箱不能修改外部 Git 元数据，分支操作经授权执行；依赖 prepare 中 husky 无法写入 Git config，不影响锁定依赖恢复。

基线完整构建和架构检查通过。WebSocket 专项在受限沙箱因 loopback listen EPERM 失败；允许本机监听后 48 pass / 0 fail。该记录只证明本地传输，不证明真实 Codex/OAuth 提供商兼容。

插件挂载入口 route，配置 `models` 数组：每项 `provider`、`model`、可选 `alias`、`target: {type: route|service, id: UUID}`、可选 `capabilityOverrides`。目标在自身配置中声明 `llm_protocol: responses|chat_completions|anthropic_messages`。不管理上游 URL/凭据，不添加模型前缀。

目录模板针对 CLI 0.160.1。保留上游原生字段与顺序；没有能力目录或上下文长度时不发布外部模型。默认不声明服务端搜索、并行工具或压缩历史支持。能力修正只限制目录所支持的能力。目录按请求合并，无跨身份缓存，返回 private/no-store 与新 ETag。泛用 data[] 仍返回 data[]。原生目录与绑定 ID 冲突在读取目录时拒绝；动态原生目录不可在离线配置编译时获取，不能声称已经在提交前验证远端原生冲突。

阶段验证和后续完成状态将随实现更新。真实 Desktop 界面与真实提供商联调尚未完成。

目录阶段：6 项新契约测试通过；models-dev/model-mapping 回归 31 pass；OAuth/配置编译回归 74 pass；完整构建与架构检查通过。目录功能有绑定 UI、版本化模板、通用 target 引用与循环校验。后续调度尚在下一阶段。
