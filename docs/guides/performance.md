# 性能测量

在隔离开发环境执行。记录 Bun、OS、CPU、内存、配置与构建来源；使用相同工作负载比较，先验证响应和清理，再解释延迟或吞吐。不要将本地 loopback、合成输入或单次 RSS 差值写成生产 SLA。

## 运行真实进程基准

仓库根命令：

```sh
bun run benchmark
```

它执行 `tests/real-process-canonical.test.ts` 的 C benchmark，建立隔离存储、受控 Bun 上游和两个 worker，经 CLI daemon 启动及真实公共代理请求验证。A/B 和 B/A 是同一个代理的标签顺序，每个标签顺序发送五次请求；此命令没有 before-root/after-root 参数，也不是两个版本的完整性能比较。

输出 `benchmark: canonical` JSON，包含 label、order、attempted、completed、errors、elapsedMs、rps、valid。rps = completed / (elapsedMs / 1000)。只有全部响应匹配且 errors=0 的记录有效；退出和端口清理失败也会使检查失败。少量顺序请求适合检查测量链路，不能支持并发吞吐承诺。

`packages/core/benchmarks/real-proxy-compare.ts` 提供独立 `compareScenario`／`compareSuite` 计算，不提供采集 CLI。它要求每组五个正有限样本，依据场景方向、中位数与 MAD 判断 pass、regression、inconclusive 或 invalid。样本不足或噪声过大不算通过。若另行采集跨版本数据，应明确其协议与环境，不能把标签 A/B 当成版本证据。

## 测量正文共享资源

```sh
bun tests/benchmarks/measure-body-resources.ts
```

此工具只构造合成 JSON，输出元数据，不保存正文。覆盖 800 KiB、2 MiB、50 MiB 边界和边界加一字节，identity/gzip/zstd，2/8 并发及 Worker 内存压力。运行可能临时占用较多内存，避免与生产实例混用机器资源。

输出 bytes、wireBytes、coding、concurrency、ms、rssDelta、peakRetained、decompressions、jsonParses、observed、saved、codes、incomplete 和 remaining。每轮检查正文、可选、日志及解码器租约返回起始值；泄漏或压力边界未生效抛错并非零退出。

日志保存限额显式设为 1 MiB，超限仅停止日志，不代表 HTTP 或 Token 解析超限。资源参数和默认值见[正文资源边界](../architecture/http-body.md#解码解析与资源边界)。RSS 包含合成输入、运行时、HTTP 容器及 GC，不能等同于保留预算。

解压／解析次数用于检查同一表示复用，incomplete 和错误码用于解释容量拒绝。比较时同时检查成功数、失败数和资源释放，不能通过减少消费者或忽略失败宣称性能改善。
