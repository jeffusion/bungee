import type { Database } from 'bun:sqlite';

export const CONFIG_MIGRATION_V3 = {
  version: 3,
  name: 'immutable_configuration_state_singleton',
  up(db: Database): void {
    db.run(`CREATE TRIGGER configuration_state_singleton_no_delete
      BEFORE DELETE ON configuration_state
      BEGIN
        SELECT RAISE(ABORT,'configuration state singleton cannot be deleted');
      END`);
    db.run(`CREATE TRIGGER configuration_state_singleton_id_immutable
      BEFORE UPDATE OF id ON configuration_state
      BEGIN
        SELECT RAISE(ABORT,'configuration state singleton identity is immutable');
      END`);
    db.run(`CREATE TRIGGER configuration_state_singleton_no_replace
      BEFORE INSERT ON configuration_state
      WHEN EXISTS(SELECT 1 FROM configuration_state)
      BEGIN
        SELECT RAISE(ABORT,'configuration state singleton cannot be replaced');
      END`);
    db.run('INSERT INTO schema_migrations (version,name) VALUES (?,?)', [this.version, this.name]);
  },
} as const;
