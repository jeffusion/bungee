import { ACCESS_BASELINE } from './baseline';
import type { Migration } from './migration.types';
/** Frozen current baseline; append future migrations starting at 002. */
export const migrations: readonly Migration[] = [ACCESS_BASELINE];
export type { Migration, MigrationResult, MigrationRecord } from './migration.types';
export { MigrationManager } from './migration-manager';
