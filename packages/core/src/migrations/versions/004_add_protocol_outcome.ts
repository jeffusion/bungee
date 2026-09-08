import type { Migration } from '../migration.types';

export const migration: Migration = {
  version: '004',
  name: 'add_protocol_outcome',
  up: (db) => {
    db.run('ALTER TABLE access_logs ADD COLUMN protocol_outcome TEXT');
    db.run('ALTER TABLE access_logs ADD COLUMN protocol_code TEXT');
    db.run('CREATE INDEX IF NOT EXISTS idx_protocol_outcome ON access_logs(protocol_outcome)');
  },
};
