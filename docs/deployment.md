# Deployment

## CLI

```bash
npx bungee init
npx bungee start
npx bungee status
npx bungee logs
npx bungee stop
```

CLI state lives under `~/.bungee/`:

```text
~/.bungee/
├── bin/
├── data/bungee.db
├── logs/access.db
├── bungee.log
├── bungee.error.log
└── bungee.pid
```

Authentication is controlled by the stored global configuration. When authentication is disabled, management access is anonymous. When authentication is enabled, management requests require a configured token. Rotate tokens through the same configuration and management API.

## Docker Compose

```bash
docker compose up -d
docker compose ps
docker compose logs -f bungee
```

The container starts without an authentication secret. The supplied compose file persists `/usr/app/data` and `/usr/app/logs`. It does not mount a configuration file.

## Environment

| Variable | Purpose |
|---|---|
| `PORT` | Public listener port; default `8088` |
| `WORKER_COUNT` | Worker count; default `2` |
| `BUNGEE_CONFIG_DB_PATH` | Absolute configuration database path |
| `BUNGEE_ACCESS_DB_PATH` | Absolute telemetry database path |
| `DATA_DIR` | Stats directory override |

Do not set `CONFIG_PATH`; workers and the master ignore legacy file configuration.

## Health

```bash
curl http://127.0.0.1:8088/health
```

When global authentication is enabled, management APIs require `Authorization: Bearer <configured-token>`. With authentication disabled, management access is anonymous.

## Backup

For a consistent backup, stop Bungee and copy both SQLite files. Restore both files to the same paths before restarting. Configuration-level rollback uses a previously exported snapshot with `bungee import --file`; there is no automatic rollback API.
