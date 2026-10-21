import type { Database } from 'bun:sqlite';

export const LLM_TPS_SAMPLES = {
  version: '002',
  name: 'llm_tps_samples',
  up(db: Database): void {
    db.run(`CREATE TABLE llm_tps_samples (
      attempt_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      route_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      finished_at_ms INTEGER NOT NULL CHECK (finished_at_ms >= 0),
      output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
      generation_duration_ms REAL NOT NULL CHECK (generation_duration_ms > 0),
      output_source TEXT NOT NULL CHECK (output_source IN ('official','estimated'))
    )`);
    db.run('CREATE INDEX idx_llm_tps_samples_finished ON llm_tps_samples(finished_at_ms)');
    db.run('CREATE INDEX idx_llm_tps_samples_endpoint ON llm_tps_samples(route_id,endpoint_id,finished_at_ms)');
  },
};
