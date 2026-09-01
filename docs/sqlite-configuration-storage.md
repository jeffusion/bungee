# SQLite Configuration Storage

This document records the evidence and delivered architecture for Bungee's
SQLite configuration store.

## Current State

Bungee stores the canonical configuration aggregate in `data/bungee.db`.
Master owns commits and publication; workers receive strict immutable snapshots
and ACK the exact revision, configuration hash, and plugin catalog hash before
admission. Dashboard and CLI import/export use sealed versioned snapshots through
the master control API.

## Comparable Systems

| Product | Persistent truth | Runtime projection | Relevant lesson |
|---|---|---|---|
| Kong DB-backed | Database entities | Node cache | Database backup and declarative export are separate recovery layers. |
| Kong DB-less | Complete YAML/JSON document | Per-node cache | Loading one node does not propagate configuration to other nodes. |
| Traefik | External providers | Configuration channel | A provider needs an explicit, reliable publication path. |
| Caddy | Admin API runtime JSON | Atomically loaded runtime | File and API must not remain competing writable truths. |
| Nginx Proxy Manager | Normalized SQL entities | Generated Nginx files | Core entities are relational; generated runtime files are disposable. |
| Apache APISIX | etcd or standalone file | Worker memory | Committed generations can update workers without process restarts. |

Primary evidence:

- Kong deployment and DB-less modes: <https://developer.konghq.com/gateway/deployment-topologies/> and <https://developer.konghq.com/gateway/db-less-mode/>
- Kong declarative implementation at commit `fa9c3b6`: <https://github.com/Kong/kong/blob/fa9c3b695af72668f135cb17bbb84a8b4dc511d2/kong/db/declarative/init.lua#L242-L262>
- Traefik provider channel at commit `b51bd7`: <https://github.com/traefik/traefik/blob/b51bd71e1f794f8cca5d2da0b4d0b151dfa05793/pkg/provider/provider.go#L8-L14>
- Caddy atomic load at commit `d6f7f18`: <https://github.com/caddyserver/caddy/blob/d6f7f18b041de650b9a35ffc5d791fdcc7cb5049/caddyconfig/load.go#L68-L130>
- Nginx Proxy Manager SQLite selection and migration at commit `a62c2a6`: <https://github.com/NginxProxyManager/nginx-proxy-manager/blob/a62c2a6dc3ab51e6fedc34d3ea3506bc9373953f/backend/lib/config.js#L89-L104> and <https://github.com/NginxProxyManager/nginx-proxy-manager/blob/a62c2a6dc3ab51e6fedc34d3ea3506bc9373953f/backend/migrate.js#L1-L11>
- APISIX etcd watcher at commit `39b9e4`: <https://github.com/apache/apisix/blob/39b9e43019222ee3f78bc185b6fa81ca5d327a97/apisix/core/config_etcd.lua#L128-L150>

## SQLite Constraints

SQLite WAL permits concurrent readers and one writer, but does not provide a
cluster publication protocol. Configuration databases must remain on a local
filesystem. Every connection must enable foreign keys and a busy timeout.
Configuration writes and imports use short `BEGIN IMMEDIATE` transactions.

`integrity_check` does not check foreign keys, so physical artifacts require
both `integrity_check` and `foreign_key_check`. A live database file must never
be replaced while workers hold open connections; logical import writes into the
live schema in one transaction instead.

Primary SQLite references:

- WAL and filesystem limits: <https://sqlite.org/wal.html>
- Isolation and snapshots: <https://sqlite.org/isolation.html>
- Transactions and `BEGIN IMMEDIATE`: <https://sqlite.org/lang_transaction.html>
- Foreign keys: <https://sqlite.org/foreignkeys.html>
- Integrity pragmas: <https://sqlite.org/pragma.html#pragma_integrity_check>
- Online backup: <https://sqlite.org/backup.html>

## Architecture Decision

### Ownership

- `data/bungee.db` is the only persistent application-configuration truth.
- `logs/access.db` remains operational storage for logs, statistics, plugin
  installation metadata, and plugin storage. Configuration uses a separate database to
  avoid coupling control-plane commits to high-volume writes, cleanup, `VACUUM`,
  or plugin-accessible connections.
- Master is the only configuration writer and publisher.
- Worker processes are immutable projections of a committed revision. The first
  implementation replaces complete worker processes because the current server,
  routing state, health state, and plugin runtime cannot switch generations atomically.
- Export files are portable representations, never writable runtime sources.

### Schema

Normalize identity-bearing core entities and relations:

- `configuration_state`: active revision and schema metadata.
- `configuration_revisions`: commit metadata and content hash.
- `configuration_operations`: durable idempotency, mutation result, and
  publication state.
