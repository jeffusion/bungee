# Codex Router 实施记录

基线：PR #76，`a570e6b946bee886249d0daef35e4ae8488d1adc`。开发从独立 `codex/codex-router` 分支开始，原工作区无改动。未部署，未激活生产配置。

依赖恢复：Bun 1.4.2，`BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/bungee-bun-cache bun install --frozen-lockfile`，锁文件未改。受限沙箱不能修改外部 Git 元数据，分支操作经授权执行；依赖 prepare 中 husky 无法写入 Git config，不影响锁定依赖恢复。

基线完整构建和架构检查通过。WebSocket 专项在受限沙箱因 loopback listen EPERM 失败；允许本机监听后 48 pass / 0 fail。该记录只证明本地传输，不证明真实 Codex/OAuth 提供商兼容。

插件挂载入口 route，配置 `models` 数组：每项 `provider`、`model`、可选 `alias`、`target: {type: route|service, id: UUID}`、可选 `capabilityOverrides`。目标在自身配置中声明 `llm_protocol: responses|chat_completions|anthropic_messages`。不管理上游 URL/凭据，不添加模型前缀。

目录模板针对 CLI 0.160.1。保留上游原生字段与顺序；没有能力目录或上下文长度时不发布外部模型。默认不声明服务端搜索、并行工具或压缩历史支持。能力修正只限制目录所支持的能力。目录按请求合并，无跨身份缓存，返回 private/no-store 与新 ETag。泛用 data[] 仍返回 data[]。原生目录与绑定 ID 冲突在读取目录时拒绝；动态原生目录不可在离线配置编译时获取，不能声称已经在提交前验证远端原生冲突。

阶段验证和后续完成状态将随实现更新。真实 Desktop 界面与真实提供商联调尚未完成。

目录阶段：6 项新契约测试通过；models-dev/model-mapping 回归 31 pass；OAuth/配置编译回归 74 pass；完整构建与架构检查通过。目录功能有绑定 UI、版本化模板、通用 target 引用与循环校验。后续调度尚在下一阶段。

## 内部调度阶段

增加唯一 Gateway dispatch provider 和公开 onDispatchRequest Hook。目标只能来自入口插件 schema 中 gateway_target 声明的编译引用，客户端参数无法创建引用；每次请求最多转交一次，目标目录的 dispatch Hook 不再重入。route 目标运行最终 route/service/upstream 链路，service 目标使用入口 route 和指定 service；共享 service 插件及凭据按入口作用域初始化。

调度先于单一 admission session。可信 entryRouteId 随签名 RPC、preview 和 grant 固定，key-access 同时检查入口/最终受保护 scope；入口和目标不同的 route 限流分别应用。绑定目标发布时必须声明 llm_protocol；目录阶段尚不能在离线发布时获知动态原生模型冲突。

验证：新增调度、既有流水线及引用检查 23 项通过；admission/key-access/scoped phase 51 项通过（监听端口测试在沙箱外重跑）；核心构建和 32 项架构测试通过。此阶段接通原生 Responses，转换目标仍返回 protocol_not_ready，下一阶段解除。

## 协议与历史阶段

`@bungee/llms/plugin-api` 提供共享 Responses 请求、JSON 响应和 SSE 状态机。Codex 调度按目标接收协议生成 Chat Completions 或 Anthropic Messages；目标已有转换链路继续处理后续转换。旧 openai-messages-to-chat 插件使用相同响应 codec，保留原请求兼容入口。多候选 SSE 不再做有损合并，而是明确拒绝。

namespace 工具使用无碰撞的线协议名称并恢复原名称；custom 工具包装为字符串 input 参数并还原。工具 JSON 不完整、流截断、未知终态及服务端工具要求均不能产生成功完成。Chat reasoning_effort 和 Anthropic thinking budget 需要显式 capabilityOverrides，后者必须小于输出预算。未支持的图像、推理历史或参数返回明确错误。

历史正文仅保存在控制进程的有界临时缓存，经 canonical 插件 RPC 分块访问，不写入数据库或命令 journal。缓存按可信身份、入口、配置版本和绑定配置隔离；默认 512 条、32 MiB 总量、8 MiB 单条、10 分钟 TTL。待组装 RPC 分块另限 128 项、8 MiB 总量和 30 秒 TTL。无可信身份的 HTTP 请求需要完整历史。引用失效及不可还原的跨目标历史要求新建对话。

验证：阶段组合测试 110 pass；旧桥接及共享 codec 兼容测试 62 pass；核心构建、llms 类型检查和 32 项架构检查通过。覆盖真实核心 HTTP 流水线到 mock Chat/Anthropic 上游的 JSON/SSE，以及 canonical RPC 和独立消费者的历史读写。独立消费者测试仍在同一进程中，不代表多 worker 验收。WebSocket 会话模式、真实 App/CLI 与提供商验收仍待完成。
