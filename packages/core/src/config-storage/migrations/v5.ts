import type { Database } from 'bun:sqlite';

const MAX_SAFE_INTEGER_SQL = '9007199254740991';

export const CONFIG_MIGRATION_V5 = {
  version: 5,
  name: 'encrypted_plugin_control_secrets',
  up(db: Database): void {
    db.run(`CREATE TABLE secret_store_namespaces (
      namespace TEXT PRIMARY KEY CHECK(length(namespace) BETWEEN 1 AND 256),
      namespace_epoch INTEGER NOT NULL CHECK(namespace_epoch > 0 AND namespace_epoch <= ${MAX_SAFE_INTEGER_SQL})
    ) STRICT, WITHOUT ROWID`);
    db.run(`CREATE TABLE secret_store_objects (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 1024),
      namespace_epoch INTEGER NOT NULL CHECK(namespace_epoch > 0 AND namespace_epoch <= ${MAX_SAFE_INTEGER_SQL}),
      version INTEGER NOT NULL CHECK(version > 0 AND version <= ${MAX_SAFE_INTEGER_SQL}),
      deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
      envelope BLOB,
      PRIMARY KEY(namespace,key),
      FOREIGN KEY(namespace) REFERENCES secret_store_namespaces(namespace) ON DELETE CASCADE,
      CHECK((deleted=0 AND envelope IS NOT NULL) OR (deleted=1 AND envelope IS NULL))
    ) STRICT, WITHOUT ROWID`);
    db.run('INSERT INTO schema_migrations (version,name) VALUES (?,?)', [this.version, this.name]);
  },
} as const;
