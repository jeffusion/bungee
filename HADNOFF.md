# Bungee 项目问题交接

本文记录当前项目分析中发现的主要问题，供后续修复、验证和交接使用。

## 当前状态

- 当前分支：`dev`
- 工作区：干净
- 当前版本：`4.1.0`
- 当前活动计划：`.omo/plans/dashboard-stats-chain-dimension.md`
- 当前阶段：核心能力已基本产品化，正在进行 failover 请求链统计口径和工程治理收口

## P0：当前 chain 统计任务尚未完全收口

> **状态：已修复（2026-07-12）**

### 1. 单元测试复制生产 SQL，没有调用生产实现

> **已修复**：测试文件重写为 `import { LogQueryService } from '../../src/api/logs'`，直接调用 `service.getStats()` / `service.getTimeSeriesStats()`。测试中的 SQL 副本已删除。LogQueryService 构造函数新增 optional `db?: Database` 参数支持测试注入 in-memory DB（生产调用无参，默认 `accessLogWriter.getDatabase()`）。新增 migration guard 防止测试文件再次嵌入生产 SQL。

### 2. 测试用例与实施计划不一致

> **已修复**：新增 3 项缺失测试：
> - T5：无 final row 的 fallback 测试（chain 全部 failover 行无 final，chainStatus fallback 到最后 attempt status）
> - T6：跨 bucket 归位测试（chain attempts 跨两个 time bucket，确认归位到 first attempt 的 bucket）
> - T7：getTimeSeriesStats 直接测试（多 bucket + chain-level 计数双 subatomic 验证）

### 3. migration guard 检查不完整

> **已修复**：新增 3 项 guards：
> - getStats 必须含 `status_rank`（ROW_NUMBER() AS status_rank window function）
> - getTimeSeriesStats 必须含 `status_rank`
> - 测试文件必须 import LogQueryService 且不含生产 SQL 副本

### 4. 活动任务状态未关闭

> **已修复**：`.omo/boulder.json` work `dashboard-stats-chain` status 改为 `completed`，`active_work_id` 设为 null。

### 验证结果

- 820 测试全通过（含 7 项 chain 维度测试 + 25 项 migration guards）
- 完整 build 链通过
- Docker 8088 API 返回正确 chain 维度 stats
- Playwright 0 console errors

## P1：配置版本文档与代码实现冲突

> **状态：已修复（2026-07-12）**

代码当前已经进入 Config V4：

- `packages/core/src/config-migrations/types.ts` 中 `LATEST_CONFIG_VERSION = 4`
- 已存在 `packages/core/src/config-migrations/versions/v3-to-v4.ts`

文档已统一更新为 V4：

- `README.md`：Config Model V3 → V4，新增 V3→V4 迁移说明段
- `README_zh.md`：所有 `config_version: 3` → `config_version: 4`
- `docs/configuration.md`：所有 V3 引用 → V4，新增 V3→V4 迁移说明段 + 职责分离说明
- `config.example.json`：`config_version: 4`，`sticky_session` 移至 `load_balancing.policy=consistent_hash`，`probe_interval_ms` → `backoff_base_ms`，`auto_enable_on_active_health_check` 移至 `health_check`，Route `connect_ms` 移至 Service
- CLI init 模板：无 V3 硬编码，无需修改

全仓 grep 确认零 V3 残留。

## P1：CI 覆盖不足

> **状态：已修复（2026-07-12）**

相关文件：

- `.github/workflows/ci.yml`

### 1. CI 只对发往 main 的 Pull Request 触发

> **已修复**：CI 现在覆盖 `push` 和 `pull_request` 到 `dev` + `main` 分支。

### 2. Bun 使用 latest，构建不可复现

> **已修复**：Bun 版本固定为 `1.3.10`。

### 3. CI 没有执行完整构建链

> **已修复**：CI 现在执行 `bun run build`（完整构建链 types → widgets → ui → bundle-ui → core → llms → cli）。

### 4. Playwright 默认被跳过

> **已修复**：`CI_UI_SMOKE` 条件已移除，Playwright smoke tests 默认运行。

## P2：测试结果状态不可信

> **状态：已分析（2026-07-12），非阻塞**

相关文件：

