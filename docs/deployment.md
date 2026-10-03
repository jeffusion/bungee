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

At startup the master reads the actual SQLite version loaded by `bun:sqlite`
while holding
the access-database lock, selects the journal mode, writes it, and verifies the
exact value before running access-database migrations. SQLite `>=3.37.0` is
accepted with `DELETE`; `WAL` is used only by SQLite `3.44.6+`, `3.50.7+`, `3.51.3+`,
or `>=3.52`. Versions `3.45.x` through `3.49.x` use `DELETE`. A new database
also starts in `DELETE`; macOS has no special platform override. Installing a
system `sqlite3` CLI does not change `bun:sqlite`. DELETE only avoids the
known unsafe WAL-reset case: it allows only one writer and may block readers
during writes, while WAL permits readers alongside its single writer. Busy
timeouts do not eliminate operational write failures or filesystem/power-loss
durability boundaries. Each connection preserves the selected mode and uses
`FULL` for DELETE or `NORMAL` for WAL, with a 5-second busy timeout.

If an existing database is WAL on a runtime that is not WAL-safe, startup stops
before migration and schema writes. Stop all Bungee processes, back up the
database and `-wal`/`-shm` files, then convert WAL to DELETE offline with a
trusted SQLite tool and run an integrity check before restarting. Never delete
the `-wal` file as a conversion method.

Management is anonymous and proxy routes are public by default. `bungee init` only initializes storage. Enable 管理认证 (`local-accounts`) for a single administrator session, and 访问控制 (`key-access`) to create Keys and explicitly protect routes. Disabling management authentication restores anonymous management; a failed or missing selected plugin does not. See [authentication](./authentication.md).

## Docker Compose

```bash
docker compose run --rm --no-deps bungee bun packages/core/dist/main.js --initialize-config /usr/app/data/bungee.db
docker compose up -d
docker compose ps
docker compose logs -f bungee
```

The supplied compose file requires `BUNGEE_PLUGIN_SECRETS_KEY` for encrypted plugin credentials. It is separate from API Keys, which are created and revoked through their lifecycle API rather than `logical_configuration.auth`. The compose file persists `/usr/app/data` and `/usr/app/logs`; it does not mount a configuration file. It publishes the public listener and binds management to host loopback by default.

The public data listener is `0.0.0.0:8088` and is proxy-only. The management
root is `http://127.0.0.1:8089/`; its API is `/api`, plugin static assets are
under `/plugins`, and health is `/health`. The design page is
`http://127.0.0.1:8089/#/design`.

In the official bridge setup, the container management listener is explicitly
`BUNGEE_MANAGEMENT_HOST=0.0.0.0`, while Compose publishes on host loopback.
Set `BUNGEE_MANAGEMENT_PUBLISH_PORT` if host port `8089` is occupied, or set
`BUNGEE_MANAGEMENT_PUBLISH_HOST=0.0.0.0` for LAN access. Management is anonymous unless 管理认证 is enabled, then it requires the administrator session. Configure HTTPS and an explicit public Origin for external browser access.

## Environment

| Variable | Purpose |
|---|---|
| `PORT` | Public proxy/Ingress listener port; default `8088`; public data mapping |
| `BUNGEE_MANAGEMENT_HOST` | Management listener host; standalone default `127.0.0.1`; Docker Compose sets `0.0.0.0` inside the container |
| `BUNGEE_MANAGEMENT_PORT` | Management listener port; default `8089` |
| `BUNGEE_PUBLIC_ORIGIN` | Public HTTPS Origin for administrator Cookie/CSRF |
| `BUNGEE_TRUSTED_MANAGEMENT_PROXIES` | Comma-separated exact proxy IPs allowed to provide one client IP |
| `BUNGEE_MANAGEMENT_PUBLISH_HOST` | Docker host address for management; default `127.0.0.1` |
| `BUNGEE_MANAGEMENT_PUBLISH_PORT` | Docker host port for management; default `8089` |
| `BUNGEE_MASTER_CONTROL_PORT` | Private master control port; default `3011`; host fixed to `127.0.0.1`, never publish |
| `WORKER_COUNT` | Worker count; default `2` |
| `BUNGEE_PLUGIN_SECRETS_KEY` | Required in standalone Docker; stable encryption key for plugin credentials |
| `BUNGEE_CONFIG_DB_PATH` | Absolute configuration database path |
| `BUNGEE_ACCESS_DB_PATH` | Absolute telemetry database path |
| `DATA_DIR` | Stats directory override |

Do not set `CONFIG_PATH`; workers and the master ignore legacy file configuration.

## Health

```bash
docker compose exec bungee sh -c 'wget -qO- "http://127.0.0.1:${BUNGEE_MANAGEMENT_PORT:-8089}/health"'
```

The Docker health check maps wildcard management hosts to a container loopback
address before connecting. `/health` is the management availability check.
Management APIs are anonymous by default, or require the selected administrator Cookie/Bearer session when 管理认证 is enabled. `/health` reports minimal availability without exposing management data.

## Backup

For a consistent backup, stop Bungee and copy `data/bungee.db` and `logs/access.db` separately. Restore both files to the same paths before restarting; do not delete runtime lock files as part of database maintenance. Configuration-level rollback uses a previously exported snapshot with `bungee import --file`; there is no automatic rollback API.
