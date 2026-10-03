/**
 * Plugin Context Manager
 *
 * 管理插件的全局上下文，确保每个插件只有一个context实例
 * 解决原有架构中临时实例导致的storage丢失问题
 */

import type { PluginInitContext, PluginStorage } from './plugin.types';
import { createPluginStorageCapability } from './plugin-storage';
import { logger as globalLogger } from './logger';
import type { Database } from 'bun:sqlite';
import * as path from 'path';
import type { LRUCacheOptions } from './plugin-storage-cache';

/**
 * Storage缓存配置
 */
export interface StorageCacheConfig {
  enabled: boolean;
  maxSize?: number;
  writeDelay?: number;
  writeBatchSize?: number;
}

// 默认缓存配置
const DEFAULT_CACHE_CONFIG: StorageCacheConfig = {
  enabled: true,
  maxSize: 1000,
  writeDelay: 1000,
  writeBatchSize: 10,
};

/**
 * 扩展的Plugin初始化上下文
 * 添加更多元数据和能力
 */
export interface ExtendedPluginInitContext extends PluginInitContext {
  /**
   * 插件目录的绝对路径
   */
  extensionPath: string;

  /**
   * 全局状态管理
   * 跨会话持久化的状态
   */
  globalState: StateManager;

  /**
   * 工作区状态管理
   * 仅在当前会话有效的状态
   */
  workspaceState: StateManager;

  /**
   * 插件间通信 (Phase 3实现)
   */
  // exports: PluginAPI;
  // getPluginAPI(pluginName: string): PluginAPI | undefined;
  // events: EventBus;
}

/**
 * 状态管理器接口
 * 提供简单的get/set API，底层使用Storage实现
 */
export interface StateManager {
  get<T = any>(key: string, defaultValue?: T): Promise<T | undefined>;
  update<T = any>(key: string, value: T): Promise<void>;
  keys(): Promise<readonly string[]>;
}

/**
 * 基于Storage实现的StateManager
 */
class StorageStateManager implements StateManager {
  constructor(
    private storage: PluginStorage,
    private prefix: string  // 'global:' or 'workspace:'
  ) {}

  async get<T = any>(key: string, defaultValue?: T): Promise<T | undefined> {
    const fullKey = `${this.prefix}${key}`;
    const value = await this.storage.get<T>(fullKey);
    return value !== null ? value : defaultValue;
  }

  async update<T = any>(key: string, value: T): Promise<void> {
    const fullKey = `${this.prefix}${key}`;
    await this.storage.set(fullKey, value);
  }

  async keys(): Promise<readonly string[]> {
    const allKeys = await this.storage.keys(this.prefix);
    // 移除前缀
    return allKeys.map(k => k.substring(this.prefix.length));
  }
}

/**
 * Plugin Context Manager
 * 单例模式，全局唯一
 */
export class PluginContextManager {
  private static instance: PluginContextManager | null = null;

  /**
   * 插件名称 -> 插件上下文
   * 每个插件只有一个context实例
   */
  private contexts: Map<string, ExtendedPluginInitContext> = new Map();
  private revocations = new Map<string, () => void>();

  /**
   * 数据库实例
   */
  private db: Database;

  /**
   * Storage缓存配置
   */
  private cacheConfig: StorageCacheConfig;

  private constructor(db: Database, cacheConfig?: Partial<StorageCacheConfig>) {
    this.db = db;
    this.cacheConfig = { ...DEFAULT_CACHE_CONFIG, ...cacheConfig };
    globalLogger.info(
      { cacheConfig: this.cacheConfig },
      'PluginContextManager cache configuration'
    );
  }

  /**
   * 获取单例实例
   */
  static getInstance(
    db: Database,
    cacheConfig?: Partial<StorageCacheConfig>
  ): PluginContextManager {
    if (!PluginContextManager.instance) {
      PluginContextManager.instance = new PluginContextManager(db, cacheConfig);
    }
    return PluginContextManager.instance;
  }

