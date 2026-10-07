# HTTP 正文架构

Bungee 默认把请求和响应作为不透明字节流。Content-Type、Content-Encoding 或 Hook 的存在均不会单独触发解析；只有当前请求的有效内容需求才读取正文。没有需求时，JSON、SSE、二进制、multipart 和未知编码都保留原始 wire 字节与实体头。ingress 与 worker 的 fetch 关闭自动解压。当前 HTTP 网关不实现 WebSocket，升级请求返回 426。

## 同一插件与 Hook 生命周期

核心业务与项目插件都实现 `Plugin.bodyRequirements()` 和 `Plugin.register(hooks)`。Host 创建 `PluginHooks`，经 register 装配核心提供者，再校验每个必需阶段恰好一个提供者。缺失或重复均在接纳请求前失败，不能在请求中静默回退到旁路实现。

当前十个核心插件为正文服务、HTTP 请求入口、路由、准入、选择、重试、请求规则、转发、响应规则、日志。正文服务 `BodyServicePlugin` 注册 `onGatewayBody`；该同步 Bail Hook 与异步 Hook 共用 BaseHook 的注册、排序和统计机制，拒绝异步注册和 Promise 返回值。它只创建所有者，不提前读取正文。所有生产正文创建经 `createBodySource()` 调用同一 Hook；唯一 `new BodySource()` 在正文提供者中。没有另建正文容器或异步初始化阶段。

`runGatewayRequest()` 通过 AsyncLocalStorage 捕获本请求的核心 Hook 装配。后续重试、后台日志和观察使用该请求的装配，新的配置代际不能替换在途请求的提供者。scoped 插件保持 Global、Route、Service、Upstream 的请求顺序及反向 inbound 顺序；响应瀑布在每个 tap 之后刷新当前正文表示。

实现入口：[运行时装配](../packages/core/src/gateway/runtime.ts)、[正文插件](../packages/core/src/gateway/body-plugin.ts)、[正文工厂](../packages/core/src/gateway/body-factory.ts)、[正文所有者](../packages/core/src/gateway/body-service.ts)。`worker/request/body-source.ts` 仅转导内部实现。插件唯一公共核心入口是 `@jeffusion/bungee-core/plugin`，正文 SDK 导出类型和受控句柄，不提供自行建立 reader 的工厂，也不会把 node:zlib 引入控制面 SDK bundle。

## 需求、方向和版本

配置使用 `request: {headers, query, body}` 与 `response: {headers, body, body_formats}`。Route.request 合并 Endpoint.request，Endpoint 的具体字段覆盖 Route；Endpoint.response 合并 Route.response，Route 的具体字段覆盖 Endpoint。操作数组沿用去重并集，Route 显式 body_formats 覆盖 Endpoint，缺省为 json、sse-json。空操作块不产生需求。字段操作按 add、replace、default、remove 执行；remove 不删除同一规则中 add/replace 的字段。

静态 header、query 和 path 修改保持流式。表达式正文依赖通过 AST 识别：body/headers 指当前方向，request 指出站请求，response 只用于响应阶段；url、method、env 保持可用。条件及一致性 hash 的正文依赖在选择上游前读取；Endpoint 的需求只在被选中后求值。响应规则需要 request.body 时，在发送前保留必要请求视图。

全部 runtime 插件和 handler 使用 SDK 3，必须提供 `bodyRequirements(context)`；缺方法或无效需求不能初始化/执行。请求区分 none、json-read、json-write，响应选择 json/sse-json，replay 单独声明。可选 observe 不提升 mandatory 需求。所有随仓库发行的插件统一更新，不提供旧 SDK 隐式兼容声明。

正文身份包括 requestId、attemptId、direction、stage、version、contentType、contentEncoding，区分四种阶段：

| 阶段 | 含义 |
| --- | --- |
| original-request | 收到的原始请求 |
| outbound-request | 当前 attempt 最终发送的请求 |
| upstream-response | 转换前的原始上游响应 |
| client-response | 规则与插件处理后最终输出的响应 |

只读 Hook 保留原 wire 表示及编码。Hook 返回新响应或规则改写正文时，表示版本递增；下一 tap 的 bodyHandle 绑定新版本，不沿用旧缓存。原始、出站、上游和最终表示不能混用，日志与 Token 观察需明确其所消费的阶段。

## 所有权与共享计算

BodySource 拥有唯一物理 reader，区分 empty、opaque-stream、replayable-bytes，不 clone/tee 请求。wire、decoded、JSON 与 SSE 事件由同一所有者按需建立缓存；同版本正常计算只解压、JSON 解析或分帧一次。JSON 和 SSE 公共对象递归冻结，字节视图按 SDK 契约只读；写操作建立新表示，可变规则对象使用隔离副本。false、null、0 和空字符串保留实际值。

请求 body rules 要求 JSON object；空 POST 可由 add/default 建立 object，GET/HEAD 不产生正文。改写按 identity JSON 序列化，全部 Hook、header profile 与凭据注入之后删除旧 Content-Encoding、重算 Content-Length。只读操作恢复编码和长度，保留业务头修改。

重试、failover 或显式 replay 需求才独立保留可重放字节，受正文与 worker 资源约束，不落盘。只读解析保留的 wire 也可重放。未保留的 one-shot stream 消耗后不能再尝试，响应已输出后不再 failover。signature-repair 的一次修复重试经网关重试插件执行，不重跑已完成的请求转换，并保留原错误作为修复失败的回退。

failover 关键词检测只保留有界 wire 前缀，命中立即取消唯一源；SSE 在首个完整分隔边界返回，不等待后续 EOF。未命中逐字节回放前缀和余流。完整压缩样本通过已注册正文提供者的 decoded 视图检查，不自建解压器；UTF-8 前缀匹配属于文本检查，不建立额外 JSON parser。

