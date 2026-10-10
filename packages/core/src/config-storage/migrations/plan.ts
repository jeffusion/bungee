import type { Database } from 'bun:sqlite';
import { CONFIG_BASELINE } from './baseline';

export interface ConfigMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: Database) => void;
}

/** Frozen baseline. Append future migrations starting at 2; never rewrite applied entries. */
export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [CONFIG_BASELINE];
export const CONFIG_SCHEMA_VERSION = CONFIG_MIGRATIONS.at(-1)!.version;
