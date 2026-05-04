import { LATEST_CONFIG_VERSION, type ConfigMigration, type MigrationChange, type MigrationWarning } from '../types';
import { cleanupEmptyObjects, cloneJson, deleteAtPath, getAtPath, isPlainRecord, setAtPath } from '../utils';

const LEGACY_FIELD_MAPPINGS = [
  ['failover.requestTimeoutMs', 'timeouts.requestMs'],
  ['failover.connectTimeoutMs', 'timeouts.connectMs'],
  ['failover.retryableStatusCodes', 'failover.retryOn'],
  ['failover.consecutiveFailuresThreshold', 'failover.passiveHealth.consecutiveFailures'],
  ['failover.healthyThreshold', 'failover.passiveHealth.healthySuccesses'],
  ['failover.autoDisableThreshold', 'failover.passiveHealth.autoDisableThreshold'],
  ['failover.autoEnableOnHealthCheck', 'failover.passiveHealth.autoEnableOnActiveHealthCheck'],
  ['failover.recoveryIntervalMs', 'failover.recovery.probeIntervalMs'],
  ['failover.recoveryTimeoutMs', 'failover.recovery.probeTimeoutMs'],
] as const;

function hasAnyValue(route: Record<string, any>, paths: readonly string[]): boolean {
  return paths.some((path) => getAtPath(route, path) !== undefined);
}

function moveLegacyField(route: Record<string, any>, fromPath: string, toPath: string, changes: MigrationChange[]): void {
  const currentValue = getAtPath(route, fromPath);
  if (currentValue === undefined) {
    return;
  }

  setAtPath(route, toPath, currentValue);
  deleteAtPath(route, fromPath);
  changes.push({
    type: 'move',
    path: fromPath,
    from: currentValue,
    to: toPath,
    message: `Moved ${fromPath} to ${toPath}`,
  });
}

export const v1ToV2Migration: ConfigMigration = {
  fromVersion: 1,
  toVersion: LATEST_CONFIG_VERSION,
  description: 'Migrate legacy failover route fields to config model v2',
  migrate(input) {
    const config = cloneJson(input);
    if (!isPlainRecord(config)) {
      throw new Error('Config must be an object');
    }

    if (!Array.isArray(config.routes)) {
      throw new Error('Config routes must be an array');
    }

    const changes: MigrationChange[] = [];
    const warnings: MigrationWarning[] = [];
    const newFieldPaths = [
      'timeouts.requestMs',
      'timeouts.connectMs',
      'failover.retryOn',
      'failover.passiveHealth',
      'failover.recovery',
    ];
    const legacyFieldPaths = LEGACY_FIELD_MAPPINGS.map(([fromPath]) => fromPath);

    config.routes = config.routes.map((route, routeIndex) => {
      if (!isPlainRecord(route)) {
        throw new Error(`Route #${routeIndex + 1} must be an object`);
      }

      const migratedRoute = cloneJson(route);
      if (hasAnyValue(migratedRoute, legacyFieldPaths) && hasAnyValue(migratedRoute, newFieldPaths)) {
        throw new Error(`Route "${migratedRoute.path || routeIndex}" mixes legacy and v2 failover fields`);
      }

      for (const [fromPath, toPath] of LEGACY_FIELD_MAPPINGS) {
        moveLegacyField(migratedRoute, fromPath, toPath, changes);
      }

      return cleanupEmptyObjects(migratedRoute);
    });

    config.configVersion = LATEST_CONFIG_VERSION;

    return {
      config: cleanupEmptyObjects(config),
      changes,
      warnings,
    };
  }
};
