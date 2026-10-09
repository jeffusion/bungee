# Codex Router 实施记录

基线：PR #76，`a570e6b946bee886249d0daef35e4ae8488d1adc`。开发从独立 `codex/codex-router` 分支开始，原工作区无改动。未部署，未激活生产配置。

依赖恢复：Bun 1.4.2，`BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/bungee-bun-cache bun install --frozen-lockfile`，锁文件未改。受限沙箱不能修改外部 Git 元数据，分支操作经授权执行；依赖 prepare 中 husky 无法写入 Git config，不影响锁定依赖恢复。

基线完整构建和架构检查通过。WebSocket 专项在受限沙箱因 loopback listen EPERM 失败；允许本机监听后 48 pass / 0 fail。该记录只证明本地传输，不证明真实 Codex/OAuth 提供商兼容。

插件挂载入口 route，配置 `models` 数组：每项 `provider`、`model`、可选 `alias`、`target: {type: route|service, id: UUID}`、可选 `capabilityOverrides`。目标在自身配置中声明 `llm_protocol: responses|chat_completions|anthropic_messages`。不管理上游 URL/凭据，不添加模型前缀。

目录模板针对 CLI 0.160.1。保留上游原生字段与顺序；没有能力目录或上下文长度时不发布外部模型。默认不声明服务端搜索、并行工具或压缩历史支持。能力修正只限制目录所支持的能力。目录按请求合并，无跨身份缓存，返回 private/no-store 与新 ETag。泛用 data[] 仍返回 data[]。原生目录与绑定 ID 冲突在读取目录时拒绝；动态原生目录不可在离线配置编译时获取，不能声称已经在提交前验证远端原生冲突。

实现包含目录、内部调度、HTTP/SSE 转换、跨 worker 临时历史和 WebSocket 会话。真实 Desktop 界面与真实提供商联调尚未完成。

目录阶段：6 项新契约测试通过；models-dev/model-mapping 回归 31 pass；OAuth/配置编译回归 74 pass；完整构建与架构检查通过。目录功能有绑定 UI、版本化模板、通用 target 引用与循环校验。后续调度尚在下一阶段。

## 内部调度阶段

增加唯一 Gateway dispatch provider 和公开 onDispatchRequest Hook。目标只能来自入口插件 schema 中 gateway_target 声明的编译引用，客户端参数无法创建引用；每次请求最多转交一次，目标目录的 dispatch Hook 不再重入。route 目标运行最终 route/service/upstream 链路，service 目标使用入口 route 和指定 service；共享 service 插件及凭据按入口作用域初始化。

调度先于单一 admission session。可信 entryRouteId 随签名 RPC、preview 和 grant 固定，key-access 同时检查入口/最终受保护 scope；入口和目标不同的 route 限流分别应用。绑定目标发布时必须声明 llm_protocol；目录阶段尚不能在离线发布时获知动态原生模型冲突。

验证：新增调度、既有流水线及引用检查 23 项通过；admission/key-access/scoped phase 51 项通过（监听端口测试在沙箱外重跑）；核心构建和 32 项架构测试通过。此阶段接通原生 Responses，转换目标仍返回 protocol_not_ready，下一阶段解除。

## 协议与历史阶段

`@jeffusion/bungee-llms/plugin-api` 提供共享 Responses 请求、JSON 响应和 SSE 状态机。Codex 调度按目标接收协议生成 Chat Completions 或 Anthropic Messages；目标已有转换链路继续处理后续转换。旧 openai-messages-to-chat 插件使用相同响应 codec，保留原请求兼容入口。多候选 SSE 不再做有损合并，而是明确拒绝。

namespace 工具使用无碰撞的线协议名称并恢复原名称；custom 工具包装为字符串 input 参数并还原。工具 JSON 不完整、流截断和未知终态不能产生成功完成。Chat reasoning_effort 需要模型目录支持以及显式 capabilityOverrides。首版 Router 不启用 Anthropic thinking：签名 thinking 历史不能可靠重编码，目录也不声明该能力；通用 codec 的单次显式 budget 接口不代表 Router 支持其续聊。未支持的图像、推理历史或参数返回明确错误。

