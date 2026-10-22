import type { Database } from 'bun:sqlite';

export const LLM_TPS_MODEL = {
  version: '003',
  name: 'llm_tps_model',
  up(db: Database): void {
    db.run(`ALTER TABLE llm_tps_samples ADD COLUMN model TEXT
      CHECK (model IS NULL OR (typeof(model) = 'text' AND length(trim(model)) > 0))`);
  },
};
