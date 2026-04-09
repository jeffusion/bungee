import type { Plugin, PluginTranslations, LoadedPluginManifest, PluginMetadata } from './plugin.types';
import type { PluginConfig } from '@jeffusion/bungee-types';
import { logger } from './logger';
import * as path from 'path';
import * as fs from 'fs';
import {
  isDevelopmentCompatPluginPath,
  loadPluginArtifactManifest,
  PluginManifestValidationError,
  toPluginManifestContractSnapshot,
  type PluginManifestContractSnapshot,
} from './plugin-artifact-contract';
import {
  classifyPluginValidationFailure,
  createPluginRegistryStateSnapshot,
} from './plugin-runtime-state-machine';
import { getPluginContextManager, isPluginContextManagerInitialized } from './plugin-context-manager';
import { getPermissionManager } from './plugin-permissions';
import { PluginRegistryDB } from './plugin-registry-db';
import type { Database } from 'bun:sqlite';
import type { PluginRegistryStateSnapshot } from './plugin-runtime-state-machine';
import { PluginPathResolver } from './plugin-path-resolver';

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
  /** 插件 manifest（如果存在） */
  manifest?: LoadedPluginManifest;
  metadata?: PluginMetadata;
  entryPath: string;
  pluginDir?: string;
}

async function resolvePluginPath(
  pathResolver: PluginPathResolver,
  pluginName: string,
  category?: string,
): Promise<string> {
  const paths = pathResolver.getSearchPaths(pluginName, { category });

  for (const pluginPath of paths) {
    try {
      const exists = await Bun.file(pluginPath).exists();
      if (exists) {
        logger.debug({ pluginName, pluginPath }, 'Plugin resolved');
        return pluginPath;
      }
    } catch {
      continue;
    }
  }

  throw new Error(
    `Plugin "${pluginName}" not found. Searched in:\n${paths.map(p => `  - ${p}`).join('\n')}\n\n` +
    `Tip: Plugin files should be in one of the following formats:\n` +
    `  - Single file: ${pluginName}.ts/js\n` +
    `  - Directory: ${pluginName}/index.ts/js`
  );
}

/**
 * Plugin 注册表
 * 负责加载和管理 plugins 的元数据
 *
 * 注意：实际的插件执行由 ScopedPluginRegistry 处理
 * 此类主要用于：
 * - 插件发现和加载
 * - 插件元数据管理
 * - 插件启用/禁用状态管理（UI）
 */
export class PluginRegistry {
  private pluginFactories: Map<string, PluginFactoryInfo> = new Map();
  private pluginTranslations: Map<string, PluginTranslations> = new Map(); // 插件翻译内容
  private pluginManifests: Map<string, LoadedPluginManifest> = new Map(); // 插件 manifest 缓存
  private pluginStateSnapshots: Map<string, PluginRegistryStateSnapshot> = new Map();
  private configBasePath: string;
  private pathResolver: PluginPathResolver;
  private registryDB?: PluginRegistryDB; // 插件状态数据库

  constructor(configBasePath: string = process.cwd(), db?: Database) {
    this.configBasePath = configBasePath;
    this.pathResolver = new PluginPathResolver(import.meta.dir, configBasePath);

    logger.debug(
      { configBasePath },
      'PluginPathResolver initialized'
    );

    // 如果提供了数据库，初始化 PluginRegistryDB
    if (db) {
      this.registryDB = new PluginRegistryDB(db);
      logger.info('Plugin registry initialized with database support');
    } else {
      logger.warn(
        'Plugin registry initialized without database - plugin states will not be persisted'
      );
    }
  }

  /**
   * 读取并解析插件的 manifest.json
   * @param pluginDir 插件目录路径
   * @returns 解析后的 manifest，如果不存在或解析失败则返回 null
   */
  private async peekManifestName(pluginDir: string): Promise<string | undefined> {
    const manifestPath = path.join(pluginDir, 'manifest.json');
    try {
      const exists = await Bun.file(manifestPath).exists();
      if (!exists) {
        return undefined;
      }

      const content = await Bun.file(manifestPath).text();
      const manifest = JSON.parse(content) as { name?: unknown };
      return typeof manifest.name === 'string' && manifest.name.trim().length > 0
        ? manifest.name.trim()
        : undefined;
    } catch {
      return undefined;
    }
  }

