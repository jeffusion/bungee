/** Current schema baseline. Future changes use incremental migrations. */
export const CONFIG_SCHEMA_STATEMENTS = [
  `CREATE TABLE configuration_operation_workers (
    mutation_id TEXT NOT NULL,
    worker_slot INTEGER NOT NULL CHECK(worker_slot >= 0 AND worker_slot <= 9007199254740991),
    target_revision INTEGER NOT NULL CHECK(target_revision > 0 AND target_revision <= 9007199254740991),
    drain_recovery_generation INTEGER NOT NULL DEFAULT 0
      CHECK(drain_recovery_generation >= 0 AND drain_recovery_generation <= 9007199254740991),
    attempt_no INTEGER NOT NULL DEFAULT 0 CHECK(attempt_no >= 0 AND attempt_no <= 9007199254740991),
    last_begin_previous_attempt_no INTEGER CHECK(last_begin_previous_attempt_no IS NULL OR
      (last_begin_previous_attempt_no >= 0 AND last_begin_previous_attempt_no < 9007199254740991)),
    last_begin_reason TEXT CHECK(last_begin_reason IS NULL OR last_begin_reason IN ('initial','retry','master_recovery')),
    state TEXT NOT NULL CHECK(state IN ('pending','converged','failed')),
    applied_revision INTEGER CHECK(applied_revision IS NULL OR (applied_revision > 0 AND applied_revision <= 9007199254740991)),
    last_error TEXT,
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0 AND updated_at <= 9007199254740991),
    PRIMARY KEY(mutation_id,worker_slot),
    FOREIGN KEY(mutation_id,target_revision) REFERENCES configuration_operations(mutation_id,committed_revision) ON DELETE CASCADE,
    CHECK((attempt_no=0 AND last_begin_previous_attempt_no IS NULL AND last_begin_reason IS NULL) OR
          (attempt_no=1 AND last_begin_previous_attempt_no=0 AND last_begin_reason IN ('initial','master_recovery')) OR
          (attempt_no > 1 AND last_begin_previous_attempt_no=attempt_no-1 AND
            last_begin_reason IN ('retry','master_recovery'))),
    CHECK((state='pending' AND applied_revision IS NULL AND last_error IS NULL) OR
          (state='converged' AND attempt_no > 0 AND applied_revision=target_revision AND last_error IS NULL) OR
          (state='failed' AND attempt_no > 0 AND last_error IS NOT NULL AND
            length(last_error) <= 512 AND length(trim(last_error)) > 0))
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE configuration_operations (
    mutation_id TEXT PRIMARY KEY CHECK(length(mutation_id) BETWEEN 1 AND 128),
    request_hash TEXT NOT NULL CHECK(length(request_hash)=71 AND substr(request_hash,1,7)='sha256:' AND substr(request_hash,8) NOT GLOB '*[^0-9a-f]*'),
    expected_revision INTEGER NOT NULL CHECK(expected_revision > 0 AND expected_revision <= 9007199254740991),
    committed_revision INTEGER NOT NULL CHECK(committed_revision > 0 AND committed_revision <= 9007199254740991)
      REFERENCES configuration_revisions(revision),
    kind TEXT NOT NULL CHECK(kind IN ('config','admin_state')),
    target_worker_count INTEGER NOT NULL CHECK(target_worker_count >= 0 AND target_worker_count <= 9007199254740991),
    state TEXT NOT NULL CHECK(state IN ('committed','publishing','draining','converged','degraded')),
    result_status INTEGER,
    error_code TEXT,
    error_detail TEXT,
    drain_recovery_generation INTEGER NOT NULL DEFAULT 0
      CHECK(drain_recovery_generation >= 0 AND drain_recovery_generation <= 9007199254740991),
    last_drain_recovery_previous_generation INTEGER
      CHECK(last_drain_recovery_previous_generation IS NULL OR
        (last_drain_recovery_previous_generation >= 0 AND
         last_drain_recovery_previous_generation < 9007199254740991)),
    created_at INTEGER NOT NULL CHECK(created_at >= 0 AND created_at <= 9007199254740991),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at AND updated_at <= 9007199254740991),
    UNIQUE(mutation_id,committed_revision),
    CHECK((drain_recovery_generation=0 AND last_drain_recovery_previous_generation IS NULL) OR
          (drain_recovery_generation > 0 AND
            last_drain_recovery_previous_generation=drain_recovery_generation-1)),
    CHECK((state IN ('committed','publishing') AND drain_recovery_generation=0 AND
            result_status IS NULL AND error_code IS NULL AND error_detail IS NULL) OR
          (state='draining' AND result_status IS NULL AND error_code IS NULL AND error_detail IS NULL) OR
          (state='converged' AND drain_recovery_generation=0 AND
            result_status=200 AND error_code IS NULL AND error_detail IS NULL) OR
          (state='degraded' AND result_status=202 AND
            error_code IN ('replacement_convergence_failed','old_worker_drain_failed','control_readiness_failed') AND
            (error_code <> 'replacement_convergence_failed' OR drain_recovery_generation=0) AND
            error_detail IS NOT NULL AND length(error_detail) <= 512 AND length(trim(error_detail)) > 0))
  ) STRICT`,
  `CREATE TABLE configuration_recoveries (
      recovery_sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(recovery_sequence > 0),
      recovery_id TEXT NOT NULL UNIQUE CHECK(length(recovery_id)=36 AND substr(recovery_id,9,1)='-' AND substr(recovery_id,14,1)='-' AND substr(recovery_id,19,1)='-' AND substr(recovery_id,24,1)='-' AND replace(recovery_id,'-','') NOT GLOB '*[^0-9a-f]*'),
      source_mutation_id TEXT NOT NULL,
      target_revision INTEGER NOT NULL CHECK(target_revision > 0 AND target_revision <= 9007199254740991),
      trigger TEXT NOT NULL CHECK(trigger IN ('automatic','manual')),
      state TEXT NOT NULL CHECK(state IN ('scheduled','running','succeeded','stopped')),
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0 AND attempt_count <= 6),
      max_attempts INTEGER NOT NULL CHECK(max_attempts=6),
      next_retry_at INTEGER CHECK(next_retry_at IS NULL OR (next_retry_at >= 0 AND next_retry_at <= 9007199254740991)),
      final_reason_code TEXT CHECK(final_reason_code IS NULL OR final_reason_code IN
  ('target_serving','already_serving','deterministic_worker_rejection','deterministic_protocol_failure',
   'deterministic_control_failure','retry_exhausted','revision_superseded','safety_outcome_unknown','fatal_source_failure')), final_reason_detail TEXT,
      created_at INTEGER NOT NULL CHECK(created_at >= 0 AND created_at <= 9007199254740991),
      updated_at INTEGER NOT NULL CHECK(updated_at >= created_at AND updated_at <= 9007199254740991),
      FOREIGN KEY(source_mutation_id) REFERENCES configuration_operations(mutation_id),
      FOREIGN KEY(target_revision) REFERENCES configuration_revisions(revision),
      CHECK((state='scheduled' AND final_reason_code IS NULL AND final_reason_detail IS NULL) OR
        (state='running' AND next_retry_at IS NULL AND final_reason_code IS NULL AND final_reason_detail IS NULL) OR
        (state='succeeded' AND ((final_reason_code='already_serving' AND attempt_count=0) OR
          (final_reason_code='target_serving' AND attempt_count > 0)) AND next_retry_at IS NULL) OR
        (state='stopped' AND final_reason_code IN ('deterministic_worker_rejection','deterministic_protocol_failure',
          'deterministic_control_failure','revision_superseded') AND next_retry_at IS NULL) OR
        (state='stopped' AND final_reason_code='retry_exhausted' AND attempt_count=6 AND next_retry_at IS NULL) OR
        (state='stopped' AND final_reason_code='safety_outcome_unknown' AND attempt_count > 0 AND next_retry_at IS NULL) OR
        (state='stopped' AND final_reason_code='fatal_source_failure' AND attempt_count=0 AND next_retry_at IS NULL)),
      CHECK(state <> 'scheduled' OR next_retry_at IS NULL OR next_retry_at > updated_at),
      CHECK(state <> 'scheduled' OR attempt_count < 6), CHECK(state <> 'running' OR attempt_count > 0),
      CHECK(final_reason_detail IS NULL OR (length(final_reason_detail) <= 512 AND length(trim(final_reason_detail)) > 0))
    ) STRICT`,
  `CREATE TABLE configuration_revisions (
    revision INTEGER PRIMARY KEY CHECK(revision > 0 AND revision <= 9007199254740991),
    content_hash TEXT NOT NULL CHECK(length(content_hash)=71 AND substr(content_hash,1,7)='sha256:' AND substr(content_hash,8) NOT GLOB '*[^0-9a-f]*'),
    kind TEXT NOT NULL CHECK(kind IN ('config','admin_state')),
    created_at INTEGER NOT NULL CHECK(created_at >= 0 AND created_at <= 9007199254740991)
  ) STRICT`,
  `CREATE TABLE configuration_serving_snapshots (
      revision INTEGER NOT NULL CHECK(revision > 0 AND revision <= 9007199254740991),
      content_hash TEXT NOT NULL CHECK(length(content_hash)=71 AND substr(content_hash,1,7)='sha256:' AND substr(content_hash,8) NOT GLOB '*[^0-9a-f]*'),
      plugin_catalog_hash TEXT NOT NULL CHECK(length(plugin_catalog_hash)=71 AND substr(plugin_catalog_hash,1,7)='sha256:' AND substr(plugin_catalog_hash,8) NOT GLOB '*[^0-9a-f]*'),
      aggregate_json TEXT NOT NULL CHECK(json_valid(aggregate_json) AND json_type(aggregate_json)='object'
        AND length(CAST(aggregate_json AS BLOB)) BETWEEN 2 AND 1048576),
      PRIMARY KEY(revision,content_hash,plugin_catalog_hash),
      FOREIGN KEY(revision,content_hash)
        REFERENCES configuration_revisions(revision,content_hash)
    ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE configuration_state (
      id INTEGER PRIMARY KEY CHECK(id=1),
      schema_version INTEGER NOT NULL CHECK(schema_version=4),
      active_revision INTEGER NOT NULL CHECK(active_revision > 0 AND active_revision <= 9007199254740991)
        REFERENCES configuration_revisions(revision),
      created_at INTEGER NOT NULL CHECK(created_at >= 0 AND created_at <= 9007199254740991),
      updated_at INTEGER NOT NULL CHECK(updated_at >= created_at AND updated_at <= 9007199254740991)
    ) STRICT`,
  `CREATE TABLE plugin_activations (
    plugin_name TEXT PRIMARY KEY CHECK(length(plugin_name) > 0 AND plugin_name=lower(plugin_name)
      AND plugin_name NOT GLOB '*[^a-z0-9-]*' AND substr(plugin_name,1,1) GLOB '[a-z]'
      AND substr(plugin_name,-1,1)<>'-' AND plugin_name NOT LIKE '%--%')
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE plugin_bindings (
    id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'),
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','service','route','upstream')),
    scope_owner TEXT NOT NULL,
    service_id TEXT REFERENCES services(id) ON DELETE CASCADE,
    route_id TEXT REFERENCES routes(id) ON DELETE CASCADE,
    upstream_id TEXT REFERENCES upstreams(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0 AND position <= 9007199254740991),
    plugin_name TEXT NOT NULL CHECK(length(plugin_name) > 0 AND plugin_name=lower(plugin_name)
      AND plugin_name NOT GLOB '*[^a-z0-9-]*' AND substr(plugin_name,1,1) GLOB '[a-z]'
      AND substr(plugin_name,-1,1)<>'-' AND plugin_name NOT LIKE '%--%'),
    options_json TEXT CHECK(options_json IS NULL OR (json_valid(options_json) AND json_type(options_json)='object')),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    CHECK((scope_kind='global' AND scope_owner='' AND service_id IS NULL AND route_id IS NULL AND upstream_id IS NULL) OR
          (scope_kind='service' AND service_id IS NOT NULL AND scope_owner=service_id AND route_id IS NULL AND upstream_id IS NULL) OR
          (scope_kind='route' AND route_id IS NOT NULL AND scope_owner=route_id AND service_id IS NULL AND upstream_id IS NULL) OR
          (scope_kind='upstream' AND upstream_id IS NOT NULL AND scope_owner=upstream_id AND service_id IS NULL AND route_id IS NULL)),
    UNIQUE(scope_kind,scope_owner,position)
  ) STRICT`,
  `CREATE TABLE routes (
    id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'),
    position INTEGER NOT NULL UNIQUE CHECK(position >= 0 AND position <= 9007199254740991),
    path TEXT NOT NULL UNIQUE CHECK(substr(path,1,1)='/'),
    service_id TEXT REFERENCES services(id),
    policy_json TEXT NOT NULL CHECK(json_valid(policy_json) AND json_type(policy_json)='object')
  ) STRICT`,
  `CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY CHECK(version > 0 AND version <= 9007199254740991),
    name TEXT NOT NULL UNIQUE
  ) STRICT`,
  `CREATE TABLE services (
    id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'),
    position INTEGER NOT NULL UNIQUE CHECK(position >= 0 AND position <= 9007199254740991),
    name TEXT NOT NULL UNIQUE CHECK(length(name) > 0),
    policy_json TEXT NOT NULL CHECK(json_valid(policy_json) AND json_type(policy_json)='object')
  ) STRICT`,
  `CREATE TABLE settings (
    id INTEGER PRIMARY KEY CHECK(id=1),
    log_level TEXT CHECK(log_level IS NULL OR log_level IN ('trace','debug','info','warn','error','fatal')),
    body_parser_limit TEXT CHECK(body_parser_limit IS NULL OR CASE
      WHEN substr(body_parser_limit,-2) IN ('gb','mb','kb') THEN
        length(substr(body_parser_limit,1,length(body_parser_limit)-2)) > 0
        AND body_parser_limit=substr(body_parser_limit,1,length(body_parser_limit)-2)||substr(body_parser_limit,-2)
        AND substr(body_parser_limit,1,1) GLOB '[1-9]'
        AND substr(body_parser_limit,1,length(body_parser_limit)-2) NOT GLOB '*[^0-9]*'
        AND (length(substr(body_parser_limit,1,length(body_parser_limit)-2)) < 16 OR
          (length(substr(body_parser_limit,1,length(body_parser_limit)-2))=16 AND
           substr(body_parser_limit,1,length(body_parser_limit)-2)<='9007199254740991'))
      WHEN substr(body_parser_limit,-1)='b' THEN
        length(substr(body_parser_limit,1,length(body_parser_limit)-1)) > 0
        AND body_parser_limit=substr(body_parser_limit,1,length(body_parser_limit)-1)||'b'
        AND substr(body_parser_limit,1,1) GLOB '[1-9]'
        AND substr(body_parser_limit,1,length(body_parser_limit)-1) NOT GLOB '*[^0-9]*'
        AND (length(substr(body_parser_limit,1,length(body_parser_limit)-1)) < 16 OR
          (length(substr(body_parser_limit,1,length(body_parser_limit)-1))=16 AND
           substr(body_parser_limit,1,length(body_parser_limit)-1)<='9007199254740991'))
      ELSE 0 END),
    auth_json TEXT CHECK(auth_json IS NULL OR json_valid(auth_json)),
    logging_json TEXT CHECK(logging_json IS NULL OR json_valid(logging_json))
  , publication_json TEXT) STRICT`,
  `CREATE TABLE supervision_state (
      id INTEGER PRIMARY KEY CHECK(id=1),
      instance_id TEXT NOT NULL UNIQUE CHECK(length(instance_id)=36),
      controller_epoch INTEGER NOT NULL CHECK(controller_epoch >= 0 AND controller_epoch < 9007199254740991),
      current_controller_id TEXT,
      updated_at INTEGER NOT NULL CHECK(updated_at >= 0 AND updated_at < 9007199254740991)
    ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE upstreams (
    id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'),
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('service','route')),
    service_id TEXT REFERENCES services(id) ON DELETE CASCADE,
    route_id TEXT REFERENCES routes(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0 AND position <= 9007199254740991),
    target TEXT NOT NULL CHECK(length(target) > 0),
    weight REAL NOT NULL CHECK(weight > 0),
    priority REAL NOT NULL CHECK(priority > 0),
    is_disabled INTEGER NOT NULL CHECK(is_disabled IN (0,1)),
    policy_json TEXT NOT NULL CHECK(json_valid(policy_json) AND json_type(policy_json)='object'),
    CHECK((owner_kind='service' AND service_id IS NOT NULL AND route_id IS NULL) OR
          (owner_kind='route' AND route_id IS NOT NULL AND service_id IS NULL)),
    UNIQUE(owner_kind,service_id,position), UNIQUE(owner_kind,route_id,position)
  ) STRICT`,
  `CREATE UNIQUE INDEX configuration_recoveries_active_target_revision
      ON configuration_recoveries(target_revision) WHERE state IN ('scheduled','running')`,
  `CREATE UNIQUE INDEX configuration_revisions_revision_content_hash
      ON configuration_revisions(revision,content_hash)`,
  `CREATE TRIGGER configuration_operations_terminal_immutable_delete
      BEFORE DELETE ON configuration_operations
      WHEN OLD.state IN ('converged','degraded')
      BEGIN
        SELECT RAISE(ABORT,'terminal configuration operations are immutable');
      END`,
  `CREATE TRIGGER configuration_operations_terminal_immutable_update
      BEFORE UPDATE ON configuration_operations
      WHEN OLD.state IN ('converged','degraded')
      BEGIN
        SELECT RAISE(ABORT,'terminal configuration operations are immutable');
      END`,
  `CREATE TRIGGER configuration_recoveries_no_delete BEFORE DELETE ON configuration_recoveries
      BEGIN SELECT RAISE(ABORT,'configuration recovery cannot be deleted'); END`,
  `CREATE TRIGGER configuration_recoveries_sequence_insert_guard BEFORE INSERT ON configuration_recoveries
      WHEN NEW.recovery_sequence != -1 BEGIN SELECT RAISE(ABORT,'recovery sequence is database assigned'); END`,
  `CREATE TRIGGER configuration_recoveries_sequence_update_guard BEFORE UPDATE OF recovery_sequence ON configuration_recoveries
      BEGIN SELECT RAISE(ABORT,'recovery sequence is immutable'); END`,
  `CREATE TRIGGER configuration_serving_snapshots_immutable_delete
      BEFORE DELETE ON configuration_serving_snapshots
      BEGIN
        SELECT RAISE(ABORT,'configuration serving snapshots are immutable');
      END`,
  `CREATE TRIGGER configuration_serving_snapshots_immutable_update
      BEFORE UPDATE ON configuration_serving_snapshots
      BEGIN
        SELECT RAISE(ABORT,'configuration serving snapshots are immutable');
      END`,
  `CREATE TRIGGER configuration_state_singleton_id_immutable
      BEFORE UPDATE OF id ON configuration_state
      BEGIN
        SELECT RAISE(ABORT,'configuration state singleton identity is immutable');
      END`,
  `CREATE TRIGGER configuration_state_singleton_no_delete
      BEFORE DELETE ON configuration_state
      BEGIN
        SELECT RAISE(ABORT,'configuration state singleton cannot be deleted');
      END`,
  `CREATE TRIGGER configuration_state_singleton_no_replace
      BEFORE INSERT ON configuration_state
      WHEN EXISTS(SELECT 1 FROM configuration_state)
      BEGIN
        SELECT RAISE(ABORT,'configuration state singleton cannot be replaced');
      END`
] as const;
