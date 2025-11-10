import type { Plugin, PluginContext } from './plugin.types';
import type { PluginConfig } from '@jeffusion/bungee-shared';
import { logger } from './logger';
import * as path from 'path';
import { PluginPool } from './plugin-pool';

/**
 * Plugin 工厂函数类型
 */
type PluginFactory = new (options: any) => Plugin;

/**
 * Plugin 工厂信息
 */
interface PluginFactoryInfo {
  PluginClass: PluginFactory;
  config: PluginConfig;
  enabled: boolean;
  pooled: boolean; // 是否使用对象池
  pool?: PluginPool<Plugin>; // 对象池实例
}

/**
 * Plugin 注册表
 * 负责加载、管理和执行 plugins
 *
 * 生命周期策略：
 * - 默认：每个请求创建新的 plugin 实例（完全隔离）
 * - 可选：使用 @Pooled 装饰器的 plugin 采用对象池复用
 */
export class PluginRegistry {
  private pluginFactories: Map<string, PluginFactoryInfo> = new Map();
  private configBasePath: string;

  constructor(configBasePath: string = process.cwd()) {
    this.configBasePath = configBasePath;
  }

  /**
   * 从配置加载 plugins
   */
  async loadPlugins(configs: Array<PluginConfig | string>): Promise<void> {
    for (const config of configs) {
      try {
        if (typeof config === 'string') {
          // Load string reference as transformer plugin
          await this.loadTransformerPlugin(config);
        } else {
          // Load full PluginConfig
          await this.loadPlugin(config);
        }
      } catch (error) {
        logger.error(
          { error, pluginConfig: config },
          'Failed to load plugin, skipping'
        );
      }
    }
  }

  /**
   * 加载单个 plugin（存储工厂信息而不是实例）
   * @returns 插件名称
   */
  async loadPlugin(config: PluginConfig): Promise<string> {
    const enabled = config.enabled !== false; // 默认启用

    // 解析 plugin 路径
    const pluginPath = path.isAbsolute(config.path)
      ? config.path
      : path.resolve(this.configBasePath, config.path);

    logger.info({ pluginPath, enabled }, 'Loading plugin');

    // 动态导入 plugin 模块
    const pluginModule = await import(pluginPath);

    // 支持 default export 或 named export
    const PluginClass = pluginModule.default || pluginModule.Plugin;

    if (!PluginClass) {
      throw new Error(`Plugin at ${pluginPath} must export a default class or named export 'Plugin'`);
    }

    // 验证是否为构造函数
    if (typeof PluginClass !== 'function') {
      throw new Error(`Plugin at ${pluginPath} must be a class constructor`);
    }

    // 创建临时实例以获取名称和版本（用于日志）
    const tempInstance = new PluginClass(config.options || {});

    // 验证 plugin 接口
    if (!tempInstance.name) {
      throw new Error(`Plugin at ${pluginPath} must have a 'name' property`);
    }

    // 检测是否使用 @Pooled 装饰器
    const pooled = !!(PluginClass as any).__pooled__;
    const poolOptions = (PluginClass as any).__poolOptions__ || {};

    // 如果启用池化，创建对象池
    let pool: PluginPool<Plugin> | undefined;
    if (pooled) {
      pool = new PluginPool<Plugin>(
        () => new PluginClass(config.options || {}),
        {
          minSize: poolOptions.minSize || 2,
          maxSize: poolOptions.maxSize || 20
        }
      );
      logger.info(
        {
          pluginName: tempInstance.name,
          minSize: poolOptions.minSize || 2,
          maxSize: poolOptions.maxSize || 20
        },
        'Plugin pool created'
      );
    }

    // 注册工厂信息
    const factoryInfo: PluginFactoryInfo = {
      PluginClass,
      config,
      enabled,
      pooled,
      pool
    };

    this.pluginFactories.set(tempInstance.name, factoryInfo);

    logger.info(
      {
        pluginName: tempInstance.name,
        version: tempInstance.version,
        enabled,
        pooled,
        lifecycle: pooled ? 'pooled' : 'per-request'
      },
      'Plugin loaded successfully'
    );

    return tempInstance.name;
  }

  /**
   * 确保插件已加载到 registry 并返回插件名称
   *
   * 支持两种参数类型：
   * - PluginConfig 对象：加载自定义插件
   * - string：加载内置 transformer 插件
   *
   * @param config - 插件配置对象或 transformer 名称
   * @returns 插件名称
   */
  async ensurePluginLoaded(config: PluginConfig | string): Promise<string> {
    if (typeof config === 'string') {
      // 字符串简写，加载内置 transformer plugin
      return await this.loadTransformerPlugin(config);
    }

    // 正常 PluginConfig 对象
    return await this.loadPlugin(config);
  }

