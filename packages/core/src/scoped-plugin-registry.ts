/**
 * Scoped Plugin Registry
 *
 * 作用域插件注册表 - 新架构的核心组件
 *
 * 核心概念：
 * 1. PluginClass - 插件类定义（行为模板，单例）
 * 2. PluginHandler - 配置实例（按 scope + config 创建，长生命周期）
 * 3. PrecompiledHooks - 预编译的 Hooks（启动时创建，请求时直接使用）
 * 4. RequestContext - 请求上下文（轻量级，每请求创建）
 *
 * 生命周期：
 * - 应用启动：加载 PluginClass，创建 PluginHandler，预编译 Hooks
 * - 请求处理：O(1) 查找预编译的 Hooks，直接执行
 * - 配置热更新：原子替换预编译的 Hooks
 * - 应用关闭：销毁所有 handlers
 *
 * 性能优化：
 * - 启动时预编译所有 route+upstream 组合的 Hooks
 * - 请求时 O(1) 查找，无创建开销
 * - 无 acquire/release，无 reset 调用
 */

import { logger } from './logger';
import type {
  PluginHooks,
  RequestContext,
  MutableRequestContext,
  ResponseContext,
  ErrorContext,
  StreamChunkContext,
  FinallyContext,
  PluginInitContext,
} from './hooks';
import { createPluginHooks } from './hooks';
import type { PluginConfig } from '@jeffusion/bungee-types';
import type { PluginStorage, PluginMetadata, PluginConfigField, PluginTranslations } from './plugin.types';
import { getPluginContextManager, isPluginContextManagerInitialized } from './plugin-context-manager';
import * as path from 'path';

// ============ 类型定义 ============

/**
 * 插件作用域
 */
export type PluginScope =
  | { type: 'global' }
  | { type: 'route'; routeId: string }
  | { type: 'upstream'; upstreamId: string };

/**
 * 插件处理器接口
 * 由 PluginClass.createHandler() 创建，长生命周期
 */
export interface PluginHandler {
  /** 插件名称 */
  readonly pluginName: string;

  /** 此处理器的配置 */
  readonly config: Record<string, any>;

  /** 执行优先级（可选） */
  readonly priority?: number;

  /**
   * 注册 Hooks 回调
   * 在创建时调用一次，将回调注册到 hooks 系统
   */
  register(hooks: PluginHooks): void;

  /**
   * 销毁处理器（可选）
   * 释放资源，如数据库连接、定时器等
   */
  destroy?(): Promise<void>;
}

/**
 * 插件类接口（工厂模式）
 * 插件类是无状态的，通过 createHandler 创建配置实例
 */
export interface PluginClass {
  /** 插件唯一标识符 */
  readonly name: string;

  /** 插件版本 */
  readonly version: string;

  /** 插件元数据（可选） */
  readonly metadata?: PluginMetadata;

  /** 配置 Schema（可选） */
  readonly configSchema?: PluginConfigField[];

  /** 翻译内容（可选） */
  readonly translations?: PluginTranslations;

  /**
   * 根据配置创建处理器
   * 每个 (scope + config) 组合调用一次
   *
   * @param config 插件配置
   * @param initContext 初始化上下文（包含 storage, logger 等）
   * @returns 处理器实例
   */
  createHandler(config: Record<string, any>, initContext: PluginInitContext): PluginHandler | Promise<PluginHandler>;
}

/**
 * 预编译的 Hooks 集合
 * 应用启动时创建，请求时直接使用（零创建开销）
 */
export interface PrecompiledHooks {
  /** 关联的处理器列表 */
  readonly handlers: PluginHandler[];

  /** 预编译的 hooks（所有回调已注册） */
  readonly hooks: PluginHooks;

  /** 是否有流式处理回调 */
  readonly hasStreamCallbacks: boolean;

  /** 是否有响应处理回调 */
  readonly hasResponseCallbacks: boolean;

  /** 是否有请求拦截回调 */
  readonly hasInterceptCallbacks: boolean;

  /** 元数据（调试用） */
  readonly metadata: {
    createdAt: number;
    pluginCount: number;
    pluginNames: string[];
    scope: string;
  };
}

/**
 * 作用域插件实例
 * 存储处理器和其元数据
 */
interface ScopedPluginInstance {
  /** 作用域 */
  scope: PluginScope;

  /** 处理器实例 */
  handler: PluginHandler;

  /** 执行优先级（数字越小优先级越高） */
  priority: number;

