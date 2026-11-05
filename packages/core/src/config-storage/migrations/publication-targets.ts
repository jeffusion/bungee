import type { Database } from 'bun:sqlite';
import { ConfigRepositoryError } from '../repository-types';
import { sqliteGet } from '../sqlite-query';
import type { ConfigMigration } from './plan';

/** Adds persisted targets, the single publication owner and its cancellation fence. */
export const PUBLICATION_TARGET_MIGRATION: ConfigMigration = {
  version: 8,
  name: 'publication_targets_and_cancellation',
  up(db) {
    // A running publication cannot be translated: its owner snapshot and candidate
    // identity belong to the previous schema. The supported upgrade contract requires
    // every publication to be terminal before the configuration database is migrated.
    const unfinished = sqliteGet<{ readonly mutation_id: string; readonly state: string }, []>(db,
      `SELECT mutation_id,state FROM configuration_operations
       WHERE state IN ('committed','publishing','draining') LIMIT 1`);
    if (unfinished !== null) {
      throw new ConfigRepositoryError('migration_failed',
        `configuration upgrade cannot resume publication ${unfinished.mutation_id} (${unfinished.state}); finish it with the previous executable before upgrading`);
    }
    db.run(`CREATE TABLE configuration_operations_next (
      mutation_id TEXT PRIMARY KEY CHECK(length(mutation_id) BETWEEN 1 AND 128),
      request_hash TEXT NOT NULL CHECK(length(request_hash)=71 AND substr(request_hash,1,7)='sha256:' AND substr(request_hash,8) NOT GLOB '*[^0-9a-f]*'),
      expected_revision INTEGER NOT NULL CHECK(expected_revision > 0 AND expected_revision <= 9007199254740991),
      committed_revision INTEGER NOT NULL CHECK(committed_revision > 0 AND committed_revision <= 9007199254740991)
        REFERENCES configuration_revisions(revision),
      kind TEXT NOT NULL CHECK(kind IN ('config','admin_state')),
      target_worker_count INTEGER NOT NULL CHECK(target_worker_count >= 0 AND target_worker_count <= 9007199254740991),
      state TEXT NOT NULL CHECK(state IN ('pending','committed','publishing','draining','converged','degraded','superseded')),
      result_status INTEGER,
      error_code TEXT,
      error_detail TEXT,
      drain_recovery_generation INTEGER NOT NULL DEFAULT 0
        CHECK(drain_recovery_generation >= 0 AND drain_recovery_generation <= 9007199254740991),
      last_drain_recovery_previous_generation INTEGER
        CHECK(last_drain_recovery_previous_generation IS NULL OR
          (last_drain_recovery_previous_generation >= 0 AND
           last_drain_recovery_previous_generation < 9007199254740991)),
      management_provider TEXT,
      offline_management INTEGER NOT NULL DEFAULT 0 CHECK(offline_management IN (0,1)),
      plugin_catalog_hash TEXT CHECK(plugin_catalog_hash IS NULL OR
        (length(plugin_catalog_hash)=71 AND substr(plugin_catalog_hash,1,7)='sha256:' AND
         substr(plugin_catalog_hash,8) NOT GLOB '*[^0-9a-f]*')),
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
      prepare_started INTEGER NOT NULL DEFAULT 0 CHECK(prepare_started IN (0,1)),
      created_at INTEGER NOT NULL CHECK(created_at >= 0 AND created_at <= 9007199254740991),
      updated_at INTEGER NOT NULL CHECK(updated_at >= created_at AND updated_at <= 9007199254740991),
      UNIQUE(mutation_id,committed_revision),
      CHECK((drain_recovery_generation=0 AND last_drain_recovery_previous_generation IS NULL) OR
            (drain_recovery_generation > 0 AND
              last_drain_recovery_previous_generation=drain_recovery_generation-1)),
      CHECK((state='pending' AND drain_recovery_generation=0 AND result_status IS NULL AND
              error_code IS NULL AND error_detail IS NULL AND cancel_requested=0 AND prepare_started=0) OR
            (state IN ('committed','publishing') AND drain_recovery_generation=0 AND
              result_status IS NULL AND error_code IS NULL AND error_detail IS NULL) OR
            (state='draining' AND result_status IS NULL AND error_code IS NULL AND error_detail IS NULL) OR
            (state='converged' AND drain_recovery_generation=0 AND
              result_status=200 AND error_code IS NULL AND error_detail IS NULL) OR
            (state='degraded' AND result_status=202 AND
              error_code IN ('replacement_convergence_failed','old_worker_drain_failed','control_readiness_failed') AND
              (error_code <> 'replacement_convergence_failed' OR drain_recovery_generation=0) AND
              error_detail IS NOT NULL AND length(error_detail) <= 512 AND length(trim(error_detail)) > 0) OR
            (state='superseded' AND drain_recovery_generation=0 AND result_status=409 AND
              error_code='revision_superseded' AND prepare_started=0 AND
              error_detail IS NOT NULL AND length(error_detail) <= 512 AND length(trim(error_detail)) > 0))
    ) STRICT`);
    db.run(`INSERT INTO configuration_operations_next
      (mutation_id,request_hash,expected_revision,committed_revision,kind,target_worker_count,state,
       result_status,error_code,error_detail,drain_recovery_generation,
       last_drain_recovery_previous_generation,management_provider,offline_management,created_at,updated_at)
      SELECT mutation_id,request_hash,expected_revision,committed_revision,kind,target_worker_count,state,
       result_status,error_code,error_detail,drain_recovery_generation,
       last_drain_recovery_previous_generation,management_provider,offline_management,created_at,updated_at
      FROM configuration_operations`);
    db.run('DROP TABLE configuration_operations');
    db.run('ALTER TABLE configuration_operations_next RENAME TO configuration_operations');
    db.run(`CREATE TRIGGER configuration_operations_terminal_immutable_delete
      BEFORE DELETE ON configuration_operations
      WHEN OLD.state IN ('converged','degraded','superseded')
      BEGIN SELECT RAISE(ABORT,'terminal configuration operations are immutable'); END`);
    db.run(`CREATE TRIGGER configuration_operations_terminal_immutable_update
      BEFORE UPDATE ON configuration_operations
      WHEN OLD.state IN ('converged','degraded','superseded')
      BEGIN SELECT RAISE(ABORT,'terminal configuration operations are immutable'); END`);
    db.run(`CREATE UNIQUE INDEX configuration_operations_single_owner
      ON configuration_operations((state IN ('committed','publishing','draining')))
      WHERE state IN ('committed','publishing','draining')`);
    db.run(`CREATE TABLE configuration_publication_candidate_evidence (
      mutation_id TEXT NOT NULL,
      worker_slot INTEGER NOT NULL CHECK(worker_slot >= 0 AND worker_slot <= 9007199254740991),
      attempt_no INTEGER NOT NULL CHECK(attempt_no > 0 AND attempt_no <= 9007199254740991),
      exit_kind TEXT NOT NULL CHECK(exit_kind IN ('not_started','exited')),
      cleanup TEXT NOT NULL CHECK((exit_kind='not_started' AND cleanup='not_started') OR
        (exit_kind='exited' AND cleanup='released')),
      updated_at INTEGER NOT NULL CHECK(updated_at >= 0 AND updated_at <= 9007199254740991),
      PRIMARY KEY(mutation_id,worker_slot,attempt_no),
      FOREIGN KEY(mutation_id,worker_slot)
        REFERENCES configuration_operation_workers(mutation_id,worker_slot)
    ) STRICT, WITHOUT ROWID`);
    db.run("CREATE TRIGGER publication_candidate_evidence_no_delete BEFORE DELETE ON configuration_publication_candidate_evidence BEGIN SELECT RAISE(ABORT,'publication candidate evidence is immutable'); END");
    db.run("CREATE TRIGGER publication_candidate_evidence_no_update BEFORE UPDATE ON configuration_publication_candidate_evidence BEGIN SELECT RAISE(ABORT,'publication candidate evidence is immutable'); END");
    db.run("CREATE TRIGGER publication_candidate_evidence_no_replace BEFORE INSERT ON configuration_publication_candidate_evidence WHEN EXISTS(SELECT 1 FROM configuration_publication_candidate_evidence WHERE mutation_id=NEW.mutation_id AND worker_slot=NEW.worker_slot AND attempt_no=NEW.attempt_no) BEGIN SELECT RAISE(ABORT,'publication candidate evidence is immutable'); END");
    // Immutable launch intent: the identity and guard facts captured before the native fork.
    db.run(`CREATE TABLE configuration_worker_launch_intents (
      worker_instance_id TEXT PRIMARY KEY CHECK(length(worker_instance_id)=36 AND
        substr(worker_instance_id,9,1)='-' AND substr(worker_instance_id,14,1)='-' AND
        substr(worker_instance_id,19,1)='-' AND substr(worker_instance_id,24,1)='-' AND
        replace(worker_instance_id,'-','') NOT GLOB '*[^0-9a-f]*'),
      master_generation TEXT NOT NULL CHECK(length(master_generation)=36),
      worker_slot INTEGER NOT NULL CHECK(worker_slot >= 0 AND worker_slot <= 9007199254740991),
      allocation_mutation_id TEXT CHECK(allocation_mutation_id IS NULL OR
        length(allocation_mutation_id) BETWEEN 1 AND 128),
      allocation_worker_slot INTEGER CHECK(allocation_worker_slot IS NULL OR
        (allocation_worker_slot >= 0 AND allocation_worker_slot <= 9007199254740991)),
      allocation_attempt_no INTEGER CHECK(allocation_attempt_no IS NULL OR
        (allocation_attempt_no > 0 AND allocation_attempt_no <= 9007199254740991)),
      guard_json TEXT NOT NULL CHECK(length(guard_json) > 0),
      registered_at INTEGER NOT NULL CHECK(registered_at >= 0 AND registered_at <= 9007199254740991),
      CHECK((allocation_mutation_id IS NULL AND allocation_worker_slot IS NULL AND allocation_attempt_no IS NULL) OR
            (allocation_mutation_id IS NOT NULL AND allocation_worker_slot IS NOT NULL AND
             allocation_attempt_no IS NOT NULL AND allocation_worker_slot=worker_slot)),
      FOREIGN KEY(allocation_mutation_id,allocation_worker_slot)
        REFERENCES configuration_operation_workers(mutation_id,worker_slot)
    ) STRICT`);
    db.run("CREATE TRIGGER configuration_worker_launch_intents_no_delete BEFORE DELETE ON configuration_worker_launch_intents BEGIN SELECT RAISE(ABORT,'worker launch intent is immutable'); END");
    db.run("CREATE TRIGGER configuration_worker_launch_intents_no_update BEFORE UPDATE ON configuration_worker_launch_intents BEGIN SELECT RAISE(ABORT,'worker launch intent is immutable'); END");
    // Append-only reservation/admission/exit/cleanup facts.
    db.run(`CREATE TABLE configuration_worker_launch_facts (
      fact_id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('reserved','not_started','admitted','exited','cleanup')),
      mutation_id TEXT,
      worker_slot INTEGER,
      attempt_no INTEGER,
      worker_instance_id TEXT,
      recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0 AND recorded_at <= 9007199254740991),
      CHECK((mutation_id IS NULL AND worker_slot IS NULL AND attempt_no IS NULL) OR
            (mutation_id IS NOT NULL AND worker_slot IS NOT NULL AND attempt_no IS NOT NULL AND
             worker_slot >= 0 AND worker_slot <= 9007199254740991 AND
             attempt_no > 0 AND attempt_no <= 9007199254740991)),
      CHECK((kind='reserved' AND worker_instance_id IS NULL AND mutation_id IS NOT NULL) OR
            (kind='not_started' AND (worker_instance_id IS NOT NULL OR mutation_id IS NOT NULL)) OR
            (kind IN ('admitted','exited','cleanup') AND worker_instance_id IS NOT NULL)),
      FOREIGN KEY(mutation_id,worker_slot) REFERENCES configuration_operation_workers(mutation_id,worker_slot),
      FOREIGN KEY(worker_instance_id) REFERENCES configuration_worker_launch_intents(worker_instance_id)
    ) STRICT`);
    db.run("CREATE UNIQUE INDEX configuration_worker_launch_facts_reserved ON configuration_worker_launch_facts(mutation_id,worker_slot,attempt_no) WHERE kind='reserved'");
    db.run("CREATE UNIQUE INDEX configuration_worker_launch_facts_not_started_allocation ON configuration_worker_launch_facts(mutation_id,worker_slot,attempt_no) WHERE kind='not_started' AND mutation_id IS NOT NULL");
    db.run("CREATE UNIQUE INDEX configuration_worker_launch_facts_not_started_instance ON configuration_worker_launch_facts(worker_instance_id) WHERE kind='not_started' AND worker_instance_id IS NOT NULL");
    db.run("CREATE UNIQUE INDEX configuration_worker_launch_facts_admitted ON configuration_worker_launch_facts(worker_instance_id) WHERE kind='admitted'");
    db.run("CREATE UNIQUE INDEX configuration_worker_launch_facts_exited ON configuration_worker_launch_facts(worker_instance_id) WHERE kind='exited'");
    db.run("CREATE UNIQUE INDEX configuration_worker_launch_facts_cleanup ON configuration_worker_launch_facts(worker_instance_id) WHERE kind='cleanup'");
    db.run("CREATE TRIGGER configuration_worker_launch_facts_no_delete BEFORE DELETE ON configuration_worker_launch_facts BEGIN SELECT RAISE(ABORT,'worker launch facts are immutable'); END");
    db.run("CREATE TRIGGER configuration_worker_launch_facts_no_update BEFORE UPDATE ON configuration_worker_launch_facts BEGIN SELECT RAISE(ABORT,'worker launch facts are immutable'); END");
  },
};