  /**
   * 为当前请求创建或获取 plugin 实例（支持池化）
   *
   * 这是主要的实例获取方法：
   * - 非池化 plugin：每次创建新实例
   * - 池化 plugin：从对象池获取实例
   *
   * @param pluginNames 要获取的 plugin 名称列表（如果为空则获取所有启用的）
   * @returns Plugin 实例数组和清理函数
   */
  async acquirePluginInstances(pluginNames?: string[]): Promise<{
    plugins: Plugin[];
    release: () => Promise<void>;
  }> {
    const targetNames = pluginNames || Array.from(this.pluginFactories.keys());
    const instances: Plugin[] = [];
    const pooledInstances: Array<{ plugin: Plugin; poolName: string }> = [];

    for (const name of targetNames) {
      const factoryInfo = this.pluginFactories.get(name);

      if (!factoryInfo || !factoryInfo.enabled) {
        continue;
      }

      if (factoryInfo.pooled && factoryInfo.pool) {
        // 从池中获取实例
        try {
          const instance = await factoryInfo.pool.acquire();
          instances.push(instance);
          pooledInstances.push({ plugin: instance, poolName: name });
        } catch (error) {
          logger.error(
            { error, pluginName: name },
            'Failed to acquire plugin from pool'
          );
        }
      } else {
        // 创建新实例
        try {
          const instance = new factoryInfo.PluginClass(factoryInfo.config.options || {});
          instances.push(instance);
        } catch (error) {
          logger.error(
            { error, pluginName: name },
            'Failed to create plugin instance'
          );
        }
      }
    }

    // 返回实例和清理函数
    const release = async (): Promise<void> => {
      // 归还池化实例
      for (const { plugin, poolName } of pooledInstances) {
        const factoryInfo = this.pluginFactories.get(poolName);
        if (factoryInfo?.pool) {
          try {
            await factoryInfo.pool.release(plugin);
          } catch (error) {
            logger.error(
              { error, pluginName: poolName },
              'Failed to release plugin to pool'
            );
          }
        }
      }

      // 销毁非池化实例
      for (const instance of instances) {
        if (!pooledInstances.some(p => p.plugin === instance)) {
          try {
            if (instance.onDestroy) {
              await instance.onDestroy();
            }
          } catch (error) {
            logger.error(
              { error, pluginName: instance.name },
              'Error during plugin cleanup'
            );
          }
        }
      }
    };

    return { plugins: instances, release };
  }

  /**
   * 为当前请求创建新的 plugin 实例（不使用池化）
   *
   * 仅用于需要强制创建新实例的场景。
   * 大多数情况下应使用 acquirePluginInstances() 方法。
   *
   * @param pluginNames 要创建的 plugin 名称列表（如果为空则创建所有启用的）
   * @returns Plugin 实例数组
   */
  createPluginInstances(pluginNames?: string[]): Plugin[] {
    const targetNames = pluginNames || Array.from(this.pluginFactories.keys());
    const instances: Plugin[] = [];

    for (const name of targetNames) {
      const factoryInfo = this.pluginFactories.get(name);

      if (!factoryInfo || !factoryInfo.enabled) {
        continue;
      }

      try {
        const instance = new factoryInfo.PluginClass(factoryInfo.config.options || {});
        instances.push(instance);
      } catch (error) {
        logger.error(
          { error, pluginName: name },
          'Failed to create plugin instance'
        );
      }
    }

    return instances;
  }

  /**
   * 获取所有启用的 plugins
   * @deprecated 此方法返回临时实例仅用于兼容性，新代码应使用 acquirePluginInstances()
   */
  getEnabledPlugins(): Plugin[] {
    logger.warn('getEnabledPlugins() is deprecated, use acquirePluginInstances() instead');
    return this.createPluginInstances();
  }

  /**
   * 根据名称获取 plugin（创建临时实例）
   * @deprecated 此方法创建临时实例仅用于兼容性，新代码应使用 acquirePluginInstances()
   */
  getPlugin(name: string): Plugin | undefined {
    logger.warn('getPlugin() is deprecated, use acquirePluginInstances() instead');
    const factoryInfo = this.pluginFactories.get(name);
    if (!factoryInfo || !factoryInfo.enabled) {
      return undefined;
    }
    try {
      return new factoryInfo.PluginClass(factoryInfo.config.options || {});
    } catch (error) {
      logger.error({ error, pluginName: name }, 'Failed to create plugin instance');
      return undefined;
    }
  }

