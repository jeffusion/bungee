import type { AppConfig } from '@jeffusion/bungee-types';

export const LATEST_CONFIG_VERSION = 2;

export type MigrationChangeType = 'rename' | 'move' | 'delete' | 'normalize' | 'default';

export interface MigrationChange {
  type: MigrationChangeType;
  path: string;
  from?: unknown;
  to?: unknown;
  message: string;
}

export interface MigrationWarning {
  path: string;
  message: string;
}

export interface MigrationResult<TConfig = unknown> {
  config: TConfig;
  changes: MigrationChange[];
  warnings: MigrationWarning[];
}

export interface ConfigMigration {
  fromVersion: number;
  toVersion: number;
  description: string;
  migrate(input: unknown): MigrationResult;
}

export interface AppConfigV1 extends Omit<AppConfig, 'routes'> {
  configVersion?: number;
  routes: Array<Record<string, any>>;
}

export interface LatestAppConfig extends AppConfig {
  configVersion: typeof LATEST_CONFIG_VERSION;
}

export interface MigrateToLatestResult extends MigrationResult<LatestAppConfig> {
  originalVersion: number;
  finalVersion: number;
}
