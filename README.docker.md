# Bungee Docker Deployment

## Start

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f bungee
```

The public proxy/Ingress listener is available on `http://127.0.0.1:8088` by default. The compose file publishes only this public port.

```bash
curl http://127.0.0.1:8088/health
```

Authentication is controlled by the stored global configuration. When authentication is disabled, management access is anonymous. When authentication is enabled, management requests require a configured token.

## Persistence

The supplied compose file persists exactly two volumes:

| Volume | Container path | Contents |
|---|---|---|
| `data` | `/usr/app/data` | `bungee.db` configuration revisions |
| `logs` | `/usr/app/logs` | `access.db` telemetry |

No JSON/YAML configuration file is mounted or read. `bungee.db` and `access.db` are separate databases; runtime lock files are separate from both and must not be deleted while Bungee is running. Stop the service before copying the databases for a consistent backup.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8088` | Public proxy/Ingress listener; this is the only port to publish |
| `BUNGEE_MANAGEMENT_HOST` | `127.0.0.1` | Master management listener host; loopback only |
| `BUNGEE_MANAGEMENT_PORT` | `8089` | Master management listener; loopback only, never publish publicly |
| `BUNGEE_INGRESS_SUPERVISION_PORT` | `3010` | Signed Ingress supervision listener; loopback only, never publish publicly |
| `WORKER_COUNT` | `2` | Worker count |
| `BUNGEE_PLUGIN_SECRETS_KEY` | — | Required for standalone Docker; encryption key for plugin credentials |
| `BUNGEE_CONFIG_DB_PATH` | `/usr/app/data/bungee.db` | Absolute configuration DB path |
| `BUNGEE_ACCESS_DB_PATH` | `/usr/app/logs/access.db` | Absolute telemetry DB path |

Standalone Docker deployments must inject `BUNGEE_PLUGIN_SECRETS_KEY` and keep it stable. This key is separate from authentication, which is stored in `logical_configuration.auth`. Do not publish the management or supervision listeners.

## Operations

```bash
docker compose logs -f bungee
docker compose restart bungee
docker compose down
```

Configuration is managed through the Dashboard or versioned API snapshots. See [Configuration](docs/configuration.md) and [Deployment](docs/deployment.md).