- `test-results/.last-run.json`

`test-results/` 目录已在 `.gitignore` 中且不被 git 跟踪。本地陈旧的 `.last-run.json` 不影响仓库。

Phase 3 CI 加固后 Playwright smoke tests 默认运行（不再需要 `CI_UI_SMOKE=1`），每次 CI 会刷新该文件。本地运行 Playwright 也会刷新。

## P2：大型核心文件正在形成复杂度热点

> **状态：后续阶段（Phase 4），非阻塞**

当前明显偏大的文件包括：

- `packages/core/src/scoped-plugin-registry.ts`
- `packages/core/src/worker/request/handler.ts`
- `packages/core/src/plugin-registry.ts`
- `packages/core/src/api/logs.ts`
- `packages/core/src/worker/request/proxy.ts`
- `packages/core/src/worker/response/processor.ts`

`api/logs.ts` 随 chain 聚合 + stats chain 维度切换持续增长，当前功能正确但偏大。

建议在后续迭代中按职责拆分（例如 `logs.ts` 拆为 `logs-query.ts` + `logs-chain.ts` + `logs-stats.ts`），不在本次收口范围。

## P2：SQLite WAL 需要持续观察

> **状态：后续阶段（Phase 4），非阻塞**

当前运行数据中：

- `logs/access.db` 约 37 MB。
- `logs/access.db-wal` 约 39 MB。

仅凭文件大小不能认定存在故障，但 WAL 接近或超过主库大小，值得检查。

建议后续加定期 checkpoint 机制（`PRAGMA wal_checkpoint(TRUNCATE)`），先做运行观测，不要直接加入激进的强制 checkpoint，不在本次收口范围。

## 建议执行顺序

### 第一阶段：关闭当前 chain 统计任务

> **状态：已完成（2026-07-12）**

1. ✅ 测试改为调用生产 `LogQueryService`（删除 SQL 副本，构造函数加 `db?: Database` 注入参数）。
2. ✅ 补齐 fallback、bucket 和 time-series 测试（3 项新增 + 原有 4 项 = 7/7 通过）。
3. ✅ 补全 migration guard（新增 `status_rank` 检查，25/25 guards 全通过）。
4. ✅ 执行 `bun run build`（完整构建链通过）。
5. ✅ 执行 `bun test`（820/820 全通过）。
6. ✅ 执行 Playwright Smoke Test（0 console errors）。
7. ✅ 验证 Dashboard 和 stats API 数值（chain 维度正确：totalRequests=198967, successRate=96.62%）。
8. ✅ 关闭 `.omo/boulder.json` 中的 active work（status 改为 completed）。

### 第二阶段：Config V4 文档收口

> **状态：已完成（2026-07-12）**

1. ✅ 修复 README 和配置文档（全部 V3 → V4 + 新增 V3→V4 迁移说明段）。
2. ✅ 修复示例配置与初始化模板（config.example.json fully V4，CLI init 无硬编码 V3）。
3. ✅ 增加 V3 → V4 迁移说明（README + docs/configuration.md 新增段落）。

### 第三阶段：CI 加固

> **状态：已完成（2026-07-12）**

1. ✅ 覆盖 `dev` 和 `main`（push + pull_request）。
2. ✅ 固定 Bun 版本（`1.3.10`）。
3. ✅ 执行完整 build（`bun run build` 替代仅 `build:ui + bundle:ui + build:llms`）。
4. ✅ 默认运行基础 UI Smoke Test（移除 `CI_UI_SMOKE` 条件）。

### 第四阶段：复杂度治理

> **状态：后续阶段，非阻塞**

按热点文件逐个拆分，避免与当前功能收口并行展开大规模重构。

## 总结

Bungee 的核心功能方向正确，当前主要风险不是缺少能力，而是功能演进速度已经快于测试、文档和 CI 的同步速度。

当前最需要完成的是：

1. ✅ 让 chain 统计测试真正覆盖生产实现。
2. ✅ 统一 Config V4 的代码和文档口径。
3. ✅ 让 CI 覆盖真实开发分支和完整发布构建链。

完成这三项后，再继续增加 WebSocket、Prometheus 或更复杂流量治理能力会更稳妥。
