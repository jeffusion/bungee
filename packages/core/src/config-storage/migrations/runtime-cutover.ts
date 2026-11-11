import type { ConfigMigration } from './plan';

export const RUNTIME_CUTOVER_MIGRATION: ConfigMigration = {
  version: 11,
  name: 'stopped_instance_runtime_cutovers',
  up(db) {
    db.run(`CREATE TABLE runtime_cutovers (
      runtime_epoch INTEGER PRIMARY KEY CHECK(runtime_epoch BETWEEN 0 AND 9007199254740991),
      stopped_container_id TEXT UNIQUE,
      saved_revision INTEGER NOT NULL REFERENCES configuration_revisions(revision),
      confirmed_at INTEGER NOT NULL CHECK(confirmed_at BETWEEN 0 AND 9007199254740991),
      recovery_budget_json TEXT CHECK(recovery_budget_json IS NULL OR
        (json_valid(recovery_budget_json) AND json_type(recovery_budget_json)='object')),
      CHECK((runtime_epoch=0 AND stopped_container_id IS NULL AND saved_revision=1 AND confirmed_at=0
        AND recovery_budget_json IS NULL) OR (runtime_epoch>0 AND stopped_container_id IS NOT NULL
        AND length(stopped_container_id)=64 AND stopped_container_id NOT GLOB '*[^0-9a-f]*'
        AND recovery_budget_json IS NOT NULL))
    ) STRICT`);
    db.run('INSERT INTO runtime_cutovers(runtime_epoch,saved_revision,confirmed_at) VALUES(0,1,0)');
    db.run(`CREATE TRIGGER runtime_cutovers_no_delete BEFORE DELETE ON runtime_cutovers
      BEGIN SELECT RAISE(ABORT,'runtime cutover history is immutable'); END`);
    db.run(`CREATE TRIGGER runtime_cutovers_no_update BEFORE UPDATE ON runtime_cutovers
      BEGIN SELECT RAISE(ABORT,'runtime cutover history is immutable'); END`);
    db.run(`CREATE TRIGGER runtime_cutovers_no_replace BEFORE INSERT ON runtime_cutovers
      WHEN EXISTS(SELECT 1 FROM runtime_cutovers WHERE runtime_epoch=NEW.runtime_epoch
        OR stopped_container_id=NEW.stopped_container_id)
      BEGIN SELECT RAISE(ABORT,'runtime cutover history is immutable'); END`);
    for (const table of ['configuration_operations', 'configuration_recoveries', 'configuration_worker_launch_intents']) {
      db.run(`ALTER TABLE ${table} ADD COLUMN runtime_epoch INTEGER NOT NULL DEFAULT 0 REFERENCES runtime_cutovers(runtime_epoch)`);
    }
    db.run('DROP INDEX configuration_operations_single_owner');
    db.run(`CREATE UNIQUE INDEX configuration_operations_single_owner
      ON configuration_operations(runtime_epoch) WHERE state IN ('committed','publishing','draining')`);
    db.run('DROP INDEX configuration_recoveries_active_target_revision');
    db.run(`CREATE UNIQUE INDEX configuration_recoveries_active_target_revision
      ON configuration_recoveries(runtime_epoch,target_revision) WHERE state IN ('scheduled','running')`);
  },
};
