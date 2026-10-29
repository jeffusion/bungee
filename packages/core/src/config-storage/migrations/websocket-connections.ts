import type { ConfigMigration } from './plan';

export const WEBSOCKET_CONNECTIONS_MIGRATION: ConfigMigration = {
  version: 6,
  name: 'websocket_connections',
  up(db) {
    // SQL NULL preserves an omitted setting and its revision hash; JSON null means unlimited.
    db.run(`ALTER TABLE settings ADD COLUMN websocket_max_connections_json TEXT
      CHECK(websocket_max_connections_json IS NULL OR websocket_max_connections_json='null'
        OR (json_valid(websocket_max_connections_json)
          AND json_type(websocket_max_connections_json)='integer'
          AND json_extract(websocket_max_connections_json,'$') BETWEEN 1 AND 2147483647
          AND websocket_max_connections_json=CAST(json_extract(websocket_max_connections_json,'$') AS TEXT)))`);
  },
};
