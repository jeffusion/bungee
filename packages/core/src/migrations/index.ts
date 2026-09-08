/**
 * Migration registry
 *
 * All migrations must be imported and added to the migrations array in order.
 * Migrations are executed in the order they appear in this array.
 */

import { migration as m001 } from './versions/001_initial_schema_with_failover';
import { migration as m002 } from './versions/002_add_plugin_storage';
import { migration as m003 } from './versions/003_add_plugin_registry';
import { migration as m004 } from './versions/004_add_protocol_outcome';
import type { Migration } from './migration.types';

/**
 * Ordered list of all migrations
 *
 * IMPORTANT: Migrations must be added in sequential order.
 * Do not reorder or remove existing migrations.
 */
export const migrations: Migration[] = [
  m001, // initial_schema_with_failover (includes all fields including request_type)
  m002, // add_plugin_storage
  m003, // add_plugin_registry
  m004, // add_protocol_outcome
];

// Re-export types and manager for convenience
export type { Migration, MigrationResult, MigrationRecord } from './migration.types';
export { MigrationManager } from './migration-manager';
