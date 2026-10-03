import type { Migration } from '../migration.types';

export const migration: Migration = {
  version: '007',
  name: 'token_stats_key',
  up: db => {
    db.run('ALTER TABLE token_stats_attempts ADD COLUMN key_id TEXT');
    db.run('CREATE INDEX idx_token_stats_attempts_key_finished ON token_stats_attempts(key_id, finished_at_ms)');
  },
};