- `configuration_operation_workers`: per-worker-slot publication state.
- `settings`: singleton global settings for the active state.
- `services`: stable service ID, unique name, and typed service policy payloads.
- `routes`: stable route ID, unique path, optional service foreign key, and typed
  route policy payloads.
- `upstreams`: stable upstream ID owned by exactly one service or route.
- `plugin_bindings`: ordered plugin bindings by scope.
- `plugin_activations`: the only persistent truth for installation-level plugin
  activation. Absence means inactive.

`PluginBindingV2.enabled` remains part of each scoped logical binding and only
disables that binding. It does not activate or deactivate the installed plugin.
Conversely, an installation activation is valid without any binding. These two
states are independent and must not be inferred from one another.

Complex policy objects and plugin options remain validated JSON columns where
further decomposition would not improve identity, references, or queries. The
complete `AppConfig` is not stored as an opaque source-of-truth blob.

Normalized configuration tables contain only the active materialization and do
not carry revision columns. `configuration_revisions` is append-only commit
metadata, not historical configuration storage. Replacing all active rows,
inserting the revision, recording the committed operation, and advancing
`active_revision` occur in one transaction.

`configuration_operations` contains `mutation_id` as its primary key,
`request_hash`, `expected_revision`, non-null `committed_revision`, state
(`committed`, `publishing`, `draining`, `converged`, or `degraded`), nullable HTTP
result status, nullable error code/detail, and creation/update timestamps. The
exact durable combinations are nonterminal states with no result, `converged/200`
with no error, and `degraded/202` with either
`replacement_convergence_failed` or `old_worker_drain_failed` plus a bounded,
nonblank detail. Each operation
also stores the frozen target-row count so deletion of a target is detectable.
`configuration_operation_workers` contains mutation ID, worker slot, target
revision, current `attempt_no`, the last begin command's previous attempt and
reason, current `drain_recovery_generation`, state (`pending`, `converged`, or `failed`), nullable applied revision,
nullable bounded last error, update timestamp, and a composite primary key of
mutation ID and worker slot. Attempt zero is only the frozen pre-publication row;
terminal worker states require a positive attempt. The durable last-begin fields
make `(previous_attempt_no, reason)` replay-idempotent across restart while every
new attempt fences late results. Its composite foreign key binds mutation ID and
target revision to the parent operation's committed revision.

The parent operation stores `drain_recovery_generation` and
`last_drain_recovery_previous_generation`; every target stores its current drain
recovery generation. Generation zero is the normal same-master publication path.
`beginDrainingRecovery(mutation_id, previous_generation, updated_at)` is an
operation-level compare-and-swap: when the durable generation equals
`previous_generation`, one transaction increments the operation generation and
fences every frozen target with a new `master_recovery` attempt in that generation.
The durable previous-generation field proves exact command replay across reopen,
even if a target has since retried. Repeating the uncertain command with its old
previous generation returns the existing transition without changing attempts or
timestamps. A later master reads the current generation and passes that value,
which intentionally creates the next generation.

### Commit And Publication

1. The stable public listener intercepts managed control-plane paths before
   worker selection. Master authenticates the request against the committed snapshot.
2. Master parses the bounded request body and rechecks authentication immediately
   before committing mutations whose body processing can outlive an auth change.
3. A single pure `parseNormalizeCompileAggregate()` implementation validates the
   `ConfigurationAggregateV2`, delegates `logical_configuration` to
   `parseNormalizeCompile()`, and validates and sorts `plugin_activations` without
   process exit, database writes, plugin imports, or `onInit`.
4. Master starts `BEGIN IMMEDIATE`, verifies the expected revision, writes
   normalized rows, increments the revision, records the mutation ID and content
   hash, freezes the sorted target worker slots as pending rows, and commits the
    operation as `committed` with no result status. Duplicate mutation IDs return
    their current durable operation.
5. Master starts replacement workers with the immutable snapshot and revision.
   A replacement reports `ready(revision)` only after all runtime state, plugins,
   and listeners initialize successfully.
6. After every exact target converges, master persists `draining` before issuing
   any drain command. Old workers stop accepting new connections with `server.stop(false)` and
   drain in-flight requests. The worker serving the mutation response is replaced
   last.
7. A successful write returns HTTP `202` after the durable commit is queued.
   Clients poll the operation until `converged` or `degraded`. HTTP `409` means a
   stale revision or active operation, `422` means invalid input, and
   `503 outcome_unknown` directs the client to query by mutation ID.

