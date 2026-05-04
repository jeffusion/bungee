import { logger } from './logger';
import type { AppConfig, AuthConfig, FailoverConfig, RouteConfig } from '@jeffusion/bungee-types';
import fs from 'fs';
import path from 'path';
import { migrateConfigToLatest } from './config-migrations/migrate-config';

interface ConfigMapping {
  jsonKey: string;
  envKey: string;
  default: string;
  validate?: (value: string) => boolean;
}

function ensurePositiveNumber(value: unknown, field: string, context: string): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    logger.error(`${field} in ${context} must be a positive number.`);
    process.exit(1);
  }
  return value;
}

function normalizeRouteConfig(route: RouteConfig): RouteConfig {
  route.timeouts ??= {};
  route.failover ??= undefined;

  for (const upstream of route.upstreams) {
    if (upstream.weight === undefined) {
      upstream.weight = 100;
    }
    if (upstream.priority === undefined) {
      upstream.priority = 1;
    }
  }

  return route;
}

function validateStickySession(route: RouteConfig): void {
  if (route.stickySession === undefined) {
    return;
  }

  if (typeof route.stickySession !== 'object' || route.stickySession === null || Array.isArray(route.stickySession)) {
    logger.error(`Invalid stickySession config in route "${route.path}". stickySession must be an object.`);
    process.exit(1);
  }

  if (route.stickySession.enabled !== undefined && typeof route.stickySession.enabled !== 'boolean') {
    logger.error(`Invalid stickySession.enabled in route "${route.path}". stickySession.enabled must be a boolean.`);
    process.exit(1);
  }

  if (route.stickySession.keyExpression !== undefined && typeof route.stickySession.keyExpression !== 'string') {
    logger.error(`Invalid stickySession.keyExpression in route "${route.path}". stickySession.keyExpression must be a string.`);
    process.exit(1);
  }
}

function validateFailoverConfig(route: RouteConfig): void {
  const failover = route.failover;
  if (!failover) {
    return;
  }

  if (typeof failover.enabled !== 'boolean') {
    logger.error(`Invalid failover.enabled in route "${route.path}". failover.enabled must be a boolean.`);
    process.exit(1);
  }

  if (route.upstreams.length < 2 && failover.enabled) {
    logger.warn(`Route for path "${route.path}" has failover enabled but less than 2 upstreams. Failover will not be active.`);
  }

  if (route.timeouts?.connectMs !== undefined) {
    ensurePositiveNumber(route.timeouts.connectMs, 'timeouts.connectMs', `route "${route.path}"`);
  }

  if (route.timeouts?.requestMs !== undefined) {
    ensurePositiveNumber(route.timeouts.requestMs, 'timeouts.requestMs', `route "${route.path}"`);
  }

  if (failover.recovery?.probeIntervalMs !== undefined) {
    ensurePositiveNumber(failover.recovery.probeIntervalMs, 'failover.recovery.probeIntervalMs', `route "${route.path}"`);
  }

  if (failover.recovery?.probeTimeoutMs !== undefined) {
    ensurePositiveNumber(failover.recovery.probeTimeoutMs, 'failover.recovery.probeTimeoutMs', `route "${route.path}"`);
  }

  if (failover.passiveHealth?.consecutiveFailures !== undefined) {
    ensurePositiveNumber(failover.passiveHealth.consecutiveFailures, 'failover.passiveHealth.consecutiveFailures', `route "${route.path}"`);
  }

  if (failover.passiveHealth?.healthySuccesses !== undefined) {
    ensurePositiveNumber(failover.passiveHealth.healthySuccesses, 'failover.passiveHealth.healthySuccesses', `route "${route.path}"`);
  }

  if (failover.passiveHealth?.autoDisableThreshold !== undefined) {
    ensurePositiveNumber(failover.passiveHealth.autoDisableThreshold, 'failover.passiveHealth.autoDisableThreshold', `route "${route.path}"`);
  }

  if (failover.passiveHealth?.autoEnableOnActiveHealthCheck !== undefined && typeof failover.passiveHealth.autoEnableOnActiveHealthCheck !== 'boolean') {
    logger.error(`Invalid failover.passiveHealth.autoEnableOnActiveHealthCheck in route "${route.path}". It must be a boolean.`);
    process.exit(1);
  }

  if (failover.slowStart) {
    if (typeof failover.slowStart.enabled !== 'boolean') {
      logger.error(`Invalid failover.slowStart.enabled in route "${route.path}". It must be a boolean.`);
      process.exit(1);
    }
    if (failover.slowStart.durationMs !== undefined) {
      ensurePositiveNumber(failover.slowStart.durationMs, 'failover.slowStart.durationMs', `route "${route.path}"`);
    }
    if (failover.slowStart.initialWeightFactor !== undefined) {
      const factor = failover.slowStart.initialWeightFactor;
      if (typeof factor !== 'number' || Number.isNaN(factor) || factor <= 0 || factor > 1) {
        logger.error(`failover.slowStart.initialWeightFactor in route "${route.path}" must be between 0 and 1.`);
        process.exit(1);
      }
    }
  }

  if (failover.healthCheck) {
    if (typeof failover.healthCheck.enabled !== 'boolean') {
      logger.error(`Invalid failover.healthCheck.enabled in route "${route.path}". It must be a boolean.`);
      process.exit(1);
    }
    if (failover.healthCheck.intervalMs !== undefined) {
      ensurePositiveNumber(failover.healthCheck.intervalMs, 'failover.healthCheck.intervalMs', `route "${route.path}"`);
    }
    if (failover.healthCheck.timeoutMs !== undefined) {
      ensurePositiveNumber(failover.healthCheck.timeoutMs, 'failover.healthCheck.timeoutMs', `route "${route.path}"`);
    }
    if (failover.healthCheck.unhealthyThreshold !== undefined) {
      ensurePositiveNumber(failover.healthCheck.unhealthyThreshold, 'failover.healthCheck.unhealthyThreshold', `route "${route.path}"`);
    }
    if (failover.healthCheck.healthyThreshold !== undefined) {
      ensurePositiveNumber(failover.healthCheck.healthyThreshold, 'failover.healthCheck.healthyThreshold', `route "${route.path}"`);
    }
  }
}

