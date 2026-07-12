# Configuration Guide

This guide is the source of truth for `config.json`, environment overrides, and failover/health-check behavior.

Related implementation files:

- `packages/types/src/types.ts`
- `packages/core/src/config.ts`
- `packages/core/src/worker/health/checker.ts`
- `packages/core/src/worker/upstream/failover-coordinator.ts`

---

## 1) Configuration Sources and Priority

Bungee resolves runtime settings in this order:

```text
Environment Variables > config.json > Default Values
```

Global settings loaded with this precedence:

| Setting | Env var | Default |
|---|---|---|
| `log_level` | `LOG_LEVEL` | `info` |
| `workers` | `WORKER_COUNT` | `2` |
| `port` | `PORT` | `8088` |
| `body_parser_limit` | `BODY_PARSER_LIMIT` | `50mb` |

Notes:

- If `CONFIG_PATH` is set, Bungee reads config from that path.
- Missing config file is auto-initialized as `{ "config_version": 4, "routes": [] }` in core runtime.

---

## 2) Root Schema (`AppConfig`)

| Field | Type | Required | Description |
|---|---|---|---|
| `config_version` | `number` | No | Current format is `4` |
| `routes` | `RouteConfig[]` | Yes | Route table; must be an array |
| `services` | `Service[]` | No | Reusable backend service definitions |
| `body_parser_limit` | `string` | No | Max request body size |
| `log_level` | `string` | No | Runtime log level |
| `auth` | `AuthConfig` | No | Global authentication config |
| `logging` | `LoggingConfig` | No | Body logging retention/size options |
| `plugins` | `Array<PluginConfig \| string>` | No | Global plugin configuration |

Minimal valid config:

```json
{
  "config_version": 4,
  "routes": []
}
```

---

## 3) Service and Endpoint Schema

Services hold reusable endpoint pools. Routes should usually reference a service by name.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Service name referenced by routes |
| `endpoints` | `Endpoint[]` | Yes | Target endpoint list (non-empty) |
| `health_check` | `object` | No | Service-level active health check |
| `failover` | `object` | No | Service-level retry/failover behavior |

Endpoint fields:

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `target` | `string` | Yes | - | Endpoint URL |
| `weight` | `number` | No | `100` | Weighted selection within same priority |
| `priority` | `number` | No | `1` | Lower value = higher priority |
| `condition` | `string` | No | - | `{{ }}` expression filter |
| `is_disabled` | `boolean` | No | `false` | Excluded from selection when true |
| `plugins` | `Array<PluginConfig \| string>` | No | - | Endpoint-level plugin set |
| `headers` / `body` / `query` | `ModificationRules` | No | - | Endpoint-level mutation rules |

Selection model:

1. Disabled endpoints are excluded.
2. If request context exists, `condition` is evaluated.
3. Candidates are grouped by `priority` (ascending).
4. Within one priority group, weighted strategy is applied.

---

## 4) Route Schema (`RouteConfig`)

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | Prefix match path |
| `service` | `string` | Usually | Name of a service in `services` |
| `endpoints` | `Endpoint[]` | Alternative | Inline endpoint list for simple/special routes |
| `path_rewrite` | `Record<string, string>` | No | Regex rewrite map |
| `auth` | `AuthConfig` | No | Route auth (overrides global auth) |
| `plugins` | `Array<PluginConfig \| string>` | No | Route plugins |
| `headers` / `body` / `query` | `ModificationRules` | No | Route-level mutation rules |
| `failover` | `object` | No | Route-level retry/failover config |
| `sticky_session` | `object` | No | Session-affinity routing config |
| `timeouts` | `object` | No | Route request/connect timeouts |

Validation behavior:

- A route must reference `service` or define non-empty `endpoints`.
- If `failover.enabled=true` and endpoint count is `< 2`, Bungee logs a warning.

### 4.1 Sticky session fields (`sticky_session`)

| Field | Type | Required | Default |
|---|---|---|---|
| `enabled` | `boolean` | Yes | `false` |
| `key_expression` | `string` | No | - |

Behavior notes:

- Sticky session is active only when `enabled=true` and the computed key is non-empty.
- `key_expression` uses `{{ }}` expression syntax (for example, `{{ headers['x-session-id'] || body.conversation_id }}`).
- Priority and condition filtering still run before sticky selection.
- When no sticky key is resolved, selection falls back to the normal weighted strategy.

---

## 5) Timeouts, Failover, and Health Check

### 5.1 Route timeouts (`timeouts`)

| Field | Type | Default |
|---|---|---|
| `request_ms` | `number` | `30000` |
| `connect_ms` | `number` | `5000` |

### 5.2 Failover fields (`failover`)

| Field | Type | Default |
|---|---|---|
| `enabled` | `boolean` | `false` |
| `retry_on` | `number \| string \| (number\|string)[]` | route-dependent |
| `passive_health` | `object` | - |
| `recovery` | `object` | - |
| `slow_start` | `object` | - |
| `health_check` | `object` | - |

### 5.3 Passive health fields (`failover.passive_health`)

