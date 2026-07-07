import { logger } from './logger';
import type { AppConfig, AuthConfig, RouteConfig, Service } from '@jeffusion/bungee-types';
import fs from 'fs';
import path from 'path';
import { migrateConfigToLatest } from './config-migrations/migrate-config';
import { LegacyCompatAdapter } from './compat/legacy-plugin-adapter';
import { resolveEffectiveRouteEndpoints } from './utils/endpoint-resolver';

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

function normalizeRouteConfig(route: RouteConfig, services?: Service[]): RouteConfig {
  route.timeouts ??= {};

  const endpoints = resolveEffectiveRouteEndpoints(route, services);
  route.endpoints = endpoints;

  for (const endpoint of endpoints) {
    if (endpoint.weight === undefined) {
      endpoint.weight = 100;
    }
    if (endpoint.priority === undefined) {
      endpoint.priority = 1;
    }
  }

  return route;
}

function validateLoadBalancing(service: Service): void {
  const lb = service.load_balancing;
  if (!lb) return;

  const validPolicies = ['weighted_random', 'round_robin', 'least_requests', 'consistent_hash'];
  if (!validPolicies.includes(lb.policy)) {
    logger.error(`Invalid load_balancing.policy "${lb.policy}" in service "${service.name}". Must be one of: ${validPolicies.join(', ')}`);
    process.exit(1);
  }

  if (lb.policy === 'consistent_hash') {
    const hp = lb.hash_policy;
    if (!hp || (!hp.header && !hp.expression)) {
      logger.error(`Service "${service.name}" with policy=consistent_hash requires hash_policy with at least one of header or expression.`);
      process.exit(1);
    }
    if (hp.header !== undefined && typeof hp.header !== 'string') {
      logger.error(`Invalid load_balancing.hash_policy.header in service "${service.name}". Must be a string.`);
      process.exit(1);
    }
    if (hp.expression !== undefined && typeof hp.expression !== 'string') {
      logger.error(`Invalid load_balancing.hash_policy.expression in service "${service.name}". Must be a string.`);
      process.exit(1);
    }
  }
}

function validateFailoverConfig(service: Service): void {
  const failover = service.failover;
  if (!failover) {
    return;
  }

  if (typeof failover.enabled !== 'boolean') {
    logger.error(`Invalid failover.enabled in service "${service.name}". failover.enabled must be a boolean.`);
    process.exit(1);
  }

  if (service.endpoints.length < 2 && failover.enabled) {
    logger.warn(`Service "${service.name}" has failover enabled but less than 2 endpoints. Failover will not be active.`);
  }

  if (failover.recovery?.backoff_base_ms !== undefined) {
    ensurePositiveNumber(failover.recovery.backoff_base_ms, 'failover.recovery.backoff_base_ms', `service "${service.name}"`);
  }

  if (failover.recovery?.probe_timeout_ms !== undefined) {
    ensurePositiveNumber(failover.recovery.probe_timeout_ms, 'failover.recovery.probe_timeout_ms', `service "${service.name}"`);
  }

  if (failover.passive_health?.consecutive_failures !== undefined) {
    ensurePositiveNumber(failover.passive_health.consecutive_failures, 'failover.passive_health.consecutive_failures', `service "${service.name}"`);
  }

  if (failover.passive_health?.healthy_successes !== undefined) {
    ensurePositiveNumber(failover.passive_health.healthy_successes, 'failover.passive_health.healthy_successes', `service "${service.name}"`);
  }

  if (failover.passive_health?.auto_disable_threshold !== undefined) {
    ensurePositiveNumber(failover.passive_health.auto_disable_threshold, 'failover.passive_health.auto_disable_threshold', `service "${service.name}"`);
  }

  if (failover.slow_start) {
    if (typeof failover.slow_start.enabled !== 'boolean') {
      logger.error(`Invalid failover.slow_start.enabled in service "${service.name}". It must be a boolean.`);
      process.exit(1);
    }
    if (failover.slow_start.duration_ms !== undefined) {
      ensurePositiveNumber(failover.slow_start.duration_ms, 'failover.slow_start.duration_ms', `service "${service.name}"`);
    }
    if (failover.slow_start.initial_weight_factor !== undefined) {
      const factor = failover.slow_start.initial_weight_factor;
      if (typeof factor !== 'number' || Number.isNaN(factor) || factor <= 0 || factor > 1) {
        logger.error(`failover.slow_start.initial_weight_factor in service "${service.name}" must be between 0 and 1.`);
        process.exit(1);
      }
    }
  }
}

