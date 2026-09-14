import type { Database } from 'bun:sqlite';

const MAX = '9007199254740991';
const UUID = "length(recovery_id)=36 AND substr(recovery_id,9,1)='-' AND substr(recovery_id,14,1)='-' AND substr(recovery_id,19,1)='-' AND substr(recovery_id,24,1)='-' AND replace(recovery_id,'-','') NOT GLOB '*[^0-9a-f]*'";
const REASONS = `final_reason_code IS NULL OR final_reason_code IN
  ('target_serving','already_serving','deterministic_worker_rejection','deterministic_protocol_failure',
   'deterministic_control_failure','retry_exhausted','revision_superseded','safety_outcome_unknown','fatal_source_failure')`;

export const CONFIG_MIGRATION_V10 = {
  version: 10,
  name: 'fatal_configuration_recovery_marker',
  up(db: Database): void {
    db.run('DROP TRIGGER configuration_recoveries_sequence_update_guard');
    db.run('DROP TRIGGER configuration_recoveries_sequence_insert_guard');
    db.run('DROP TRIGGER configuration_recoveries_no_delete');
    db.run('DROP INDEX configuration_recoveries_active_target_revision');
    db.run('ALTER TABLE configuration_recoveries RENAME TO configuration_recoveries_v9');
    db.run(`CREATE TABLE configuration_recoveries (
      recovery_sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(recovery_sequence > 0),
      recovery_id TEXT NOT NULL UNIQUE CHECK(${UUID}),
      source_mutation_id TEXT NOT NULL,
      target_revision INTEGER NOT NULL CHECK(target_revision > 0 AND target_revision <= ${MAX}),
      trigger TEXT NOT NULL CHECK(trigger IN ('automatic','manual')),
      state TEXT NOT NULL CHECK(state IN ('scheduled','running','succeeded','stopped')),
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0 AND attempt_count <= 6),
      max_attempts INTEGER NOT NULL CHECK(max_attempts=6),
      next_retry_at INTEGER CHECK(next_retry_at IS NULL OR (next_retry_at >= 0 AND next_retry_at <= ${MAX})),
      final_reason_code TEXT CHECK(${REASONS}), final_reason_detail TEXT,
      created_at INTEGER NOT NULL CHECK(created_at >= 0 AND created_at <= ${MAX}),
      updated_at INTEGER NOT NULL CHECK(updated_at >= created_at AND updated_at <= ${MAX}),
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
    ) STRICT`);
    db.run(`INSERT INTO configuration_recoveries SELECT * FROM configuration_recoveries_v9`);
    db.run('DROP TABLE configuration_recoveries_v9');
    db.run(`CREATE UNIQUE INDEX configuration_recoveries_active_target_revision
      ON configuration_recoveries(target_revision) WHERE state IN ('scheduled','running')`);
    db.run(`CREATE TRIGGER configuration_recoveries_sequence_update_guard BEFORE UPDATE OF recovery_sequence ON configuration_recoveries
      BEGIN SELECT RAISE(ABORT,'recovery sequence is immutable'); END`);
    db.run(`CREATE TRIGGER configuration_recoveries_sequence_insert_guard BEFORE INSERT ON configuration_recoveries
      WHEN NEW.recovery_sequence != -1 BEGIN SELECT RAISE(ABORT,'recovery sequence is database assigned'); END`);
    db.run(`CREATE TRIGGER configuration_recoveries_no_delete BEFORE DELETE ON configuration_recoveries
      BEGIN SELECT RAISE(ABORT,'configuration recovery cannot be deleted'); END`);
    db.run('INSERT INTO schema_migrations (version,name) VALUES (?,?)', [this.version, this.name]);
  },
} as const;
