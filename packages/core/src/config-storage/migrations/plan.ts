import { WEBSOCKET_MESSAGE_SIZE_MIGRATION } from './websocket-message-size';
import { WEBSOCKET_CONNECTIONS_MIGRATION } from './websocket-connections';
import { SERVICE_REFERENCES_MIGRATION } from './service-references';
import type { Database } from 'bun:sqlite';
import { MANAGEMENT_PROTECTION_MIGRATION } from './management-protection';
import { UI_MENUS_MIGRATION } from './ui-menus';
import { CONFIG_BASELINE } from './baseline';
import { PUBLICATION_RETIREMENT_MIGRATION } from './publication-retirement';
import { PUBLICATION_TARGET_MIGRATION } from './publication-targets';
import { REQUEST_LOGS_DEFAULT_MIGRATION } from './request-logs-default';
import { WORKER_LAUNCH_CAPACITY_MIGRATION } from './worker-launch-capacity';

export interface ConfigMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: Database) => void;
}

/** Frozen baseline. Append future migrations starting at 2; never rewrite applied entries. */
export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [CONFIG_BASELINE, PUBLICATION_RETIREMENT_MIGRATION, UI_MENUS_MIGRATION, MANAGEMENT_PROTECTION_MIGRATION, SERVICE_REFERENCES_MIGRATION, WEBSOCKET_CONNECTIONS_MIGRATION, WEBSOCKET_MESSAGE_SIZE_MIGRATION, PUBLICATION_TARGET_MIGRATION, REQUEST_LOGS_DEFAULT_MIGRATION, WORKER_LAUNCH_CAPACITY_MIGRATION];
export const CONFIG_SCHEMA_VERSION = CONFIG_MIGRATIONS.at(-1)!.version;
