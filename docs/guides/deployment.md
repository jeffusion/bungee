# Deployment

## CLI

```bash
npx @jeffusion/bungee@latest upgrade
npx @jeffusion/bungee@latest init
npx @jeffusion/bungee@latest start
npx @jeffusion/bungee@latest status
npx @jeffusion/bungee@latest logs
npx @jeffusion/bungee@latest stop
```

CLI state lives under `~/.bungee/`:

```text
~/.bungee/
├── bin/
├── data/
│   ├── bungee.db
│   ├── plugin-state.db
│   └── plugin-secrets.key
├── logs/access.db
├── bungee.log
├── bungee.error.log
└── bungee.pid
```

`bungee.db` stores configuration, `plugin-state.db` stores plugin business state and secrets, and `access.db` stores telemetry. CLI initialization generates and persists the encryption key in the owner-only `plugin-secrets.key` file beside the configuration database. For a supplied key, initialization parameters and precedence are documented in the [CLI reference](../reference/cli.md#bungee-init). Later CLI commands read this file; retain it with database backups. Runtime lock files are separate from these databases; do not delete lock files while Bungee is running.

Storage Workers validate schema and migration prefixes before serving. The observation Worker selects and checks the journal mode using the SQLite runtime actually loaded by Bun; installing a separate sqlite3 CLI does not change that runtime. If an existing WAL database conflicts with the selected mode, startup fails before migrations. Stop the whole instance and back up SQLite side files before offline conversion; never delete a WAL file as a conversion method. See [storage contracts](../architecture/storage.md) and [journal selection](../../packages/core/src/access-database.ts).

Management is anonymous and proxy routes are public by default. `bungee init` initializes storage and persists its encryption key. To protect management with 用户认证 (`user-auth`), enable it in the plugin center and enter a username, password and password confirmation. The activation dialog creates the first account and establishes a verified Cookie session; existing accounts use password verification. If the provider is already selected but uninitialized, `/#/setup` creates the account and returns to login. Use offline `release-auth` to explicitly restore anonymous management; online disabling, replacement, import or installed-provider failure cannot release protection. Startup automatically removes records for plugins absent from the installed catalog, including a removed management-provider selection; plugin business state is retained. Enable 访问控制 (`key-access`) separately to create Keys and explicitly protect routes. See [authentication](./authentication.md).

## Docker Compose

Set `BUNGEE_PLUGIN_SECRETS_KEY` to a stable, privately stored encryption key before starting Compose.

```bash
docker compose run --rm --no-deps bungee ./docker-entrypoint.sh --initialize-config /usr/app/data/bungee.db
docker compose up -d
docker compose ps
docker compose logs -f bungee
```

Enable management authentication online in the plugin center. For offline account recovery, stop the original container and use a temporary interactive container with the original volumes and environment. Its image must match the selected runtime release; updates in the original container's writable layer are not copied to temporary containers. The official image uses `/usr/app` as its working directory:

```sh
docker compose stop bungee
docker compose run --rm -it --no-deps bungee ./docker-entrypoint.sh --recover /usr/app/data/bungee.db --plugin user-auth --action reset-password
docker compose up -d bungee
```

Restart only after recovery succeeds. Use `add-user` to create an account or `reset` to recover the original administrator; see [offline recovery](offline-recovery.md). These actions do not enable the plugin or change the selected provider. Do not run recovery against a running instance or an empty replacement volume.

The supplied compose file requires `BUNGEE_PLUGIN_SECRETS_KEY` for encrypted plugin credentials. It is separate from API Keys, which are created and revoked through their lifecycle API rather than a core token list. The compose file persists `/usr/app/data` and `/usr/app/logs`; it does not mount a configuration file. It publishes the public listener and binds management to host loopback by default.

The official image executes a release binary under tini. `BUNGEE_INSTALL_ROOT=/usr/app/runtime` is separate from the data and log volumes: `version.txt` selects a stable `x.y.z` release in `bin/<version>/`, containing the executable and adjacent `plugins/`. Startup rejects a missing or invalid selection without downloading or selecting a fallback.

The dashboard version control checks release metadata and requires confirmation before downloading, installing and restarting. This updates only the container's binary and bundled plugins; it does not pull an image or access the host. Restarting the same container retains the update. Recreating the container, including replacement by Compose, restores the image release while preserving the databases. Choose an image compatible with those databases before recreation or offline recovery. An update failure never automatically rolls back a potentially migrated database; see [binary updates](../architecture/runtime.md#binary-updates).

The public data listener is `0.0.0.0:8088` and is proxy-only. The management
root is `http://127.0.0.1:8089/`; its API is `/api`, plugin static assets are
under `/plugins`, and health is `/health`. The design page is
`http://127.0.0.1:8089/#/design`.

In the official bridge setup, the container management listener is explicitly
`BUNGEE_MANAGEMENT_HOST=0.0.0.0`, while Compose publishes on host loopback.
Set `BUNGEE_MANAGEMENT_PUBLISH_PORT` if host port `8089` is occupied, or set
`BUNGEE_MANAGEMENT_PUBLISH_HOST=0.0.0.0` for LAN access. Management is anonymous unless 管理认证 is enabled, then it requires the administrator session. Configure an explicit public HTTP or HTTPS Origin for browser access; HTTPS is recommended in production.

## Environment

| Variable | Purpose |
|---|---|
| `PORT` | Public proxy/Ingress listener port; default `8088`; public data mapping |
| `BUNGEE_MANAGEMENT_HOST` | Management listener host; standalone default `127.0.0.1`; Docker Compose sets `0.0.0.0` inside the container |
| `BUNGEE_MANAGEMENT_PORT` | Management listener port; default `8089` |
| `BUNGEE_PUBLIC_ORIGIN` | Explicit public HTTP/HTTPS Origin for management callbacks and Cookie/CSRF; HTTPS recommended in production |
| `BUNGEE_TRUSTED_MANAGEMENT_PROXIES` | Comma-separated exact proxy IPs allowed to provide one client IP |
| `BUNGEE_MANAGEMENT_PUBLISH_HOST` | Docker host address for management; default `127.0.0.1` |
| `BUNGEE_MANAGEMENT_PUBLISH_PORT` | Docker host port for management; default `8089` |
| `BUNGEE_MASTER_CONTROL_PORT` | Private master control port; default `3011`; host fixed to `127.0.0.1`, never publish |
| `WORKER_COUNT` | Worker count; default `2` |
| `BUNGEE_PLUGIN_SECRETS_KEY` | Required in standalone Docker; stable encryption key for plugin credentials |
| `BUNGEE_CONFIG_DB_PATH` | Absolute configuration database path |
| `BUNGEE_ACCESS_DB_PATH` | Absolute telemetry database path |
| `DATA_DIR` | Stats directory override |

Configuration comes from SQLite and validated memory snapshots. `CONFIG_PATH` does not select a runtime JSON/YAML file.

WebSocket client admission is configured in System Settings, not environment variables. The default is 512 client connections across the instance; `websocket_max_connections: null` removes the additional count limit. Publish the configuration to apply it without recreating the container. Worker drain during publication may require clients to reconnect. Message and buffer budgets remain in force; see [WebSocket resource limits](../architecture/websocket.md#资源与关闭).

## Health

```bash
docker compose exec bungee sh -c 'wget -qO- "http://127.0.0.1:${BUNGEE_MANAGEMENT_PORT:-8089}/health/management"'
```

The Docker health check maps wildcard management hosts to a container loopback
address before connecting. `/health/management` is the container management-readiness check.
Management APIs are anonymous by default, or require the selected administrator Cookie/Bearer session when 管理认证 is enabled. `/health` reports live, management, data and degraded separately; its 200 requires live and management, not data. `/health/data` returns 503 without a confirmed serving worker.

## Backup

For a consistent backup, stop the entire instance and preserve `data/` and `logs/`, including all three databases and any SQLite side files. Preserve the stable plugin secrets encryption key separately. Restore the matching data, logs and key before restarting; do not delete runtime lock files as part of database maintenance. Configuration-level rollback uses a previously exported snapshot with `bungee import --file`; there is no automatic rollback API.
