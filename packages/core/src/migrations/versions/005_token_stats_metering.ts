import type { Migration } from '../migration.types';

export const migration: Migration = {
  version: '005',
  name: 'token_stats_metering',
  up: (db) => {
    db.run(`
      DELETE FROM plugin_storage
      WHERE plugin_name = 'token-stats'
        AND substr(key, 1, length('token-stats:v2:')) = 'token-stats:v2:'
    `);
    db.run(`
      CREATE TABLE token_stats_attempts (
        attempt_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        finished_at_ms INTEGER NOT NULL CHECK (finished_at_ms >= 0),
        route_id TEXT NOT NULL,
        upstream_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        outcome TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
        output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
        input_source TEXT NOT NULL CHECK (input_source IN ('usage', 'estimated', 'partial', 'unknown')),
        output_source TEXT NOT NULL CHECK (output_source IN ('usage', 'estimated', 'partial', 'unknown')),
        cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
        cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
        cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
        observation_incomplete INTEGER NOT NULL CHECK (observation_incomplete IN (0, 1)),
        CHECK ((input_source = 'unknown') = (input_tokens IS NULL)),
        CHECK ((output_source = 'unknown') = (output_tokens IS NULL))
      )
    `);
    db.run('CREATE INDEX idx_token_stats_attempts_finished ON token_stats_attempts(finished_at_ms)');
  },
};
