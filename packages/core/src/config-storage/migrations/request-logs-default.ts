import type { ConfigMigration } from './plan';

export const REQUEST_LOGS_DEFAULT_MIGRATION: ConfigMigration = {
  version: 9,
  name: 'request_logs_default',
  up(db) {
    db.run(`CREATE TABLE configuration_request_logs_default (
      id INTEGER PRIMARY KEY CHECK(id=1),
      settled_revision INTEGER NOT NULL REFERENCES configuration_revisions(revision)
    ) STRICT, WITHOUT ROWID`);
  },
};
