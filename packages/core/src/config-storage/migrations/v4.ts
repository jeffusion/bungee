import type { Database } from 'bun:sqlite';
import { ConfigRepositoryError } from '../repository-types';
import { sqliteAll } from '../sqlite-query';

export const CONFIG_MIGRATION_V4 = {
  version: 4,
  name: 'remove_bootstrap_configuration_state',
  up(db: Database): void {
    const state = sqliteAll<{ readonly id: number }, []>(db, 'SELECT id FROM configuration_state ORDER BY id');
    if (state.length !== 1 || state[0]?.id !== 1) {
      throw new ConfigRepositoryError('schema_corrupt', 'configuration state singleton is broken');
    }
    db.run('DROP TRIGGER configuration_state_bootstrap_completion_guard');
    db.run('DROP TRIGGER configuration_state_singleton_no_delete');
    db.run('DROP TRIGGER configuration_state_singleton_id_immutable');
    db.run('DROP TRIGGER configuration_state_singleton_no_replace');
    db.run('ALTER TABLE configuration_state RENAME TO configuration_state_v3');
    db.run(`CREATE TABLE configuration_state (
      id INTEGER PRIMARY KEY CHECK(id=1),
      schema_version INTEGER NOT NULL CHECK(schema_version=4),
      active_revision INTEGER NOT NULL CHECK(active_revision > 0 AND active_revision <= 9007199254740991)
        REFERENCES configuration_revisions(revision),
      created_at INTEGER NOT NULL CHECK(created_at >= 0 AND created_at <= 9007199254740991),
      updated_at INTEGER NOT NULL CHECK(updated_at >= created_at AND updated_at <= 9007199254740991)
    ) STRICT`);
    db.run(`INSERT INTO configuration_state (id,schema_version,active_revision,created_at,updated_at)
      SELECT state.id,4,state.active_revision,0,revision.created_at
      FROM configuration_state_v3 AS state
      JOIN configuration_revisions AS revision ON revision.revision=state.active_revision`);
    db.run('DROP TABLE configuration_state_v3');
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