  /**
   * 启用 plugin
   */
  enablePlugin(name: string): boolean {
    const factoryInfo = this.pluginFactories.get(name);
    if (factoryInfo) {
      factoryInfo.enabled = true;
      logger.info({ pluginName: name }, 'Plugin enabled');
      return true;
    }
    return false;
  }

  /**
   * 禁用 plugin
   */
  disablePlugin(name: string): boolean {
    const factoryInfo = this.pluginFactories.get(name);
    if (factoryInfo) {
      factoryInfo.enabled = false;
      logger.info({ pluginName: name }, 'Plugin disabled');
      return true;
    }
    return false;
  }

  /**
   * 卸载所有 plugins（销毁对象池）
   */
  async unloadAll(): Promise<void> {
    // 销毁所有对象池和非池化插件
    for (const [name, factoryInfo] of this.pluginFactories.entries()) {
      if (factoryInfo.pool) {
        // 池化插件：销毁整个池
        try {
          await factoryInfo.pool.destroy();
          logger.info({ pluginName: name }, 'Plugin pool destroyed');
        } catch (error) {
          logger.error({ error, pluginName: name }, 'Error destroying plugin pool');
        }
      } else {
        // 非池化插件：创建临时实例并调用 onDestroy（用于清理全局资源）
        try {
          const tempInstance = new factoryInfo.PluginClass(factoryInfo.config.options || {});
          if (tempInstance.onDestroy) {
            await tempInstance.onDestroy();
            logger.debug({ pluginName: name }, 'Non-pooled plugin cleanup completed');
          }
        } catch (error) {
          logger.error({ error, pluginName: name }, 'Error during non-pooled plugin cleanup');
        }
      }
    }

    this.pluginFactories.clear();
    logger.info('All plugins unloaded');
  }

  /**
   * 执行 onRequestInit 钩子
   */
  async executeOnRequestInit(
    context: PluginContext
  ): Promise<void> {
    const plugins = this.getEnabledPlugins();

    for (const plugin of plugins) {
      if (plugin.onRequestInit) {
        try {
          await plugin.onRequestInit(context);
        } catch (error) {
          logger.error(
            { error, pluginName: plugin.name },
            'Error in onRequestInit hook'
          );
        }
      }
    }
  }

  /**
   * 执行 onBeforeRequest 钩子
   */
  async executeOnBeforeRequest(
    context: PluginContext
  ): Promise<void> {
    const plugins = this.getEnabledPlugins();

    for (const plugin of plugins) {
      if (plugin.onBeforeRequest) {
        try {
          await plugin.onBeforeRequest(context);
        } catch (error) {
          logger.error(
            { error, pluginName: plugin.name },
            'Error in onBeforeRequest hook'
          );
        }
      }
    }
  }

  /**
   * 执行 onInterceptRequest 钩子
   * 如果任何 plugin 返回响应，立即返回该响应
   */
  async executeOnInterceptRequest(
    context: PluginContext
  ): Promise<Response | null> {
    const plugins = this.getEnabledPlugins();

    for (const plugin of plugins) {
      if (plugin.onInterceptRequest) {
        try {
          const response = await plugin.onInterceptRequest(context);
          if (response) {
            logger.info({ pluginName: plugin.name }, 'Request intercepted by plugin');
            return response;
          }
        } catch (error) {
          logger.error(
            { error, pluginName: plugin.name },
            'Error in onInterceptRequest hook'
          );
        }
      }
    }

    return null;
  }

  /**
   * 执行 onResponse 钩子
   * 如果 plugin 返回新的 Response，则使用该 Response 替换原响应
   */
  async executeOnResponse(
    context: PluginContext & { response: Response }
  ): Promise<Response> {
    const plugins = this.getEnabledPlugins();
    let currentResponse = context.response;

    for (const plugin of plugins) {
      if (plugin.onResponse) {
        try {
          const result = await plugin.onResponse({
            ...context,
            response: currentResponse
          });

          // 如果 plugin 返回了新的 Response，使用它
          if (result && result instanceof Response) {
            currentResponse = result;
            logger.info(
              { pluginName: plugin.name },
              'Plugin returned modified response'
            );
          }
        } catch (error) {
          logger.error(
            { error, pluginName: plugin.name },
            'Error in onResponse hook'
          );
        }
      }
    }

    return currentResponse;
  }

  /**
   * 执行 onError 钩子
   */
  async executeOnError(
    context: PluginContext & { error: Error }
  ): Promise<void> {
    const plugins = this.getEnabledPlugins();

    for (const plugin of plugins) {
      if (plugin.onError) {
        try {
          await plugin.onError(context);
        } catch (error) {
          logger.error(
            { error, pluginName: plugin.name },
            'Error in onError hook'
          );
        }
      }
    }
  }

