# CLI Reference

This document is aligned with `packages/cli/src/index.ts` and `packages/cli/src/config/paths.ts`.

---

## 1) Command Matrix

| Command | Description |
|---|---|
| `bungee init` | Initialize `~/.bungee/data` for SQLite storage |
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

Creates the data directory idempotently. It does not create or copy JSON configuration.

### `bungee start`

- `-p, --port <port>`: override port
- `-w, --workers <count>`: worker process count (default `2`)
- `-d, --detach`: run as daemon (default enabled)
- `--auto-upgrade`: auto-upgrade binary when version mismatch is detected

### `bungee restart`

- `-p, --port <port>`
- `-w, --workers <count>`
- `--auto-upgrade`

### `bungee logs`

- `-f, --follow`: stream logs
- `-n, --lines <number>`: number of lines (default `50`)

### `bungee ui`

- `-p, --port <port>`: proxy port (default `8088`)
- `-H, --host <host>`: proxy host (default `localhost`)

### `bungee upgrade`

- `-f, --force`: force re-download even when current version is latest

### `bungee export`

- `-o, --file <path>`: output file
- `-t, --token <token>`: current control-plane token

### `bungee import`

- `-f, --file <path>`: snapshot file
- `-t, --token <token>`: current control-plane token
- `--next-token <token>`: explicit credential required when bootstrap or authentication changes

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
├── data/bungee.db
└── logs/access.db
```

---

## 4) Common Operational Workflows

### Bootstrap and start

```bash
npx bungee init
npx bungee start
npx bungee status
```

### Tail logs

```bash
npx bungee logs --follow
```

### Restart with explicit worker count

```bash
npx bungee restart --workers 4
```

### Open dashboard

```bash
npx bungee ui --host localhost --port 8088
```

---

## 5) Runtime Notes

- `start` and `restart` use stable absolute SQLite paths under `~/.bungee/data`.
- Release downloads are `.tar.gz` archives containing the executable and strict built-in plugin artifacts.
- Daemon metadata and logs are managed under `~/.bungee/`.
- `status` reports daemon PID state. Use `/health` for HTTP health.
