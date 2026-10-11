import type { Database } from 'bun:sqlite';
import { ACCESS_SCHEMA_STATEMENTS } from './schema';

export const ACCESS_BASELINE_VERSION = '001';
export const ACCESS_BASELINE_NAME = 'current_access_baseline';
export const ACCESS_BASELINE = {
  version: ACCESS_BASELINE_VERSION,
  name: ACCESS_BASELINE_NAME,
  up(db: Database): void {
    for (const statement of ACCESS_SCHEMA_STATEMENTS) db.run(statement);
  },
};
