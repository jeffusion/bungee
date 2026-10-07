# HTTP 正文架构

Bungee 默认把请求和响应当作不透明字节流。Content-Type 声明为 JSON、SSE，或存在 Content-Encoding，均不会独自触发解析。binary、multipart、未知编码以及错误的 JSON 声明，在没有内容需求时保持原始 wire 字节和实体头。公网 ingress 与 worker 的 fetch 都关闭自动解压。

## 需求与方向

配置使用 `request: { headers, query, body }` 和 `response: { headers, body, body_formats }`。请求由 Route.request 合并 Endpoint.request，Endpoint 的具体字段覆盖 Route；响应由 Endpoint.response 合并 Route.response，Route 的具体字段覆盖 Endpoint。操作数组沿用去重并集；Route 显式 body_formats 覆盖 Endpoint，缺省为 json、sse-json。空操作块没有正文需求。字段操作保持 add、replace、default、remove 顺序；remove 不删除在同一规则中 add/replace 的字段。

Header、query、path 的静态修改保持流式。表达式依赖通过 AST 识别，只有实际引用正文时才读取。body/headers 指当前方向，request 指最终出站请求，response 只可用于响应阶段；url、method、env 保持可用。条件和一致性 hash 的正文依赖在选择上游前读取；Endpoint 的正文需求只在该 Endpoint 被选中后读取。响应表达式依赖 request.body 时，在发送前保留所需请求视图。

SDK 插件必须声明 bodyRequirements。缺少方法或返回无效需求的插件不能初始化/执行；没有旧插件隐式全 JSON 解析兜底。读取和修改请求分别声明 json-read、json-write；response 选择 json/sse-json；replay 独立声明。可选 observe 不提升 mandatory 内容需求。需求使用路径重写后的实际 URL。

## 正文所有权

`worker/request/body-source.ts` 的 BodySource 区分 empty、opaque-stream、replayable-bytes，拥有唯一 reader，不 clone/tee 请求。decoded 与 JSON 视图按实例缓存一次。只读解析会保留原始 wire bytes 与 Content-Encoding；false、null、0、空字符串不被替换为默认对象。

请求 body rules 要求 JSON object。空 POST 可通过 add/default 创建 object，GET/HEAD 不生成正文。修改后按 identity JSON 序列化，在全部 hooks、header profile、credential 注入后删除 Content-Encoding 并重算 Content-Length；未修改的正文保留原编码与长度。

重试、启用的 failover 或插件明确 replay 才独立保留内存字节，受正文与 worker 总量限制，不落盘。只读解析产生的原始字节也可重放；每次尝试的可变 JSON 使用隔离副本。one-shot stream 已被消耗且没有可重放字节时停止后续尝试，响应输出后不会进入新的 failover。

## 编码与资源边界

必要读取支持 identity、gzip、zstd 的异步流解码。zstd 的最大窗口为 8 MiB（ZSTD_d_windowLogMax=23）。未知或组合编码仅在必要读取时返回 415；压缩、UTF-8 或 JSON 无效返回 400。错误码固定，不包含解析输入。

wire 和 decoded 字节分别受 body_parser_limit 约束，缺省 50mb。Content-Length 提前超过上限时，在选择上游发送之前返回 413；chunked 流超过上限时取消上传，可能已有前缀到达上游。worker 同时最多两个必要解码器，累计保留正文缓冲限制 128 MiB，含 replay、decoded 视图和必要 SSE 帧。容量不足返回 503 的 body_decoder_capacity/body_buffer_capacity。读取/解码使用 Route request_ms 的处理期限，缺省 30 秒。必要的匹配响应解析失败返回 502；头部已发出的流失败关闭连接并记录失败。

## 响应与 SSE

原始响应先进入有界旁路 meter，然后执行 Endpoint、Service、Route、Global inbound hooks，接着 merged body rules、headers rules，最后校正实体头。raw hooks 默认收到原始编码。声明响应内容需求的协议转换器可显式调用 RawResponseContext.decodeResponseBody，使用网关统一的 wire/decoded 上限、解码器容量及 deadline；OAuth 转换器通过此入口处理 gzip/zstd SSE。解码输出由宿主持有，cleanup 和 abort 归还解码器并取消源流，插件遗弃输出或持锁不影响释放。默认透传不调用该入口。必需 JSON 插件收到解码视图；只读 hook 返回同一 Response 时恢复原 wire 字节，改写返回值使用 identity 表示。