  /** 插件配置（用于调试） */
  config: PluginConfig;
}

// ============ ScopedPluginRegistry 实现 ============

/**
 * 作用域插件注册表
 *
 * 管理所有插件实例的生命周期，支持三级作用域：
 * - Global: 所有请求都会执行
 * - Route: 匹配特定路由的请求执行
 * - Upstream: 匹配特定上游的请求执行
 *
 * 性能优化：
 * - 预编译 Hooks：启动时创建，请求时 O(1) 查找
 * - 组合缓存：route+upstream 组合的 Hooks 被缓存
 * - 无 acquire/release：长生命周期实例，无请求级开销
 */
export class ScopedPluginRegistry {
  // ========== 核心数据结构 ==========

  /** 全局插件实例 */
  private globalInstances: ScopedPluginInstance[] = [];

  /** 路由级插件实例：routeId → instances */
  private routeInstances: Map<string, ScopedPluginInstance[]> = new Map();

  /** 上游级插件实例：upstreamId → instances */
  private upstreamInstances: Map<string, ScopedPluginInstance[]> = new Map();

  // ========== 预编译 Hooks 缓存 ==========

  /** 全局预编译 Hooks */
  private globalPrecompiled: PrecompiledHooks | null = null;

  /** 路由级预编译 Hooks：routeId → PrecompiledHooks */
  private routePrecompiled: Map<string, PrecompiledHooks> = new Map();

  /** 上游级预编译 Hooks：upstreamId → PrecompiledHooks */
  private upstreamPrecompiled: Map<string, PrecompiledHooks> = new Map();

  /** 组合 Hooks 缓存：`route:${routeId}|upstream:${upstreamId}` → PrecompiledHooks */
  private combinedHooksCache: Map<string, PrecompiledHooks> = new Map();

  // ========== 其他字段 ==========

  /** 已加载的插件类：pluginName → PluginClass */
  private pluginClasses: Map<string, PluginClass> = new Map();

  /** 插件翻译内容缓存 */
  private pluginTranslations: Map<string, PluginTranslations> = new Map();

  /** 配置基础路径 */
  private configBasePath: string;

  /** 是否已销毁 */
  private destroyed: boolean = false;

  /** 是否已完成预编译 */
  private precompiled: boolean = false;

  constructor(configBasePath: string = process.cwd()) {
    this.configBasePath = configBasePath;
  }

  // ============ 插件类加载 ============

  /**
   * 加载插件类（不创建实例）
   *
   * @param pluginPath 插件文件路径
   * @returns 插件类
   */
  async loadPluginClass(pluginPath: string): Promise<PluginClass> {
    const absolutePath = path.isAbsolute(pluginPath)
      ? pluginPath
      : path.resolve(this.configBasePath, pluginPath);

    logger.debug({ pluginPath: absolutePath }, 'Loading plugin class');

    const pluginModule = await import(absolutePath);
    const PluginClassDef = pluginModule.default || pluginModule.Plugin;

    if (!PluginClassDef) {
      throw new Error(`Plugin at ${absolutePath} must export a default class or named export 'Plugin'`);
    }

    // 验证必需的静态属性
    if (!PluginClassDef.name) {
      throw new Error(`Plugin at ${absolutePath} must have a static 'name' property`);
    }
    if (!PluginClassDef.version) {
      throw new Error(`Plugin at ${absolutePath} must have a static 'version' property`);
    }

    // 检查是否已经是新架构的插件类（有 createHandler 静态方法）
    // 或者是旧架构的插件（需要适配）
    const pluginClass = this.adaptPluginClass(PluginClassDef);

    // 缓存插件类
    this.pluginClasses.set(pluginClass.name, pluginClass);

    // 收集翻译内容
    if (PluginClassDef.translations) {
      this.pluginTranslations.set(pluginClass.name, PluginClassDef.translations);
    }

    logger.info(
      {
        pluginName: pluginClass.name,
        version: pluginClass.version,
        hasCreateHandler: typeof PluginClassDef.createHandler === 'function'
      },
      'Plugin class loaded'
    );

    return pluginClass;
  }

