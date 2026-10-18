import type { Database } from 'bun:sqlite';
import { UI_MENUS_MIGRATION } from './ui-menus';
import { CONFIG_BASELINE } from './baseline';
import { PUBLICATION_RETIREMENT_MIGRATION } from './publication-retirement';

export interface ConfigMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: Database) => void;
}

/** Frozen baseline. Append future migrations starting at 2; never rewrite applied entries. */
export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [CONFIG_BASELINE, PUBLICATION_RETIREMENT_MIGRATION, UI_MENUS_MIGRATION];
export const CONFIG_SCHEMA_VERSION = CONFIG_MIGRATIONS.at(-1)!.version;