function validateServiceHealthCheck(service: Service): void {
  const hc = service.health_check;
  if (!hc) return;
  if (typeof hc.enabled !== 'boolean') {
    logger.error(`Invalid health_check.enabled in service "${service.name}". It must be a boolean.`);
    process.exit(1);
  }
  if (hc.interval_ms !== undefined) ensurePositiveNumber(hc.interval_ms, 'health_check.interval_ms', `service "${service.name}"`);
  if (hc.timeout_ms !== undefined) ensurePositiveNumber(hc.timeout_ms, 'health_check.timeout_ms', `service "${service.name}"`);
  if (hc.unhealthy_threshold !== undefined) ensurePositiveNumber(hc.unhealthy_threshold, 'health_check.unhealthy_threshold', `service "${service.name}"`);
  if (hc.healthy_threshold !== undefined) ensurePositiveNumber(hc.healthy_threshold, 'health_check.healthy_threshold', `service "${service.name}"`);
  if (hc.auto_enable_on_active_health_check !== undefined && typeof hc.auto_enable_on_active_health_check !== 'boolean') {
    logger.error(`Invalid health_check.auto_enable_on_active_health_check in service "${service.name}". It must be a boolean.`);
    process.exit(1);
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

function validateServices(services: Service[]): void {
  const names = new Set<string>();
  for (const service of services) {
    if (!service.name || typeof service.name !== 'string') {
      logger.error('Each service must have a non-empty "name" string.');
      process.exit(1);
    }
    if (names.has(service.name)) {
      logger.error(`Duplicate service name: "${service.name}". Service names must be unique.`);
      process.exit(1);
    }
    names.add(service.name);

    if (!service.endpoints || !Array.isArray(service.endpoints) || service.endpoints.length === 0) {
      logger.error(`Service "${service.name}" must have a non-empty "endpoints" array.`);
      process.exit(1);
    }

    for (const endpoint of service.endpoints) {
      if (typeof endpoint.target !== 'string') {
        logger.error(`Invalid endpoint in service "${service.name}". Each endpoint must have a string "target".`);
        process.exit(1);
      }
    }

    validateLoadBalancing(service);
    validateFailoverConfig(service);
    validateServiceTimeouts(service);
    validateServiceHealthCheck(service);
  }
}

function validateServiceTimeouts(service: Service): void {
  const t = service.timeouts;
  if (!t) return;
  if (t.connect_ms !== undefined) ensurePositiveNumber(t.connect_ms, 'timeouts.connect_ms', `service "${service.name}"`);
  if (t.send_ms !== undefined) ensurePositiveNumber(t.send_ms, 'timeouts.send_ms', `service "${service.name}"`);
  if (t.read_ms !== undefined) ensurePositiveNumber(t.read_ms, 'timeouts.read_ms', `service "${service.name}"`);
}

function validateAndNormalizeConfig(config: AppConfig): AppConfig {
  if (!config.routes || !Array.isArray(config.routes)) {
    logger.error('Error: "routes" is not defined or not an array in config.json.');
    process.exit(1);
  }

  if (config.services && Array.isArray(config.services)) {
    validateServices(config.services);
  }

  if (config.auth) {
    validateAuthConfig(config.auth, 'global');
  }

  for (const route of config.routes) {
    const hasEndpoints = route.endpoints && route.endpoints.length > 0;
    const hasServiceRef = !!route.service;

  const hasDirectResponse = !!(route as any).direct_response?.enabled;
  const hasRedirect = !!(route as any).redirect?.enabled;
  const hasResponseRules = !!(route as any).response_rules?.some((rule: any) => rule.enabled);

  if (!hasEndpoints && !hasServiceRef && !hasDirectResponse && !hasRedirect && !hasResponseRules) {
    logger.error(`Route for path "${route.path}" must have "endpoints", "service", "response_rules", "direct_response", or "redirect" defined.`);
      process.exit(1);
    }

    if (hasServiceRef) {
      const svc = config.services?.find(s => s.name === route.service);
      if (!svc) {
        logger.error(`Route "${route.path}" references unknown service "${route.service}".`);
        process.exit(1);
      }
    }

    if (route.auth) {
      validateAuthConfig(route.auth, `route "${route.path}"`);
    }

    normalizeRouteConfig(route, config.services);

    if (route.timeouts?.request_ms !== undefined) {
      ensurePositiveNumber(route.timeouts.request_ms, 'timeouts.request_ms', `route "${route.path}"`);
    }

  const endpoints = resolveEffectiveRouteEndpoints(route, config.services);

  if (endpoints.length > 0) {
    let total_weight = 0;
    for (const endpoint of endpoints) {
      if (typeof endpoint.target !== 'string') {
        logger.error(`Invalid endpoint in route for path "${route.path}". Each endpoint must have a string "target".`);
        process.exit(1);
      }

      if (typeof endpoint.weight !== 'number' || endpoint.weight <= 0) {
        logger.error(`Invalid weight in route for path "${route.path}". Weight must be a positive number.`);
        process.exit(1);
      }

      if (typeof endpoint.priority !== 'number' || endpoint.priority <= 0) {
        logger.error(`Invalid priority in route for path "${route.path}". Priority must be a positive number.`);
        process.exit(1);
      }

      total_weight += endpoint.weight;
    }

    if (total_weight === 0) {
      logger.error(`Total weight for endpoints in route "${route.path}" cannot be zero.`);
      process.exit(1);
    }
  }  }

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
        jsonKey: 'log_level',
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
        jsonKey: 'body_parser_limit',
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
        config_version: 4,
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

    const adapted = LegacyCompatAdapter.adaptConfig(migrated.config);

    return validateAndNormalizeConfig(adapted);
  } catch (error) {
    logger.fatal({ error }, 'Failed to load or parse config.json. Please ensure it exists and is valid JSON.');
    process.exit(1);
  }
}

export { loadConfig, preloadGlobalConfig, updateConfig, validateAndNormalizeConfig };
