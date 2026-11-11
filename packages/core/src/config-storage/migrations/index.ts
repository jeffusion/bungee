import { convertServiceReferenceRevision } from '../service-reference-upgrade';
import type { ConfigRepositoryOptions } from '../repository-types';
import type { Database } from 'bun:sqlite';
import { ConfigRepositoryError } from '../repository-types';
import { verifySchemaFingerprint } from '../schema-fingerprint';
import { isSqliteBusyError, repositoryFailure } from '../sqlite-errors';
import { applyRequestLogsDefault } from '../request-logs-default';
import { recordRuntimeCutover, verifyRuntimeCutoverCatalog, type RuntimeCutover } from '../runtime-cutover';
import { readActiveRevision } from '../current-revision';
import { readActivePublication } from '../active-publication';
import { readRepositorySnapshot, verifyRepositoryIntegrity } from '../repository-snapshot';
import { readMenuLayout } from '../menu-store';
import { readSupervisionState } from '../../supervision/state-repository';
import { CONFIG_MIGRATIONS, type ConfigMigration } from './plan';
export { CONFIG_MIGRATIONS, CONFIG_SCHEMA_VERSION } from './plan';
export { CONFIG_BASELINE_VERSION, CONFIG_BASELINE_NAME } from './baseline';

export function migrateConfigurationDatabase(db: Database, plan: readonly ConfigMigration[] = CONFIG_MIGRATIONS, options: ConfigRepositoryOptions = {}): void {
  migrate(db, plan, options);
}

export function migrateStoppedDockerCutover(db: Database, stoppedContainerId: string, now: number): RuntimeCutover {
  return migrate(db, CONFIG_MIGRATIONS, {}, { stoppedContainerId, now })!;
}

function migrate(db: Database, plan: readonly ConfigMigration[], options: ConfigRepositoryOptions,
  cutover?: { stoppedContainerId: string; now: number }): RuntimeCutover | undefined {
  // Table rebuilds preserve child rows only while foreign key actions are disabled;
  // the final foreign_key_check keeps the resulting graph enforced.
  if (db.inTransaction) throw new ConfigRepositoryError('migration_failed', 'configuration migration must not nest in a transaction');
  db.run('PRAGMA foreign_keys = OFF');
  try {
    if (db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys !== 0) {
      throw new ConfigRepositoryError('migration_failed', 'configuration migration could not disable foreign keys');
    }
    return db.transaction(() => {
      if (!plan.length || plan[0] !== CONFIG_MIGRATIONS[0] || plan.some((m,i) => i > 0 && m.version !== plan[i-1]!.version+1)
        || new Set(plan.map(m => m.name)).size !== plan.length) throw new ConfigRepositoryError('migration_failed', 'invalid configuration migration plan');
      const count = db.query<{count:number},[]>("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()!.count;
      if (cutover !== undefined && count === 0) {
        throw new ConfigRepositoryError('schema_corrupt', 'runtime cutover requires an existing configuration database');
      }
      let applied: {version:number;name:string}[] = [];
      if (count > 0) {
        applied = db.query<{version:number;name:string},[]>('SELECT version,name FROM schema_migrations ORDER BY version').all();
        if (!applied.length || applied.length > plan.length || applied.some((r,i) => r.version !== plan[i]?.version || r.name !== plan[i]?.name))
          throw new ConfigRepositoryError('schema_corrupt', 'configuration migration history is not an exact baseline prefix');
        verifySchemaFingerprint(db, applied.at(-1)!.version, plan);
        if (cutover !== undefined) readActiveRevision(db);
      }
      for (const migration of plan.slice(applied.length)) {
        migration.up(db);
        db.run('INSERT INTO schema_migrations(version,name) VALUES(?,?)', [migration.version,migration.name]);
      }
      verifySchemaFingerprint(db, plan.at(-1)!.version, plan);
      if (plan === CONFIG_MIGRATIONS && applied.length > 0 && applied.at(-1)!.version < 5) {
        convertServiceReferenceRevision(db, options);
      }
      if (plan === CONFIG_MIGRATIONS) {
        verifyRuntimeCutoverCatalog(db, options.compileOptions?.availablePlugins);
        applyRequestLogsDefault(db, options);
      }
      // Only a schema change can invalidate references; untouched databases are audited later.
      if (plan.length > applied.length && db.query('PRAGMA foreign_key_check').all().length > 0) {
        throw new ConfigRepositoryError('schema_corrupt', 'configuration migration left invalid references');
      }
      if (cutover === undefined) return;
      readActivePublication(db);
      const result = recordRuntimeCutover(db, cutover.stoppedContainerId, cutover.now);
      verifyRepositoryIntegrity(db);
      readRepositorySnapshot(db);
      readMenuLayout(db);
      readSupervisionState(db);
      return result;
    }).immediate();
  } catch (error) {
    if (error instanceof ConfigRepositoryError) throw error;
    if (isSqliteBusyError(error)) throw repositoryFailure('configuration migration was blocked by SQLite', error);
    throw new ConfigRepositoryError('migration_failed', 'configuration migration failed', error);
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }
}
