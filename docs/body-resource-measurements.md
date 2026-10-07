# 正文共享资源测量

2026-10-07，Arch Linux，Bun 1.4.2。在仓库根目录运行：

```sh
bun scripts/measure-body-resources.ts
bun test packages/core/tests/shared-body-service.test.ts tests/unit/opaque-observer.test.ts
```

脚本只生成重复字符的合成 JSON，输出字节数、耗时、RSS 差值、计算次数和租约余量，不输出正文。它覆盖 800 KiB、2 MiB、50 MiB 精确边界、边界 +1 byte，identity/gzip/zstd，以及 2/8 并发和 worker 内存压力。脚本检测每轮正文、可选、日志和解码器租约均回归起始值。耗时/RSS 受机器和 GC 影响，不作为稳定 SLA；RSS 包含合成输入、运行时和 HTTP 容器对象，不能与正文租约预算等同。

| 合成输入 | 编码 | 必要解析和观察 | 共享解压/JSON 解析 | 峰值保留 | 耗时 |
| --- | --- | --- | --- | --- | --- |
| 800 KiB | identity / gzip / zstd | 每种均完整 | 0/1、1/1、1/1 | 约 4.43 MiB | 11.39 / 20.82 / 7.06 ms |
| 2 MiB | identity / gzip / zstd | 每种均完整 | 0/1、1/1、1/1 | 约 6 MiB | 16.16 / 8.26 / 8.62 ms |
| 50 MiB | identity / gzip / zstd | 每种均完整 | 0/1、1/1、1/1 | 约 150 MiB | 294.44 / 191.28 / 181.49 ms |
| 50 MiB +1 | identity | wire 413 | 0/0 | 约 48 MiB | 102.36 ms |
| 50 MiB +1 | gzip / zstd | decoded 413 | 每种 1/0 | 约 50 MiB | 142.72 / 184.91 ms |

日志保存配置在测量中显式设为 1 MiB：800 KiB 保存完整；2/50 MiB 只停止日志保存，必要解析与 Token 观察完整。这是日志配置的保存语义，并非 HTTP 解析或观察正文上限。

800 KiB identity 的 2/8 并发均完整，峰值约 8.85/35.42 MiB。初始两个解码器的 gzip/zstd 八并发有六个容量拒绝；据此补测八个解码器：800 KiB 的重复及混合文本、2 MiB 重复文本在 identity/gzip/zstd 下八并发均完整，观察各八份，每份解压和 JSON 解析各一次，结束后租约归零。混合文本 gzip/zstd wire 约 603/601 KiB，峰值保留约 14.54/13.84 MiB，耗时 101.80/64.93 ms；2 MiB 八并发峰值不超过 48.01 MiB，日志仅按显式 1 MiB 保存配置停止。最终必要和可选解码器基线均据这组测量设为八个，不承诺任意大小或并发的压缩请求全部获准。所有样本结束后保留字节为 0，decoder 数量回到 0；内存压力用例返回 `body_buffer_capacity` 并释放全部租约。512 MiB worker 预算为测得单份 50 MiB 约 150 MiB canonical 缓存，以及按需可变副本、并发和临时拼接留余量，所有配额均可按部署资源调整。

中央配置位于 `packages/core/src/gateway/body-resources.ts`，在 worker 启动时读取。默认值是可调整的运行基线，不是新的业务限制，也不替代显式 `body_parser_limit`：

| 环境变量 | 默认 | 用途 |
| --- | --- | --- |
| `BUNGEE_BODY_WORKER_MEMORY_BYTES` | 512 MiB | 所有共享正文实际保留分配与保守 JSON/文本估算 |
| `BUNGEE_BODY_OPTIONAL_MEMORY_BYTES` | 256 MiB | 所有可选计算的独立 worker 预算 |
| `BUNGEE_BODY_LOG_MEMORY_BYTES` | 32 MiB | 日志 wire 保留及保存表示的独立配额；共享 wire 只计一次 |
| `BUNGEE_BODY_OBSERVER_BACKLOG_BYTES` | 32 MiB | 单消费者 SSE 引用积压 |
| `BUNGEE_BODY_OBSERVER_BACKLOG_EVENTS` | 1024 | 单消费者事件引用积压 |
| `BUNGEE_BODY_MANDATORY_DECODERS` | 8 | 必要解码并发 |
| `BUNGEE_BODY_OPTIONAL_DECODERS` | 8 | 可选解码并发；同一内容缓存不重复申请 |
| `BUNGEE_BODY_LOG_CONSUMERS` | 64 | 日志消费者数 |
| `BUNGEE_BODY_CALLBACK_MS` | 250 ms | 观察回调有效期 |
| `BUNGEE_BODY_OPTIONAL_DECODE_MS` | 1000 ms | 有限可选正文解压期限；连续 SSE 不用累计一秒期限 |
| `BUNGEE_BODY_ZSTD_WINDOW_LOG` | 23 | zstd 最大窗口 8 MiB |

wire 与 decoded 的业务边界继承正文配置，默认 50 MiB。SSE 的该边界作用于每个完整帧，包括原始分隔符，而非连接累计传输量。旁路在实际 wire pull 时采样，既不提前读取，也不反压主要转发；它失败后只撤销自身消费者。正常表示只解压/解析一次，容量不足的可选任务不会留下永久失败的 mandatory 缓存。JSON 和 SSE 对象是递归冻结的公共缓存；字节视图按 SDK 契约只读，写插件必须创建新表示。

缺少 Content-Type 且最终 Accept 为 SSE 时，中央 session 保留有界 frame 引用和 decoded 缓存。`formatSSELog` 的可选 parsedMessages 仅在原媒体/Accept/合法字段判定通过后复用，普通错误文本、明确非 SSE 媒体、无协商及非法帧均仍返回原文本。格式化测试证明该复用分支调用 JSON.parse 零次；中央 SSE 测试每个 data 只有一次 JSON 解析尝试（包括 [DONE] 的一次失败尝试），gzip 解压一次。

专项还验证：gzip/zstd SSE 日志与观察共用一次解压、一次分帧；CR/LF 原始分隔符、comment-only 帧和 EOF 尾部逐字节保持；取消一个消费者后其他消费者仍可读取；日志保存上限只停止日志；压力之后资源释放。源数据中无法强制终止的异步插件仍须遵守 `isActive()` 有效期，失效后不得继续修改业务状态。