| Field | Type | Default |
|---|---|---|
| `consecutive_failures` | `number` | `3` |
| `healthy_successes` | `number` | `2` |
| `auto_disable_threshold` | `number` | disabled unless configured |
| `auto_enable_on_active_health_check` | `boolean` | `true` |

### 5.4 Recovery fields (`failover.recovery`)

| Field | Type | Default |
|---|---|---|
| `probe_interval_ms` | `number` | `5000` |
| `probe_timeout_ms` | `number` | `3000` |

### 5.5 Slow start fields (`failover.slow_start`)

| Field | Type | Default |
|---|---|---|
| `enabled` | `boolean` | `false` |
| `duration_ms` | `number` | `60000` |
| `initial_weight_factor` | `number` | `0.25` |

### 5.6 Health check fields (`health_check` or `failover.health_check`)

| Field | Type | Default |
|---|---|---|
| `enabled` | `boolean` | `false` |
| `interval_ms` | `number` | `10000` |
| `timeout_ms` | `number` | `3000` |
| `path` | `string` | `/health` |
| `method` | `string` | `GET` |
| `expected_status` | `number[]` | `[200]` |
| `unhealthy_threshold` | `number` | `3` |
| `healthy_threshold` | `number` | `2` |
| `body` | `string` | - |
| `content_type` | `string` | `application/json` |
| `headers` | `Record<string,string>` | - |
| `query` | `Record<string,string>` | - |

Health-check `headers` and `query` support expression evaluation; failed expression evaluation falls back to raw value with warning logs.

### 5.7 Migration from older config versions

Legacy config versions are migrated in memory to config model V4. New config files should use `config_version: 4`, `services`, `endpoints`, and snake_case fields.

**V3 → V4 migration changes:**

- `failover.health_check` → Service top-level `health_check` (promoted from nested subfield to independent subsystem)
- `failover.recovery.probe_interval_ms` → `failover.recovery.backoff_base_ms` (now exponential backoff base, not fixed interval)
- `passive_health.auto_enable_on_active_health_check` → `health_check.auto_enable_on_active_health_check`
- Route-level `sticky_session` → Service-level `load_balancing.policy = "consistent_hash"` + `hash_policy.expression`
- Route-level `failover` → Service-level `failover`

**Responsibility split (V4):**

- **Route** owns: path matching, auth, request processing (transformer, headers, body, `timeouts.request_ms`, rate_limit, cors)
- **Service** owns: endpoints, `load_balancing`, `health_check`, `failover`, `timeouts` (`connect_ms`/`send_ms`/`read_ms`)

---

## 6) Authentication

`AuthConfig`:

| Field | Type | Required | Rule |
|---|---|---|---|
| `enabled` | `boolean` | Yes | If false, auth is bypassed |
| `tokens` | `string[]` | Yes when enabled | Must be non-empty array |

Scope behavior:

- Route `auth` overrides global `auth`.
- On successful auth, authorization data is sanitized before forwarding.

---

## 7) Plugin Configuration

`PluginConfig`:

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Plugin identifier |
| `path` | `string` | No | Optional explicit path |
| `options` | `object` | No | Plugin init options |
| `enabled` | `boolean` | No | Defaults to `true` |

Plugin application levels:

- Global (`app.plugins`)
- Route (`route.plugins`)
- Endpoint (`endpoint.plugins`)

The effective set is scope-aware; endpoint-level configuration can narrow behavior for a specific target.

---

## 8) Modification Rules (`headers`, `body`, `query`)

Supported operations:

- `add`
- `replace`
- `remove`
- `default` (for `body`/`query`)

Expression syntax:

```text
{{ ... }}
```

Common context variables: `headers`, `body`, `url`, `method`, `env`.

---

## 9) Operational Example

```json
{
  "config_version": 4,
  "log_level": "info",
  "workers": 2,
  "port": 8088,
  "body_parser_limit": "50mb",
  "auth": {
    "enabled": true,
    "tokens": ["{{ env.GLOBAL_API_TOKEN }}"]
  },
  "services": [
    {
      "name": "critical-api",
      "endpoints": [
        { "target": "https://primary.example.com", "priority": 1, "weight": 80 },
        { "target": "https://backup.example.com", "priority": 1, "weight": 20 },
        { "target": "https://fallback.example.com", "priority": 2 }
      ],
      "health_check": {
        "enabled": true,
        "interval_ms": 10000,
        "timeout_ms": 3000,
        "path": "/health",
        "expected_status": [200]
      },
      "failover": {
        "enabled": true,
        "retry_on": ">=500,!503",
        "passive_health": {
          "auto_disable_threshold": 10,
          "auto_enable_on_active_health_check": true
        }
      }
    }
  ],
  "routes": [
    {
      "path": "/api/critical",
      "plugins": ["ai-transformer"],
      "service": "critical-api",
      "timeouts": {
        "request_ms": 30000,
        "connect_ms": 5000
      }
    }
  ]
}
```

---

## 10) Validation and Failure Behavior

- Invalid JSON / invalid schema causes startup failure.
- Invalid auth config (enabled but no tokens) causes startup failure.
- Invalid endpoint weight/priority causes startup failure.
- Invalid `retry_on` matcher format is rejected by runtime matcher initialization.
