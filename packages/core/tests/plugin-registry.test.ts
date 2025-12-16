import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PluginRegistry } from '../src/plugin-registry';
import { initializePluginContextManager } from '../src/plugin-context-manager';
import type { PluginConfig } from '@jeffusion/bungee-types';
import * as fs from 'fs';
import * as path from 'path';
import { Database } from 'bun:sqlite';

// 创建测试用的临时 plugin 文件
const TEST_PLUGINS_DIR = path.join(import.meta.dir, 'temp-plugins');

// 测试用的 plugin 实现（使用新的 Hook 注册模式）
const simplePluginCode = `
export class SimplePlugin {
  static name = 'simple-test-plugin';
  static version = '1.0.0';

  constructor(options = {}) {
    this.options = options;
  }

  register(hooks) {
    hooks.onRequestInit.tapPromise({ name: 'simple-test-plugin' }, async (ctx) => {
      // 简单的初始化逻辑
    });
  }
}

export default SimplePlugin;
`;

const interceptorPluginCode = `
export class InterceptorPlugin {
  static name = 'interceptor-test-plugin';
  static version = '1.0.0';

  register(hooks) {
    hooks.onInterceptRequest.tapPromise({ name: 'interceptor-test-plugin' }, async (ctx) => {
      if (ctx.url.pathname === '/intercept-me') {
        return new Response(JSON.stringify({ intercepted: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return undefined;
    });
  }
}

export default InterceptorPlugin;
`;

const errorPluginCode = `
export class ErrorPlugin {
  static name = 'error-test-plugin';
  static version = '1.0.0';

  register(hooks) {
    hooks.onRequestInit.tapPromise({ name: 'error-test-plugin' }, async (ctx) => {
      throw new Error('Test error from plugin');
    });
  }
}

export default ErrorPlugin;
`;