function validateAuthConfig(authConfig: AuthConfig, context: string): void {
  if (authConfig.enabled === undefined) {
    logger.error(`Auth config in ${context} must have an "enabled" field.`);
    process.exit(1);
  }

  if (!authConfig.enabled) {
    return;
  }

  if (!authConfig.tokens || !Array.isArray(authConfig.tokens)) {
    logger.error(`Auth config in ${context} must have a "tokens" array when enabled.`);
    process.exit(1);
  }

  if (authConfig.tokens.length === 0) {
    logger.error(`Auth config in ${context} must have at least one token in the "tokens" array.`);
    process.exit(1);
  }

  for (let i = 0; i < authConfig.tokens.length; i++) {
    if (typeof authConfig.tokens[i] !== 'string') {
      logger.error(`Token at index ${i} in ${context} auth config must be a string.`);
      process.exit(1);
    }
  }

  logger.debug(`Auth config validated successfully for ${context}`);
}

function validateAndNormalizeConfig(config: AppConfig): AppConfig {
  if (!config.routes || !Array.isArray(config.routes)) {
    logger.error('Error: "routes" is not defined or not an array in config.json.');
    process.exit(1);
  }

  if (config.auth) {
    validateAuthConfig(config.auth, 'global');
  }

  for (const route of config.routes) {
    if (!route.upstreams || route.upstreams.length === 0) {
      logger.error(`Route for path "${route.path}" must have a non-empty "upstreams" array.`);
      process.exit(1);
    }

    if (route.auth) {
      validateAuthConfig(route.auth, `route "${route.path}"`);
    }

    validateStickySession(route);
    validateFailoverConfig(route);
    normalizeRouteConfig(route);

    let totalWeight = 0;
    for (const upstream of route.upstreams) {
      if (typeof upstream.target !== 'string') {
        logger.error(`Invalid upstream in route for path "${route.path}". Each upstream must have a string "target".`);
        process.exit(1);
      }

      if (typeof upstream.weight !== 'number' || upstream.weight <= 0) {
        logger.error(`Invalid weight in route for path "${route.path}". Weight must be a positive number.`);
        process.exit(1);
      }

      if (typeof upstream.priority !== 'number' || upstream.priority <= 0) {
        logger.error(`Invalid priority in route for path "${route.path}". Priority must be a positive number.`);
        process.exit(1);
      }

      totalWeight += upstream.weight;
    }

    if (totalWeight === 0) {
      logger.error(`Total weight for upstreams in route "${route.path}" cannot be zero.`);
      process.exit(1);
    }
  }

  return config;
}

