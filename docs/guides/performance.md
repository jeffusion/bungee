# 性能测量

在隔离开发环境执行。记录 Bun、OS、CPU、内存、配置与构建来源；使用相同工作负载比较，先验证响应和清理，再解释延迟或吞吐。不要将本地 loopback、合成输入或单次 RSS 差值写成生产 SLA。

## 测量正文共享资源

在仓库根目录运行：

```sh
bun run benchmark
```

此入口执行 `tests/benchmarks/measure-body-resources.ts`，独立于功能回归。

此工具只构造合成 JSON，输出元数据，不保存正文。覆盖 800 KiB、2 MiB、50 MiB 边界和边界加一字节，identity/gzip/zstd，2/8 并发及 Worker 内存压力。运行可能临时占用较多内存，避免与生产实例混用机器资源。

输出 bytes、wireBytes、coding、concurrency、ms、rssDelta、peakRetained、decompressions、jsonParses、observed、saved、codes、incomplete 和 remaining。每轮检查正文、可选、日志及解码器租约返回起始值；泄漏或压力边界未生效抛错并非零退出。

日志保存限额显式设为 1 MiB，超限仅停止日志，不代表 HTTP 或 Token 解析超限。资源参数和默认值见[正文资源边界](../architecture/http-body.md#解码解析与资源边界)。RSS 包含合成输入、运行时、HTTP 容器及 GC，不能等同于保留预算。

解压／解析次数用于检查同一表示复用，incomplete 和错误码用于解释容量拒绝。比较时同时检查成功数、失败数和资源释放，不能通过减少消费者或忽略失败宣称性能改善。
