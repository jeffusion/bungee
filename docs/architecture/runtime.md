# Architecture

## Process Model

Bungee runs one master, one stable ingress process, and one or more workers.

- The master coordinates configuration storage, plugin control, publication, admission control, worker supervision, and shutdown. Separate storage Workers execute configuration, plugin-state and observation database operations.
- The ingress process owns the stable public listener and forwards requests only to the active admission set.
- Workers are inert until they receive a validated start command. Each worker validates the configuration hash, plugin catalog hash, revision, attempt number, and activation set before listening on a private loopback port.
- Detached workers and ingress use authenticated loopback HTTP. Signed leases and fencing allow a higher-epoch master to adopt the existing data plane without interrupting active traffic.

## Request Flow

```text
client -> stable public listener -> admitted worker -> route -> service -> upstream
```

The listener selects one admitted worker per request and streams the request and response without retrying. Internal transport uses a master-generation secret and restores the original URL and host before routing.

HTTP bodies are opaque streams by default. Worker rules, explicit plugin requirements, and effective admission policies request content views only when needed; read-only views preserve original wire bytes. All HTTP response bodies share completion, cancellation, and drain handling. See [HTTP body architecture](./http-body.md) for directional rules, decoding and replay limits, SSE envelopes, and bounded observers.

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

Shutdown stops background supervision, drains or kills owned workers with exact exit evidence, shuts down the ingress process after admission is safe, waits for storage Worker database-close acknowledgements, and only then releases instance locks.

## Control and data readiness

The master starts control plugins in local dependency order before data-plane publication. The selected management provider and its control dependencies can remain ready when worker publication fails or recovery stops. Unrelated plugin failure affects its consumers rather than disabling every control capability.

`/health` distinguishes process liveness, management readiness, data readiness and degradation. `/health/management` and `/health/data` check the corresponding capability. A live master without confirmed serving workers is not a ready data plane. See [storage and lifecycle](storage.md) for state ownership and failure handling.
