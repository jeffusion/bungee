# Architecture

## Process Model

Bungee runs one master and one or more workers.

- The master owns both SQLite paths, the stable public listener, configuration commits, publication, admission, worker supervision, and shutdown.
- Workers are inert until they receive a validated start command. Each worker validates the configuration hash, plugin catalog hash, revision, attempt number, bootstrap state, and activation set before listening on a private loopback port.
- Workers stop serving and exit when IPC disconnects or the master heartbeat expires.

## Request Flow

```text
client -> stable public listener -> admitted worker -> route -> service -> upstream
```

The listener selects one admitted worker per request and streams the request and response without retrying. Internal transport uses a master-generation secret and restores the original URL and host before routing.

## Revision Publication

1. The control API commits a complete aggregate to `data/bungee.db` using `expected_revision`.
2. The master starts replacement workers with the exact revision, content hash, plugin catalog hash, bootstrap mode, and plugin activation names.
3. A worker compiles the snapshot and ACKs its private port and validated hashes.
4. The master atomically switches admission only after all replacement ACKs match.
5. Old workers drain; exact exit evidence finalizes the operation.

Replacement failure keeps the previous admitted set. If an admitted worker later exits, supervision republishes using validated survivors and spawns only missing slots.

## Configuration Truth

`data/bungee.db` is the only configuration truth. Plugin global activation lives in revisioned `plugin_activations`; binding enabled is a separate revisioned field. The telemetry database never controls runtime activation.

## Shutdown

Shutdown closes the public listener, clears admission, stops heartbeat, drains or kills owned workers with exact exit evidence, closes both databases, and only then releases instance locks.
