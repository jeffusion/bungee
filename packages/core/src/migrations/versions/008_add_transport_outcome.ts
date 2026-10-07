import type { Migration } from '../migration.types';

export const migration: Migration = {
  version: '008',
  name: 'add_transport_outcome',
  up(db) {
    // Historical records deliberately remain NULL: HTTP/protocol outcomes are not byte-stream proof.
    db.run('ALTER TABLE access_logs ADD COLUMN transport_outcome TEXT');
    db.run('ALTER TABLE access_logs ADD COLUMN transport_code TEXT');
    db.run('CREATE INDEX IF NOT EXISTS idx_transport_outcome ON access_logs(transport_outcome)');
  },
};