CLI 常规附带的 prompt_cache_key/client_metadata 经校验后不转交转换目标，也不能成为身份或路由依据。include 中仅接受 reasoning.encrypted_content 这一可选输出请求；转换结果不生成加密内容，实际加密输入仍拒绝。自动/none/缺省工具选择中的顶层 web_search/web_search_preview 声明可以省略；required、强制指定搜索及其他未支持的服务端工具明确报错。普通工具和 grammar custom 工具仍交由 Codex 执行。

历史正文仅保存在控制进程的有界临时缓存，经 canonical 插件 RPC 分块访问，不写入数据库或命令 journal。缓存按可信身份、入口、配置版本和绑定配置隔离；默认 512 条、32 MiB 总量、8 MiB 单条、10 分钟 TTL。待组装 RPC 分块另限 128 项、8 MiB 总量和 30 秒 TTL。无可信身份的 HTTP 请求需要完整历史。引用失效及不可还原的跨目标历史要求新建对话。

历史 RPC 使用正式请求作用域，控制进程核验签名 worker、所服务的配置版本、入口插件绑定和可信 principal。延迟响应回调保留入口 owner lease 并重新建立 invocation，不借用过期 RPC frame。分块序列化转义 UTF-16 surrogate，避免 Emoji 在 canonical RPC 边界被拆断。原生加密历史只允许经缓存验证的相同 provider/model/target/upstream，所有选择和重试都检查来源 upstream；没有可信来源或切换目标时要求新建对话。

验证：阶段组合测试 110 pass；旧桥接及共享 codec 兼容测试 62 pass；核心构建、llms 类型检查和 32 项架构检查通过。该阶段覆盖真实核心 HTTP 流水线到 mock Chat/Anthropic 上游的 JSON/SSE，以及 canonical RPC 和独立消费者的历史读写；后续多进程证据见下一节。

## WebSocket 会话与真实本地验收

透明代理仍复用 #76。指定 Codex 入口的 Responses 会话通过核心 managed session 接入；每次 response.create 派生独立请求 ID、固定配置版本和可信身份，重新执行绑定及最终目标链路。首版同一连接串行生成，忙碌时拒绝新生成；generate:false 预热仅保存连接内输入，不连接提供商、不产生生成统计。response.cancel 和断开取消活动请求。

HTTP 上游使用共享 SSE BodyHandle，转换成 WS JSON；Responses 目标启用 websocket 时使用核心原生 WS 上游。发送等待 Bun drain，不重发已入队帧；接收、消息和进程预算、关闭期限、排空均归核心 transport。每个生成复用单一 admission 与逐次 token 统计，握手不重复计为生成。入口限流沿用 #76 握手能力；要求未支持逐生成硬预算的目标，在上游连接前拒绝。匿名连接的可还原历史只保存在连接内，默认最多 32 条、8 MiB、10 分钟 TTL，关闭释放资源。

`tests/codex-router-real-process.test.ts` 启动实际 master 和两个受监督 worker，加载构建后的插件并经过公共入口、真实 canonical peer RPC。目录和提供商是 fixtures。四项验收 4 pass / 0 fail / 81 assertions：100843 字节中文/Emoji 与普通、namespace、custom 工具历史跨 worker 续接；身份及配置版本隔离；Chat service → Anthropic route 切换；原生 WS 多轮、预热、busy/cancel/断开及旧 worker 排空。一次运行中 12 个逻辑生成对应 12 个上游调用，统计无重复。

