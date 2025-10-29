/**
 * Migration registry
 *
 * All migrations must be imported and added to the migrations array in order.
 * Migrations are executed in the order they appear in this array.
 */

import { migration as m001 } from './versions/001_initial_schema_with_failover';
import type { Migration } from './migration.types';

/**
 * Ordered list of all migrations
 *
 * IMPORTANT: Migrations must be added in sequential order.
 * Do not reorder or remove existing migrations.
 */
export const migrations: Migration[] = [
  m001, // initial_schema_with_failover (includes all fields including request_type)
];

// Re-export types and manager for convenience
export type { Migration, MigrationResult, MigrationRecord } from './migration.types';
export { MigrationManager } from './migration-manager';