没有需求的 SSE 完整按字节透传，没有 parser、heartbeat、自动终态补帧或 JSON type 推导 event。必要的 SSE 使用 SSEEnvelope，data/json 与 event/id/retry/comments/raw 分离。body rules 只作用于每个 JSON object event；非 JSON、非 object、[DONE] 保持原帧，分片和 CR/LF 边界被正确处理。配置规则不能把一个 event 变成多个；插件的 typed envelope 支持 N:M。SSE header rules 引用当前 response.body 会被拒绝。

普通 JSON、二进制和 SSE 都通过相同的 pull/backpressure/cancel/completion 收尾，不依靠 Content-Type 判断 drain。错误后不伪造成功正文。显式 raw 插件可提供已验证的 protocolCompletion，已验证终态在随后客户端取消时得以保留；核心不会为默认 opaque SSE 推断终态。

## 准入与旁路观察

内部 inspect RPC 校验 worker 身份、路由保护与 principal，返回 policyVersion 和各策略的必要正文需求，不运行 quota plan，不签发 grant。只有有效策略要求 json-read 时读取正文；最终 URL/model 确定后执行 preview/prepare/admit。版本变化最多尝试三轮。

可选 byte observer 从主流复制独立队列，不使用 tee。JSON/单 SSE event 的观察上限 1 MiB，队列 256 KiB，worker 总观察缓冲 16 MiB，callback 250ms 有界有效期。队列/解码/回调不足以完成观察时记录 incomplete，原始流继续传输，包括 EOF，不等待观察回调。观察完成后再结算统计及释放插件 lease；相同原因按 attempt 去重通知。JSON 错误重试仅在存在统计消费者时有界读取（最多 1 MiB），其它响应仍取消后重试。响应协议依据 Content-Type 或显式 Accept，不使用请求正文的 stream 字段猜测。可选解码不占用必要解码器槽位；SSE observation 的 envelope 元数据不注入 JSON。

日志中的 request_body_plan、request_body_dispatch、response_body_plan 记录 mode、reasons、source、replay；观察不足通过 incomplete event 单独记录。日志和 token 统计不能强制主要流全量缓冲。

WebSocket 升级在当前 HTTP 网关仍返回 426。

## 配置迁移与发布

数据库打开时自动执行 v15，一次性整理旧字段；运行时只接受 request/response，不保留双版本执行逻辑或兼容开关。旧 Endpoint.body 保留双向语义，迁移后的响应只作用于普通 JSON。迁移生成新修订，历史修订和 serving snapshot 不改写；未完成发布或恢复时禁止迁移。SDK 3 的全部插件必须提供需求方法。

新旧修改字段可混用：新方向块中显式提供的 headers/query/body 优先，包括空规则；其余旧字段按方向自动搬迁。无法使用的修改字段、操作或具体条目局部忽略，保留有效兄弟规则，不回退到被新字段覆盖的旧规则。Service 不支持的修改字段忽略，Service 的 Endpoint 仍独立迁移。无效响应 body_formats 连同对应 body 忽略，避免删除选择器后意外扩大到 SSE。鉴权、插件配置、路由目标及数据库完整性仍严格校验，不通过忽略这些字段放行。

混合配置中新 response.body_formats 若不是单独的 json，不继承旧 Endpoint.body 到响应方向，记录 new_format_preferred；请求方向仍独立保留。明确的新 response.body 使用新选择器。这样旧 JSON 规则不会因升级被扩展到 SSE。

升级事务提交后，服务日志一次性记录 ignored_rules 的配置位置及固定原因，不记录规则值；失败回滚或重复打开不输出成功摘要。快照导入先验证原始内容和封装 hash，再执行相同整理；接受导入的响应返回 warnings，并记录服务日志。界面通过只读的 POST /api/config/validate（envelope 参数）预览整理后的实际配置，并显示忽略数量，无需手动编辑导入文件。普通配置编辑和 aggregate 参数校验仍严格拒绝旧字段或无效规则。

`GET /api/runtime/routes` 在管理认证和 config.read 权限内返回已提交配置的处理计划；路由编辑器显示相同计划。插件和准入需求依赖实际请求，最终方式以请求日志为准。该接口不返回规则值、上游地址或密钥。

发布前先备份配置数据库，在独立数据目录启动构建产物并验证配置迁移及 HTTP 转发；确认后才切换生产。回退需要旧构建与升级前数据库备份，不能把已迁移数据库交给旧版本。此轮实施与测试不切换生产容器。

## 验收位置

