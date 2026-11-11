import type { ConfigMigration } from './plan';

export const PREPARED_WORKER_ALLOCATION_MIGRATION: ConfigMigration = {
  version: 12,
  name: 'prepared_worker_allocation',
  up(db) {
    db.run('DROP TRIGGER configuration_worker_launch_intents_no_update');
    db.run(`CREATE TRIGGER configuration_worker_launch_intents_no_update
      BEFORE UPDATE ON configuration_worker_launch_intents
      WHEN OLD.allocation_mutation_id IS NOT NULL OR NEW.allocation_mutation_id IS NULL
        OR NEW.worker_instance_id IS NOT OLD.worker_instance_id OR NEW.master_generation IS NOT OLD.master_generation
        OR NEW.worker_slot IS NOT OLD.worker_slot OR NEW.guard_json IS NOT OLD.guard_json
        OR NEW.registered_at IS NOT OLD.registered_at OR NEW.runtime_epoch IS NOT OLD.runtime_epoch
      BEGIN SELECT RAISE(ABORT,'worker launch intent is immutable'); END`);
  },
};
