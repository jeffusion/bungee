import type { Migration } from '../migration.types';

export const migration: Migration = {
  version: '006',
  name: 'upgrade_token_stats_metering',
  up: (db) => {
    // Early v005 deployments lack model/cost columns and reject partial sources.
    // Rebuild in the migration transaction to preserve rows and upgrade CHECKs.
    const columns = new Set(db.query<{ name: string }, []>('PRAGMA table_info(token_stats_attempts)').all().map((column) => column.name));
    const model = columns.has('model') ? 'model' : "'unknown'";
    const cost = columns.has('cost_usd') ? 'cost_usd' : 'NULL';
    db.run(`
      CREATE TABLE token_stats_attempts_v006 (
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
    db.run(`
      INSERT INTO token_stats_attempts_v006 (
        attempt_id, request_id, finished_at_ms, route_id, upstream_id, provider, outcome, model,
        input_tokens, output_tokens, input_source, output_source,
        cache_read_tokens, cache_write_tokens, cost_usd, observation_incomplete
      )
      SELECT attempt_id, request_id, finished_at_ms, route_id, upstream_id, provider, outcome, ${model},
        input_tokens, output_tokens, input_source, output_source,
        cache_read_tokens, cache_write_tokens, ${cost}, observation_incomplete
      FROM token_stats_attempts
    `);
    db.run('DROP TABLE token_stats_attempts');
    db.run('ALTER TABLE token_stats_attempts_v006 RENAME TO token_stats_attempts');
    db.run('CREATE INDEX idx_token_stats_attempts_finished ON token_stats_attempts(finished_at_ms)');
  },
};
