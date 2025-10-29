import type { Database } from 'bun:sqlite';

/**
 * Migration definition interface
 */
export interface Migration {
  /** Migration version (e.g., "001", "002") */
  version: string;

  /** Migration name (e.g., "initial_schema", "add_failover_fields") */
  name: string;

  /** Migration logic to apply changes */
  up: (db: Database) => void;
}

/**
 * Migration result returned by MigrationManager
 */
export interface MigrationResult {
  /** Whether migration succeeded */
  success: boolean;

  /** Whether the migration was automatically recovered from an error */
  recovered?: boolean;

  /** Fallback mode if migration failed */
  fallback?: 'readonly';

  /** User-friendly error message (for display in UI/console) */
  userMessage?: string;

  /** Technical error message (for logging) */
  error?: string;
}

/**
 * Migration record stored in schema_migrations table
 */
export interface MigrationRecord {
  version: string;
  name: string;
  applied_at: number;
}