可选真实 CLI 验收：`BUNGEE_CODEX_CLI_PROBE=1 bun test tests/codex-router-real-process.test.ts --test-name-pattern 'public WS generations'`。CLI 0.160.1 在隔离 HOME/CODEX_HOME 和临时 ChatGPT-shaped stub 登录下，实际查询 GET /models?client_version=0.160.1；model/list 显示全部四个原始 org/* 标识。选择 Responses、Chat、Anthropic 分别到达正确 mock 路径并完成生成。该专项 1 pass / 0 fail / 99 assertions；六次 CLI 生成各有唯一 token 记录（4/2）。五次 app-server 请求 outcome=completed；额外 API Key codex exec 成功收到答案并关闭传输，其 outcome=aborted，不能将其视为完整消费 HTTP 流的证据。真实 CLI 还完成了两轮 Chat 工具往返：exec_command 执行 printf 返回标记；custom apply_patch 的空补丁返回真实错误，无文件修改；独立 stdio MCP echo 返回标记。下一轮实际请求包含三个原始 call_id 的结果、custom 类型与 MCP namespace，随后生成完成。MCP 子进程关闭经身份核验。没有读取或改写用户实际 Codex 配置、凭据。

独立复审发现的问题和全回归中的回归均逐项处理：

| Finding | 处理和证据 |
|---|---|
| 加密历史可能进入其他 provider 或 failover endpoint | 保存来源并固定 upstream，跨来源和来源缺失明确拒绝；插件历史测试及独立复审通过。 |
| Anthropic thinking 缺少可重放签名 | Router 禁用该能力，覆盖配置 override 无法开启的测试；独立复审通过。 |
| refusal 响应无法用于下一轮 | 作为 assistant 文本重编码，两种协议的 refusal 续聊测试通过。 |
| 空绑定遗漏正式 dispatch owner lease | 根据实际 dispatch Hook 保留 owner，不按目标数量判断；正式 RPC host 下目录/原生生成透传测试通过，同轴复审通过。 |
| 同 URL 的无 ID 端点被预热去重 | 保留原有端点位置身份，只对新增预热的显式 ID 去重；既有 upstream scope isolation 回归通过，同轴复审通过。 |
| 普通非调度路由新增入口租约影响销毁 | 仅为参与 dispatch Hook 的 owner 提前保留租约；普通 routing 销毁回归与完整 suite 通过。 |

CLI 兼容调整复审没有新增 P0–P2；独立执行 33 项测试及 42 项兼容/拒绝矩阵断言通过。Unicode 分块与错误类归一化为局部修复，已自行验证，无需复审。主线程也点验了多进程日志、测试断言、三个客户端结果和统计记录。

## 交付、启用和验收边界

四个依赖分支按顺序派生，首个仍依赖未合并的 #76；合并前序后调整 base 并变基，不重新从 main 开始：

| 分支 | 提交/PR | 初始 base |
|---|---|---|
| codex/codex-router | 8a93db0 / [#77](https://github.com/jeffusion/bungee/pull/77) | codex/websocket-responses-metering |
| codex/codex-router-dispatch | ade7d15 / [#78](https://github.com/jeffusion/bungee/pull/78) | codex/codex-router |
| codex/codex-router-protocol | 2d62c99 / [#79](https://github.com/jeffusion/bungee/pull/79) | codex/codex-router-dispatch |
| codex/codex-router-websocket | ff3ced9 / [#80](https://github.com/jeffusion/bungee/pull/80) | codex/codex-router-protocol |

功能只有指定入口挂载并启用插件才生效。按 native Responses、Chat、Anthropic 的顺序逐个启用并做提供商验收；关闭插件并恢复入口配置即可回退，目标 route/service 原用途不变，临时历史允许失效。此次没有部署或激活生产配置。

最终完整构建通过，32 项架构检查和 llms 类型检查通过；协议、目录、桥接、Gateway 流水线、admission、master composition、公共 SDK 和 WS 的组合回归 223 pass / 0 fail / 1442 assertions。与 #76 相同范围的完整回归 `bun test packages/core/tests plugins scripts packages/ui/src` 为 4015 pass / 0 fail / 31340 assertions。最后一次 Hook owner 过滤调整没有重复完整 suite，已运行直接影响的 14 项回归（92 assertions）和真实 CLI/双 worker 合并验收（4 pass / 139 assertions，18 次生成对应 18 次上游调用），全部通过。旧测试的 registry stub 同步补齐新接口，构建清单添加 codex-router，不放宽生产调用。

尚未验证：真实 Desktop App 的选择器、真实 OAuth/外部提供商及真实客户端跨模型历史切换。跨模型切换证据来自 mock 契约及公共 WS 测试；CLI 工具执行已真实完成，但模型仍为 fixtures。服务端搜索、Anthropic 签名 thinking、多候选 SSE、不可还原跨提供商历史和逐生成 WS 硬预算不支持。动态原生目录冲突在读取时拒绝，未实现离线发布前的远端冲突保证；目标接收协议必须显式设置，未根据提供商名称推断。
