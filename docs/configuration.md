# Configuration

Bungee stores configuration in SQLite. The master process owns `data/bungee.db`; workers receive immutable revision snapshots and never read a configuration file.

## Paths

| Data | Default | Override |
|---|---|---|
| Configuration | `data/bungee.db` | `BUNGEE_CONFIG_DB_PATH` |
| Telemetry | `logs/access.db` | `BUNGEE_ACCESS_DB_PATH` |

Both overrides must be absolute paths. `CONFIG_PATH`, YAML, and JSON configuration files are unsupported.

## Authentication

Global authentication is controlled by the stored configuration. When it is disabled, management access is anonymous. When it is enabled, management requests require a configured token. Token rotation is performed through the same configuration and management API.

The `BUNGEE_MANAGEMENT_TOKEN` name in the example is a deployment-defined environment variable, not a built-in Bungee variable. Set it yourself before publishing the configuration when authentication is enabled. `logical_configuration.auth` is the only source of truth for authentication.

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

For a retry, send exactly `{"request_id":"<lowercase UUID>","expected_revision":<positive safe integer>}`. The response is a durable recovery record; active recoveries return `202`, terminal records return `200`, and retrying the same request ID with the same operation and revision is idempotent.

`GET /api/config/runtime` includes authoritative `publication` state: the current operation and recovery records, `retryable`, `serving_complete`, `serving_revision`, and `target_revision`.

### Aggregate schema

Every write replaces one complete `ConfigurationAggregateV2`. Entity IDs are stable UUIDs; `position` controls deterministic ordering; routes reference services by `service_id`.

```json
{
  "logical_configuration": {
    "auth": { "enabled": true, "tokens": ["{{ env.BUNGEE_MANAGEMENT_TOKEN }}"] },
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
  "plugin_activations": [{ "plugin_name": "ai-transformer" }]
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

The `aggregate` field is the complete object shown above. When authentication changes, send the actual next credential in `X-Bungee-Next-Authorization`.

## Import And Export

```bash
bungee export --token "$TOKEN" --file bungee-snapshot.json
bungee import --file bungee-snapshot.json --token "$TOKEN"
```

If the imported snapshot rotates authentication, add `--next-token "$NEW_TOKEN"`. Imports replace the complete aggregate; merge import and automatic rollback are intentionally unsupported.

## Expressions

Configuration values may reference environment variables with `{{ env.NAME }}`. Expressions are resolved at publication boundaries. Missing required values fail closed.