function preloadGlobalConfig(): void {
  try {
    const configPath = process.env.CONFIG_PATH || path.resolve(process.cwd(), 'config.json');

    if (!fs.existsSync(configPath)) {
      console.log(`Config file not found at ${configPath}, using environment variables and defaults.`);
      return;
    }

    const configContent = fs.readFileSync(configPath, 'utf-8');
    const rawConfig = JSON.parse(configContent);
    const config = migrateConfigToLatest(rawConfig).config;

    const configMapping: ConfigMapping[] = [
      {
        jsonKey: 'logLevel',
        envKey: 'LOG_LEVEL',
        default: 'info',
        validate: (value) => ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(value.toLowerCase())
      },
      {
        jsonKey: 'workers',
        envKey: 'WORKER_COUNT',
        default: '2',
        validate: (value) => {
          const num = parseInt(value);
          return !isNaN(num) && num > 0 && num <= 32;
        }
      },
      {
        jsonKey: 'port',
        envKey: 'PORT',
        default: '8088',
        validate: (value) => {
          const num = parseInt(value);
          return !isNaN(num) && num > 0 && num <= 65535;
        }
      },
      {
        jsonKey: 'bodyParserLimit',
        envKey: 'BODY_PARSER_LIMIT',
        default: '50mb'
      }
    ];

    configMapping.forEach(({ jsonKey, envKey, default: defaultValue, validate }) => {
      if (!process.env[envKey]) {
        const configValue = (config as any)[jsonKey];
        const finalValue = configValue !== undefined ? String(configValue) : defaultValue;

        if (validate && !validate(finalValue)) {
          console.warn(`Invalid value for ${jsonKey}: "${finalValue}". Using default: "${defaultValue}"`);
          process.env[envKey] = defaultValue;
        } else {
          process.env[envKey] = finalValue;
        }

        console.log(`Loaded ${envKey}=${process.env[envKey]} from config.json`);
      } else {
        console.log(`Using ${envKey}=${process.env[envKey]} from environment variable`);
      }
    });
  } catch (error) {
    console.error('Failed to preload global config:', error);
    console.log('Falling back to environment variables and defaults.');
  }
}

async function updateConfig(newConfig: AppConfig): Promise<void> {
  const configFilePath = process.env.CONFIG_PATH || 'config.json';
  const migrated = migrateConfigToLatest(newConfig).config;
  await Bun.write(configFilePath, JSON.stringify(migrated, null, 2));
  logger.info('Config updated successfully');
}

async function loadConfig(configPath?: string): Promise<AppConfig> {
  try {
    const configFilePath = configPath || process.env.CONFIG_PATH || 'config.json';

    if (!fs.existsSync(configFilePath)) {
      logger.info(`Config file not found at ${configFilePath}, creating empty configuration`);
      const minimalConfig: AppConfig = {
        configVersion: 2,
        routes: []
      };
      fs.writeFileSync(configFilePath, JSON.stringify(minimalConfig, null, 2), 'utf-8');
      logger.info(`✅ Empty config file created at ${configFilePath}`);
      logger.warn(`⚠️  No routes configured. Please add routes via the web UI at http://localhost:${process.env.PORT || 8088}`);
      logger.info(`📝 Built-in endpoints: /health (health check), / (web UI)`);
    }

    const rawConfig = await Bun.file(configFilePath).json();
    const migrated = migrateConfigToLatest(rawConfig);
    if (migrated.originalVersion !== migrated.finalVersion) {
      logger.info(
        {
          fromVersion: migrated.originalVersion,
          toVersion: migrated.finalVersion,
          changeCount: migrated.changes.length,
        },
        'Config migrated to latest version in memory'
      );
    }

    return validateAndNormalizeConfig(migrated.config);
  } catch (error) {
    logger.fatal({ error }, 'Failed to load or parse config.json. Please ensure it exists and is valid JSON.');
    process.exit(1);
  }
}

export { loadConfig, preloadGlobalConfig, updateConfig, validateAndNormalizeConfig };
