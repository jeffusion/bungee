import { logger } from './logger';
import type { AppConfig, AuthConfig } from '@jeffusion/bungee-shared';
import fs from 'fs';
import path from 'path';

interface ConfigMapping {
  jsonKey: string;
  envKey: string;
  default: string;
  validate?: (value: string) => boolean;
}

/**
 * 预加载全局配置到环境变量
 * 配置优先级：环境变量 > config.json > 默认值
 *
 * 此函数必须在程序最早期执行（在 logger 初始化之前），
 * 因此不能使用 logger，只能使用 console.log
 */
function preloadGlobalConfig(): void {
  try {
    const configPath = process.env.CONFIG_PATH || path.resolve(process.cwd(), 'config.json');

    if (!fs.existsSync(configPath)) {
      console.log(`Config file not found at ${configPath}, using environment variables and defaults.`);
      return;
    }

    const configContent = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configContent);

    // 配置映射：config.json字段 -> 环境变量名 -> 默认值
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
      // 优先级：环境变量 > config.json > 默认值
      if (!process.env[envKey]) {
        const configValue = config[jsonKey];
        const finalValue = configValue !== undefined ? String(configValue) : defaultValue;

        // 验证配置值
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

/**
 * 验证认证配置
 * @param authConfig - 认证配置对象
 * @param context - 配置上下文（用于错误消息）
 */
function validateAuthConfig(authConfig: AuthConfig, context: string): void {
  // 1. 检查必需字段
  if (authConfig.enabled === undefined) {
    logger.error(`Auth config in ${context} must have an "enabled" field.`);
    process.exit(1);
  }

  // 如果未启用，跳过其他验证
  if (!authConfig.enabled) {
    return;
  }

  // 2. 验证 type 字段
  if (!authConfig.type) {
    logger.error(`Auth config in ${context} must have a "type" field when enabled.`);
    process.exit(1);
  }

  if (!['jwt', 'api-key'].includes(authConfig.type)) {
    logger.error(`Invalid auth type "${authConfig.type}" in ${context}. Must be "jwt" or "api-key".`);
    process.exit(1);
  }

  // 3. 验证 tokens 字段
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

  // 4. 验证 jwtOptions（如果提供）
  if (authConfig.jwtOptions) {
    if (authConfig.jwtOptions.verify && !authConfig.jwtOptions.secret) {
      logger.error(`JWT verify is enabled in ${context} but no secret is provided. Please provide "jwtOptions.secret".`);
      process.exit(1);
    }
  }

  logger.debug(`Auth config validated successfully for ${context}`);
}

// --- Configuration Loading ---
async function loadConfig(configPath?: string): Promise<AppConfig> {
  try {
    const path = configPath || process.env.CONFIG_PATH || 'config.json';
    const config: AppConfig = await Bun.file(path).json();

    // Validate config
    if (!config.routes || !Array.isArray(config.routes)) {
      logger.error('Error: "routes" is not defined or not an array in config.json.');
      process.exit(1);
    }

    // Validate global auth config
    if (config.auth) {
      validateAuthConfig(config.auth, 'global');
    }

    // Validate each route
    for (const route of config.routes) {
      if (!route.upstreams || route.upstreams.length === 0) {
        logger.error(`Route for path "${route.path}" must have a non-empty "upstreams" array.`);
        process.exit(1);
      }
      if (route.upstreams.length < 2 && route.failover?.enabled) {
          logger.warn(`Route for path "${route.path}" has failover enabled but less than 2 upstreams. Failover will not be active.`);
      }

      // Validate route-level auth config
      if (route.auth) {
        validateAuthConfig(route.auth, `route "${route.path}"`);
      }
      let totalWeight = 0;
      for (const upstream of route.upstreams) {
        if (typeof upstream.target !== 'string') {
          logger.error(`Invalid upstream in route for path "${route.path}". Each upstream must have a string "target".`);
          process.exit(1);
        }

        // 设置默认 weight 为 100，验证 weight 值
        if (upstream.weight === undefined) {
          upstream.weight = 100;
        } else if (typeof upstream.weight !== 'number' || upstream.weight <= 0) {
          logger.error(`Invalid weight in route for path "${route.path}". Weight must be a positive number.`);
          process.exit(1);
        }

        // 设置默认 priority 为 1，验证 priority 值
        if (upstream.priority === undefined) {
          upstream.priority = 1;
        } else if (typeof upstream.priority !== 'number' || upstream.priority <= 0) {
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
  } catch (error) {
    logger.fatal({ error }, 'Failed to load or parse config.json. Please ensure it exists and is valid JSON.');
    process.exit(1);
  }
}

export { loadConfig, preloadGlobalConfig };