import type { Database } from 'bun:sqlite';

export const CONFIG_MIGRATION_V12 = {
  version: 12,
  name: 'add_publication_policy',
  up(db: Database, faultInjection?: () => void): void {
    db.run('ALTER TABLE settings ADD COLUMN publication_json TEXT');
    db.run('INSERT INTO schema_migrations(version,name) VALUES (?,?)', [this.version, this.name]);
    faultInjection?.();
  },
} as const;