  /**
   * 适配旧架构插件为新架构
   *
   * 旧架构：class Plugin { register(hooks) {...} }
   * 新架构：class PluginClass { static createHandler(config) {...} }
   */
  private adaptPluginClass(PluginClassDef: any): PluginClass {
    // 如果已经有 createHandler 静态方法，直接返回
    if (typeof PluginClassDef.createHandler === 'function') {
      return PluginClassDef as PluginClass;
    }

    // 适配旧架构插件
    const adaptedClass: PluginClass = {
      name: PluginClassDef.name,
      version: PluginClassDef.version,
      metadata: PluginClassDef.metadata,
      configSchema: PluginClassDef.configSchema,
      translations: PluginClassDef.translations,

      createHandler(config: Record<string, any>, initContext: PluginInitContext): PluginHandler {
        // 创建旧架构插件实例
        const instance = new PluginClassDef(config);

        // 如果有 init 方法，需要异步初始化
        // 注意：这里返回的是同步的 handler，init 会在外部处理

        return {
          pluginName: PluginClassDef.name,
          config,

          register(hooks: PluginHooks): void {
            // 调用旧架构插件的 register 方法
            if (instance.register) {
              instance.register(hooks);
            }
          },

          async destroy(): Promise<void> {
            if (instance.onDestroy) {
              await instance.onDestroy();
            }
          }
        };
      }
    };

    return adaptedClass;
  }

  /**
   * 通过名称获取已加载的插件类
   */
  getPluginClass(name: string): PluginClass | undefined {
    return this.pluginClasses.get(name);
  }

  /**
   * 确保插件类已加载
   */
  async ensurePluginClassLoaded(pluginConfig: PluginConfig | string): Promise<PluginClass> {
    const config = typeof pluginConfig === 'string' ? { name: pluginConfig } : pluginConfig;

    // 检查是否已加载
    let pluginClass = this.pluginClasses.get(config.name);
    if (pluginClass) {
      return pluginClass;
    }

    // 需要加载
    if (config.path) {
      pluginClass = await this.loadPluginClass(config.path);
    } else {
      // 尝试从默认路径加载
      const searchPaths = this.getSearchPaths(config.name);
      for (const searchPath of searchPaths) {
        try {
          const exists = await Bun.file(searchPath).exists();
          if (exists) {
            pluginClass = await this.loadPluginClass(searchPath);
            break;
          }
        } catch {
          continue;
        }
      }
    }

    if (!pluginClass) {
      throw new Error(`Plugin "${config.name}" not found`);
    }

    return pluginClass;
  }

  /**
   * 获取插件搜索路径
   */
  private getSearchPaths(pluginName: string): string[] {
    const baseDir = import.meta.dir;
    return [
      // 内置插件
      path.join(baseDir, 'plugins', pluginName, 'index.ts'),
      path.join(baseDir, 'plugins', pluginName, 'index.js'),
      path.join(baseDir, 'plugins', `${pluginName}.ts`),
      path.join(baseDir, 'plugins', `${pluginName}.js`),
      // 自定义插件
      path.join(this.configBasePath, 'plugins', pluginName, 'index.ts'),
      path.join(this.configBasePath, 'plugins', pluginName, 'index.js'),
    ];
  }

  // ============ 实例创建 ============

  /**
   * 创建插件处理器实例
   *
   * @param scope 作用域
   * @param pluginConfig 插件配置
   * @returns 创建的实例
   */
  async createInstance(scope: PluginScope, pluginConfig: PluginConfig): Promise<ScopedPluginInstance> {
    // 确保插件类已加载
    const pluginClass = await this.ensurePluginClassLoaded(pluginConfig);

    // 创建初始化上下文
    const initContext = await this.createInitContext(pluginClass.name, pluginConfig.options || {});

    // 创建处理器
    const handler = await pluginClass.createHandler(pluginConfig.options || {}, initContext);

    const instance: ScopedPluginInstance = {
      scope,
      handler,
      priority: (pluginConfig.options?.priority as number | undefined) ?? handler.priority ?? 0,
      config: pluginConfig
    };

    // 存储到对应作用域
    this.addInstance(instance);

    // 标记需要重新预编译
    this.precompiled = false;

    logger.info(
      {
        pluginName: handler.pluginName,
        scope,
        priority: instance.priority
      },
      'Plugin handler created'
    );

    return instance;
  }

  /**
   * 添加实例到对应作用域
   */
  private addInstance(instance: ScopedPluginInstance): void {
    switch (instance.scope.type) {
      case 'global':
        this.globalInstances.push(instance);
        this.globalInstances.sort((a, b) => a.priority - b.priority);
        break;

      case 'route':
        const routeList = this.routeInstances.get(instance.scope.routeId) || [];
        routeList.push(instance);
        routeList.sort((a, b) => a.priority - b.priority);
        this.routeInstances.set(instance.scope.routeId, routeList);
        break;

      case 'upstream':
        const upstreamList = this.upstreamInstances.get(instance.scope.upstreamId) || [];
        upstreamList.push(instance);
        upstreamList.sort((a, b) => a.priority - b.priority);
        this.upstreamInstances.set(instance.scope.upstreamId, upstreamList);
        break;
    }
  }

