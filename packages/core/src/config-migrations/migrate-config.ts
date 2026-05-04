import type { ConfigMigration, MigrateToLatestResult, MigrationChange, MigrationWarning } from './types';
import { LATEST_CONFIG_VERSION } from './types';
import { CONFIG_MIGRATIONS } from './index';
import { cloneJson, detectConfigVersion, isPlainRecord } from './utils';

function buildMigrationMap(migrations: ConfigMigration[]): Map<number, ConfigMigration> {
  return new Map(migrations.map(migration => [migration.fromVersion, migration]));
}

export function migrateConfigToLatest(rawConfig: unknown): MigrateToLatestResult {
  const migrationMap = buildMigrationMap(CONFIG_MIGRATIONS);
  const originalVersion = detectConfigVersion(rawConfig);

  let currentVersion = originalVersion;
  let workingConfig = cloneJson(rawConfig);
  const changes: MigrationChange[] = [];
  const warnings: MigrationWarning[] = [];

  while (currentVersion < LATEST_CONFIG_VERSION) {
    const migration = migrationMap.get(currentVersion);
    if (!migration) {
      throw new Error(`No config migration registered from version ${currentVersion}`);
    }

    const result = migration.migrate(workingConfig);
    workingConfig = result.config;
    changes.push(...result.changes);
    warnings.push(...result.warnings);
    currentVersion = migration.toVersion;
  }

  if (!isPlainRecord(workingConfig)) {
    throw new Error('Migrated config must be an object');
  }

  workingConfig.configVersion = LATEST_CONFIG_VERSION;

  return {
    config: workingConfig as MigrateToLatestResult['config'],
    originalVersion,
    finalVersion: LATEST_CONFIG_VERSION,
    changes,
    warnings,
  };
}