- tests/unit/opaque-transport.test.ts：wire 哈希、方向与优先级、只读编码保持、SSE metadata/分片、首块、replay、大小与解码容量、通用取消/错误。
- tests/unit/opaque-admission.test.ts：inspect 无扣量、保护 fail-closed、按有效需求读取、三轮版本边界。
- tests/unit/opaque-observer.test.ts：慢观察不阻塞、queue 上限、独立压缩视图、SSE metadata。
- tests/opaque-http-real-process.test.ts：真实 ingress → worker 子进程 → upstream 的字节哈希与双方向首块早于 EOF。

## 审查修复记录

| 问题 | 处理 | 验证 |
| --- | --- | --- |
| 流式所有权绕过有限 raw 错误来源校验 | 错误正文有界读取，校验 raw completion 后再返回 | phase-aware-pipeline 的五种不安全替换与安全替换 |
| 重复取消已锁定的原始流 | 唯一 reader 负责取消，清理等待真实取消 Promise | data-plane-final-regressions 的异步取消与清理期限 |
| 插件改写正文保留旧实体头 | 标记表示变更，在全部响应规则后校正实体头 | opaque-response-plugins 的真实 HTTP 长正文 |
| 只读恢复原字节时丢失业务头 | 仅恢复原编码、长度，保留 hook 修改的业务头 | opaque-response-plugins 的 gzip 哈希与 x-plugin |
| 已准入请求重试重新读取当前策略 | 同一逻辑请求沿用原 grant，新请求仍 inspect | opaque-admission 与 data-admission |
| 单个 header 表达式失败终止整个请求 | 按字段隔离失败并记录固定诊断 | server 的 graceful expression 用例 |
| 既有 Date 表达式被 AST 拒绝 | 仅开放 Date 构造及明确实例方法 | server 的动态 Date 表达式 |
| 有限正文 EOF 提前解除 raw proof 期限 | 严格协议完成后才解除请求 deadline | phase-aware-pipeline 的有限正文与悬挂 proof |
| observer 隐藏源流取消完成状态 | 持有真实源 reader，把 teardown 纳入有界 cleanup | attempt-observation 的 retry/failover cancel gate；独立 cancel reject/hang 复验 |
| 插件遗弃 raw 解码输出耗尽容量 | 宿主登记可释放的解码输出，dispose/abort 幂等归还容量 | phase-aware-pipeline 的 throw、locked-throw、deadline 后恢复 gzip/zstd；独立三次异常与取消 gate 复验 |
| CR 换行 SSE 末帧丢失 | 观察解析归一化完整行，EOF 消费尾 CR | opaque-observer 的整块与逐字节 CR-only 输入 |
| 混合配置的新格式选择器扩大旧 Endpoint 响应规则范围 | 新选择器优先，无法保持 JSON-only 的旧响应 body 不继承，请求 body 保留 | directional-config 的空、SSE、双格式、无效选择器和明确新正文组合；修复前复现失败 |

另以 attempt-observation、token-stats-v3.integration、request-body-limit 验证可选回调不阻塞 EOF、同原因通知去重、合法注释尾部、协议头选择、429 两次 usage 及 413 错误正文持久化。

## 本轮验证结果

2026-10-07 的初次实现回归执行 `bun test packages/core/tests tests/unit plugins packages/llms/tests packages/llms/src packages/ui/src packages/types tests/opaque-http-real-process.test.ts scripts`：332 个文件、3273 项通过、2 项 Windows 专用测试跳过、0 失败。

完整项目构建、Core TypeScript 检查和 `git diff --check` 均通过。隔离数据目录中的构建产物完成真实 master、ingress、worker 启动、配置发布及 HTTP 转发验证。真实 HTTP gzip/zstd OAuth 响应转换专项测试 2 项通过，验证关闭 fetch 自动解压后仍能通过宿主解码服务完成转换。生产部署保持原状。

随后调整为局部忽略策略：同一全量回归命令 3285 项通过、2 项 Windows 专用测试跳过、0 失败。独立审查发现混合格式选择器边界问题，补测复现并修复；复审及最终迁移/导入专项 53 项通过，最终配置存储、并发升级、历史快照和界面配置回归 170 项通过、0 失败（测试集合重叠，数量不累计）。完整构建通过；边界修复后的 Core 构建、Core TypeScript 检查、隔离构建产物真实进程发布测试及差异检查均通过。未切换生产，未执行浏览器交互验证。

已有 signature-repair 插件的内部 fetch 重试仍沿用原机制，未纳入网关 attempt 准入与计量协调；本次适配提供明确正文与 replay 需求，并修正重发 JSON 的实体头。此限制仍适用于该插件的内部重试。
