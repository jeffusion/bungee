# Bungee Docker Deployment

## Start

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f bungee
```

The public proxy/Ingress listener is available on `http://127.0.0.1:8088` by default. It is proxy-only; management routes are not served there.

The management UI is available at `http://127.0.0.1:8089/`. The API is under
`/api`, plugin static assets under `/plugins`, and health under `/health`.
The design page is `http://127.0.0.1:8089/#/design`.

Compose binds the container's management listener to `0.0.0.0` but publishes
it on host loopback by default. Set `BUNGEE_MANAGEMENT_PUBLISH_PORT` when host
port `8089` is busy, or explicitly set `BUNGEE_MANAGEMENT_PUBLISH_HOST=0.0.0.0`
for LAN access. If authentication is disabled, the management surface is anonymous.

The container health check queries the internal management listener. To run the same check without publishing management port `8089` to the host:

```bash
docker compose exec bungee sh -c 'wget -qO- "http://127.0.0.1:${BUNGEE_MANAGEMENT_PORT:-8089}/health"'
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
| `PORT` | `8088` | Public proxy/Ingress listener; proxy-only |
| `BUNGEE_MANAGEMENT_HOST` | `0.0.0.0` in Compose | Container management listener; host exposure is controlled by port mapping |
| `BUNGEE_MANAGEMENT_PORT` | `8089` | Management listener |
| `BUNGEE_MANAGEMENT_PUBLISH_HOST` | `127.0.0.1` | Docker host address that publishes management |
| `BUNGEE_MANAGEMENT_PUBLISH_PORT` | `8089` | Docker host port that publishes management |
| `BUNGEE_MASTER_CONTROL_PORT` | `3011` | Private master control listener; host is fixed to `127.0.0.1`, never publish |
| `WORKER_COUNT` | `2` | Worker count |
| `BUNGEE_PLUGIN_SECRETS_KEY` | — | Required for standalone Docker; encryption key for plugin credentials |
| `BUNGEE_CONFIG_DB_PATH` | `/usr/app/data/bungee.db` | Absolute configuration DB path |
| `BUNGEE_ACCESS_DB_PATH` | `/usr/app/logs/access.db` | Absolute telemetry DB path |

Standalone Docker deployments must inject `BUNGEE_PLUGIN_SECRETS_KEY` and keep it stable. This key is separate from authentication, which is stored in `logical_configuration.auth`. Never publish the private master control listener.

## Operations

```bash
docker compose logs -f bungee
docker compose restart bungee
docker compose down
```

Configuration is managed through the Dashboard or versioned API snapshots. See [Configuration](docs/configuration.md) and [Deployment](docs/deployment.md).