`request_hash` is repository-owned and is the RFC 8785 SHA-256 hash of the exact
projection `{ kind, expected_revision, aggregate, target_worker_slots }` after
normalization and ascending target-slot sorting. It excludes `mutation_id`,
`created_at`, process IDs, and readiness. Reusing a mutation ID with the same hash returns only
the durable original operation, because revisions do not store historical snapshots;
reusing it with another hash returns `409 idempotency_key_reused`. Target workers
are all configured worker slots at commit time, not only live process IDs.
Authenticated `GET /api/config/operations/{mutation_id}` returns the durable
operation or `404`.

Only the operation belonging to `active_revision` may enter or advance
publication. A `committed`, `publishing`, or `draining` active operation blocks the next
revision with `409 operation_in_progress`; the attempted mutation ID is not
reserved. Duplicate lookup remains first, so a retry returns its current durable
operation even after a later revision becomes active. A later revision may commit
only after the active operation reaches `converged` or `degraded`. Historical
operations must be terminal and remain queryable, but cannot publish again.

The repository accepts the commit envelope as untrusted data and creates one
side-effect-free plain JSON snapshot before validation. Accessors, symbol keys,
proxies, exotic prototypes, sparse arrays, cycles, and non-JSON values are
rejected without invoking getters. Aggregate compilation, target sorting, hashes,
environment resolution, SQL writes, and returned values consume only that
prepared snapshot. Resolver callbacks therefore cannot alter the pending commit
by mutating caller-owned objects.

A failed replacement attempt can be retried by incrementing its durable attempt;
only the current pending attempt may record a result. Once no target is pending
and at least one failed, publication may terminate as
`replacement_convergence_failed`. When all exact targets converge, publication
must first enter `draining`. An empty frozen target set satisfies this boundary
without creating a synthetic worker attempt. It reaches `converged` only after the caller proves
all old workers exited; force termination followed by the same proof records
`old_worker_drain_failed`. Without that proof it remains nonterminal. Exact begin,
worker-result, drain-boundary, and terminal commands are idempotent across reopen;
conflicting replays fail closed. Attempt and drain-recovery generation metadata
are execution state and therefore do not participate in `request_hash`.

After a master crash while `draining`, the new master must read the current drain
recovery generation and call `beginDrainingRecovery()` with it before using any
prior target proof. Every prior ACK is then fenced and every target must report
its new current attempt in the new generation; failed recovery attempts may retry
without changing generation. A second master crash repeats the CAS from the
current generation and fences all targets again. Because generation greater than
zero proves that prior drain evidence was lost, it permanently forbids
`converged/200` for that operation. Once all current-generation target attempts
converge and old-process exit is proved, the only truthful terminal result is
`old_worker_drain_failed/202`. Without fresh target convergence or explicit exit
proof, the operation remains `draining`.

The database commit remains authoritative if a replacement worker fails after
commit. Master reports failed convergence explicitly and continues retry/recovery
from the committed revision; it never rewrites the database back to an older
revision. On master restart, only the latest committed revision is reconstructed.

### Authentication

Global authentication is part of the stored logical configuration. When it is
disabled, management access is anonymous. When it is enabled, management
requests require a configured token. Configuration changes and imports may rotate
the configured tokens through the normal management API.

### Import And Export

Logical export is exactly this versioned JSON envelope, with no missing or extra
properties:

```text
{
  "format": "bungee-config-snapshot",
  "format_version": 1,
  "schema_version": 2,
  "exported_at": <finite nonnegative safe integer>,
  "source_revision": <positive safe integer>,
  "content_hash": "sha256:<64 lowercase hexadecimal digits>",
  "aggregate": <normalized ConfigurationAggregateV2>,
  "envelope_hash": "sha256:<64 lowercase hexadecimal digits>"
}
```

The normalized `ConfigurationAggregateV2` is the revision, content-hash,
snapshot, and export boundary. Hashes use SHA-256 over RFC 8785 canonical JSON
UTF-8 bytes. Before hashing, aggregate parsing, or CAS work, import validates the
exact property set and every metadata field's literal, type, range, and canonical
digest form. The parser also rejects duplicate properties, non-finite numbers,
and invalid Unicode. Stable IDs are included so an export/import round trip
preserves identity.

Hashes are defined exactly as:

```text
content_hash = "sha256:" + lowercase_hex(
  SHA256(JCS_UTF8(normalized_configuration_aggregate))
)

envelope_hash = "sha256:" + lowercase_hex(
  SHA256(JCS_UTF8(envelope_without_envelope_hash))
)
```