## 解码、解析与资源边界

中央正文实现按需支持 identity、gzip、zstd。zstd 最大窗口由中央配置控制，默认 8 MiB。未知或组合编码只有必要解码时才失败；无内容需求的转发保持透明。无效压缩、UTF-8 或 JSON 使用固定错误码，不包含解析输入。必要响应解析失败返回 502，头部已输出则关闭连接并记录失败。

三个限制有不同含义：

| 限制 | 作用 |
| --- | --- |
| HTTP `body_parser_limit` | 必要 wire/decoded 读取的内容上限，默认 50 MiB；SSE 按完整单帧计算，不按连接累计量 |
| worker 资源预算 | 所有并发请求实际保留分配、可选计算、解码器及消费者积压，容量不足返回固定 503 或使可选消费者 incomplete |
| 日志保存配额 | 单份保存内容和日志内存，超限仅停止日志，不截断 HTTP 正文或 Token 观察 |

Content-Length 提前超限在发送上游前返回 413；chunked 超限取消上传，已有前缀可能到达上游。读取与必要解码遵循请求 deadline。日志和观察拥有可选资源预算，不能占满必要解码槽位或把各自失败传播成主流成功/失败判定。

中央配置及可重复测量见 [正文共享资源测量](./body-resource-measurements.md)。当前默认 worker 总保留预算为 512 MiB，必要/可选解码器各八个；这些是资源运行基线，不是新的业务限额。初始两个解码器会拒绝低负载的八并发，因此依据重复与混合文本测量调整为八个。800 KiB 和 2 MiB 样本八并发均完成，不承诺任意大小或并发均能完成。

## SSE 与独立消费者

无需求的 SSE 逐字节透传，不建 parser、heartbeat 或终态补帧，不按 JSON type 猜 event。必要 SSE 使用封套 `{data,json?,event?,id?,retry?,comments?,raw?}`，正文与元数据分开。body rules 只改写 JSON object data；非 JSON、非 object、[DONE]、comment-only 帧和原始 CR/LF 分隔保持原帧。配置规则不能把一个 event 变多个；插件支持 N:M 封套转换。SSE header rules 引用当前 response.body 会被拒绝。

规则、日志与 Token 消费同一事件 session 的冻结引用；每个可选消费者有独立期限、积压预算、取消状态及 incomplete 通知。关闭日志不关闭 Token；关闭统计消费不影响日志。取消一个消费者不取消其他活跃消费者，慢观察不反压主要转发。插件异步回调需遵守 `isActive()`，失效后不能继续修改业务状态。

原始响应观察先于 inbound 转换，用于真实上游 usage；最终响应日志绑定 client-response。JSON、二进制和 SSE 都沿用 pull/backpressure/cancel/completion 收尾，不靠媒体类型决定 drain，也不因错误伪造成功正文。显式 raw 插件可提供已验证 protocolCompletion；默认 opaque SSE 不推断业务终态。

日志启用后在实际输入读取、最终请求发送及最终响应输出时附着消费者，不提前 pump。原始请求与最终请求分别保存；EOF 后后台保存，访问日志回填引用，文件日志等待最终正文引用后后台入队，HTTP 不等待保存。重试使用独立版本，防止旧 attempt 覆盖最终记录。保存配额、可选解码、UTF-8/base64 展示及 incomplete 仅作用于日志。

SSE 日志保存为 `[{event,data}, ...]`：多行 data 合并，合法 JSON 使用公共解析结果，其余保留字符串，[DONE] 保持文本；注释、id、retry 不进入展示数组。历史正文只作读取时投影，复制和下载使用同一展示值，不改历史文件。缺 Content-Type 时，只在最终 Accept 明确接受 SSE 且原文符合字段格式时展示数组，普通错误文本保持原样。

## 配置整理与验收

数据库自动 v15 整理旧字段，运行时只执行 request/response。新方向块的显式字段优先，包括空规则；剩余旧字段按方向搬迁。不可用的规则、操作或条目自动局部忽略，保留有效兄弟项，不回退到已被新字段覆盖的旧值，无需手动迁移。旧 Endpoint.body 的响应语义仍为普通 JSON；混合的新 body_formats 不能把它扩大到 SSE。鉴权、目标、插件及数据库完整性继续严格校验。

导入先验证原封装 hash，再执行同一整理，预览与提交保持一致，warnings 仅记录位置及固定原因。历史修订和 serving snapshot 不改写；升级和发布是独立状态，不把构建或测试通过当作部署完成。

`bun run check:architecture` 使用 TypeScript AST 检查公共 SDK 导入、正文构造、原生读体和中央解码边界；负例测试包含错误 import、getReader、clone、原生 json/text/arrayBuffer、tee 与 codec 旁路。OAuth 交换、账号 usage、模型目录及管理 API 属于明确辅助网络边界，业务 JSON 字段解析不被全局禁用。CI 在构建前运行检查。

测试定位：`gateway-plugin-pipeline.test.ts` 覆盖提供者缺失/重复、实际 Hook 调用与每 tap 表示刷新；`shared-body-service.test.ts` 和 `body-lifecycle.test.ts` 覆盖共享计算、消费者隔离及取消；`response-detector.test.ts` 覆盖前缀回放和压缩检查；`opaque-transport.test.ts`、`opaque-observer.test.ts` 覆盖透明字节及独立观察；`package-artifact-contract.test.ts` 重建并验证发布产物。当前工作未部署，不以历史测试数字作为本轮验收证据。