  private setPluginStateSnapshot(snapshot: PluginRegistryStateSnapshot): void {
    this.pluginStateSnapshots.set(snapshot.pluginName, snapshot);
  }

  private renamePluginStateSnapshot(previousName: string, nextName: string): void {
    if (previousName === nextName) {
      return;
    }

    const existing = this.pluginStateSnapshots.get(previousName);
    if (!existing) {
      return;
    }

    this.pluginStateSnapshots.delete(previousName);
    this.pluginStateSnapshots.set(nextName, {
      ...existing,
      pluginName: nextName,
    });
  }

  private async loadManifest(pluginDir: string): Promise<{
    manifest: LoadedPluginManifest | null;
    pluginNameHint?: string;
    contract?: PluginManifestContractSnapshot;
    error?: Error;
  }> {
    try {
      const manifestPath = path.join(pluginDir, 'manifest.json');
      const exists = await Bun.file(manifestPath).exists();
      if (!exists) {
        return { manifest: null };
      }

      const pluginNameHint = await this.peekManifestName(pluginDir) || path.basename(pluginDir);
      const loadedManifest = await loadPluginArtifactManifest(pluginDir);

      logger.debug(
        { pluginName: loadedManifest.name, manifestPath },
        'Manifest loaded successfully'
      );

      return {
        manifest: loadedManifest,
        pluginNameHint: loadedManifest.name || pluginNameHint,
        contract: toPluginManifestContractSnapshot(loadedManifest, {
          manifestContract: loadedManifest.manifestContract,
          schemaVersion: loadedManifest.schemaVersion,
          artifactKind: loadedManifest.artifactKind,
          main: loadedManifest.main,
          capabilities: loadedManifest.capabilities,
          uiExtensionMode: loadedManifest.uiExtensionMode,
          engines: loadedManifest.engines,
          contractWarnings: loadedManifest.contractWarnings,
        }),
      };
    } catch (error) {
      const manifestPath = path.join(pluginDir, 'manifest.json');
      const pluginNameHint = await this.peekManifestName(pluginDir) || path.basename(pluginDir);
      logger.warn(
        { error, manifestPath },
        'Failed to load manifest.json'
      );
      return {
        manifest: null,
        pluginNameHint,
        contract: error instanceof PluginManifestValidationError ? error.details : undefined,
        error: error as Error,
      };
    }
  }

  private inferPluginDirFromEntryPath(pluginPath: string): string | undefined {
    const basename = path.basename(pluginPath);
    if (basename !== 'index.ts' && basename !== 'index.js') {
      return undefined;
    }

    const parentDir = path.dirname(pluginPath);
    const parentName = path.basename(parentDir);
    if (parentName === 'server' || parentName === 'dist') {
      return path.dirname(parentDir);
    }

    return parentDir;
  }

  /**
   * 递归遍历目录，返回所有文件路径
   * @param dir 要遍历的目录
   * @returns 文件路径数组
   */
  private async walkDirectory(dir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // 递归遍历子目录
          files.push(...await this.walkDirectory(fullPath));
        } else {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // 目录不存在或无权限，忽略
      logger.debug({ error, directory: dir }, 'Directory not accessible, skipping');
    }

