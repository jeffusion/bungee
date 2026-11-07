import type { ConfigMigration } from './plan';

export const WORKER_LAUNCH_CAPACITY_MIGRATION: ConfigMigration = {
  version: 10,
  name: 'worker_launch_capacity',
  up(db) {
    db.run(`CREATE TABLE configuration_worker_launch_capacity_reclaims (
      worker_instance_id TEXT PRIMARY KEY REFERENCES configuration_worker_launch_intents(worker_instance_id),
      recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0 AND recorded_at <= 9007199254740991)
    ) STRICT, WITHOUT ROWID`);
    db.run(`CREATE TRIGGER configuration_worker_launch_capacity_reclaims_guard BEFORE INSERT ON configuration_worker_launch_capacity_reclaims
      WHEN EXISTS (SELECT 1 FROM configuration_worker_launch_capacity_reclaims WHERE worker_instance_id=NEW.worker_instance_id)
        OR NOT EXISTS (SELECT 1 FROM configuration_worker_launch_facts WHERE worker_instance_id=NEW.worker_instance_id AND kind='admitted' AND recorded_at<=NEW.recorded_at)
        OR NOT EXISTS (SELECT 1 FROM configuration_worker_launch_facts WHERE worker_instance_id=NEW.worker_instance_id AND kind='exited' AND recorded_at<=NEW.recorded_at)
        OR EXISTS (SELECT 1 FROM configuration_worker_launch_facts WHERE worker_instance_id=NEW.worker_instance_id AND kind IN ('not_started','cleanup'))
      BEGIN SELECT RAISE(ABORT,'worker launch capacity reclaim requires a new admitted exit without successful cleanup'); END`);
    db.run("CREATE TRIGGER configuration_worker_launch_capacity_reclaims_no_delete BEFORE DELETE ON configuration_worker_launch_capacity_reclaims BEGIN SELECT RAISE(ABORT,'worker launch capacity reclaim is immutable'); END");
    db.run("CREATE TRIGGER configuration_worker_launch_capacity_reclaims_no_update BEFORE UPDATE ON configuration_worker_launch_capacity_reclaims BEGIN SELECT RAISE(ABORT,'worker launch capacity reclaim is immutable'); END");
  },
};
