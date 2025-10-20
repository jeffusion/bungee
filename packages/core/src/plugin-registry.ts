import type { Plugin, PluginContext } from './plugin.types';
import type { PluginConfig } from '@jeffusion/bungee-shared';
import { logger } from './logger';
import * as path from 'path';

/**
 * Plugin 实例包装器
 */
interface PluginInstance {
  plugin: Plugin;
  config: PluginConfig;
  enabled: boolean;
}

/**
 * Plugin 注册表
 * 负责加载、管理和执行 plugins
 */
export class PluginRegistry {
  private plugins: Map<string, PluginInstance> = new Map();
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
   * 加载单个 plugin
   */
  async loadPlugin(config: PluginConfig): Promise<void> {
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

    // 实例化 plugin
    const pluginInstance: Plugin = typeof PluginClass === 'function'
      ? new PluginClass(config.options || {})
      : PluginClass;

    // 验证 plugin 接口
    if (!pluginInstance.name) {
      throw new Error(`Plugin at ${pluginPath} must have a 'name' property`);
    }

    // 注册 plugin
    const instance: PluginInstance = {
      plugin: pluginInstance,
      config,
      enabled
    };

    this.plugins.set(pluginInstance.name, instance);

    logger.info(
      {
        pluginName: pluginInstance.name,
        version: pluginInstance.version,
        enabled
      },
      'Plugin loaded successfully'
    );
  }

  /**
   * 获取所有启用的 plugins
   */
  getEnabledPlugins(): Plugin[] {
    return Array.from(this.plugins.values())
      .filter(instance => instance.enabled)
      .map(instance => instance.plugin);
  }

  /**
   * 根据名称获取 plugin
   */
  getPlugin(name: string): Plugin | undefined {
    const instance = this.plugins.get(name);
    return instance?.enabled ? instance.plugin : undefined;
  }

  /**
   * 启用 plugin
   */
  enablePlugin(name: string): boolean {
    const instance = this.plugins.get(name);
    if (instance) {
      instance.enabled = true;
      logger.info({ pluginName: name }, 'Plugin enabled');
      return true;
    }
    return false;
  }

  /**
   * 禁用 plugin
   */
  disablePlugin(name: string): boolean {
    const instance = this.plugins.get(name);
    if (instance) {
      instance.enabled = false;
      logger.info({ pluginName: name }, 'Plugin disabled');
      return true;
    }
    return false;
  }

  /**
   * 卸载所有 plugins
   */
  async unloadAll(): Promise<void> {
    const plugins = this.getEnabledPlugins();

    for (const plugin of plugins) {
      try {
        if (plugin.onDestroy) {
          await plugin.onDestroy();
        }
      } catch (error) {
        logger.error({ error, pluginName: plugin.name }, 'Error during plugin cleanup');
      }
    }

    this.plugins.clear();
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
   * 从配置加载单个 plugin
   * 支持字符串简写（引用内置 transformer plugin）
   */
  async loadPluginFromConfig(config: PluginConfig | string): Promise<Plugin | null> {
    if (typeof config === 'string') {
      // 字符串简写，加载内置 transformer plugin
      logger.debug({ pluginName: config }, 'Loading plugin from string reference');
      return await this.loadTransformerPlugin(config);
    }

    // 正常 PluginConfig 对象
    await this.loadPlugin(config);

    // 获取 plugin 名称
    const pluginPath = path.isAbsolute(config.path)
      ? config.path
      : path.resolve(this.configBasePath, config.path);

    try {
      const pluginModule = await import(pluginPath);
      const PluginClass = pluginModule.default || pluginModule.Plugin;
      const pluginInstance: Plugin = typeof PluginClass === 'function'
        ? new PluginClass(config.options || {})
        : PluginClass;

      return this.getPlugin(pluginInstance.name);
    } catch (error) {
      logger.error({ error, pluginPath: config.path }, 'Failed to get plugin name from config');
      return null;
    }
  }

  /**
   * 自动加载 transformer plugin
   * 根据 transformer 名称从预定义路径加载对应的 plugin
   */
  async loadTransformerPlugin(transformerName: string): Promise<Plugin | null> {
    // 检查是否已经加载
    const existing = this.getPlugin(transformerName);
    if (existing) {
      return existing;
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

        const plugin = this.getPlugin(transformerName);
        if (plugin) {
          logger.info({ transformerName, pluginPath }, 'Transformer plugin auto-loaded successfully');
          return plugin;
        }
      } catch (error) {
        // Try next path
        logger.debug({ error, transformerName, pluginPath }, 'Failed to load from this path, trying next');
        continue;
      }
    }

    // All paths failed
    logger.error(
      { transformerName, attemptedPaths: possiblePaths },
      'Failed to auto-load transformer plugin from all paths'
    );
    return null;
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
