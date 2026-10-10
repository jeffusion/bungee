# 请求统计口径

仪表盘通过 `GET /api/stats/dashboard?range=1h|12h|24h` 读取数据。一次响应中的趋势和上游统计来自同一时间窗口、同一个 SQLite 只读事务；时间范围为 `[startTime, endTime)`。

## HTTP 与传输分别记录

日志和仪表盘分别展示 HTTP 状态和 `transportOutcome`。HTTP 200 只说明响应状态码，不能证明传输完整或业务成功；完整返回 HTTP 500 也可以对应传输完成。

| 传输结果 | 观测依据 |
| --- | --- |
| `pending` | 响应已返回，尚未观察到流结束 |
| `completed` | 响应流正常读到结束，或响应没有正文 |
| `failed` | 响应读取出错，或有明确的代理超时证据 |
| `cancelled` | 请求或响应消费被取消 |
| `unknown` | 没有传输观测记录 |

最终返回的响应在客户端响应边界观察；未返回客户端的重试尝试在上游响应边界观察。传输完成表示代理观察到的字节流结束，不证明客户端应用已接收、处理成功，也不解析 SSE 中的业务终止事件。

`transportCode` 保存可用的原始原因，如 `request_timeout`、`first_response_timeout`、`stream_read_failed`、`client_cancelled`。取消单独计数；没有明确来源时展示“取消来源未知”。有明确的超时证据时不因随后发生取消而改成客户端取消。

传输字段允许 NULL，API 映射为 `unknown`；没有观察证据时不根据 HTTP、`success` 或协议结果回填。

## 计数单位

- **客户端总览与趋势**：按请求链计数，一次客户端请求即使发生重试也只计一次。使用最终尝试的结果，按请求链第一条日志的时间归桶；耗时包含重试间隔。
- **上游统计**：每次上游尝试单独计数，按该条日志的时间计入窗口。上游请求分布包含成功和失败，流量占比的分母是全部上游尝试。
- **没有上游的请求**：例如鉴权失败或直接响应，只进入客户端统计。

例如一次请求第一次访问上游 A 完整返回 503，重试上游 B 完整返回 200：客户端总览增加一个 HTTP 2xx、一个传输完成；上游统计增加两个尝试，一个 HTTP 5xx、一个 HTTP 2xx，两个传输完成。两个维度的数量有意不同；API 的 `units` 字段标明各自单位。

仪表盘保留所有上游，避免各面板分别截取前十名后出现遗漏。独立上游接口仍保留原有默认数量限制。

最终尝试先按 `request_type = final` 选择，再按 `attempt_number`、`timestamp`、`id` 降序取一条。列表、详情、筛选和统计使用同一选择规则；列表的代表行可能是较早尝试，不用于推断最终传输结果。

## API 与兼容字段

流式响应可能先返回 HTTP 200，然后发生协议错误、超时或取消。HTTP 状态码保留真实值，不能在流结束后改成 500。

汇总、时间序列和上游统计返回两个独立计数组：

- `httpStatusCounts`：`status2xx`、`status3xx`、`status4xx`、`status5xx`、`statusOther`。
- `transportCounts`：`pending`、`completed`、`failed`、`cancelled`、`unknown`。

每个计数组之和分别等于该维度总数，空窗口全部为零。

仪表盘使用独立的 `requestCounts.success` 和 `requestCounts.failed`：

- 成功：HTTP 2xx 且 `transportOutcome = completed`。
- 失败：`transportOutcome = failed`，或传输完整结束但 HTTP 为非 2xx。
- 取消、进行中和未知：不计入成功或失败，也不参与成功率分母。

请求成功率为 `success / (success + failed)`。没有可判定的请求时显示 `—`，趋势保留空点。失败数趋势和上游失败排行使用相同定义，不解析响应体中的业务结果。上游请求总量与流量占比仍包含全部尝试。`requestCounts` 同时出现在总览、趋势和上游统计中，直接在 SQL 中组合状态码与传输结果，不从两个独立计数组推算交集。

日志查询和导出接受 `transportOutcome` 单值以及重复的 `status` 参数，例如 `status=200&status=500&transportOutcome=completed`。非法值返回 400。`groupBy=chain` 时按最终尝试筛选，默认仍按单次尝试查询；时间窗口统一为 `[startTime, endTime)`，请求链按起始时间归属窗口。日志页面的 JSON/CSV 导出与列表使用相同请求链筛选，详情复制保留传输和协议诊断字段。

请求链 CSV 保留代表尝试的原字段，同时新增 `chainId`、`chainStatus`、`chainDurationMs`、`chainTransportOutcome`、`chainTransportCode`。这些明确命名的链字段对应最终结果，不覆盖代表尝试的 HTTP 或协议诊断。JSONL 文件记录在元数据和最终传输观测都就绪后入队一次，避免先刷出 `pending` 后无法更新。

`protocolOutcome`、`protocolCode` 在日志 API 和导出中保留现有插件提供的结果。核心日志不新增业务结果解析，不为诊断增加正文采集。

兼容 API 继续保留 `success`、`successRequests`、`failedRequests`、`successRate`、`failureRate`、`failed2xx`、旧历史 `errors` 及 `success` 筛选的原有语义。这些字段仍可能把协议失败和取消归为失败；仪表盘使用新的 `requestCounts`，不使用兼容字段判断请求成功或失败。独立上游成功／失败接口的旧筛选语义保持兼容。

统计只解释已有观测，不修改路由、重试或超时策略。
