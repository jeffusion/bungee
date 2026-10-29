import type { Database } from 'bun:sqlite';

export const ACCESS_LOG_TRANSPORT_TYPE = {
  version: '005',
  name: 'access_log_transport_type',
  up(db: Database): void {
    db.run(`ALTER TABLE access_logs ADD COLUMN transport_type TEXT
      CHECK (transport_type IS NULL OR transport_type IN ('http', 'websocket'))`);
  },
};
