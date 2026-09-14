# 性能基准

`real-proxy` 是仓库内的真实进程 compare suite。它不会修改两个 target；每个 trial
都使用新的空 fixture/DB、两个 worker 和独立的 Bun upstream。正式运行固定为 5 个
logical samples，每个 sample 使用 AB/BA 两个 counterbalanced legs；每个 scenario
各有 5×2 个 pair rows，即 70 行 raw、140 个 target trials。每个 trial 前对 upstream
固定执行 16 次直接 ordinary prewarm，随后 reset 计数。

```sh
bun run benchmark --before-root=/abs/clean/v6 --after-root=/abs/clean/v10 --output=/abs/new/result
```

准备每个 target（包括 clean baseline）时，在该 target 内运行完整构建：

```sh
bun install --frozen-lockfile && bun run build
```

`packages/core/src/ui/assets.ts` 是 `.gitignore` 中、由 `scripts/bundle-ui.ts` 生成的
产物；它必须由各自 commit 的 target 自行 build 生成，不能从 driver 或其他 target
复制。benchmark preflight 会校验该文件的 repository 内 realpath 和生成标记，拒绝缺失、
错误标记或 symlink 逃逸；正式运行前仍须确认每个 target 的 `git status` 为 clean。

正式 CLI 只有 `--before-root`、`--after-root`、`--output` 和 `--help`。两个 target
必须是不同的 absolute realpath、已提交且 clean 的 Git repository；source entry、
`bun.lock`（或 `bun.lockb`）和 workspace package 都必须留在各自 repository 内。
output 必须是 repository 外尚不存在的 absolute path。driver 使用与当前 Bun 相同的
`process.execPath`，项目要求 Bun `1.3.14`。

`raw.jsonl` 在每个 B/A leg 完成后追加一行，`comparison.json` 在全部 pairs 完成后
写入；这两个文件为 schema version 3。每个 raw row 保留 logical block、repeat、leg、
实际 scenario order、AB/BA order、两个 target trial 和每个 target 的 config provenance。
结果记录 argv、cwd、runner/target commit 和
tree、Bun/OS/CPU/memory、精确 commands、受限环境变量、profile/config hashes 以及
trial summary，不写完整 environment 或 token。若 output 已创建后发生 trial/startup
异常，则写入有界的 `failure.json`，记录异常证据和已完成 pair 数；它仅表示异常中止，
不是性能结果，不替代 `comparison.json`。

覆盖路径：ordinary 32 并发 GET、SSE 16 并发的 32×512B/5ms event、1 MiB request、
4 MiB response、Node `http.Agent` keep-alive 128 并发、client cancel，以及 publication
100 rps/max 256 的 open-loop。前六项是 closed-loop；publication 在第 3 秒执行真实
`PUT /api/config`，校验 operation/runtime 收敛、切换前只 A、收敛后只 B、无 drop/error，
并要求 active 为零。所有 payload 在 measurement 前建立，latency samples 有上限。

publication 的 metric 仅使用 operation 返回的 `converged_ms`，不是外层观测时间；发布
promise 在 switch 时异步启动，期间仍持续按绝对时间发射 open-loop 流量。before 使用 legacy
单端口标签（`PORT=public`，不设置 management/ingress env）；after
使用 split layout（public、management、ingress supervision 三个独立端口）。只使用
HEAD v6 与 after v10 的共同 GET/PUT/config-operation 接口。

每个 trial 都有 correctness gate；invalid、inconclusive、regression、cleanup 异常或
cap/deadline 违反都会以非零退出。A/A 和短 real smoke 由内部 `TestProfile` 直接调用，
不会增加 quick CLI；测试命令会运行 unit、short smoke、TypeScript 检查和 diff，正式
5×7×2 suite 不属于普通验证流程。profile 时长、场景、repeats 和既有 comparison
thresholds 均不因 counterbalancing 改变；两条 leg 的 target config 分别记录，不伪称为
单一 config hash。
