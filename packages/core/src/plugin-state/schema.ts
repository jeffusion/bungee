import { Database } from 'bun:sqlite';
import { databaseSchemaDescriptor } from '../database-schema';
import { PLUGIN_DURABLE_STATE_SCHEMA_SQL } from '../plugin-durable-state';
import { PLUGIN_COMMUNICATION_SCHEMA_SQL } from '../plugin-services/persistence';
import { COMMAND_JOURNAL_RETENTION_SCHEMA_SQL } from '../plugin-services/command-journal';

export const PLUGIN_STATE_SCHEMA_SQL = `${PLUGIN_DURABLE_STATE_SCHEMA_SQL}
CREATE TABLE IF NOT EXISTS secret_store_namespaces (
 namespace TEXT PRIMARY KEY CHECK(length(namespace) BETWEEN 1 AND 256),
 namespace_epoch INTEGER NOT NULL CHECK(namespace_epoch > 0 AND namespace_epoch <= 9007199254740991)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS secret_store_objects (
 namespace TEXT NOT NULL, key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 1024),
 namespace_epoch INTEGER NOT NULL CHECK(namespace_epoch > 0 AND namespace_epoch <= 9007199254740991),
 version INTEGER NOT NULL CHECK(version > 0 AND version <= 9007199254740991),
 deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), envelope BLOB,
 PRIMARY KEY(namespace,key), FOREIGN KEY(namespace) REFERENCES secret_store_namespaces(namespace) ON DELETE CASCADE,
 CHECK((deleted=0 AND envelope IS NOT NULL) OR (deleted=1 AND envelope IS NULL))
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS plugin_storage (
 plugin_name TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, ttl INTEGER,
 updated_at INTEGER NOT NULL, PRIMARY KEY(plugin_name,key)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_plugin_storage_ttl ON plugin_storage(ttl);
${PLUGIN_COMMUNICATION_SCHEMA_SQL}
${COMMAND_JOURNAL_RETENTION_SCHEMA_SQL}
PRAGMA user_version=1;
`;
export interface PluginStateMigration { readonly version:number; readonly name:string; readonly up:(db:Database)=>void; }
/** Frozen baseline; append future migrations starting at 2. */
export const PLUGIN_STATE_MIGRATIONS: readonly PluginStateMigration[] = [
  {version:1,name:'current_plugin_state_baseline',up(db) {db.exec(PLUGIN_STATE_SCHEMA_SQL);}},
];
const descriptors = new Map<number,string>();
function verifyPluginSchema(db:Database,version:number,plan:readonly PluginStateMigration[]):void {
  let expected = plan === PLUGIN_STATE_MIGRATIONS ? descriptors.get(version) : undefined;
  if (expected === undefined) {
    const reference = new Database(':memory:');
    try { for (const m of plan.filter(m => m.version <= version)) m.up(reference); expected = databaseSchemaDescriptor(reference); }
    finally {reference.close();}
    if (plan === PLUGIN_STATE_MIGRATIONS) descriptors.set(version,expected);
  }
  if (databaseSchemaDescriptor(db) !== expected) throw new Error('plugin_state_schema_corrupt');
}
export function initializePluginStateDatabase(db:Database,plan:readonly PluginStateMigration[]=PLUGIN_STATE_MIGRATIONS):void {
  db.transaction(() => {
    if (!plan.length || plan[0] !== PLUGIN_STATE_MIGRATIONS[0] || plan.some((m,i) => m.version !== i+1)
      || new Set(plan.map(m => m.name)).size !== plan.length) throw new Error('plugin_state_migration_plan_invalid');
    const version=db.query<{user_version:number},[]>('PRAGMA user_version').get()!.user_version;
    const objects=db.query<{n:number},[]>("SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()!.n;
    if (version < 0 || version > plan.at(-1)!.version || (version===0 && objects>0)) throw new Error('plugin_state_version_unsupported');
    if (version>0) verifyPluginSchema(db,version,plan);
    for (const migration of plan.filter(m => m.version>version)) {
      migration.up(db);
      db.run(`PRAGMA user_version=${migration.version}`);
    }
    verifyPluginSchema(db,plan.at(-1)!.version,plan);
  }).immediate();
}
export function validatePluginStateDatabase(db:Database):void {
  const version=db.query<{user_version:number},[]>('PRAGMA user_version').get()!.user_version;
  if (version!==PLUGIN_STATE_MIGRATIONS.at(-1)!.version) throw new Error('plugin_state_version_unsupported');
  verifyPluginSchema(db,version,PLUGIN_STATE_MIGRATIONS);
}
