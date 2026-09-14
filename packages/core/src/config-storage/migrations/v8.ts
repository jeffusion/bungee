import type { Database } from 'bun:sqlite';

const MAX_SAFE_INTEGER_SQL = '9007199254740991';
const SHA256_CHECK = "length(content_hash)=71 AND substr(content_hash,1,7)='sha256:' AND substr(content_hash,8) NOT GLOB '*[^0-9a-f]*'";
const CATALOG_SHA256_CHECK = "length(plugin_catalog_hash)=71 AND substr(plugin_catalog_hash,1,7)='sha256:' AND substr(plugin_catalog_hash,8) NOT GLOB '*[^0-9a-f]*'";

export const CONFIG_MIGRATION_V8 = {
  version: 8,
  name: 'immutable_configuration_serving_snapshots',
  up(db: Database): void {
    db.run(`CREATE UNIQUE INDEX configuration_revisions_revision_content_hash
      ON configuration_revisions(revision,content_hash)`);
    db.run(`CREATE TABLE configuration_serving_snapshots (
      revision INTEGER NOT NULL CHECK(revision > 0 AND revision <= ${MAX_SAFE_INTEGER_SQL}),
      content_hash TEXT NOT NULL CHECK(${SHA256_CHECK}),
      plugin_catalog_hash TEXT NOT NULL CHECK(${CATALOG_SHA256_CHECK}),
      aggregate_json TEXT NOT NULL CHECK(json_valid(aggregate_json) AND json_type(aggregate_json)='object'
        AND length(CAST(aggregate_json AS BLOB)) BETWEEN 2 AND 1048576),
      PRIMARY KEY(revision,content_hash,plugin_catalog_hash),
      FOREIGN KEY(revision,content_hash)
        REFERENCES configuration_revisions(revision,content_hash)
    ) STRICT, WITHOUT ROWID`);
    db.run(`CREATE TRIGGER configuration_serving_snapshots_immutable_update
      BEFORE UPDATE ON configuration_serving_snapshots
      BEGIN
        SELECT RAISE(ABORT,'configuration serving snapshots are immutable');
      END`);
    db.run(`CREATE TRIGGER configuration_serving_snapshots_immutable_delete
      BEFORE DELETE ON configuration_serving_snapshots
      BEGIN
        SELECT RAISE(ABORT,'configuration serving snapshots are immutable');
      END`);
    db.run('INSERT INTO schema_migrations (version,name) VALUES (?,?)', [this.version, this.name]);
  },
} as const;