describe('PluginRegistry', () => {
  let registry: PluginRegistry;
  let testDb: Database;

  beforeEach(() => {
    // 创建临时测试数据库
    const testDbPath = path.join(import.meta.dir, 'temp-plugins', 'test.db');
    if (!fs.existsSync(path.dirname(testDbPath))) {
      fs.mkdirSync(path.dirname(testDbPath), { recursive: true });
    }
    testDb = new Database(testDbPath);

    // 创建 plugin_storage 表
    testDb.run(`
      CREATE TABLE IF NOT EXISTS plugin_storage (
        plugin_name TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        ttl INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (plugin_name, key)
      )
    `);

    // 初始化 PluginContextManager
    initializePluginContextManager(testDb);

    // 创建临时测试目录
    if (!fs.existsSync(TEST_PLUGINS_DIR)) {
      fs.mkdirSync(TEST_PLUGINS_DIR, { recursive: true });
    }

    // 写入测试 plugin 文件
    fs.writeFileSync(
      path.join(TEST_PLUGINS_DIR, 'simple.plugin.ts'),
      simplePluginCode
    );
    fs.writeFileSync(
      path.join(TEST_PLUGINS_DIR, 'interceptor.plugin.ts'),
      interceptorPluginCode
    );
    fs.writeFileSync(
      path.join(TEST_PLUGINS_DIR, 'error.plugin.ts'),
      errorPluginCode
    );

    registry = new PluginRegistry(TEST_PLUGINS_DIR);
  });

  afterEach(async () => {
    // 清理
    await registry.unloadAll();

    // 关闭数据库
    if (testDb) {
      testDb.close();
    }

    // 删除临时文件
    if (fs.existsSync(TEST_PLUGINS_DIR)) {
      fs.rmSync(TEST_PLUGINS_DIR, { recursive: true, force: true });
    }
  });

  describe('loadPlugin', () => {
    test('should load a plugin from file path', async () => {
      const config: PluginConfig = {
        name: 'simple',
        path: 'simple.plugin.ts',
        enabled: true
      };

      await registry.loadPlugin(config);

      const metadata = registry.getAllPluginsMetadata();
      const plugin = metadata.find(p => p.name === 'simple-test-plugin');
      expect(plugin).toBeDefined();
      expect(plugin!.name).toBe('simple-test-plugin');
      expect(plugin!.version).toBe('1.0.0');
    });

    test('should load plugin with absolute path', async () => {
      const absolutePath = path.join(TEST_PLUGINS_DIR, 'simple.plugin.ts');
      const config: PluginConfig = {
        name: 'simple-absolute',
        path: absolutePath,
        enabled: true
      };

      await registry.loadPlugin(config);

      const metadata = registry.getAllPluginsMetadata();
      const plugin = metadata.find(p => p.name === 'simple-test-plugin');
      expect(plugin).toBeDefined();
    });

    test('should respect enabled flag', async () => {
      const config: PluginConfig = {
        name: 'simple-disabled',
        path: 'simple.plugin.ts',
        enabled: false
      };

      await registry.loadPlugin(config);

      const metadata = registry.getAllPluginsMetadata();
      const plugin = metadata.find(p => p.name === 'simple-test-plugin');
      expect(plugin).toBeDefined();
      expect(plugin!.enabled).toBe(false);
    });
  });

  describe('loadPlugins', () => {
    test('should load multiple plugins', async () => {
      const configs: PluginConfig[] = [
        { name: 'simple', path: 'simple.plugin.ts' },
        { name: 'interceptor', path: 'interceptor.plugin.ts' }
      ];

      await registry.loadPlugins(configs);

      const metadata = registry.getAllPluginsMetadata();
      expect(metadata.find(p => p.name === 'simple-test-plugin')).toBeDefined();
      expect(metadata.find(p => p.name === 'interceptor-test-plugin')).toBeDefined();
    });

    test('should continue loading on error', async () => {
      const configs: PluginConfig[] = [
        { name: 'simple', path: 'simple.plugin.ts' },
        { name: 'non-existent', path: 'non-existent.plugin.ts' },
        { name: 'interceptor', path: 'interceptor.plugin.ts' }
      ];

      await registry.loadPlugins(configs);

      const metadata = registry.getAllPluginsMetadata();
      expect(metadata.find(p => p.name === 'simple-test-plugin')).toBeDefined();
      expect(metadata.find(p => p.name === 'interceptor-test-plugin')).toBeDefined();
    });
  });

  describe('enablePlugin / disablePlugin', () => {
    test('should enable a disabled plugin', async () => {
      await registry.loadPlugin({
        name: 'simple',
        path: 'simple.plugin.ts',
        enabled: false
      });

      let metadata = registry.getAllPluginsMetadata();
      let plugin = metadata.find(p => p.name === 'simple-test-plugin');
      expect(plugin!.enabled).toBe(false);

      registry.enablePlugin('simple-test-plugin');

      metadata = registry.getAllPluginsMetadata();
      plugin = metadata.find(p => p.name === 'simple-test-plugin');
      expect(plugin!.enabled).toBe(true);
    });

    test('should disable an enabled plugin', async () => {
      await registry.loadPlugin({
        name: 'simple',
        path: 'simple.plugin.ts',
        enabled: true
      });

      let metadata = registry.getAllPluginsMetadata();
      let plugin = metadata.find(p => p.name === 'simple-test-plugin');
      expect(plugin!.enabled).toBe(true);

      registry.disablePlugin('simple-test-plugin');

      metadata = registry.getAllPluginsMetadata();
      plugin = metadata.find(p => p.name === 'simple-test-plugin');
      expect(plugin!.enabled).toBe(false);
    });

    test('should return false for non-existent plugin', () => {
      expect(registry.enablePlugin('non-existent')).toBe(false);
      expect(registry.disablePlugin('non-existent')).toBe(false);
    });
  });

  describe('unloadAll', () => {
    test('should call onDestroy for all plugins', async () => {
      const destroyTrackerCode = `
        export default class DestroyTracker {
          static name = 'destroy-tracker';
          static version = '1.0.0';
          static destroyed = false;

          async onDestroy() {
            global.pluginDestroyed = true;
          }
        }
      `;
      fs.writeFileSync(
        path.join(TEST_PLUGINS_DIR, 'destroy-tracker.plugin.ts'),
        destroyTrackerCode
      );

      await registry.loadPlugin({ name: 'destroy-tracker', path: 'destroy-tracker.plugin.ts' });

      (global as any).pluginDestroyed = false;
      await registry.unloadAll();

      expect((global as any).pluginDestroyed).toBe(true);
      delete (global as any).pluginDestroyed;
    });

    test('should clear all plugins', async () => {
      await registry.loadPlugins([
        { name: 'simple', path: 'simple.plugin.ts' },
        { name: 'interceptor', path: 'interceptor.plugin.ts' }
      ]);

      expect(registry.getAllPluginsMetadata().length).toBe(2);

      await registry.unloadAll();

      expect(registry.getAllPluginsMetadata().length).toBe(0);
    });
  });

  describe('getAllPluginsMetadata', () => {
    test('should return metadata for all loaded plugins', async () => {
      await registry.loadPlugins([
        { name: 'simple', path: 'simple.plugin.ts', enabled: true },
        { name: 'interceptor', path: 'interceptor.plugin.ts', enabled: false }
      ]);

      const metadata = registry.getAllPluginsMetadata();
      expect(metadata.length).toBe(2);

      const simplePlugin = metadata.find(p => p.name === 'simple-test-plugin');
      expect(simplePlugin).toBeDefined();
      expect(simplePlugin!.version).toBe('1.0.0');
      expect(simplePlugin!.enabled).toBe(true);

      const interceptorPlugin = metadata.find(p => p.name === 'interceptor-test-plugin');
      expect(interceptorPlugin).toBeDefined();
      expect(interceptorPlugin!.version).toBe('1.0.0');
      expect(interceptorPlugin!.enabled).toBe(false);
    });
  });

  describe('getAllPluginSchemas', () => {
    test('should return schemas for all loaded plugins', async () => {
      await registry.loadPlugin({ name: 'simple', path: 'simple.plugin.ts' });

      const schemas = registry.getAllPluginSchemas();
      expect(schemas['simple-test-plugin']).toBeDefined();
      expect(schemas['simple-test-plugin'].name).toBe('simple-test-plugin');
      expect(schemas['simple-test-plugin'].version).toBe('1.0.0');
    });
  });
});
