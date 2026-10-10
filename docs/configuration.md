# Configuration

Bungee stores configuration in SQLite. The master process owns `data/bungee.db`; workers receive immutable revision snapshots and never read a configuration file.

## Paths

| Data | Default | Override |
|---|---|---|
| Configuration | `data/bungee.db` | `BUNGEE_CONFIG_DB_PATH` |
| Telemetry | `logs/access.db` | `BUNGEE_ACCESS_DB_PATH` |

Both overrides must be absolute paths. `CONFIG_PATH`, YAML, and JSON configuration files are unsupported.

## Authentication

Management is anonymous and proxy routes are public by default. The optional 管理认证 (`local-accounts`) plugin establishes or verifies a single administrator and enables management sessions; disabling it restores anonymous management. 访问控制 (`key-access`) owns API Keys and the protected-route set in its plugin settings. Route and Service editors have no authentication fields. See [authentication and plugin usage](./authentication.md).

Key permissions and route protection are separate: selecting allowed routes does not protect them unless explicitly requested. Revoking the final Key does not remove protection. Public requests stay anonymous even if they carry a Key and do not consume that Key's rate or token budget. Disabling access control requires explicitly removing all route protections and satisfying plugin dependencies.

Keys, administrator sessions and plugin ledgers are durable runtime state outside ordinary proxy configuration. Persistent guards prevent a missing or failed plugin from reopening protected access. New writes reject legacy global/route `auth` fields; old tokens are not migrated.

## Control API

| Operation | Endpoint |
|---|---|
| Read current revision | `GET /api/config` |
| Replace aggregate | `PUT /api/config` |
| Poll publication | `GET /api/config/operations/:id` |
| Retry degraded publication | `POST /api/config/operations/:id/retry` |
| Export snapshot | `GET /api/config/export` |
| Import snapshot | `POST /api/config/import` |
| Runtime workers | `GET /api/config/runtime` |

Writes use optimistic concurrency with `expected_revision` and return `202` plus an operation ID. Poll until the operation is `converged` or `degraded`.

Route and service editors finish saving when the master confirms the database commit. A shared banner tracks publication across page navigation, including worker startup, traffic switching, and old requests draining; a slow publication does not mean the configuration was not saved. If a previous publication is still running, the next edit waits before submitting with its original `expected_revision`, so concurrent changes still produce a revision conflict.

If a save response is lost, the editor queries its original operation ID rather than repeating the write. Unconfirmed results retain that ID for inspection in the configuration workspace.

For a retry, send exactly `{"request_id":"<lowercase UUID>","expected_revision":<positive safe integer>}`. The response is a durable recovery record; active recoveries return `202`, terminal records return `200`, and retrying the same request ID with the same operation and revision is idempotent.

`GET /api/config/runtime` includes authoritative `publication` state: the current operation and recovery records, `retryable`, `serving_complete`, `serving_revision`, and `target_revision`.

### Aggregate schema

Every write replaces one complete `ConfigurationAggregateV2`. Entity IDs are stable UUIDs; `position` controls deterministic ordering; routes reference services by `service_id`.

```json
{
  "logical_configuration": {
    "publication": {
      "drain_start_timeout_ms": 5000,
      "drain_timeout_ms": 300000,
      "worker_exit_timeout_ms": 10000
    },
    "services": [{
      "id": "aaaaaaaa-0000-4000-8000-000000000001",
      "position": 1,
      "name": "primary",
      "plugins": [],
      "endpoints": [{
        "id": "bbbbbbbb-0000-4000-8000-000000000001",
        "position": 1,
        "target": "https://api.example.com",
        "weight": 100,
        "priority": 1,
        "is_disabled": false,
        "plugins": []
      }]
    }],
    "routes": [{
      "id": "cccccccc-0000-4000-8000-000000000001",
      "position": 1,
      "path": "/v1",
      "service_id": "aaaaaaaa-0000-4000-8000-000000000001",
      "plugins": []
    }],
    "plugins": []
  },
  "plugin_activations": [{ "plugin_name": "llm-protocol-adapter" }]
}
```

Submit it with a unique mutation ID:

```json
{
  "mutation_id": "dddddddd-0000-4000-8000-000000000001",
  "expected_revision": 1,
  "kind": "config",
  "aggregate": {}
}
```

The `aggregate` field is the complete object shown above. Enabling the management provider requires an established or verified administrator. Disabling it requires the current live administrator session and returns to anonymous management. Full writes and imports enforce the same transition, dependency and route-protection guards; a configuration import cannot bypass them.

### 发布期限（`publication`）

