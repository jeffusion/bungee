import { WEBSOCKET_MESSAGE_SIZE_MIGRATION } from './websocket-message-size';
import { WEBSOCKET_CONNECTIONS_MIGRATION } from './websocket-connections';
import { SERVICE_REFERENCES_MIGRATION } from './service-references';
import type { Database } from 'bun:sqlite';
import { MANAGEMENT_PROTECTION_MIGRATION } from './management-protection';
import { UI_MENUS_MIGRATION } from './ui-menus';
import { CONFIG_BASELINE } from './baseline';
import { PUBLICATION_RETIREMENT_MIGRATION } from './publication-retirement';

export interface ConfigMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: Database) => void;
}

/** Frozen baseline. Append future migrations starting at 2; never rewrite applied entries. */
export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [CONFIG_BASELINE, PUBLICATION_RETIREMENT_MIGRATION, UI_MENUS_MIGRATION, MANAGEMENT_PROTECTION_MIGRATION, SERVICE_REFERENCES_MIGRATION, WEBSOCKET_CONNECTIONS_MIGRATION, WEBSOCKET_MESSAGE_SIZE_MIGRATION];
export const CONFIG_SCHEMA_VERSION = CONFIG_MIGRATIONS.at(-1)!.version;
