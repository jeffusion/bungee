# Bungee Docker Deployment

## Start

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f bungee
```

The public listener is available on `http://127.0.0.1:8088` by default.

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

No JSON/YAML configuration file is mounted or read. Stop the service before copying both SQLite files for a consistent backup.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8088` | Public listener |
| `WORKER_COUNT` | `2` | Worker count |
| `BUNGEE_CONFIG_DB_PATH` | `/usr/app/data/bungee.db` | Absolute configuration DB path |
| `BUNGEE_ACCESS_DB_PATH` | `/usr/app/logs/access.db` | Absolute telemetry DB path |

## Operations

```bash
docker compose logs -f bungee
docker compose restart bungee
docker compose down
```

Configuration is managed through the Dashboard or versioned API snapshots. See [Configuration](docs/configuration.md) and [Deployment](docs/deployment.md).
