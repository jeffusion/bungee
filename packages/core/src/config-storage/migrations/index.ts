import type { Database } from 'bun:sqlite';
import { ConfigRepositoryError } from '../repository-types';
import { verifySchemaFingerprint } from '../schema-fingerprint';
import { isSqliteBusyError, repositoryFailure } from '../sqlite-errors';
import { CONFIG_MIGRATIONS, type ConfigMigration } from './plan';
export { CONFIG_MIGRATIONS, CONFIG_SCHEMA_VERSION } from './plan';
export { CONFIG_BASELINE_VERSION, CONFIG_BASELINE_NAME } from './baseline';

export function migrateConfigurationDatabase(db: Database, plan: readonly ConfigMigration[] = CONFIG_MIGRATIONS): void {
  try {
    db.transaction(() => {
      if (!plan.length || plan[0] !== CONFIG_MIGRATIONS[0] || plan.some((m,i) => i > 0 && m.version !== plan[i-1]!.version+1)
        || new Set(plan.map(m => m.name)).size !== plan.length) throw new ConfigRepositoryError('migration_failed', 'invalid configuration migration plan');
      const count = db.query<{count:number},[]>("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()!.count;
      let applied: {version:number;name:string}[] = [];
      if (count > 0) {
        applied = db.query<{version:number;name:string},[]>('SELECT version,name FROM schema_migrations ORDER BY version').all();
        if (!applied.length || applied.length > plan.length || applied.some((r,i) => r.version !== plan[i]?.version || r.name !== plan[i]?.name))
          throw new ConfigRepositoryError('schema_corrupt', 'configuration migration history is not an exact baseline prefix');
        verifySchemaFingerprint(db, applied.at(-1)!.version, plan);
      }
      for (const migration of plan.slice(applied.length)) {
        migration.up(db);
        db.run('INSERT INTO schema_migrations(version,name) VALUES(?,?)', [migration.version,migration.name]);
      }
      verifySchemaFingerprint(db, plan.at(-1)!.version, plan);
    }).immediate();
  } catch (error) {
    if (error instanceof ConfigRepositoryError) throw error;
    if (isSqliteBusyError(error)) throw repositoryFailure('configuration migration was blocked by SQLite', error);
    throw new ConfigRepositoryError('migration_failed', 'configuration migration failed', error);
  }
}