`normalized_configuration_aggregate` contains the normalized
`logical_configuration` plus `plugin_activations`, uniquely keyed and sorted by
`plugin_name` using deterministic JavaScript lexical ordering. The logical
configuration has defaults filled and explicit IDs, positions, and scoped
binding `enabled` values retained. The aggregate excludes source revision,
 export time, environment-variable resolution results, plugin
installation paths, runtime health, and endpoint runtime expansion. Revision
metadata and committed snapshots use exactly the same aggregate projection and
hash.

`source_revision` is provenance only; import creates local `active_revision + 1`.
Import parses the envelope, verifies its hash and schema, validates references
and plugin payloads, compiles the candidate runtime, then follows the same CAS
commit and publication protocol as an ordinary update. Any failure before commit
leaves the active revision unchanged. Import never replaces the live database
file and never writes `config.json`.

Physical SQLite backup is a separate operational concern and is not presented as
configuration import/export. Plugin storage, request logs, certificates, and
external files are also outside the logical configuration export unless named
explicitly by a future backup feature.

### SQLite Runtime Contract

Only master opens `bungee.db`. It uses `journal_mode=DELETE`,
`synchronous=FULL`, `foreign_keys=ON`, and `busy_timeout=5000`; configuration
migration failure is fatal. Workers never open this database. The operational
`access.db` remains multi-process WAL and therefore requires a startup SQLite
version check before opening the database or spawning workers. Startup accepts
only SQLite `>=3.51.3`, SQLite `3.50.7+`, or SQLite `3.44.6+`. It rejects
`3.51.0` through `3.51.2` and every `3.45.x` through `3.49.x` release. The Bun
runtime baseline is at least 1.3.14 but is not sufficient without this check.

Connection initialization verifies the value returned by setting
`journal_mode`, then reads back and requires `foreign_keys=1` and
`busy_timeout=5000`. Any mismatch fails startup.

Every initialized open derives an expected schema descriptor by applying the
authoritative v1 migration to an isolated SQLite database, then compares every
user-defined table, explicit index, trigger, and view against the target using
exact DDL text plus table, column, foreign-key, and index PRAGMAs. SQLite internal
autoindexes are represented through their owning table's index descriptor. Quoted
SQL text retains its exact case and literal semantics. Open, snapshot reads, and
every commit/publication mutation repeat this structure check before any write.
Startup also audits contiguous revisions,
the fixed bootstrap revision identity, one operation per revision after revision
1, operation/revision metadata coherence, exact operation state combinations,
worker target/state coherence, bootstrap/revision consistency, request digests,
and the active normalized aggregate hash. This is structural verification only;
it does not store or reconstruct historical aggregates.

Global scalar domains are strict v2 values. `log_level` is exactly one of
`trace`, `debug`, `info`, `warn`, `error`, or `fatal`. `body_parser_limit` is the
canonical lowercase form `^[1-9][0-9]*(b|kb|mb|gb)$`; its numeric component must
be a JavaScript safe integer. Values are not trimmed or case-normalized, and
leading zeroes, decimals, whitespace, uppercase suffixes, and zero are rejected.
The previous runtime merely copied this string to `BODY_PARSER_LIMIT`; it did not
provide a parser whose aliases are preserved by this unshipped v2 contract.

### Stable Identity And Ordering

Service, route, upstream, and plugin binding IDs are required immutable lowercase
UUIDs. Route-to-service and all plugin scopes reference IDs, not names, paths, or
array indexes. Every ordered collection persists an explicit `position`. Public
upstream control addresses `/api/upstreams/{upstream_id}/enabled`. The new API
and exchange format reject ID-less documents; there is no adapter for the old
shape.

Installation-level plugin activation is stored only in
`bungee.db.plugin_activations`. The operational database may retain re-scannable
installation metadata, but it is not an activation authority. Scoped plugin
bindings reference plugin names and validated options, never installation paths;
their `enabled` field controls only the individual binding.

## Rejected Designs

- A single `config_json TEXT` row: preserves whole-document rewrites and lacks
  relational identity and integrity.
- Reusing `logs/access.db`: exposes configuration commits to unrelated writer,
  cleanup, and plugin connection behavior.
- Worker-owned writes: allows multiple control-plane writers and cannot make the
  API response represent cluster convergence.
- Polling or file watching as the primary publication mechanism: commit and
  publication become separate, lossy observations.
- Live database-file replacement during import: open connections and WAL sidecar
  files can continue referring to the old database.
- Retaining `config.json` fallback: recreates the competing-source problem that
  the refactor is intended to remove.
- In-place worker snapshot switching: current request closures and runtime/plugin
  state cannot change as one generation.
- Persisting installation-level plugin activation in the operational database:
  creates a second configuration truth and prevents one-database atomic commits.