  /**
   * 创建插件初始化上下文
   */
  private async createInitContext(pluginName: string, config: Record<string, any>): Promise<PluginInitContext> {
    // 尝试获取全局 context（如果 PluginContextManager 已初始化）
    if (isPluginContextManagerInitialized()) {
      const contextManager = getPluginContextManager();
      const existingContext = contextManager.getContext(pluginName);
      if (existingContext) {
        return existingContext;
      }

      // 创建新的 context
      return contextManager.getOrCreateContext(pluginName, '', config);
    }

    // 降级：创建简单的 context
    return {
      config,
      storage: this.createDummyStorage(),
      logger: this.createPluginLogger(pluginName)
    };
  }

  /**
   * 创建插件日志器
   */
  private createPluginLogger(pluginName: string) {
    return {
      debug: (msg: string, data?: object) => logger.debug({ plugin: pluginName, ...data }, msg),
      info: (msg: string, data?: object) => logger.info({ plugin: pluginName, ...data }, msg),
      warn: (msg: string, data?: object) => logger.warn({ plugin: pluginName, ...data }, msg),
      error: (msg: string, data?: object) => logger.error({ plugin: pluginName, ...data }, msg),
    };
  }

  /**
   * 创建空的 storage（降级用）
   */
  private createDummyStorage(): PluginStorage {
    const store = new Map<string, any>();
    return {
      async get<T>(key: string): Promise<T | null> {
        return store.get(key) ?? null;
      },
      async set(key: string, value: any): Promise<void> {
        store.set(key, value);
      },
      async delete(key: string): Promise<void> {
        store.delete(key);
      },
      async keys(prefix?: string): Promise<string[]> {
        const allKeys = Array.from(store.keys());
        return prefix ? allKeys.filter(k => k.startsWith(prefix)) : allKeys;
      },
      async clear(): Promise<void> {
        store.clear();
      },
      async increment(key: string, field: string, delta: number = 1): Promise<number> {
        const obj = store.get(key) || {};
        obj[field] = (obj[field] || 0) + delta;
        store.set(key, obj);
        return obj[field];
      },
      async compareAndSet(key: string, field: string, expected: any, newValue: any): Promise<boolean> {
        const obj = store.get(key) || {};
        if (obj[field] === expected) {
          obj[field] = newValue;
          store.set(key, obj);
          return true;
        }
        return false;
      }
    };
  }

  // ============ 请求处理 ============

  /**
   * 获取请求的预编译 Hooks（O(1) 操作）
   *
   * 这是请求处理的核心方法，性能至关重要。
   * 如果尚未预编译，会自动触发预编译。
   *
   * @param routeId 路由 ID
   * @param upstreamId 上游 ID（可选）
   * @returns 预编译的 Hooks，如果没有任何插件则返回 null
   */
  getPrecompiledHooks(routeId: string, upstreamId?: string): PrecompiledHooks | null {
    // 确保已预编译
    if (!this.precompiled) {
      this.precompileAllHooks();
    }

    // 1. 尝试从组合缓存获取
    const cacheKey = this.getCombinedCacheKey(routeId, upstreamId);
    const cached = this.combinedHooksCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // 2. 缓存未命中，动态构建并缓存
    const combined = this.buildCombinedHooks(routeId, upstreamId);
    if (combined.handlers.length === 0) {
      return null;
    }

    this.combinedHooksCache.set(cacheKey, combined);
    return combined;
  }

  /**
   * 获取路由级预编译 Hooks（不含上游插件）
   *
   * @param routeId 路由 ID
   * @returns 预编译的 Hooks
   */
  getRoutePrecompiledHooks(routeId: string): PrecompiledHooks | null {
    // 确保已预编译
    if (!this.precompiled) {
      this.precompileAllHooks();
    }

    // 路由级 = global + route
    return this.getPrecompiledHooks(routeId, undefined);
  }