  /**
   * 自动加载 transformer plugin
   * 根据 transformer 名称从预定义路径加载对应的 plugin
   * @returns 插件名称
   */
  async loadTransformerPlugin(transformerName: string): Promise<string> {
    // 检查是否已经加载（检查 factory registry）
    const existingFactory = this.pluginFactories.get(transformerName);
    if (existingFactory) {
      // Already loaded, return the plugin name
      return transformerName;
    }

    // 尝试多个可能的路径
    const possiblePaths = [
      // 生产环境路径（相对于编译后的代码）
      path.join(__dirname, 'plugins', 'transformers', `${transformerName}.plugin.ts`),
      // 测试环境路径（相对于项目根目录）
      path.join(this.configBasePath, 'packages/core/src/plugins/transformers', `${transformerName}.plugin.ts`),
      // 源代码路径
      path.resolve(__dirname, '../plugins/transformers', `${transformerName}.plugin.ts`)
    ];

    for (const pluginPath of possiblePaths) {
      try {
        logger.debug({ transformerName, pluginPath }, 'Trying to load transformer plugin');

        await this.loadPlugin({
          path: pluginPath,
          enabled: true
        });

        // Check if loaded successfully
        const factoryInfo = this.pluginFactories.get(transformerName);
        if (factoryInfo) {
          logger.info({ transformerName, pluginPath }, 'Transformer plugin auto-loaded successfully');
          return transformerName;
        }
      } catch (error) {
        // Try next path
        logger.debug({ error, transformerName, pluginPath }, 'Failed to load from this path, trying next');
        continue;
      }
    }

    // All paths failed
    const error = new Error(`Failed to auto-load transformer plugin '${transformerName}' from all paths`);
    logger.error(
      { transformerName, attemptedPaths: possiblePaths, error },
      'Failed to auto-load transformer plugin from all paths'
    );
    throw error;
  }

  /**
   * 执行特定plugin的onRequestInit钩子
   */
  async executePluginOnRequestInit(
    pluginName: string,
    context: PluginContext
  ): Promise<void> {
    const plugin = this.getPlugin(pluginName);
    if (!plugin || !plugin.onRequestInit) {
      return;
    }

    try {
      await plugin.onRequestInit(context);
    } catch (error) {
      logger.error(
        { error, pluginName: plugin.name },
        'Error in onRequestInit hook'
      );
    }
  }

  /**
   * 执行特定plugin的onInterceptRequest钩子
   */
  async executePluginOnInterceptRequest(
    pluginName: string,
    context: PluginContext
  ): Promise<Response | null> {
    const plugin = this.getPlugin(pluginName);
    if (!plugin || !plugin.onInterceptRequest) {
      return null;
    }

    try {
      const response = await plugin.onInterceptRequest(context);
      if (response) {
        logger.info({ pluginName: plugin.name }, 'Request intercepted by plugin');
        return response;
      }
    } catch (error) {
      logger.error(
        { error, pluginName: plugin.name },
        'Error in onInterceptRequest hook'
      );
    }

    return null;
  }

  /**
   * 执行特定plugin的onBeforeRequest钩子
   */
  async executePluginOnBeforeRequest(
    pluginName: string,
    context: PluginContext
  ): Promise<void> {
    const plugin = this.getPlugin(pluginName);
    if (!plugin || !plugin.onBeforeRequest) {
      return;
    }

    try {
      await plugin.onBeforeRequest(context);
    } catch (error) {
      logger.error(
        { error, pluginName: plugin.name },
        'Error in onBeforeRequest hook'
      );
    }
  }

  /**
   * 执行特定plugin的onResponse钩子
   * 如果plugin返回新的Response，则使用该Response替换原响应
   */
  async executePluginOnResponse(
    pluginName: string,
    context: PluginContext & { response: Response }
  ): Promise<Response> {
    const plugin = this.getPlugin(pluginName);
    if (!plugin || !plugin.onResponse) {
      return context.response;
    }

    try {
      const result = await plugin.onResponse(context);
      if (result && result instanceof Response) {
        logger.info({ pluginName: plugin.name }, 'Plugin returned modified response');
        return result;
      }
    } catch (error) {
      logger.error(
        { error, pluginName: plugin.name },
        'Error in onResponse hook'
      );
    }

    return context.response;
  }

  /**
   * 执行特定plugin的onError钩子
   */
  async executePluginOnError(
    pluginName: string,
    context: PluginContext & { error: Error }
  ): Promise<void> {
    const plugin = this.getPlugin(pluginName);
    if (!plugin || !plugin.onError) {
      return;
    }

    try {
      await plugin.onError(context);
    } catch (error) {
      logger.error(
        { error, pluginName: plugin.name },
        'Error in onError hook'
      );
    }
  }
}
