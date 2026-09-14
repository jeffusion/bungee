# 性能基准

`real-proxy` 是仓库内的真实进程 compare suite。它不会修改两个 target；每个 trial
都使用新的空 fixture/DB、两个 worker 和一个共享的 Bun upstream。正式运行固定为
5 repeats、每个 scenario 5 秒 warmup + 15 秒 measurement，baseline/after 交替启动。

```sh
bun run benchmark --before-root=/abs/clean/v6 --after-root=/abs/clean/v10 --output=/abs/new/result
```

正式 CLI 只有 `--before-root`、`--after-root`、`--output` 和 `--help`。两个 target
必须是不同的 absolute realpath、已提交且 clean 的 Git repository；source entry、
`bun.lock`（或 `bun.lockb`）和 workspace package 都必须留在各自 repository 内。
output 必须是 repository 外尚不存在的 absolute path。driver 使用与当前 Bun 相同的
`process.execPath`，项目要求 Bun `1.3.14`。

`raw.jsonl` 在每个 B/A pair 完成后追加一行，`comparison.json` 在全部 pairs 完成后
写入；两个文件均为 schema version 2。结果记录 argv、cwd、runner/target commit 和
tree、Bun/OS/CPU/memory、精确 commands、受限环境变量、profile/config hashes 以及
trial summary，不写完整 environment 或 token。

覆盖路径：ordinary 32 并发 GET、SSE 16 并发的 32×512B/5ms event、1 MiB request、
4 MiB response、Node `http.Agent` keep-alive 128 并发、client cancel，以及 publication
100 rps/max 256 的 open-loop。前六项是 closed-loop；publication 在第 3 秒执行真实
`PUT /api/config`，校验 operation/runtime 收敛、切换前只 A、收敛后只 B、无 drop/error，
并要求 active 为零。所有 payload 在 measurement 前建立，latency samples 有上限。

before 使用 legacy 单端口标签（`PORT=public`，不设置 management/ingress env）；after
使用 split layout（public、management、ingress supervision 三个独立端口）。只使用
HEAD v6 与 after v10 的共同 GET/PUT/config-operation 接口。

每个 trial 都有 correctness gate；invalid、inconclusive、regression、cleanup 异常或
cap/deadline 违反都会以非零退出。A/A 和短 real smoke 由内部 `TestProfile` 直接调用，
不会增加 quick CLI；测试命令会运行 unit、short smoke、TypeScript 检查和 diff，正式
5×7×2 suite 不属于普通验证流程。