    return files;
  }

  /**
   * 扫描指定目录并加载所有插件
   *
   * 支持三种插件发现模式（按优先级）：
   * 1. manifest-first：检测到 manifest.json 时，从中读取元数据
   * 2. 目录插件：${pluginName}/index.ts/js（无 manifest 时回退）
   * 3. 单文件插件：${pluginName}.ts/js（直接在根目录）
   *
   * @param directory 要扫描的目录
   * @param enabledByDefault 默认是否启用插件
   * @returns 加载的插件名称列表
   */
  async scanAndLoadPlugins(directory: string, enabledByDefault: boolean): Promise<string[]> {
    logger.info({ directory, enabledByDefault }, 'Scanning directory for plugins');

    const loadedPlugins: string[] = [];

    try {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);

        try {
          if (entry.isDirectory()) {
            // 目录插件：优先检查 manifest.json
            const manifestResult = await this.loadManifest(fullPath);

            if (manifestResult.pluginNameHint) {
              this.setPluginStateSnapshot(createPluginRegistryStateSnapshot({
                pluginName: manifestResult.pluginNameHint,
                discovery: 'discovered',
                validation: manifestResult.manifest
                  ? 'validated'
                  : manifestResult.error
                    ? classifyPluginValidationFailure(manifestResult.error)
                    : 'pending',
                persistedEnabled: 'unknown',
                manifest: manifestResult.manifest || undefined,
                contract: manifestResult.contract,
                failureReason: manifestResult.error?.message,
              }));
            }

            const manifest = manifestResult.manifest;

            if (manifest) {
              // manifest-first 模式
              const pluginName = manifest.name;

              if (manifestResult.pluginNameHint) {
                this.renamePluginStateSnapshot(manifestResult.pluginNameHint, pluginName);
              }

              if (this.pluginFactories.has(pluginName)) {
                logger.debug({ pluginName }, 'Plugin already loaded, skipping');
                continue;
              }

              // 缓存 manifest
              this.pluginManifests.set(pluginName, manifest);

              if (!manifest.mainPath) {
                logger.warn(
                  { pluginName, pluginDir: fullPath },
                  'Plugin has manifest but no entry file found, skipping'
                );
                continue;
              }

              await this.loadPlugin({
                name: pluginName,
                path: manifest.mainPath,
                enabled: enabledByDefault,
              });

              loadedPlugins.push(pluginName);
              logger.info({ pluginName, mode: 'manifest', entryPath: manifest.mainPath }, 'Plugin loaded via manifest.json');
            } else if (manifestResult.error) {
              continue;
            } else {
              // 回退：传统目录插件模式
              const indexTs = path.join(fullPath, 'index.ts');
              const indexJs = path.join(fullPath, 'index.js');

              let entryPath: string | null = null;
              if (await Bun.file(indexTs).exists()) {
                entryPath = indexTs;
              } else if (await Bun.file(indexJs).exists()) {
                entryPath = indexJs;
              }

              if (entryPath) {
                const pluginName = entry.name;

                if (this.pluginFactories.has(pluginName)) {
                  logger.debug({ pluginName }, 'Plugin already loaded, skipping');
                  continue;
                }

                await this.loadPlugin({
                  name: pluginName,
                  path: entryPath,
                  enabled: enabledByDefault,
                });

                loadedPlugins.push(pluginName);
                logger.debug({ pluginName, mode: 'legacy-dir' }, 'Plugin loaded from directory');
              }
            }
          } else if (entry.isFile()) {
            // 单文件插件：${pluginName}.ts/js
            const ext = path.extname(entry.name);
            if (ext === '.ts' || ext === '.js') {
              const basename = path.basename(entry.name, ext);
              // 排除特殊文件
              if (basename === 'index' || basename === 'config') {
                continue;
              }

              if (this.pluginFactories.has(basename)) {
                logger.debug({ pluginName: basename }, 'Plugin already loaded, skipping');
                continue;
              }

              await this.loadPlugin({
                name: basename,
                path: fullPath,
                enabled: enabledByDefault,
              });

              loadedPlugins.push(basename);
              logger.debug({ pluginName: basename, mode: 'single-file' }, 'Plugin loaded from file');
            }
          }
        } catch (error) {
          logger.warn(
            { error, entry: entry.name },
            'Failed to load plugin during scan, skipping'
          );
        }
      }
    } catch (error) {
      logger.debug({ error, directory }, 'Directory not accessible, skipping');
    }

    logger.info(
      { directory, loadedCount: loadedPlugins.length },
      'Directory scan completed'
    );

    return loadedPlugins;
  }

  /**
   * 扫描所有插件目录并加载插件
   * 所有插件默认为禁用状态，需要通过配置文件显式启用
   */
  async scanAndLoadAllPlugins(): Promise<void> {
    const directories = this.pathResolver.getScanDirectories();

    logger.info({ directories }, 'Starting plugin directory scan');

    for (const directory of directories) {
      await this.scanAndLoadPlugins(directory, false); // 默认禁用
    }

    logger.info('All plugin directories scanned');
  }

  /**
   * 从配置加载 plugins
   * 支持两种格式：
   * 1. 字符串简写: "plugin-name" → { name: "plugin-name" }
   * 2. 完整配置对象: { name: "plugin-name", options: {...} }
   */
  async loadPlugins(configs: Array<PluginConfig | string>): Promise<void> {
    for (const config of configs) {
      try {
        if (typeof config === 'string') {
          // 字符串简写，转换为标准 PluginConfig
          await this.loadPlugin({ name: config });
        } else {
          // 标准 PluginConfig 对象
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
   *
   * 元数据获取优先级：
   * 1. 已缓存的 manifest（来自 scanAndLoadPlugins）
   * 2. 从插件目录加载 manifest.json
   * 3. 回退到类的静态属性（向后兼容）
   *
   * @returns 插件名称
   */
  async loadPlugin(config: PluginConfig): Promise<string> {
    // 解析 plugin 路径
    let pluginPath: string;
    let pluginDir: string | undefined;

    if (config.path) {
      // 如果提供了 path，直接使用（支持绝对路径和相对路径）
      pluginPath = path.isAbsolute(config.path)
        ? config.path
        : path.resolve(this.configBasePath, config.path);

      // 推断插件目录（用于查找 manifest.json）
      pluginDir = this.inferPluginDirFromEntryPath(pluginPath);

      logger.debug({ pluginPath, pluginDir, source: 'path' }, 'Loading plugin from explicit path');
    } else if (config.name) {
      // 如果没有提供 path，通过 name 解析路径
      // 先尝试 transformers 目录，如果失败则尝试根目录
      try {
          pluginPath = await resolvePluginPath(this.pathResolver, config.name, 'transformers');
        logger.debug({ pluginName: config.name, pluginPath, source: 'name-transformers' }, 'Plugin resolved from transformers category');
      } catch {
        // 如果在 transformers 中未找到，尝试根目录
        try {
            pluginPath = await resolvePluginPath(this.pathResolver, config.name);
          logger.debug({ pluginName: config.name, pluginPath, source: 'name-root' }, 'Plugin resolved from root');
        } catch (error) {
          // 所有路径都失败
          throw new Error(
            `Failed to resolve plugin "${config.name}". ` +
            `Searched in transformers category and root directory. ` +
            `Please check plugin name or provide explicit path.`
          );
        }
      }
    } else {
      throw new Error('Plugin config must have either "name" or "path" property');
    }

    logger.info({ pluginPath }, 'Loading plugin');

    // 尝试获取或加载 manifest
    let manifest: LoadedPluginManifest | null = null;

    // 1. 检查是否已有缓存的 manifest（来自 scanAndLoadPlugins）
    if (config.name && this.pluginManifests.has(config.name)) {
      manifest = this.pluginManifests.get(config.name)!;
      logger.debug({ pluginName: config.name }, 'Using cached manifest');
    }
    // 2. 尝试从插件目录加载 manifest.json
    else if (pluginDir) {
      const manifestResult = await this.loadManifest(pluginDir);
      manifest = manifestResult.manifest;
      if (manifest) {
        this.pluginManifests.set(manifest.name, manifest);
        logger.debug({ pluginName: manifest.name, pluginDir }, 'Manifest loaded from directory');
      } else if (manifestResult.error) {
        if (manifestResult.pluginNameHint) {
          this.setPluginStateSnapshot(createPluginRegistryStateSnapshot({
            pluginName: manifestResult.pluginNameHint,
            discovery: 'discovered',
            validation: classifyPluginValidationFailure(manifestResult.error),
            persistedEnabled: 'unknown',
            contract: manifestResult.contract,
            failureReason: manifestResult.error.message,
          }));
        }

        const isLegacyCompatDevPath = manifestResult.contract?.manifestContract === 'legacy-compat'
          && isDevelopmentCompatPluginPath(pluginPath);
        if (!isLegacyCompatDevPath) {
          throw manifestResult.error;
        }

        logger.warn(
          {
            pluginPath,
            pluginDir,
            pluginName: manifestResult.pluginNameHint,
            warnings: manifestResult.contract?.contractWarnings,
          },
          'Loading legacy plugin through transitional development compatibility path',
        );
      }
    }

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

    // 类型断言为 PluginConstructor，从静态属性获取元数据（无需实例化）
    const PluginConstructor = PluginClass as any as import('./plugin.types').PluginConstructor;

    // ===== 元数据获取（manifest-first，静态属性回退） =====
    let pluginName: string;
    let pluginVersion: string;
    let pluginDescription: string;
    let pluginMetadata: import('./plugin.types').PluginMetadata | undefined;

    if (manifest) {
      // manifest-first 模式
      pluginName = manifest.name;
      pluginVersion = manifest.version;
      pluginDescription = manifest.description || '';

      // 将 manifest 转换为 PluginMetadata 格式
      pluginMetadata = {
        name: manifest.metadata?.name || manifest.name,
        description: manifest.description,
        icon: manifest.icon,
        author: manifest.author,
        license: manifest.license,
        homepage: manifest.homepage,
        repository: manifest.repository,
        keywords: manifest.keywords,
        engines: manifest.engines,
        contributes: manifest.contributes,
        permissions: manifest.permissions,
      };

      logger.debug({ pluginName, source: 'manifest' }, 'Plugin metadata loaded from manifest');
    } else {
      // 回退到静态属性
      if (!PluginConstructor.name) {
        throw new Error(`Plugin at ${pluginPath} must have a static 'name' property or manifest.json`);
      }
      if (!PluginConstructor.version) {
        throw new Error(`Plugin at ${pluginPath} must have a static 'version' property or manifest.json`);
      }

      pluginName = PluginConstructor.name;
      pluginVersion = PluginConstructor.version;
      pluginMetadata = PluginConstructor.metadata;
      pluginDescription = pluginMetadata?.description || '';

      logger.debug({ pluginName, source: 'static-props' }, 'Plugin metadata loaded from static properties');
    }

    // ✅ 同步插件到数据库，获取启用状态（唯一真相来源）
    let enabled: boolean;
    if (this.registryDB) {
      // 使用数据库作为唯一真相来源
      enabled = await this.registryDB.syncPlugin(
        pluginName,
        PluginConstructor,
        pluginPath
      );
      logger.debug(
        { pluginName, enabled, source: 'database' },
        'Plugin status loaded from database'
      );
    } else {
      // 无数据库时的降级逻辑（向后兼容）
      const existingFactory = this.pluginFactories.get(pluginName);
      const existingEnabled = existingFactory?.enabled;

      enabled = config.enabled !== undefined
        ? config.enabled
        : existingEnabled !== undefined
          ? existingEnabled
          : true;

      logger.warn(
        { pluginName, enabled },
        'Plugin state not persisted (no database connection)'
      );
    }

    // 注册插件权限（基于 manifest 或静态 metadata）
    try {
      const permissionManager = getPermissionManager();
      permissionManager.registerPlugin(
        pluginName,
        pluginMetadata || {}
      );
    } catch (error) {
      logger.warn(
        { error, pluginName },
        'Failed to register plugin permissions (permission manager may not be initialized)'
      );
    }

    // 注册工厂信息（包含 manifest 引用）
    const factoryInfo: PluginFactoryInfo = {
      PluginClass,
      config,
      enabled,
      manifest: manifest || undefined,
      metadata: pluginMetadata,
      entryPath: pluginPath,
      pluginDir: manifest?.pluginDir || pluginDir || this.inferPluginDirFromEntryPath(pluginPath) || path.dirname(pluginPath),
    };

    this.pluginFactories.set(pluginName, factoryInfo);
    this.setPluginStateSnapshot(createPluginRegistryStateSnapshot({
      pluginName,
      discovery: 'discovered',
      validation: 'validated',
      persistedEnabled: enabled ? 'enabled' : 'disabled',
      manifest: manifest || this.pluginStateSnapshots.get(pluginName)?.manifest,
      contract: manifest
        ? toPluginManifestContractSnapshot(manifest, {
          manifestContract: (manifest as any).manifestContract ?? 'legacy-compat',
          schemaVersion: (manifest as any).schemaVersion,
          artifactKind: (manifest as any).artifactKind,
          main: manifest.main,
          capabilities: Array.isArray((manifest as any).capabilities) ? (manifest as any).capabilities : [],
          uiExtensionMode: (manifest as any).uiExtensionMode,
          engines: manifest.engines,
          contractWarnings: Array.isArray((manifest as any).contractWarnings) ? (manifest as any).contractWarnings : [],
        })
        : this.pluginStateSnapshots.get(pluginName)?.contract,
    }));

    // 如果启用了插件，使用 PluginContextManager 预创建全局 context
    // 注意：不再在此处调用 onInit，而是延迟到 ScopedPluginRegistry.createInstance() 时调用
    // 这样可以避免创建临时实例，减少内存浪费
    if (enabled && isPluginContextManagerInitialized()) {
      try {
        const contextManager = getPluginContextManager();

        // 仅创建 context，不调用 onInit
        // onInit 将在 ScopedPluginRegistry 创建 handler 时通过 adaptPluginClass 调用
        contextManager.getOrCreateContext(
          pluginName,
          pluginPath,
          config.options || {}
        );

        logger.debug({ pluginName }, 'Plugin context pre-created');
      } catch (error) {
        logger.error({ error, pluginName }, 'Failed to create plugin context');
      }
    }

    // 收集插件的翻译内容（manifest 优先，静态属性回退）
    const translations = manifest?.translations || PluginConstructor.translations;
    if (translations) {
      this.pluginTranslations.set(pluginName, translations);
      logger.info(
        {
          plugin: pluginName,
          locales: Object.keys(translations),
          source: manifest?.translations ? 'manifest' : 'static-props'
        },
        'Plugin translations collected'
      );
    }

    logger.info(
      {
        pluginName,
        version: pluginVersion,
        description: pluginDescription,
        enabled
      },
      'Plugin loaded successfully'
    );

    return pluginName;
  }

  /**
   * 确保插件已加载到 registry 并返回插件名称
   */
  async ensurePluginLoaded(config: PluginConfig | string): Promise<string> {
    if (typeof config === 'string') {
      return await this.loadPlugin({ name: config });
    }
    return await this.loadPlugin(config);
  }

  /**
   * 启用 plugin
   */
  enablePlugin(name: string): boolean {
    // ✅ 更新数据库（唯一真相来源）
    if (this.registryDB) {
      const success = this.registryDB.enablePlugin(name);
      if (!success) {
        return false;
      }
    }

    // 更新内存中的状态
    const factoryInfo = this.pluginFactories.get(name);
    if (factoryInfo) {
      factoryInfo.enabled = true;
      this.setPluginStateSnapshot(createPluginRegistryStateSnapshot({
        ...(this.pluginStateSnapshots.get(name) || { pluginName: name }),
        pluginName: name,
        discovery: 'discovered',
        validation: this.pluginStateSnapshots.get(name)?.validation || 'validated',
        persistedEnabled: 'enabled',
      }));
      logger.info({ pluginName: name }, 'Plugin enabled');
      return true;
    }

    logger.warn({ pluginName: name }, 'Plugin not found in registry');
    return false;
  }

  /**
   * 禁用 plugin
   */
  disablePlugin(name: string): boolean {
    // ✅ 更新数据库（唯一真相来源）
    if (this.registryDB) {
      const success = this.registryDB.disablePlugin(name);
      if (!success) {
        return false;
      }
    }

    // 更新内存中的状态
    const factoryInfo = this.pluginFactories.get(name);
    if (factoryInfo) {
      factoryInfo.enabled = false;
      this.setPluginStateSnapshot(createPluginRegistryStateSnapshot({
        ...(this.pluginStateSnapshots.get(name) || { pluginName: name }),
        pluginName: name,
        discovery: 'discovered',
        validation: this.pluginStateSnapshots.get(name)?.validation || 'validated',
        persistedEnabled: 'disabled',
      }));
      logger.info({ pluginName: name }, 'Plugin disabled');
      return true;
    }

    logger.warn({ pluginName: name }, 'Plugin not found in registry');
    return false;
  }

  /**
   * 获取所有已扫描插件的元数据
   * 包括已启用和未启用的插件
   *
   * 元数据来源优先级：manifest > 静态属性
   */
  getAllPluginsMetadata(): Array<{
    name: string;
    version: string;
    description: string;
    metadata: any;
    enabled: boolean;
    hasManifest: boolean;
  }> {
    const plugins: Array<{
      name: string;
      version: string;
      description: string;
      metadata: any;
      enabled: boolean;
      hasManifest: boolean;
    }> = [];

    for (const [name, factoryInfo] of this.pluginFactories.entries()) {
      try {
        const manifest = factoryInfo.manifest;

        if (manifest) {
          // manifest-first 模式
          // 支持两种 manifest 结构：
          // 1. 顶层 description（旧）
          // 2. metadata.name/metadata.description（新）
          const metadataName = manifest.metadata?.name || manifest.name;
          const metadataDesc = manifest.metadata?.description || manifest.description || '';
          const metadataIcon = manifest.metadata?.icon || manifest.icon;

          plugins.push({
            name: manifest.name,
            version: manifest.version,
            description: metadataDesc,
            metadata: {
              name: metadataName,
              description: metadataDesc,
              icon: metadataIcon,
              author: manifest.author,
              license: manifest.license,
              homepage: manifest.homepage,
              repository: manifest.repository,
              keywords: manifest.keywords,
              engines: manifest.engines,
              contributes: manifest.metadata?.contributes || manifest.contributes,
            },
            enabled: factoryInfo.enabled,
            hasManifest: true,
          });
        } else {
          // 回退到静态属性
          const PluginConstructor = factoryInfo.PluginClass as any as import('./plugin.types').PluginConstructor;

          plugins.push({
            name: PluginConstructor.name,
            version: PluginConstructor.version,
            description: PluginConstructor.metadata?.description || '',
            metadata: PluginConstructor.metadata || {},
            enabled: factoryInfo.enabled,
            hasManifest: false,
          });
        }
      } catch (error) {
        logger.error(
          { error, pluginName: name },
          'Failed to get plugin metadata'
        );
      }
    }

    return plugins;
  }

  /**
   * 获取所有插件的配置 Schema
   * 用于 UI 动态生成插件配置表单
   *
   * Schema 来源优先级：manifest.configSchema > 静态属性 configSchema
   *
   * @returns 插件 Schema Map，key 为插件名，value 为插件的 schema 信息
   */
  getAllPluginSchemas(): Record<string, {
    name: string;
    version: string;
    description: string;
    metadata: any;
    configSchema: any[];
  }> {
    const schemas: Record<string, any> = {};

    for (const [name, factoryInfo] of this.pluginFactories.entries()) {
      try {
        const manifest = factoryInfo.manifest;
        const PluginConstructor = factoryInfo.PluginClass as any as import('./plugin.types').PluginConstructor;

        if (manifest) {
          // manifest-first 模式
          // 支持两种 manifest 结构
          const metadataName = manifest.metadata?.name || manifest.name;
          const metadataDesc = manifest.metadata?.description || manifest.description || '';
          const metadataIcon = manifest.metadata?.icon || manifest.icon;

          schemas[manifest.name] = {
            name: manifest.name,
            version: manifest.version,
            description: metadataDesc,
            metadata: {
              name: metadataName,
              description: metadataDesc,
              icon: metadataIcon,
              contributes: manifest.metadata?.contributes || manifest.contributes,
            },
            configSchema: manifest.configSchema || PluginConstructor.configSchema || []
          };
        } else {
          // 回退到静态属性
          schemas[PluginConstructor.name] = {
            name: PluginConstructor.name,
            version: PluginConstructor.version,
            description: PluginConstructor.metadata?.description || '',
            metadata: PluginConstructor.metadata || {},
            configSchema: PluginConstructor.configSchema || []
          };
        }
      } catch (error) {
        logger.error(
          { error, pluginName: name },
          'Failed to get plugin schema'
        );
      }
    }

    return schemas;
  }

  /**
   * 卸载所有 plugins（清理 context 和权限）
   */
  async unloadAll(): Promise<void> {
    // 安全地获取 contextManager（如果未初始化则为 null）
    const contextManager = isPluginContextManagerInitialized() ? getPluginContextManager() : null;

    for (const [name, factoryInfo] of this.pluginFactories.entries()) {
      // 创建临时实例并调用 onDestroy（用于清理全局资源）
      try {
        const tempInstance = new factoryInfo.PluginClass(factoryInfo.config.options || {});
        if (tempInstance.onDestroy) {
          await tempInstance.onDestroy();
          logger.debug({ pluginName: name }, 'Plugin cleanup completed');
        }
      } catch (error) {
        logger.error({ error, pluginName: name }, 'Error during plugin cleanup');
      }

      // 清理插件的全局 context（如果 contextManager 已初始化）
      if (contextManager) {
        try {
          await contextManager.destroyContext(name);
        } catch (error) {
          logger.error({ error, pluginName: name }, 'Error destroying plugin context');
        }
      }

      // 注销插件权限
      try {
        const permissionManager = getPermissionManager();
        permissionManager.unregisterPlugin(name);
      } catch (error) {
        logger.warn({ error, pluginName: name }, 'Failed to unregister plugin permissions');
      }
    }

    this.pluginFactories.clear();
    logger.info('All plugins unloaded');
  }

  /**
   * 获取所有插件的翻译内容，格式化为前端 i18n 可用的结构
   *
   * 翻译键会自动添加 `plugins.{pluginName}` 前缀
   *
   * @returns 按语言组织的翻译数据
   * @example
   * ```json
   * {
   *   "en": {
   *     "plugins": {
   *       "ai-transformer": {
   *         "transformation.label": "Transformation Direction",
   *         "options.anthropic_openai.label": "Anthropic → OpenAI"
   *       }
   *     }
   *   },
   *   "zh-CN": {
   *     "plugins": {
   *       "ai-transformer": {
   *         "transformation.label": "转换方向",
   *         "options.anthropic_openai.label": "Anthropic → OpenAI"
   *       }
   *     }
   *   }
   * }
   * ```
   */
  getAllPluginTranslations(): Record<string, any> {
    const result: Record<string, any> = {};

    for (const [pluginName, translations] of this.pluginTranslations) {
      for (const [locale, messages] of Object.entries(translations)) {
        // 初始化语言结构
        if (!result[locale]) {
          result[locale] = { plugins: {} };
        }
        if (!result[locale].plugins) {
          result[locale].plugins = {};
        }

        // 添加插件的翻译（以插件名为命名空间）
        result[locale].plugins[pluginName] = messages;
      }
    }

    return result;
  }

  /**
   * 获取指定插件的 manifest
   * @param pluginName 插件名称
   * @returns manifest 对象，如果不存在则返回 undefined
   */
  getPluginManifest(pluginName: string): LoadedPluginManifest | undefined {
    return this.pluginManifests.get(pluginName);
  }

  /**
   * 获取所有已加载的 manifest
   * @returns manifest Map
   */
  getAllPluginManifests(): Map<string, LoadedPluginManifest> {
    return new Map(this.pluginManifests);
  }

  getPluginApiDeclarations(pluginName: string): Array<{
    path: string;
    methods: Array<'GET' | 'POST' | 'PUT' | 'DELETE'>;
    handler: string;
  }> {
    const factoryInfo = this.pluginFactories.get(pluginName);
    const declarations = factoryInfo?.manifest?.contributes?.api
      || factoryInfo?.metadata?.contributes?.api
      || [];

    return declarations.map((declaration) => ({
      path: declaration.path,
      methods: [...declaration.methods],
      handler: declaration.handler,
    }));
  }

  getPluginAssetDescriptor(pluginName: string): {
    entryPath: string;
    pluginDir: string;
    manifest?: LoadedPluginManifest;
  } | undefined {
    const factoryInfo = this.pluginFactories.get(pluginName);
    if (!factoryInfo?.pluginDir) {
      return undefined;
    }

    return {
      entryPath: factoryInfo.entryPath,
      pluginDir: factoryInfo.pluginDir,
      manifest: factoryInfo.manifest,
    };
  }

  getPluginStateSnapshot(pluginName: string): PluginRegistryStateSnapshot | undefined {
    const snapshot = this.pluginStateSnapshots.get(pluginName);
    if (!snapshot) {
      return undefined;
    }

    return {
      ...snapshot,
      manifest: snapshot.manifest,
      contract: snapshot.contract
        ? {
          ...snapshot.contract,
          capabilities: [...snapshot.contract.capabilities],
          contractWarnings: [...snapshot.contract.contractWarnings],
          engines: snapshot.contract.engines ? { ...snapshot.contract.engines } : undefined,
        }
        : undefined,
    };
  }

  getAllPluginStateSnapshots(): Map<string, PluginRegistryStateSnapshot> {
    return new Map(this.pluginStateSnapshots);
  }

}
