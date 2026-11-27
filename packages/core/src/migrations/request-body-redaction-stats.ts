import type { Database } from 'bun:sqlite';

export const REQUEST_BODY_REDACTION_STATS = {
  version: '007',
  name: 'request_body_redaction_stats',
  up(db: Database): void {
    db.run(`CREATE TABLE request_body_redaction_stats (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      processed_requests INTEGER NOT NULL DEFAULT 0 CHECK (processed_requests BETWEEN 0 AND 9007199254740991),
      redacted_requests INTEGER NOT NULL DEFAULT 0 CHECK (redacted_requests BETWEEN 0 AND processed_requests),
      replacements INTEGER NOT NULL DEFAULT 0 CHECK (replacements BETWEEN redacted_requests AND 9007199254740991),
      reporting_incomplete INTEGER NOT NULL DEFAULT 0 CHECK (reporting_incomplete IN (0, 1))
    ) STRICT`);
    db.run('INSERT INTO request_body_redaction_stats (id) VALUES (1)');
  },
};