  /**
   * 预编译所有 Hooks
   *
   * 在应用启动时或配置变更后调用。
   * 为每个 scope 创建预编译的 Hooks。
   */
  precompileAllHooks(): void {
    if (this.precompiled) {
      return;
    }

    const startTime = performance.now();
    logger.info('Precompiling all hooks');

    // 1. 预编译全局 Hooks
    if (this.globalInstances.length > 0) {
      this.globalPrecompiled = this.buildPrecompiledHooks(
        this.globalInstances,
        'global'
      );
    }

    // 2. 预编译路由级 Hooks
    for (const [routeId, instances] of this.routeInstances) {
      if (instances.length > 0) {
        this.routePrecompiled.set(
          routeId,
          this.buildPrecompiledHooks(instances, `route:${routeId}`)
        );
      }
    }

    // 3. 预编译上游级 Hooks
    for (const [upstreamId, instances] of this.upstreamInstances) {
      if (instances.length > 0) {
        this.upstreamPrecompiled.set(
          upstreamId,
          this.buildPrecompiledHooks(instances, `upstream:${upstreamId}`)
        );
      }
    }

    // 4. 清空组合缓存（下次请求时按需创建）
    this.combinedHooksCache.clear();

    this.precompiled = true;

    const elapsed = performance.now() - startTime;
    logger.info({
      elapsed: `${elapsed.toFixed(2)}ms`,
      globalPlugins: this.globalPrecompiled?.handlers.length || 0,
      routeScopes: this.routePrecompiled.size,
      upstreamScopes: this.upstreamPrecompiled.size
    }, 'Hooks precompiled');
  }

  /**
   * 构建单个 scope 的预编译 Hooks
   */
  private buildPrecompiledHooks(
    instances: ScopedPluginInstance[],
    scope: string
  ): PrecompiledHooks {
    const hooks = createPluginHooks();
    const handlers: PluginHandler[] = [];

    for (const instance of instances) {
      instance.handler.register(hooks);
      handlers.push(instance.handler);
    }

    return {
      handlers,
      hooks,
      hasStreamCallbacks: hooks.onStreamChunk.hasCallbacks(),
      hasResponseCallbacks: hooks.onResponse.hasCallbacks(),
      hasInterceptCallbacks: hooks.onInterceptRequest.hasCallbacks(),
      metadata: {
        createdAt: Date.now(),
        pluginCount: handlers.length,
        pluginNames: handlers.map(h => h.pluginName),
        scope
      }
    };
  }

  /**
   * 构建组合的 Hooks（global + route + upstream）
   */
  private buildCombinedHooks(routeId: string, upstreamId?: string): PrecompiledHooks {
    const combinedHooks = createPluginHooks();
    const allHandlers: PluginHandler[] = [];
    const registeredNames = new Set<string>();

    // 按顺序注册：global → route → upstream
    // 收集所有 handler
    const globalHandlers = this.globalInstances.map(i => i.handler);
    const routeHandlers = (this.routeInstances.get(routeId) || []).map(i => i.handler);
    const upstreamHandlers = upstreamId
      ? (this.upstreamInstances.get(upstreamId) || []).map(i => i.handler)
      : [];

    // 注册时去重（同一 handler 可能在多个 scope 中）
    for (const handler of [...globalHandlers, ...routeHandlers, ...upstreamHandlers]) {
      // 使用 pluginName + config 组合作为唯一标识
      const handlerKey = `${handler.pluginName}:${JSON.stringify(handler.config)}`;
      if (!registeredNames.has(handlerKey)) {
        handler.register(combinedHooks);
        allHandlers.push(handler);
        registeredNames.add(handlerKey);
      }
    }

    const scopeDesc = upstreamId
      ? `route:${routeId}|upstream:${upstreamId}`
      : `route:${routeId}`;

    return {
      handlers: allHandlers,
      hooks: combinedHooks,
      hasStreamCallbacks: combinedHooks.onStreamChunk.hasCallbacks(),
      hasResponseCallbacks: combinedHooks.onResponse.hasCallbacks(),
      hasInterceptCallbacks: combinedHooks.onInterceptRequest.hasCallbacks(),
      metadata: {
        createdAt: Date.now(),
        pluginCount: allHandlers.length,
        pluginNames: allHandlers.map(h => h.pluginName),
        scope: scopeDesc
      }
    };
  }

  /**
   * 获取组合缓存的 key
   */
  private getCombinedCacheKey(routeId: string, upstreamId?: string): string {
    return upstreamId
      ? `route:${routeId}|upstream:${upstreamId}`
      : `route:${routeId}`;
  }

