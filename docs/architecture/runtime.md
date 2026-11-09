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

1. The control API commits a complete aggregate to `data/bungee.db` using `expected_revision` and acknowledges durable storage without waiting for publication.
2. The single publication owner claims the latest saved target and freezes its snapshot identity independently of later saves.
3. The master starts replacement workers with the exact revision, content hash, plugin catalog hash, and plugin activation names. Each worker compiles the snapshot and ACKs its private port and validated hashes.
4. Before admission preparation, a newer saved target can cancel an obsolete candidate. Confirmed exit and required cleanup must precede creation of its replacement. Cancellation and permission to begin admission preparation are mutually exclusive.
5. Once admission preparation begins, the attempt follows its original switching and recovery protocol. The master switches admission only after all replacement ACKs match.
6. Old workers drain; exact exit evidence and retirement release complete the attempt. Only then can another candidate batch start.

Saving, applying and serving are separate facts. Unclaimed targets may be superseded without application; cancelled candidates retain their operation identity and audit record. Neither durable storage nor a superseded outcome proves that a revision served traffic. Late results cannot transfer authority between attempts.

Normal updates allow at most the serving batch plus one candidate or draining batch: `2N` workers for a configured count of `N`, excluding the master and ingress. There is no third prewarming batch during drain. Unconfirmed exits continue to occupy capacity, including after master recovery.

Before admission changes, the configuration database freezes the complete retired membership and replacement serving authority for the exact attempt. Drain-command deadlines are frozen after ingress handoff and before the first command; recovery reuses those deadlines. A recovering master validates and adopts active admission before starting another attempt. The subset it successfully adopts cannot substitute for the complete retirement set.

On Linux and macOS, process-lifetime locks bind authenticated descriptors to an inherited file identity. Confirmed exit is persisted before ingress releases retired admission. Cleanup success, failure or unknown is recorded separately from physical exit. Missing or uncertain evidence stops cleanup while committed active workers can continue serving. Explicit cleanup retry uses the same membership, attempt and deadlines; historical terminal failures remain audit facts.

For worker creation, a previously admitted worker with a durable exit record no longer occupies capacity once the master confirms it is absent from the fresh signed ingress registry, authenticates its stopped descriptor with failed cleanup for the same launch, and verifies its original lifetime lock is free. The master records that capacity decision before creating workers and reuses it after restarts, including after a host reboot. The master still requires a fresh signed ingress registry and counts every protected member. Failed cleanup remains recorded and does not satisfy publication attempt or retirement cleanup requirements.

Startup performs debt-only settlement after authenticated orphan cleanup and before the first publication claim, then re-reads the signed ingress registry and durable inventory. Publication claims and serialized creation permits continue to reject unproven launch debt.

For previously admitted startup launches without a publication allocation, recovery can establish missing exit and capacity facts directly from the original lifetime lock after signed cleanup proof is unavailable. The launch must be absent from the signed active, prepared and retired ingress sets. Recovery verifies the same host boot, file identity and free lock, retires the guard while holding it, then persists exit with unknown cleanup before reclaiming capacity. Missing, replaced, foreign-boot or held guards remain blocking. This proof preserves cleanup debt; it does not settle the launch or release publication cleanup requirements. An interruption between the two writes can resume from the durable exit fact and the retired original guard.

For a cancelled owner that has not begun admission preparation, the existing serial recovery scheduler rechecks late exit and cleanup evidence with capped backoff, including after master restart. These observations do not initialize workers or consume initialization-recovery attempts. Stopped safety-unknown barriers remain closed.

Failure before the admission switch keeps the previous admitted set. After a switch may have been sent, recovery must establish the actual serving identity rather than assume rollback. Missing exit or release evidence blocks another publication, not an otherwise authorized configuration save. If an admitted worker later exits, supervision republishes using validated survivors and spawns only missing slots.

## Configuration Truth

`data/bungee.db` is the only configuration truth. Plugin global activation lives in revisioned `plugin_activations`; binding enabled is a separate revisioned field. The telemetry database never controls runtime activation.

## Shutdown

Shutdown stops background supervision, drains or kills owned workers with exact exit evidence, shuts down the ingress process after admission is safe, waits for storage Worker database-close acknowledgements, and only then releases instance locks.