滚动发布的三个期限保存在 `logical_configuration.publication`，随配置 revision 持久化并参与内容 hash；它是滚动发布期限的持久化真源。该对象可以省略：省略时不写入默认值，也不改写既有 revision、快照或 hash，运行时按内置默认值解析。省略 `publication` 的历史快照在导入后保持原有 hash。

对象存在时，三个字段必须全部提供，不接受未知字段；每个字段都是正整数秒，以毫秒存储，并且必须是 `1000` 的整数倍：

| 字段 | 默认值 | 作用 |
|---|---|---|
| `drain_start_timeout_ms` | `5000` | 从下发排空命令到确认旧工作进程已开始排空。超时后只查询状态，不作为结束进程的依据。 |
| `drain_timeout_ms` | `300000` | 从旧工作进程实际开始排空到既有请求结束。到期后可能强制结束剩余请求。 |
| `worker_exit_timeout_ms` | `10000` | 从排空结束或决定强制结束之后，到资源清理完成并确认进程退出。缺少精确退出证据时该轮发布保持未定，不能标记为成功。 |

- 计时器安全上限为 `2147483000` ms（即 2147483 秒）：Bun 1.4.2 中超过该值的 `setTimeout` 会溢出为 1 ms。校验同时要求正的安全整数。
- 校验不要求三个字段之间存在固定比例或先后关系。
- 三个期限分别约束不同阶段，不能相加当作“整轮发布总超时”。
- 修改从本次发布开始生效：新一轮发布使用目标 snapshot 的 `publication`；恢复不会重置同一排空任务的 `drain_timeout_ms`。
- `drain_timeout_ms` 越长，旧代进程及其连接占用资源越久；本轮发布未到达终态时不能提交下一轮发布。
- `worker_exit_timeout_ms`（E）在 worker 自然排空到达终态或决定强制结束时创建一次。其后的状态查询、强制停止、资源清理、关闭与 OS 退出取证共用同一段剩余 E，不会重新授予一段完整 E；清理的签名终态与精确退出分别取证，即使进程已经退出，清理失败也不能判为成功。
- 这些期限是发布策略，不是单次 API / LLM 请求超时或 idle timeout，也不存在按模式切换的开关。控制台按秒显示与编辑；查看页面不会把默认值写入配置。
- `publication` 与代理请求预算相互独立，不是代理的 `request_ms` / first-byte / idle budget，也不覆盖前置插件处理阶段。代理现有 `request_ms` 默认 30 秒与可选 first-byte 预算，据此不能声称整条请求链已被一个统一 deadline 接管。

**派生交接前置阶段（H）。** 除三个用户期限外，实现中还有一个派生的前置阶段 H，其时长等于本次目标 `drain_timeout_ms`，它不是第四个用户设置。Ingress 提交后立即把新请求切到新代；此前已按旧 admission / worker 身份选定旧进程的私有请求，要等到取得响应头或失败才算释放，这段等待就是 H。H 从 Ingress commit 起单调计时，同一 boot 内重连或重试不会重新授予。H 是额外的前置阶段，不消耗、也不重启 worker 真正开始排空后的 D；若 H 逾期仍未完成，只是非致命的 unknown：保留新代接流、旧代与双方租约，操作保持非终态并禁止下一轮发布，之后只查询同一屏障。因此换代 / 退场的总时长不能写成 C + D + E。

API 场景的较短排空起始建议（5 / 30 / 10 秒）：

```json
{ "publication": { "drain_start_timeout_ms": 5000, "drain_timeout_ms": 30000, "worker_exit_timeout_ms": 10000 } }
```

LLM / 长连接场景的起始建议（5 / 300 / 10 秒）：

```json
{ "publication": { "drain_start_timeout_ms": 5000, "drain_timeout_ms": 300000, "worker_exit_timeout_ms": 10000 } }
```

这两组数值只是起始建议，不保证某个具体下游请求一定在期限内结束。

另外，两个 data listener 显式把 `idleTimeout` 设为 0，去掉了 Bun 默认的隐式 10 秒截断，用于保护超过 10 秒的首包与长流；这不扩展无界的 `text/plain` 能力，验收仍使用合法的有限 SSE。

## Import And Export

```bash
bungee export --file bungee-snapshot.json
bungee import --file bungee-snapshot.json
```

With management authentication enabled, add `--token "$SESSION"` using a current Bearer administrator session. Imports do not replace Keys, the administrator, sessions or budget ledgers. Imports replace the complete aggregate; merge import and automatic rollback are intentionally unsupported.

## Expressions

Configuration values may reference environment variables with `{{ env.NAME }}`. Expressions are resolved at publication boundaries. Missing required values fail closed.
