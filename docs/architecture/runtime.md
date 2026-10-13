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

Before admission changes, the configuration database freezes the complete retired membership and replacement serving authority for the exact attempt. Drain-command deadlines are frozen after ingress handoff and before the first command; recovery reuses those deadlines. A recovering master validates and adopts active admission before starting another attempt. The subset it successfully adopts cannot substitute for the complete retirement set.

On Linux and macOS, process-lifetime locks bind authenticated descriptors to an inherited file identity. Confirmed exit is persisted before ingress releases retired admission. Cleanup success, failure or unknown is recorded separately from physical exit. Missing or uncertain evidence stops cleanup while committed active workers can continue serving. Explicit cleanup retry uses the same membership, attempt and deadlines; historical terminal failures remain audit facts.

Replacement failure keeps the previous admitted set. If an admitted worker later exits, supervision republishes using validated survivors and spawns only missing slots.

## Configuration Truth

`data/bungee.db` is the only configuration truth. Plugin global activation lives in revisioned `plugin_activations`; binding enabled is a separate revisioned field. The telemetry database never controls runtime activation.

## Shutdown

Shutdown stops background supervision, drains or kills owned workers with exact exit evidence, shuts down the ingress process after admission is safe, waits for storage Worker database-close acknowledgements, and only then releases instance locks.

## Control and data readiness

The master starts control plugins in local dependency order before data-plane publication. The selected management provider and its control dependencies can remain ready when worker publication fails or recovery stops. Unrelated plugin failure affects its consumers rather than disabling every control capability.

`/health` distinguishes process liveness, management readiness, data readiness and degradation. `/health/management` and `/health/data` check the corresponding capability. A live master without confirmed serving workers is not a ready data plane. See [storage and lifecycle](storage.md) for state ownership and failure handling.

## Component failure recovery

A failed storage component freezes publication and mutation admission. In the Linux Docker deployment, verified tini supervision permits a whole-instance restart only after a durable restart ticket is recorded. The budget allows two tickets with 5-second and 30-second startup backoff. A native kernel monotonic timer bounds master exit even if its event loop stalls; sending a termination request is never an exit proof.

Unknown or exhausted budget, or unavailable whole-instance supervision, leaves a live master in stopped state instead of an exit loop. Manual shutdown releases its keepalive resources. Tickets reset only after the same physical master reports continuously healthy management and data capabilities for 30 minutes, with no sample gap exceeding 60 seconds. Ordinary restarts and wall-clock changes do not reset the budget.
