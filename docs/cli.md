# CLI Reference

This document is aligned with `packages/cli/src/index.ts` and `packages/cli/src/config/paths.ts`.

---

## 1) Command Matrix

| Command | Description |
|---|---|
| `bungee init [path]` | Initialize configuration file (default `~/.bungee/config.json`) |
| `bungee start [config]` | Start proxy server as daemon |
| `bungee stop` | Stop daemon |
| `bungee restart [config]` | Restart daemon |
| `bungee status` | Show daemon status and health |
| `bungee logs` | Show daemon logs |
| `bungee ui` | Open dashboard in browser |
| `bungee upgrade` | Upgrade binary to latest version |

---

## 2) Options by Command

### `bungee init [path]`

- `-f, --force`: overwrite existing config file

### `bungee start [config]`

- `-p, --port <port>`: override port
- `-w, --workers <count>`: worker process count (default `2`)
- `-d, --detach`: run as daemon (default enabled)
- `--auto-upgrade`: auto-upgrade binary when version mismatch is detected

### `bungee restart [config]`

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

---

## 3) Data Directory Layout

CLI-managed default directory:

```text
~/.bungee/
├── config.json
├── bungee.pid
├── bungee.log
├── bungee.error.log
└── data/
    └── stats/
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

- `start` and `restart` both support config path argument and runtime override flags.
- Daemon metadata and logs are managed under `~/.bungee/`.
- `status` reflects daemon-level state, not only process existence.
