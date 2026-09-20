import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

const MAX_SAFE_INTEGER_SQL = '9007199254740991';

export const CONFIG_MIGRATION_V7 = {
  version: 7,
  name: 'reconnect_supervision_state',
  up(db: Database): void {
    db.run(`CREATE TABLE supervision_state (
      id INTEGER PRIMARY KEY CHECK(id=1),
      instance_id TEXT NOT NULL UNIQUE CHECK(length(instance_id)=36),
      controller_epoch INTEGER NOT NULL CHECK(controller_epoch >= 0 AND controller_epoch < ${MAX_SAFE_INTEGER_SQL}),
      current_controller_id TEXT,
      updated_at INTEGER NOT NULL CHECK(updated_at >= 0 AND updated_at < ${MAX_SAFE_INTEGER_SQL})
    ) STRICT, WITHOUT ROWID`);
    db.run(`INSERT INTO supervision_state
      (id,instance_id,controller_epoch,current_controller_id,updated_at)
      VALUES (1,?,0,NULL,0)`, [randomUUID()]);
    db.run('INSERT INTO schema_migrations (version,name) VALUES (?,?)', [this.version, this.name]);
  },
} as const;
