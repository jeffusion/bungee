# CLI Reference

This document is aligned with `packages/cli/src/index.ts` and `packages/cli/src/config/paths.ts`.

The npm package is `@jeffusion/bungee`; its executable is named `bungee`. Use `npx @jeffusion/bungee@latest <command>` without a global installation, or install it with `npm install -g @jeffusion/bungee@latest` to use the `bungee` commands below directly.

---

## 1) Command Matrix

| Command | Description |
|---|---|
| `bungee init` | Initialize SQLite storage and persist the plugin secrets encryption key |
| `bungee recover` | Recover stopped-instance identity or plugin state from bounded JSON input |
| `bungee start` | Start proxy server as daemon |
| `bungee stop` | Stop daemon |
| `bungee restart` | Restart daemon |
| `bungee status` | Show daemon status and health |
| `bungee logs` | Show daemon logs |
| `bungee ui` | Open dashboard in browser |
| `bungee export` | Export a sealed configuration snapshot |
| `bungee import` | Import a sealed snapshot and wait for publication |
| `bungee upgrade` | Upgrade binary to latest version |

---

## 2) Options by Command

### `bungee init`

Creates the SQLite configuration database and its sibling `plugin-state.db` idempotently, and initializes `plugin-secrets.key` beside the configuration database. It does not create an administrator or proxy API Keys. The core launch parameter is `--initialize-config <absolute-db-path>`. The instance must be stopped; initialization holds master and ingress locks.

- `--plugin-secrets-key <base64>`: supply the encryption key during initialization. It takes precedence over `BUNGEE_PLUGIN_SECRETS_KEY`; when neither is supplied, `init` generates 32 random bytes encoded as canonical Base64.
- The final key is always persisted. The file is owner-only (`0600` on Linux/macOS, restricted ACL on Windows); command output shows its path, never the key.
- Repeated `init` reuses the existing key. A different supplied key, a malformed key or an unsafe key file is rejected without replacement. If either the configuration database or `plugin-state.db` exists without a key file, `init` requires the original key; no replacement key is generated for either database.
- `start`, `restart` and `recover` read only the persisted key. Their environment cannot override it, and they never generate a missing key. Back up this file with the databases and restore the matching key before use.

### `bungee recover`

Read JSON through stdin or `--file <path>` (owner-only `0600` regular file). Requires the same configuration database and startup environment, with the whole instance stopped. See [recovery examples](../guides/offline-recovery.md). Secrets are not command arguments.

### `bungee start`

- `-p, --port <port>`: set the public proxy/Ingress port
- `-w, --workers <count>`: worker process count (default `2`)
- `-d, --detach`: run as daemon (default enabled)
- `--auto-upgrade`: auto-upgrade binary when version mismatch is detected

### `bungee restart`

- `-p, --port <port>`: set the public proxy/Ingress port
- `-w, --workers <count>`
- `--auto-upgrade`

### `bungee logs`

- `-f, --follow`: stream logs
- `-n, --lines <number>`: number of lines (default `50`)

### `bungee ui`

- `-p, --port <port>`: management port (default `8089`)
- `-H, --host <host>`: management host (default `localhost`)

### `bungee upgrade`

- `-f, --force`: force re-download even when current version is latest

### `bungee export`

- `-o, --file <path>`: output file (required)
- `-p, --port <port>`: management port (default `8089`)
- `-H, --host <host>`: management host (default `localhost`)
- `-t, --token <token>`: optional Bearer administrator session

### `bungee import`

- `-f, --file <path>`: snapshot file (required)
- `-p, --port <port>`: management port (default `8089`)
- `-H, --host <host>`: management host (default `localhost`)
- `-t, --token <token>`: optional Bearer administrator session

---

## 3) Data Directory Layout

CLI-managed default directory:

```text
~/.bungee/
├── bungee.pid
├── bungee.log
├── bungee.error.log
├── bin/
│   └── <version>/
│       ├── bungee-<platform>
│       └── plugins/
├── data/
│   ├── bungee.db
│   ├── plugin-state.db
│   └── plugin-secrets.key
└── logs/access.db
```

`bungee.db` stores configuration, `plugin-state.db` stores plugin state and secrets, and `access.db` stores telemetry. Runtime lock files are separate from these databases; do not delete lock files while Bungee is running.

---

## 4) Common Operational Workflows

### Bootstrap and start

```bash
npx @jeffusion/bungee@latest init
npx @jeffusion/bungee@latest start
npx @jeffusion/bungee@latest status
```

### Tail logs

```bash
npx @jeffusion/bungee@latest logs --follow
```

### Restart with explicit worker count

```bash
npx @jeffusion/bungee@latest restart --workers 4
```

### Open dashboard

```bash
npx @jeffusion/bungee@latest ui --host localhost --port 8089
```

---

## 5) Runtime Notes

Management is anonymous by default. When the optional 管理认证 (`local-accounts`) plugin is enabled, obtain a short-lived Bearer session using `POST /api/auth/login` with `{username,password,transport:"bearer"}`, then pass it through `--token` for export/import. The CLI does not save sessions. Disabling management authentication returns to anonymous management.

- `start` and `restart` use stable absolute SQLite paths under `~/.bungee/data`.
- Release downloads are `.tar.gz` archives containing the executable and strict built-in plugin artifacts.
- Daemon metadata and logs are managed under `~/.bungee/`.
- `status` reports daemon PID state. Use management `/health/management` for management readiness and `/health/data` for confirmed data readiness; data-plane `/health` is an ordinary proxy path subject to its route protection. The CLI `--port` option does not change the management listener.
