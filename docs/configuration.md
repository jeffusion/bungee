# Configuration Guide

This guide is the source-of-truth for `config.json`, environment overrides, and failover/health-check behavior.

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
| `logLevel` | `LOG_LEVEL` | `info` |
| `workers` | `WORKER_COUNT` | `2` |
| `port` | `PORT` | `8088` |
| `bodyParserLimit` | `BODY_PARSER_LIMIT` | `50mb` |

Notes:

- If `CONFIG_PATH` is set, Bungee reads config from that path.
- Missing config file is auto-initialized as `{ "routes": [] }` in core runtime.

---

## 2) Root Schema (`AppConfig`)

| Field | Type | Required | Description |
|---|---|---|---|
| `routes` | `RouteConfig[]` | Yes | Route table; must be an array |
| `bodyParserLimit` | `string` | No | Max request body size |
| `auth` | `AuthConfig` | No | Global authentication config |
| `logging` | `LoggingConfig` | No | Body logging retention/size options |
| `plugins` | `Array<PluginConfig \| string>` | No | Global plugin configuration |

Minimal valid config:

```json
{
  "routes": []
}
```

---

## 3) Route Schema (`RouteConfig`)

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | Prefix match path |
| `upstreams` | `Upstream[]` | Yes | Target upstream list (non-empty) |
| `pathRewrite` | `Record<string, string>` | No | Regex rewrite map |
| `auth` | `AuthConfig` | No | Route auth (overrides global auth) |
| `plugins` | `Array<PluginConfig \| string>` | No | Route plugins |
| `headers` / `body` / `query` | `ModificationRules` | No | Route-level mutation rules |
| `failover` | `object` | No | Retry/failover/health-check config |
| `stickySession` | `object` | No | Session-affinity routing config |

Validation behavior:

- Route must have non-empty `upstreams`.
- If `failover.enabled=true` and upstream count is `< 2`, Bungee logs a warning.

### 3.1 Sticky session fields (`stickySession`)

| Field | Type | Required | Default |
|---|---|---|---|
| `enabled` | `boolean` | Yes | `false` |
| `keyExpression` | `string` | No | - |

Behavior notes:

- Sticky session is active only when `enabled=true` and the computed key is non-empty.
- `keyExpression` uses `{{ }}` expression syntax (for example, `{{ headers['x-session-id'] || body.conversation_id }}`).
- Priority and condition filtering still run before sticky selection.
- When no sticky key is resolved, selection falls back to the normal weighted strategy.

---

## 4) Upstream Schema (`Upstream`)

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `target` | `string` | Yes | - | Upstream URL |
| `weight` | `number` | No | `100` | Weighted selection within same priority |
| `priority` | `number` | No | `1` | Lower value = higher priority |
| `condition` | `string` | No | - | `{{ }}` expression filter |
| `disabled` | `boolean` | No | `false` | Excluded from selection when true |
| `plugins` | `Array<PluginConfig \| string>` | No | - | Upstream-level plugin set |
| `headers` / `body` / `query` | `ModificationRules` | No | - | Upstream-level mutation rules |

Selection model:

1. Disabled upstreams are excluded.
2. If request context exists, `condition` is evaluated.
3. Candidates are grouped by `priority` (ascending).
4. Within one priority group, weighted strategy is applied.

---

## 5) Failover and Health Check

### 5.1 Failover fields

| Field | Type | Default |
|---|---|---|
| `enabled` | `boolean` | `false` |
| `retryableStatusCodes` | `number \| string \| (number\|string)[]` | route-dependent |
| `consecutiveFailuresThreshold` | `number` | `3` |
| `recoveryIntervalMs` | `number` | `5000` |
| `recoveryTimeoutMs` | `number` | `3000` |
| `healthyThreshold` | `number` | `2` |
| `requestTimeoutMs` | `number` | `30000` |
| `connectTimeoutMs` | `number` | `5000` |
| `autoDisableThreshold` | `number` | disabled unless configured |
| `autoEnableOnHealthCheck` | `boolean` | `true` |

### 5.2 Health check fields (`failover.healthCheck`)

| Field | Type | Default |
|---|---|---|
| `enabled` | `boolean` | `false` |
| `intervalMs` | `number` | `10000` |
| `timeoutMs` | `number` | `3000` |
| `path` | `string` | `/health` |
| `method` | `string` | `GET` |
| `expectedStatus` | `number[]` | `[200]` |
| `unhealthyThreshold` | `number` | `3` |
| `healthyThreshold` | `number` | `2` |
| `body` | `string` | - |
| `contentType` | `string` | `application/json` |
| `headers` | `Record<string,string>` | - |
| `query` | `Record<string,string>` | - |

Health-check `headers` and `query` support expression evaluation; failed expression evaluation falls back to raw value with warning logs.

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
- Upstream (`upstream.plugins`)

The effective set is scope-aware; upstream-level configuration can narrow behavior for a specific target.

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
  "logLevel": "info",
  "workers": 2,
  "port": 8088,
  "bodyParserLimit": "50mb",
  "auth": {
    "enabled": true,
    "tokens": ["{{ env.GLOBAL_API_TOKEN }}"]
  },
  "routes": [
    {
      "path": "/api/critical",
      "plugins": ["ai-transformer"],
      "upstreams": [
        { "target": "https://primary.example.com", "priority": 1, "weight": 80 },
        { "target": "https://backup.example.com", "priority": 1, "weight": 20 },
        { "target": "https://fallback.example.com", "priority": 2 }
      ],
      "failover": {
        "enabled": true,
        "retryableStatusCodes": ">=500,!503",
        "autoDisableThreshold": 10,
        "autoEnableOnHealthCheck": true,
        "healthCheck": {
          "enabled": true,
          "intervalMs": 10000,
          "path": "/health",
          "expectedStatus": [200]
        }
      }
    }
  ]
}
```

---

## 10) Validation and Failure Behavior

- Invalid JSON / invalid schema causes startup failure.
- Invalid auth config (enabled but no tokens) causes startup failure.
- Invalid upstream weight/priority causes startup failure.
- Invalid `retryableStatusCodes` matcher format is rejected by runtime matcher initialization.
