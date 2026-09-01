import type { Database } from 'bun:sqlite';

export const CONFIG_MIGRATION_V2 = {
  version: 2,
  name: 'irreversible_bootstrap_completion',
  up(db: Database): void {
    db.run(`ALTER TABLE configuration_state ADD COLUMN bootstrap_completed_revision INTEGER
      REFERENCES configuration_revisions(revision)`);
    db.run(`UPDATE configuration_state SET bootstrap_completed_revision=active_revision
      WHERE bootstrap_mode=0`);
    db.run(`CREATE TRIGGER configuration_state_bootstrap_completion_guard
      BEFORE UPDATE ON configuration_state
      WHEN (NEW.bootstrap_mode=1 AND NEW.bootstrap_completed_revision IS NOT NULL) OR
      (NEW.bootstrap_mode=0 AND (
        NEW.bootstrap_completed_revision IS NULL OR
        NEW.bootstrap_completed_revision < 2 OR
        NEW.bootstrap_completed_revision > NEW.active_revision
      )) OR (
        OLD.bootstrap_completed_revision IS NOT NULL AND
        NEW.bootstrap_completed_revision IS NOT OLD.bootstrap_completed_revision
      )
      BEGIN
        SELECT RAISE(ABORT,'bootstrap completion is irreversible');
      END`);
    db.run('INSERT INTO schema_migrations (version,name) VALUES (?,?)', [this.version, this.name]);
  },
} as const;
