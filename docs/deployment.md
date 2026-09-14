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

`bungee.db` is the configuration database and `access.db` is the telemetry database. Runtime lock files are separate from these databases; do not delete lock files while Bungee is running.

Authentication is controlled by the stored global configuration. When authentication is disabled, management access is anonymous. When authentication is enabled, management requests require a configured token. Rotate tokens through the same configuration and management API.

## Docker Compose

```bash
docker compose up -d
docker compose ps
docker compose logs -f bungee
```

The supplied compose file requires `BUNGEE_PLUGIN_SECRETS_KEY` for encrypted plugin credentials. This is not the authentication token: authentication is stored in `logical_configuration.auth`. The compose file persists `/usr/app/data` and `/usr/app/logs`; it does not mount a configuration file and publishes only the public listener.

## Environment

| Variable | Purpose |
|---|---|
| `PORT` | Public proxy/Ingress listener port; default `8088`; publish only this port |
| `BUNGEE_MANAGEMENT_HOST` | Master management listener host; default `127.0.0.1`; loopback only |
| `BUNGEE_MANAGEMENT_PORT` | Master management listener port; default `8089`; do not publish publicly |
| `BUNGEE_INGRESS_SUPERVISION_PORT` | Signed Ingress supervision port; default `3010`; do not publish publicly |
| `WORKER_COUNT` | Worker count; default `2` |
| `BUNGEE_PLUGIN_SECRETS_KEY` | Required in standalone Docker; stable encryption key for plugin credentials |
| `BUNGEE_CONFIG_DB_PATH` | Absolute configuration database path |
| `BUNGEE_ACCESS_DB_PATH` | Absolute telemetry database path |
| `DATA_DIR` | Stats directory override |

Do not set `CONFIG_PATH`; workers and the master ignore legacy file configuration.

## Health

```bash
curl http://127.0.0.1:8088/health
```

`/health` is the public data-plane availability check. When global authentication is enabled, management APIs require `Authorization: Bearer <configured-token>`. With authentication disabled, management access is anonymous.

## Backup

For a consistent backup, stop Bungee and copy `data/bungee.db` and `logs/access.db` separately. Restore both files to the same paths before restarting; do not delete runtime lock files as part of database maintenance. Configuration-level rollback uses a previously exported snapshot with `bungee import --file`; there is no automatic rollback API.
