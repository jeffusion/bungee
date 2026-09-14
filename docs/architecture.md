# Architecture

## Process Model

Bungee runs one master, one stable ingress process, and one or more workers.

- The master owns both SQLite paths, configuration commits, publication, admission control, worker supervision, and shutdown.
- The ingress process owns the stable public listener and forwards requests only to the active admission set.
- Workers are inert until they receive a validated start command. Each worker validates the configuration hash, plugin catalog hash, revision, attempt number, and activation set before listening on a private loopback port.
- Detached workers and ingress use authenticated loopback HTTP. Signed leases and fencing allow a higher-epoch master to adopt the existing data plane without interrupting active traffic.

## Request Flow

```text
client -> stable public listener -> admitted worker -> route -> service -> upstream
```

The listener selects one admitted worker per request and streams the request and response without retrying. Internal transport uses a master-generation secret and restores the original URL and host before routing.

## Revision Publication

1. The control API commits a complete aggregate to `data/bungee.db` using `expected_revision`.
2. The master starts replacement workers with the exact revision, content hash, plugin catalog hash, and plugin activation names.
3. A worker compiles the snapshot and ACKs its private port and validated hashes.
4. The master atomically switches admission only after all replacement ACKs match.
5. Old workers drain; exact exit evidence finalizes the operation.

Replacement failure keeps the previous admitted set. If an admitted worker later exits, supervision republishes using validated survivors and spawns only missing slots.

## Configuration Truth

`data/bungee.db` is the only configuration truth. Plugin global activation lives in revisioned `plugin_activations`; binding enabled is a separate revisioned field. The telemetry database never controls runtime activation.

## Shutdown

Shutdown stops background supervision, drains or kills owned workers with exact exit evidence, shuts down the ingress process after admission is safe, closes both databases, and only then releases instance locks.
