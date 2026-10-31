import type { ConfigMigration } from './plan';

export const WEBSOCKET_MESSAGE_SIZE_MIGRATION: ConfigMigration = {
  version: 7,
  name: 'websocket_message_size',
  up(db) {
    // NULL preserves omitted settings and existing revision hashes.
    db.run(`ALTER TABLE settings ADD COLUMN websocket_max_message_bytes INTEGER
      CHECK(websocket_max_message_bytes IS NULL OR (typeof(websocket_max_message_bytes)='integer'
        AND websocket_max_message_bytes BETWEEN 1 AND 2147483647))`);
  },
};