  /**
   * 为插件创建或获取context
   *
   * @param pluginName - 插件名称
   * @param pluginPath - 插件文件路径
   * @param config - 插件配置
   * @returns 插件上下文
   */
  getOrCreateContext(
    pluginName: string,
    pluginPath: string,
    config: any
  ): ExtendedPluginInitContext {
    // 如果已存在，直接返回
    if (this.contexts.has(pluginName)) {
      return this.contexts.get(pluginName)!;
    }

    // 创建新的context
    // 根据配置决定是否启用缓存
    const cacheOptions: LRUCacheOptions | undefined = this.cacheConfig.enabled
      ? {
          maxSize: this.cacheConfig.maxSize!,
          writeDelay: this.cacheConfig.writeDelay,
          writeBatchSize: this.cacheConfig.writeBatchSize,
        }
      : undefined;

    const { storage, revoke } = createPluginStorageCapability(
      this.db,
      pluginName,
      cacheOptions
    );
    const pluginLogger = globalLogger.child({ plugin: pluginName });
    const extensionPath = path.dirname(pluginPath);

    const context: ExtendedPluginInitContext = {
      storage,
      logger: pluginLogger,
      config,
      extensionPath,
      globalState: new StorageStateManager(storage, 'global:'),
      workspaceState: new StorageStateManager(storage, 'workspace:'),
    };

    // 缓存context
    this.contexts.set(pluginName, context);
    this.revocations.set(pluginName, revoke);

    globalLogger.debug(
      { pluginName, extensionPath, cacheEnabled: cacheOptions !== undefined },
      'Created plugin context'
    );

    return context;
  }

  /**
   * 获取已存在的context
   *
   * @param pluginName - 插件名称
   * @returns 插件上下文，如果不存在则返回undefined
   */
  getContext(pluginName: string): ExtendedPluginInitContext | undefined {
    return this.contexts.get(pluginName);
  }

  /**
   * 删除插件的context
   * 在插件卸载时调用
   *
   * @param pluginName - 插件名称
   */
  async destroyContext(pluginName: string): Promise<void> {
    const context = this.contexts.get(pluginName);
    if (!context) {
      return;
    }

    // 刷新storage缓存到数据库
    if (context.storage && typeof (context.storage as any).flush === 'function') {
      try {
        await (context.storage as any).flush();
        globalLogger.debug({ pluginName }, 'Flushed plugin storage cache');
      } catch (error) {
        globalLogger.error(
          { error, pluginName },
          'Failed to flush plugin storage cache'
        );
      }
    }

    // 清理workspaceState (可选，看需求)
    // await context.workspaceState.clear();

    this.revocations.get(pluginName)?.();
    this.revocations.delete(pluginName);
    this.contexts.delete(pluginName);

    globalLogger.debug(
      { pluginName },
      'Destroyed plugin context'
    );
  }

  /**
   * 清理所有context
   * 在服务器关闭时调用
   */
  async destroyAll(): Promise<void> {
    const pluginNames = Array.from(this.contexts.keys());

    for (const pluginName of pluginNames) {
      await this.destroyContext(pluginName);
    }

    this.contexts.clear();
    // A stopped runtime must not leave a singleton holding its closed database.
    if (PluginContextManager.instance === this) PluginContextManager.instance = null;
    if (globalContextManager === this) globalContextManager = null;

    globalLogger.info('Destroyed all plugin contexts');
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      totalContexts: this.contexts.size,
      plugins: Array.from(this.contexts.keys()),
    };
  }
}

/**
 * 便捷函数：获取全局PluginContextManager实例
 * 需要在应用启动时初始化
 */
let globalContextManager: PluginContextManager | null = null;

export function initializePluginContextManager(db: Database): void {
  globalContextManager = PluginContextManager.getInstance(db);
  globalLogger.info('Plugin context manager initialized');
}

export function isPluginContextManagerInitialized(): boolean {
  return globalContextManager !== null;
}

export function getPluginContextManager(): PluginContextManager {
  if (!globalContextManager) {
    throw new Error(
      'PluginContextManager not initialized. Call initializePluginContextManager() first.'
    );
  }
  return globalContextManager;
}
