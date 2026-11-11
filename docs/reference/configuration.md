# Configuration

Bungee stores configuration in SQLite. A configuration storage Worker owns `data/bungee.db`; the master coordinates writes and data-plane workers receive immutable revision snapshots and never read a configuration file.

## Paths

| Data | Default | Override |
|---|---|---|
| Configuration | `data/bungee.db` | `BUNGEE_CONFIG_DB_PATH` |
| Plugin state and secrets | `data/plugin-state.db` | Sibling of the configuration database |
| Telemetry | `logs/access.db` | `BUNGEE_ACCESS_DB_PATH` |

The configuration and telemetry overrides must be absolute paths. `CONFIG_PATH`, YAML, and JSON configuration files are unsupported.

## Authentication

Management is anonymous and proxy routes are public by default. The optional 用户认证 (`user-auth`) plugin creates the first account in its online activation dialog using a username, password and password confirmation; an existing account is verified instead. Mandatory management protection persists independently of ordinary configuration export and import; use offline `release-auth` to explicitly restore anonymous management. Startup removes records for plugins absent from the installed catalog, including a removed management-provider selection; see [storage contracts](../architecture/storage.md#管理能力与健康). 访问控制 (`key-access`) owns API Keys and the protected-route set in its plugin settings. Route and Service editors have no authentication fields. See [authentication and plugin usage](../guides/authentication.md).

Key permissions and route protection are separate: selecting allowed routes does not protect them; protection is edited separately. Revoking the final Key does not remove protection. Public requests stay anonymous even if they carry a Key and do not consume that Key's rate or token budget. Disabling access control requires explicitly removing all route protections and satisfying plugin dependencies.

Keys, administrator sessions and plugin ledgers are durable runtime state outside ordinary proxy configuration. Persistent guards preserve route protection and reject installed-provider failures; startup removal of an absent management provider clears its selection. Writes reject global/route `auth` fields; authentication is a plugin capability.

## Control API

| Operation | Endpoint |
|---|---|
| Read current revision | `GET /api/config` |
| Replace aggregate | `PUT /api/config` |
| Poll publication | `GET /api/config/operations/:id` |
| Retry degraded publication or stopped active cleanup | `POST /api/config/operations/:id/retry` |
| Export snapshot | `GET /api/config/export` |
| Import snapshot | `POST /api/config/import` |
| Runtime workers | `GET /api/config/runtime` |

Online writes use optimistic concurrency with `expected_revision`. The master waits for the candidate workers and ingress policy to prepare, then returns `202` and an operation ID after durable storage confirms the write. The same operation tracks ingress cutover and old-worker drain. A stale revision returns `409`. Read the current revision before updating your changes.

If candidate preparation fails, the API returns `503 control_readiness_failed` and the current revision and active ingress stay in place. If the publication queue is blocked by recovery or missing admission evidence, it returns `503 control_recovering` before saving. The editor keeps unsaved changes after either response.

The master applies one target at a time. The previous retirement must release worker capacity before another online candidate starts. Startup, offline and recovery targets that were already saved can still use the publication queue.

Operation states distinguish `pending` (saved, waiting to be claimed), `committed` (claimed publication target), `publishing`, `draining`, and the terminal states `converged`, `degraded`, and `superseded`. In particular, `pending` is already durable; it is not an unsent editor draft. A superseded operation is not a failed save and must not be blindly submitted again. Inspect the latest target and actual serving identity separately.

If a save response is lost, the editor queries its original operation ID rather than repeating the write. Unconfirmed results retain that ID for application-wide tracking. Further input is allowed, but another submission must not replace the unresolved operation with a new mutation ID.

For a retry, send exactly `{"request_id":"<lowercase UUID>","expected_revision":<positive safe integer>}`. The response is a durable recovery record; active recoveries return `202`, terminal records return `200`, and retrying the same request ID with the same operation and revision is idempotent.

For stopped cleanup of an active `draining` operation, the same endpoint returns `202` with `request_id`, `source_mutation_id`, `target_revision` and `status: "accepted"`. Acceptance is durable and idempotent; it retries the frozen retirement proof without starting another worker attempt or resetting deadlines. Poll runtime facts to observe the resulting cleanup state.

`GET /api/config/runtime` includes authoritative `publication` state: the current operation and recovery records, `retryable`, `serving_complete`, `serving_revision`, and `target_revision`.

The response also includes typed dependency freshness, component recovery budget and retirement cleanup facts. Current serving health is independent of historical terminal publication errors; stale observations are not treated as current health. Physical exit and cleanup success are separate member fields.

### Instance navigation API

Navigation is separate from the proxy aggregate. `GET /api/ui/menus` returns
`revision`, the page `catalog`, the ordered `layout`, and `iconRevision`.
`PUT /api/ui/menus` accepts exactly `{ "expected_revision": 0, "layout": [] }`;
replace the example layout with the complete page/group tree. A successful save
returns the new snapshot immediately, without configuration publication.
Conflicting revisions return `409` with `error: "stale_revision"` and `active`;
invalid layouts return `422`, unavailable storage returns `503`.

Layout nodes are pages (`kind`, `pageId`, `visible`, optional `icon`) or one-level
groups (`kind`, `id`, `title`, `visible`, optional `icon`, `children`). A null title
uses the translated default title for `group:gateway`, `group:usage`,
`group:access` or `group:system`; other group IDs require a nonempty title.
Every page occurs at most once. Icon IDs use `collection:name`; unknown new page IDs and unavailable icon
overrides are rejected. Previously saved pages removed from the catalog remain
editable. Unseen available contributions append to saved layouts automatically.
Navigation contributions from one plugin with the same path identify one page;
the first declaration supplies its label and default icon.

Offline icon reads use `GET /api/ui/icons/collections`,
`GET /api/ui/icons/search?collection=lucide&q=server&offset=0&limit=48` (maximum
96 results per page), and `GET /api/ui/icons/data?ids=lucide:server,tabler:home`
(maximum 64 IDs). Responses carry their resource `revision`; data responses
contain `icons` and `missing`; a missing or retired collection does not prevent
valid IDs in the same batch from resolving. Read endpoints require `config.read`; menu writes
require `config.write` and the normal management write checks. Icon responses use
private ETag revalidation. Menu settings are excluded from proxy import/export.

### Aggregate schema

Every write replaces one complete `ConfigurationAggregate`. Entity IDs are stable UUIDs; `position` controls deterministic ordering; routes and services reference target Services through `service_references` arrays using stable `service_id` values.

Exported snapshots use `format_version: 1` and `schema_version: 1`. Import preview and commit accept only this envelope and the current aggregate schema; unsupported versions or fields are rejected without migration.

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
      "endpoints": [{
        "id": "bbbbbbbb-0000-4000-8000-000000000002",
        "position": 1,
        "target": "https://backup.example.com",
        "weight": 100,
        "priority": 2,
        "is_disabled": false,
        "plugins": []
      }],
      "service_references": [{
        "id": "eeeeeeee-0000-4000-8000-000000000001",
        "position": 0,
        "service_id": "aaaaaaaa-0000-4000-8000-000000000001",
        "weight": 100,
        "priority": 1,
        "is_disabled": false
      }],
      "plugins": []
    }],
    "plugins": []
  },
  "plugin_activations": [{ "plugin_name": "llm-protocol-adapter" }]
}
```

A Route may own `endpoints`, reference Services through `service_references`, or combine both. Endpoints and references share one position group within their Route or Service owner. A Service keeps its `endpoints`; an empty reference array is omitted from normalized Services. For Routes, omit `service_references` when there are no references; an explicitly empty reference array is rejected. A Route with references and no direct endpoints may omit `endpoints`. The removed Route scalar fields `service` and `service_id` are rejected.

Each reference has a stable lowercase UUID `id`, a non-negative integer `position`, and a target `service_id`. Omitted `weight`, `priority`, and `is_disabled` default to `100`, `1`, and `false`. Weight and priority must be finite positive numbers. A target may occur only once per owner. Unknown targets, Service self-references, and cycles are rejected, including cycles that combine native references with plugin `gateway_target` dispatch. References survive Service renames because names are not identities. Removing a referenced Service without also removing its references rejects the complete write.

Management writes, imports and Worker compilation use the installed plugin catalog to identify schema-declared dispatch targets and reject mixed cycles. Internal storage auditing without a catalog validates native references and stored identities; it does not interpret arbitrary plugin options as dispatch targets or replace catalog-backed validation.

Routes accept `load_balancing` with the same policy and hash-input fields as Services. Route `failover` accepts only `enabled`, `retry_on`, and `retry_on_response`; passive health, recovery, slow start and active health remain Service policies.

At each layer, endpoints and Service references participate in the same priority groups and selection policy. A reference's weight applies to the Service as a whole, not to each reachable endpoint. Selecting a Service enters its own target pool and uses that Service's policies; request selection does not flatten the graph. Physical request attempts share the request's budget across these layers.

Submit it with a unique mutation ID:

```json
{
  "mutation_id": "dddddddd-0000-4000-8000-000000000001",
  "expected_revision": 1,
  "kind": "config",
  "aggregate": {}
}
```

The `aggregate` field is the complete object shown above. Management protection and provider activation are written atomically by the configuration storage Worker. Once protected, online disabling, replacing the selected provider or importing an aggregate without it is rejected. The mandatory-protection record is excluded from ordinary snapshots; an import cannot release it. Online activation passes `managementSetup: {operation: "initialize", username, password, passwordConfirmation}` for the first account, or `{operation: "verify", username, password}` for an existing one. Account creation commits to plugin state before configuration protection and activation commit; if that later commit fails, retain the account and retry with verification after re-reading setup status. Offline account actions do not change provider activation; use offline `release-auth` for explicit release while the provider remains installed. Full writes and imports also enforce dependency and route-protection guards.

### 发布期限（`publication`）

滚动发布的三个期限保存在 `logical_configuration.publication`，随配置 revision 持久化并参与内容 hash；它是滚动发布期限的持久化真源。该对象可以省略：省略时不写入默认值，也不改写既有 revision、快照或 hash，运行时按内置默认值解析。省略 `publication` 的历史快照在导入后保持原有 hash。

对象存在时，三个字段必须全部提供，不接受未知字段；每个字段都是正整数秒，以毫秒存储，并且必须是 `1000` 的整数倍：

| 字段 | 默认值 | 作用 |
|---|---|---|
| `drain_start_timeout_ms` | `5000` | 从下发排空命令到确认旧工作进程已开始排空。超时后只查询状态，不作为结束进程的依据。 |
| `drain_timeout_ms` | `300000` | Ingress 从切流开始允许旧批连接继续处理的时长。Worker 收到排空命令后，也用该值限制自身排空时长。 |
| `worker_exit_timeout_ms` | `10000` | 从排空结束或决定强制结束之后，到资源清理完成并确认进程退出。缺少精确退出证据时该轮发布保持未定，不能标记为成功。 |

- 计时器安全上限为 `2147483000` ms（即 2147483 秒）：Bun 1.4.2 中超过该值的 `setTimeout` 会溢出为 1 ms。校验同时要求正的安全整数。
- 校验不要求三个字段之间存在固定比例或先后关系。
- 三个期限分别约束不同阶段，不能相加当作“整轮发布总超时”。
- 修改从本次发布开始生效：新一轮发布使用目标 snapshot 的 `publication`；恢复不会重置同一排空任务的 `drain_timeout_ms`。
- `drain_timeout_ms` 越长，旧代进程及其连接占用资源越久。在线保存等待上一批旧进程确认退出并释放退役占用，再启动候选并验证新配置。
- `worker_exit_timeout_ms`（E）在 worker 自然排空到达终态或决定强制结束时创建一次。其后的状态查询、强制停止、资源清理、关闭与 OS 退出取证共用同一段剩余 E，不会重新授予一段完整 E；清理的签名终态与精确退出分别取证，即使进程已经退出，清理失败也不能判为成功。
- 这些期限是发布策略，不是单次 API / LLM 请求超时或 idle timeout，也不存在按模式切换的开关。控制台按秒显示与编辑；查看页面不会把默认值写入配置。
- `publication` 与代理请求预算相互独立，不是代理的 `request_ms` / first-byte / idle budget，也不覆盖前置插件处理阶段。代理现有 `request_ms` 默认 30 秒与可选 first-byte 预算，据此不能声称整条请求链已被一个统一 deadline 接管。

Ingress 切流时为旧批连接设定期限 H，时长取本次目标的 `drain_timeout_ms`。新请求立即走新批。旧请求取得响应头或失败后，Ingress 记录该请求已完成交接。H 到期时，Ingress 取消仍在等待响应头或握手的请求，并断开旧批尚未结束的 HTTP 响应流和 WebSocket。重连或重发切流命令沿用原期限。

Master 根据同一旧批次的签名状态确认交接完成，再开始 Worker 排空和退出取证。若到期后的复查仍无法确认交接，发布保留未定状态，旧批继续占用容量。Worker 的排空和退出各有独立期限。

API 场景的较短排空起始建议（5 / 30 / 10 秒）：

```json
{ "publication": { "drain_start_timeout_ms": 5000, "drain_timeout_ms": 30000, "worker_exit_timeout_ms": 10000 } }
```

LLM / 长连接场景的起始建议（5 / 300 / 10 秒）：

```json
{ "publication": { "drain_start_timeout_ms": 5000, "drain_timeout_ms": 300000, "worker_exit_timeout_ms": 10000 } }
```

这两组数值只是起始建议，不保证某个具体下游请求一定在期限内结束。

另外，两个数据监听器 显式把 `idleTimeout` 设为 0，去掉了 Bun 默认的隐式 10 秒截断，用于保护超过 10 秒的首包与长流；这不扩展无界的 `text/plain` 能力。

## Import And Export

```bash
bungee export --file bungee-snapshot.json
bungee import --file bungee-snapshot.json
```

With management authentication enabled, add `--token "$SESSION"` using a current Bearer administrator session. Imports do not replace Keys, the administrator, sessions or budget ledgers. Imports replace the complete aggregate; merge import and automatic rollback are intentionally unsupported.

## Expressions

Configuration values may reference environment variables with `{{ env.NAME }}`. Expressions are resolved at publication boundaries. Missing required values fail closed.

## Strict scalar domains

`websocket_max_message_bytes` is a positive integer byte count, defaulting to 16 MiB when omitted. It applies to complete messages in both directions and is independent of the HTTP body limit. The maximum representable value is 2147483647 bytes; buffer budgets grow with the setting. See [WebSocket resource limits](../architecture/websocket.md#资源与关闭).

`log_level` accepts trace, debug, info, warn, error or fatal. `body_parser_limit` uses canonical lowercase positive integer units: b, kb, mb or gb; leading zeroes, decimals, whitespace, uppercase suffixes and zero are rejected. Ordered objects have stable lowercase UUIDs and explicit positions; runtime bindings reference catalog names, not installation paths.

Initialization and future database upgrades follow the [storage baseline](../architecture/storage.md#数据库基线与升级). Ordinary reads use validated immutable memory projections and do not scan SQL history.