## Control and data readiness

The master starts control components in local dependency order before its first publication claim or worker fork. Their desired set follows the committed configuration together with unreleased publication, owned serving, ingress admission and state-lease references. Dependency closure retains providers until their consumers release the last reference. A temporarily stale ingress registry retains the last authenticated admission references.

Configuration commits advance control lifecycle independently of data-plane publication. Control reconciliation shares the management mutation queue with authentication preflight and settles an uncertain commit before stopping instances. A failed control component remains degraded, while durable save acknowledgements and unrelated control capabilities remain available. Data publication requires the control services actually consumed by its worker or ingress components and the control producers for declared ingress policies. The selected authentication provider continues to fail closed when unavailable.

A worker repair failure closes the data-plane recovery gate and stops further publication. Healthy configuration, plugin-state and observation components continue serving management and control APIs. Fatal configuration storage errors in the repair evidence or cause chain retain whole-instance failure handling.

Reference-release callbacks schedule reconciliation after returning, so a control invocation can finish before its own instance drains. Shutdown stops queued control reconciliation before disposing the host.

`/health` distinguishes process liveness, management readiness, data readiness and degradation. `/health/management` and `/health/data` check the corresponding capability. A live master without confirmed serving workers is not a ready data plane. See [storage and lifecycle](storage.md) for state ownership and failure handling.

## Component failure recovery

A failed storage component freezes publication and mutation admission. In the Linux Docker deployment, verified tini supervision permits a whole-instance restart only after a durable restart ticket is recorded. The budget allows two tickets with 5-second and 30-second startup backoff. A native kernel monotonic timer bounds master exit even if its event loop stalls; sending a termination request is never an exit proof.

Unknown or exhausted budget, or unavailable whole-instance supervision, leaves a live master in stopped state instead of an exit loop. Manual shutdown releases its keepalive resources. Tickets reset only after the same physical master reports continuously healthy management and data capabilities for 30 minutes, with no sample gap exceeding 60 seconds. Ordinary restarts and wall-clock changes do not reset the budget.

## Binary updates

The master checks GitHub release metadata every six hours and exposes update information beside the dashboard version. Background checks do not download release archives, install files or restart processes. Installation requires explicit confirmation in the dashboard or `bungee upgrade`; an incomplete release asset set is not installable. Windows and source deployments provide reminders only for online updates.

On supported Linux/macOS binary deployments, an update installs the executable and its adjacent plugins, stops the current instance and uses `execve` to replace the master in the same PID. The operation interrupts traffic. Dashboard downloads stop at `awaiting_confirmation` after verification while the current service continues running. `POST /api/system/updates/confirm` accepts the same operation ID, source version and target version under the existing write permission and same-origin checks, then authorizes installation and restart. Cancelling the second confirmation or closing the page leaves the operation waiting. The confirming page starts a fixed 10-second countdown and reloads once it expires, independently of service readiness or operation status; the confirmation warns users to save drafts first. This delay does not prove that the upgraded service is ready. Refresh and reauthentication query status without resubmitting either action. Other pages refresh manually. The CLI performs the complete upgrade without this second page confirmation and waits for the result; with a stopped instance it only installs and selects the release. See the [CLI reference](../reference/cli.md#bungee-upgrade).

The official Docker image starts a release executable under tini. `BUNGEE_INSTALL_ROOT=/usr/app/runtime` contains `version.txt` with a stable `x.y.z` version and `bin/<version>/<binary-name>` with adjacent `plugins/`. The entrypoint validates the selection and executes that binary; a missing or damaged selection stops startup. It never downloads files or falls back to the image version. Same-PID replacement preserves tini as PID 1 and the master's parent; manual updates do not alter the component-failure recovery budget.

Docker updates change only the executable and bundled plugins in the current container's writable layer. They do not pull an image or access the host. Restarting that container retains the selection; recreating it restores the image's release while the data and log volumes remain. Before recreating, ensure the image release supports the persisted databases. Failed updates do not automatically roll back because a newer release may already have migrated those databases. See [Docker deployment](../guides/deployment.md#docker-compose).