  /**
   * 清除指定 scope 的预编译缓存
   */
  private invalidatePrecompiledCache(routeId?: string, upstreamId?: string): void {
    // 清除组合缓存
    for (const key of this.combinedHooksCache.keys()) {
      if (routeId && key.includes(`route:${routeId}`)) {
        this.combinedHooksCache.delete(key);
      }
      if (upstreamId && key.includes(`upstream:${upstreamId}`)) {
        this.combinedHooksCache.delete(key);
      }
    }

    // 清除 scope 级别的预编译
    if (routeId) {
      this.routePrecompiled.delete(routeId);
    }
    if (upstreamId) {
      this.upstreamPrecompiled.delete(upstreamId);
    }
  }

  // ============ 生命周期管理 ============

  /**
   * 从配置初始化所有插件实例
   *
   * @param config 应用配置
   */
  async initializeFromConfig(config: {
    plugins?: Array<PluginConfig | string>;
    routes?: Array<{
      id?: string;
      path: string;
      plugins?: Array<PluginConfig | string>;
      upstreams?: Array<{
        id?: string;
        target: string;
        plugins?: Array<PluginConfig | string>;
        [key: string]: any; // 允许额外字段
      }>;
      [key: string]: any; // 允许额外字段
    }>;
    [key: string]: any; // 允许额外字段
  }): Promise<void> {
    const startTime = performance.now();
    logger.info('Initializing scoped plugin registry from config');

    // 辅助函数：标准化插件配置
    const normalizePluginConfig = (config: PluginConfig | string): PluginConfig => {
      return typeof config === 'string' ? { name: config } : config;
    };

    // 1. 加载全局插件
    for (const pluginConfig of config.plugins || []) {
      try {
        await this.createInstance({ type: 'global' }, normalizePluginConfig(pluginConfig));
      } catch (error) {
        logger.error({ error, pluginConfig }, 'Failed to create global plugin instance');
      }
    }

    // 2. 加载路由级插件
    for (const route of config.routes || []) {
      const routeId = route.id || route.path;

      for (const pluginConfig of route.plugins || []) {
        try {
          await this.createInstance({ type: 'route', routeId }, normalizePluginConfig(pluginConfig));
        } catch (error) {
          logger.error({ error, pluginConfig, routeId }, 'Failed to create route plugin instance');
        }
      }

      // 3. 加载上游级插件
      for (const upstream of route.upstreams || []) {
        const upstreamId = upstream.id || upstream.target;

        for (const pluginConfig of upstream.plugins || []) {
          try {
            await this.createInstance({ type: 'upstream', upstreamId }, normalizePluginConfig(pluginConfig));
          } catch (error) {
            logger.error({ error, pluginConfig, upstreamId }, 'Failed to create upstream plugin instance');
          }
        }
      }
    }

    // 4. 预编译所有 Hooks
    this.precompileAllHooks();

    const elapsed = performance.now() - startTime;
    logger.info(
      {
        elapsed: `${elapsed.toFixed(2)}ms`,
        global: this.globalInstances.length,
        routes: this.routeInstances.size,
        upstreams: this.upstreamInstances.size,
        totalHandlers: this.getTotalHandlerCount(),
        cachedCombinations: this.combinedHooksCache.size
      },
      'Scoped plugin registry initialized'
    );
  }

  // ============ 配置热更新 ============

  /**
   * 热更新路由的插件配置
   *
   * @param routeId 路由 ID
   * @param newPluginConfigs 新的插件配置
   */
  async hotReloadRoutePlugins(routeId: string, newPluginConfigs: PluginConfig[]): Promise<void> {
    logger.info({ routeId }, 'Hot reloading route plugins');

    // 1. 获取旧的实例
    const oldInstances = this.routeInstances.get(routeId) || [];

    // 2. 创建新的实例列表
    const newInstances: ScopedPluginInstance[] = [];

    for (const pluginConfig of newPluginConfigs) {
      try {
        const pluginClass = await this.ensurePluginClassLoaded(pluginConfig);
        const initContext = await this.createInitContext(pluginClass.name, pluginConfig.options || {});
        const handler = await pluginClass.createHandler(pluginConfig.options || {}, initContext);

        newInstances.push({
          scope: { type: 'route', routeId },
          handler,
          priority: (pluginConfig.options?.priority as number | undefined) ?? handler.priority ?? 0,
          config: pluginConfig
        });
      } catch (error) {
        logger.error({ error, pluginConfig, routeId }, 'Failed to create route plugin during hot reload');
      }
    }

    // 3. 按优先级排序
    newInstances.sort((a, b) => a.priority - b.priority);

    // 4. 原子替换
    this.routeInstances.set(routeId, newInstances);

    // 5. 清除相关缓存
    this.invalidatePrecompiledCache(routeId);
    this.precompiled = false;

    // 6. 重新预编译
    this.precompileAllHooks();

    // 7. 延迟销毁旧实例（等待正在处理的请求完成）
    if (oldInstances.length > 0) {
      setTimeout(async () => {
        for (const instance of oldInstances) {
          try {
            if (instance.handler.destroy) {
              await instance.handler.destroy();
            }
          } catch (error) {
            logger.error(
              { error, pluginName: instance.handler.pluginName },
              'Error destroying old handler during hot reload'
            );
          }
        }
        logger.debug({ routeId, destroyedCount: oldInstances.length }, 'Old handlers destroyed');
      }, 5000);
    }

    logger.info({
      routeId,
      oldCount: oldInstances.length,
      newCount: newInstances.length
    }, 'Route plugins hot reloaded');
  }

