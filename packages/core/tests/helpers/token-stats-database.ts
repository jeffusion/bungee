import type { Database } from 'bun:sqlite';
import { initializePluginStateDatabase } from '../../src/plugin-state/schema';
import { ACCESS_BASELINE } from '../../src/migrations/baseline';
/** In-memory component fixture; production stores these tables in separate files. */
export function initializeTokenStatsTestDatabase(db:Database):void {
  initializePluginStateDatabase(db);
  ACCESS_BASELINE.up(db);
}
