import type { Database } from 'bun:sqlite';

export const ACCESS_LOG_CHAIN_ID_SQL =
  "COALESCE(CASE WHEN transport_type = 'http' THEN access_id ELSE COALESCE(operation_id, access_id) END, parent_request_id, request_id)";

export const ACCESS_LOG_RECORD_IDENTITY = {
  version: '006',
  name: 'access_log_record_identity',
  up(db: Database): void {
    db.run(`ALTER TABLE access_logs ADD COLUMN record_kind TEXT
      CHECK (record_kind IN ('access', 'operation', 'attempt'))`);
    db.run('ALTER TABLE access_logs ADD COLUMN access_id TEXT');
    db.run('ALTER TABLE access_logs ADD COLUMN operation_id TEXT');
    db.run('ALTER TABLE access_logs ADD COLUMN protocol TEXT');
    db.run('ALTER TABLE access_logs ADD COLUMN operation TEXT');
    db.run('ALTER TABLE access_logs ADD COLUMN close_code INTEGER');
    db.run(`ALTER TABLE access_logs ADD COLUMN observation_outcome TEXT
      CHECK (observation_outcome IN ('complete', 'incomplete'))`);
    db.run('CREATE INDEX idx_access_log_access_id ON access_logs(access_id) WHERE access_id IS NOT NULL');
    db.run('CREATE INDEX idx_access_log_operation_id ON access_logs(operation_id) WHERE operation_id IS NOT NULL');
    db.run(`CREATE INDEX idx_access_log_chain_id ON access_logs(${ACCESS_LOG_CHAIN_ID_SQL})`);
  },
};