  /**
   * 热更新上游的插件配置
   *
   * @param upstreamId 上游 ID
   * @param newPluginConfigs 新的插件配置
   */
  async hotReloadUpstreamPlugins(upstreamId: string, newPluginConfigs: PluginConfig[]): Promise<void> {
    logger.info({ upstreamId }, 'Hot reloading upstream plugins');

    // 1. 获取旧的实例
    const oldInstances = this.upstreamInstances.get(upstreamId) || [];

    // 2. 创建新的实例列表
    const newInstances: ScopedPluginInstance[] = [];

    for (const pluginConfig of newPluginConfigs) {
      try {
        const pluginClass = await this.ensurePluginClassLoaded(pluginConfig);
        const initContext = await this.createInitContext(pluginClass.name, pluginConfig.options || {});
        const handler = await pluginClass.createHandler(pluginConfig.options || {}, initContext);

        newInstances.push({
          scope: { type: 'upstream', upstreamId },
          handler,
          priority: (pluginConfig.options?.priority as number | undefined) ?? handler.priority ?? 0,
          config: pluginConfig
        });
      } catch (error) {
        logger.error({ error, pluginConfig, upstreamId }, 'Failed to create upstream plugin during hot reload');
      }
    }

    // 3. 按优先级排序
    newInstances.sort((a, b) => a.priority - b.priority);

    // 4. 原子替换
    this.upstreamInstances.set(upstreamId, newInstances);

    // 5. 清除相关缓存
    this.invalidatePrecompiledCache(undefined, upstreamId);
    this.precompiled = false;

    // 6. 重新预编译
    this.precompileAllHooks();

    // 7. 延迟销毁旧实例
    if (oldInstances.length > 0) {
      setTimeout(async () => {
        for (const instance of oldInstances) {
          try {
            if (instance.handler.destroy) {
              await instance.handler.destroy();
            }
          } catch (error) {
            logger.error(
              { error, pluginName: instance.handler.pluginName },
              'Error destroying old handler during hot reload'
            );
          }
        }
        logger.debug({ upstreamId, destroyedCount: oldInstances.length }, 'Old handlers destroyed');
      }, 5000);
    }

    logger.info({
      upstreamId,
      oldCount: oldInstances.length,
      newCount: newInstances.length
    }, 'Upstream plugins hot reloaded');
  }

  /**
   * 为路由动态创建插件实例
   * 用于兼容现有的按需加载逻辑
   */
  async ensureRoutePluginsLoaded(routeId: string, pluginConfigs: PluginConfig[]): Promise<void> {
    // 检查是否已经加载
    const existingInstances = this.routeInstances.get(routeId) || [];
    const existingNames = new Set(existingInstances.map(i => i.handler.pluginName));

    for (const pluginConfig of pluginConfigs) {
      const pluginName = typeof pluginConfig === 'string' ? pluginConfig : pluginConfig.name;

      if (!existingNames.has(pluginName)) {
        try {
          const config = typeof pluginConfig === 'string' ? { name: pluginConfig } : pluginConfig;
          await this.createInstance({ type: 'route', routeId }, config);
        } catch (error) {
          logger.error({ error, pluginConfig, routeId }, 'Failed to create route plugin instance');
        }
      }
    }
  }

