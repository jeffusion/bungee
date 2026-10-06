# 插件通信与计费集成验收

本次改造复用现有 PluginServiceHost、认证 peer 链路和 SQLite 通信存储，不另建消息系统。同步本地服务用于请求热路径；异步 RPC 用于跨进程操作；流与版本快照承载大对象；临时通知和可靠事件分别声明其语义。

## 实现边界

- 服务提供者限定 global，消费者显式声明依赖、契约版本、进程和模式。绑定身份仍用于请求授权，不再增加按 binding 提供服务或自动重绑定。
- OAuth 凭据和预算操作迁移到类型化 Host RPC，删除专用插件 HTTP RPC 路径。预算沿用自身 CAS 与幂等账本，声明 `deduplication: none`，不叠加第二份命令日志。
- 有日志命令由 Host 维护配额、结果和恢复。取消、断连、控制权变化均不证明执行者终结；恢复授权要求持久化的物理进程身份确认退出或被替换。维护批次有界，unknown 记录不会被当作成功或删除。
- models-dev 是唯一目录下载、刷新及持久化入口。正文 `{version,fetchedAt,catalog}` 原子提交到 Host 分块快照，worker 校验正文后替换本地只读视图。旧 KV 只允许无快照时一次性迁移，不再双写或回退。
- 显式价格映射优先；目录 provider API 按主机和路径段匹配，歧义保持 unknown。统计和预算使用同一定价结果，目录或映射变化不追算历史。
- 客户端模型候选只来自保留期内真实统计记录，支持搜索、分页和自由输入，保留大小写；保存别名不生成统计记录。

## 可重复验证

在仓库根目录执行，使用锁定依赖及 Bun 1.4.2：

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build:full
bun test
bun scripts/plugin-business-browser-acceptance.ts --evidence-dir /tmp/bungee-browser-acceptance
```

根测试须保留 `bunfig.toml` 的 data-plane preload。真实进程夹具使用独立数据库、随机凭据、独立端口与临时目录，通过 DaemonManager 启动主进程及监督 worker；清理仅针对捕获的物理进程身份。失败证据保留，成功清理后验证进程退出及端口释放。浏览器脚本需要本机 Chromium/Playwright 和 models.dev 网络访问，使用正常账号初始化与会话认证，不写入伪造统计。

| 证据 | 实际覆盖 |
| --- | --- |
| `tests/plugin-rpc-gateway-real-process.test.ts` | 主进程与两个 worker 的 RPC、取消、授权、日志幂等及重启后结果复用；真实在途 control 执行者被 SIGKILL 后原 worker 接管、旧屏障释放、pending 命令转 unknown、不重执行及插件排空 |
| `tests/plugin-communication-real-process.test.ts` | 真实流读写、双向半关闭/失败、大快照更新、正文验证、可靠事件重放/ACK/保留窗口、临时通知及 outbox 原子性 |
| `tests/plugin-models-dev-real-process.test.ts`、`tests/token-stats-gateway-real-process.test.ts` | shared 目录、多个 worker 的版本收敛、真实代理计量与重启 |
| `tests/real-process-canonical.test.ts` | SIGKILL 后原 worker 保持运行、控制权接管、旧控制权拒绝、端口关闭 |
| `packages/core/tests/unit/plugin-journal-recovery.test.ts` | 子进程实际执行业务并持久化 pending 后被终止，物理退出证明控制日志恢复授权；unknown 证明不释放 |
| `packages/core/tests/unit/plugin-business-peer.test.ts` | 独立 worker 的真实 HTTP 代理与认证 OAuth RPC；两路由共享服务端点时保留各自 scope 与请求租约，退役后的拒绝旧凭据仍合法；物理成员及绑定投影使用明确 fixture，未调用付费账户 |
| 浏览器脚本 | 真实登录、设置边界、真实目录、候选键盘/分页/大小写、价格映射与自由输入、历史不追算、预算/统计一致、预算与未知价格拒绝、旧下载 API 移除 |

2026-10-06 最终构建上的隔离浏览器验收为 12/12 通过，56 次正常技术上游请求。一次请求预算和统计均为 24 tokens、48,900 nanoUSD；两次累计均为 97,800 nanoUSD。历史未知费用保持 null。页面异常、控制台错误及失败请求均为零，自有进程退出及端口释放已确认。技术上游证据不代表真实提供商账单。

详细运行证据保存在本次任务的 `/tmp/brave-egret-implementation-evidence/`：初始源文件/差异保全、失败日志、最终构建与测试日志、类型基线对比，以及 `browser/final` 的报告、网络记录、计量/预算证据和截图。此前 `browser/run4`、`run5`、`run6` 的失败和修复复验记录保留。`control-exit-recovery.json` 记录真实执行者退出、原 worker 身份、64 个旧调用回收、64 次新调用成功及排空结果。缺失或不确定物理退出证明仍保持屏障，控制权变化不会冒充任务终结。

独立集成评审首轮发现的两个 P1 均已处理：共享端点的调用者按确切请求租约选择；旧 control 退出由 worker 核验认证 peer 返回的完整物理身份后释放屏障。新控制权使用独立重连预算及指数退避，不重发旧调用。对应测试分别为 34 项凭据/生命周期回归和 17 项 peer/journal 加 3 项真实 gateway 测试，均通过；独立复审已逐项关闭这两个问题。

复审发现的上传背压忙循环已修复：传输拒绝尚未入队的 chunk 时，让出事件循环再有界重试，不把 socket 背压误当成 credit 不足。完整通道回归 47/47 通过，覆盖下一轮恢复、持续背压失败和真实 sink 的取消屏障。完整有效执行者证明的反例使用实际承载业务且带 OS marker 的子进程；断连跨核验周期仍保持 64 个 active 和租约，真实业务结束后归零。恢复记录中的 64 次新 RPC 为顺序请求，容量断言以 runtime active/租约及真实排空验证为依据。

曾出现一次普通上传 `truncated`，失败日志保留在 `full-tests-final.log`，没有把背压返回的 `overloaded` 冒称其已确认根因。之后五次隔离通信检查及两轮完整根测试通过，保留这一历史失败的诊断边界。

## 最终交付检查

| 检查 | 结果与证据 |
| --- | --- |
| 最终源码完整构建 | `build-full-final-reviewed.log`，exit 0，五平台二进制及 archives 完成 |
| 根全量测试 | `full-tests-delivery.log`，3946 pass、3 skip、0 fail，25294 assertions，3949 tests / 385 files |
| 类型诊断无新增 | `types-comparison.json` 及对应 head/current 日志：core 9→9、CLI 1→1、UI 19→19，types/llms 0→0；既有诊断未冒称零错误 |
| 真实浏览器 | `browser/final/report.json`，12/12，正常认证与真实统计，清理已确认 |
| 真实在途故障恢复 | `control-exit-acceptance.log`、`control-exit-recovery.json`；根全量测试再次覆盖 |
| 独立集成复审 | 原两项 P1、一项 P2 均逐项关闭，无新增实质性问题；最终日志与证据点验通过 |

所有运行使用隔离数据、凭据和端口，没有更新正式服务或挂载生产卷。真实运行验收来自 Linux；其他平台为构建证据，三个 Windows 专属测试在 Linux 跳过。代码提交只保存在当前工作分支，不自动推送或部署。
