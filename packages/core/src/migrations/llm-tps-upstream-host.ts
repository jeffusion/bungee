import type { Database } from 'bun:sqlite';

export const LLM_TPS_UPSTREAM_HOST = {
  version: '004',
  name: 'llm_tps_upstream_host',
  up(db: Database): void {
    db.run(`ALTER TABLE llm_tps_samples ADD COLUMN upstream_host TEXT
      CHECK (upstream_host IS NULL OR (typeof(upstream_host) = 'text' AND length(upstream_host) > 0
        AND instr(upstream_host, char(0)) = 0
        AND upstream_host NOT GLOB ('*[' || char(1) || '-' || char(32) || char(127) || ']*')
        AND upstream_host NOT GLOB '*[/\\@?#]*'))`);
  },
};