  /**
   * 获取总处理器数量
   */
  private getTotalHandlerCount(): number {
    let count = this.globalInstances.length;
    for (const instances of this.routeInstances.values()) {
      count += instances.length;
    }
    for (const instances of this.upstreamInstances.values()) {
      count += instances.length;
    }
    return count;
  }

  /**
   * 销毁所有实例
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    logger.info('Destroying scoped plugin registry');

    const allInstances = [
      ...this.globalInstances,
      ...Array.from(this.routeInstances.values()).flat(),
      ...Array.from(this.upstreamInstances.values()).flat()
    ];

    for (const instance of allInstances) {
      try {
        if (instance.handler.destroy) {
          await instance.handler.destroy();
        }
      } catch (error) {
        logger.error(
          { error, pluginName: instance.handler.pluginName },
          'Error destroying plugin handler'
        );
      }
    }

    // 清理所有数据结构
    this.globalInstances = [];
    this.routeInstances.clear();
    this.upstreamInstances.clear();
    this.pluginClasses.clear();
    this.pluginTranslations.clear();

    // 清理预编译缓存
    this.globalPrecompiled = null;
    this.routePrecompiled.clear();
    this.upstreamPrecompiled.clear();
    this.combinedHooksCache.clear();
    this.precompiled = false;

    logger.info('Scoped plugin registry destroyed');
  }

  // ============ 查询接口 ============

  /**
   * 获取所有已加载的插件类元数据
   */
  getAllPluginsMetadata(): Array<{
    name: string;
    version: string;
    description?: string;
    metadata?: PluginMetadata;
    instances: {
      global: number;
      route: number;
      upstream: number;
    };
  }> {
    const result = [];

    for (const [name, pluginClass] of this.pluginClasses) {
      const globalCount = this.globalInstances.filter(i => i.handler.pluginName === name).length;
      const routeCount = Array.from(this.routeInstances.values())
        .flat()
        .filter(i => i.handler.pluginName === name).length;
      const upstreamCount = Array.from(this.upstreamInstances.values())
        .flat()
        .filter(i => i.handler.pluginName === name).length;

      result.push({
        name,
        version: pluginClass.version,
        description: pluginClass.metadata?.description,
        metadata: pluginClass.metadata,
        instances: {
          global: globalCount,
          route: routeCount,
          upstream: upstreamCount
        }
      });
    }

    return result;
  }

  /**
   * 获取所有插件的翻译内容
   */
  getAllPluginTranslations(): Record<string, any> {
    const result: Record<string, any> = {};

    for (const [pluginName, translations] of this.pluginTranslations) {
      for (const [locale, messages] of Object.entries(translations)) {
        if (!result[locale]) {
          result[locale] = { plugins: {} };
        }
        if (!result[locale].plugins) {
          result[locale].plugins = {};
        }
        result[locale].plugins[pluginName] = messages;
      }
    }

    return result;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      pluginClasses: this.pluginClasses.size,
      globalInstances: this.globalInstances.length,
      routeInstances: this.routeInstances.size,
      upstreamInstances: this.upstreamInstances.size,
      totalHandlers: this.getTotalHandlerCount(),
      precompiled: this.precompiled,
      precompiledCache: {
        global: this.globalPrecompiled ? 1 : 0,
        route: this.routePrecompiled.size,
        upstream: this.upstreamPrecompiled.size,
        combined: this.combinedHooksCache.size
      },
      destroyed: this.destroyed
    };
  }
}

// ============ 单例管理 ============

let scopedPluginRegistry: ScopedPluginRegistry | null = null;

/**
 * 获取全局 ScopedPluginRegistry 实例
 */
export function getScopedPluginRegistry(): ScopedPluginRegistry | null {
  return scopedPluginRegistry;
}

/**
 * 初始化全局 ScopedPluginRegistry 实例
 */
export function initScopedPluginRegistry(configBasePath?: string): ScopedPluginRegistry {
  if (scopedPluginRegistry) {
    logger.warn('ScopedPluginRegistry already initialized, returning existing instance');
    return scopedPluginRegistry;
  }

  scopedPluginRegistry = new ScopedPluginRegistry(configBasePath);
  logger.info('Global ScopedPluginRegistry initialized');
  return scopedPluginRegistry;
}

/**
 * 销毁全局 ScopedPluginRegistry 实例
 */
export async function destroyScopedPluginRegistry(): Promise<void> {
  if (scopedPluginRegistry) {
    await scopedPluginRegistry.destroy();
    scopedPluginRegistry = null;
    logger.info('Global ScopedPluginRegistry destroyed');
  }
}
