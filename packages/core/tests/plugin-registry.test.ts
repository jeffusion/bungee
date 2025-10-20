import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PluginRegistry } from '../src/plugin-registry';
import type { Plugin, PluginContext } from '../src/plugin.types';
import type { PluginConfig } from '@jeffusion/bungee-shared';
import * as fs from 'fs';
import * as path from 'path';

// 创建测试用的临时 plugin 文件
const TEST_PLUGINS_DIR = path.join(import.meta.dir, 'temp-plugins');

// 测试用的 plugin 实现
const simplePluginCode = `
export class SimplePlugin {
  name = 'simple-test-plugin';
  version = '1.0.0';

  constructor(options = {}) {
    this.options = options;
  }

  async onRequestInit(ctx) {
    ctx.request.simple = 'initialized';
  }
}

export default SimplePlugin;
`;

const interceptorPluginCode = `
export class InterceptorPlugin {
  name = 'interceptor-test-plugin';
  version = '1.0.0';

  async onInterceptRequest(ctx) {
    if (ctx.url.pathname === '/intercept-me') {
      return new Response(JSON.stringify({ intercepted: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return null;
  }
}

export default InterceptorPlugin;
`;

const errorPluginCode = `
export class ErrorPlugin {
  name = 'error-test-plugin';
  version = '1.0.0';

  async onRequestInit(ctx) {
    throw new Error('Test error from plugin');
  }
}

export default ErrorPlugin;
`;

describe('PluginRegistry', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
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

    // 删除临时文件
    if (fs.existsSync(TEST_PLUGINS_DIR)) {
      fs.rmSync(TEST_PLUGINS_DIR, { recursive: true, force: true });
    }
  });

  describe('loadPlugin', () => {
    test('should load a plugin from file path', async () => {
      const config: PluginConfig = {
        path: 'simple.plugin.ts',
        enabled: true
      };

      await registry.loadPlugin(config);

      const plugin = registry.getPlugin('simple-test-plugin');
      expect(plugin).toBeDefined();
      expect(plugin?.name).toBe('simple-test-plugin');
      expect(plugin?.version).toBe('1.0.0');
    });

    test('should load plugin with absolute path', async () => {
      const absolutePath = path.join(TEST_PLUGINS_DIR, 'simple.plugin.ts');
      const config: PluginConfig = {
        path: absolutePath,
        enabled: true
      };

      await registry.loadPlugin(config);

      const plugin = registry.getPlugin('simple-test-plugin');
      expect(plugin).toBeDefined();
    });

    test('should pass options to plugin constructor', async () => {
      const config: PluginConfig = {
        path: 'simple.plugin.ts',
        options: {
          testOption: 'test-value'
        }
      };

      await registry.loadPlugin(config);

      const plugin = registry.getPlugin('simple-test-plugin') as any;
      expect(plugin.options).toEqual({ testOption: 'test-value' });
    });

    test('should respect enabled flag', async () => {
      const config: PluginConfig = {
        path: 'simple.plugin.ts',
        enabled: false
      };

      await registry.loadPlugin(config);

      const plugin = registry.getPlugin('simple-test-plugin');
      expect(plugin).toBeUndefined();
    });
  });

  describe('loadPlugins', () => {
    test('should load multiple plugins', async () => {
      const configs: PluginConfig[] = [
        { path: 'simple.plugin.ts' },
        { path: 'interceptor.plugin.ts' }
      ];

      await registry.loadPlugins(configs);

      expect(registry.getPlugin('simple-test-plugin')).toBeDefined();
      expect(registry.getPlugin('interceptor-test-plugin')).toBeDefined();
    });

    test('should continue loading on error', async () => {
      const configs: PluginConfig[] = [
        { path: 'simple.plugin.ts' },
        { path: 'non-existent.plugin.ts' }, // 这个会失败
        { path: 'interceptor.plugin.ts' }
      ];

      await registry.loadPlugins(configs);

      // 应该加载成功的 plugins
      expect(registry.getPlugin('simple-test-plugin')).toBeDefined();
      expect(registry.getPlugin('interceptor-test-plugin')).toBeDefined();
    });
  });

  describe('getEnabledPlugins', () => {
    test('should return only enabled plugins', async () => {
      await registry.loadPlugins([
        { path: 'simple.plugin.ts', enabled: true },
        { path: 'interceptor.plugin.ts', enabled: false }
      ]);

      const plugins = registry.getEnabledPlugins();
      expect(plugins.length).toBe(1);
      expect(plugins[0].name).toBe('simple-test-plugin');
    });

    test('should return all plugins when all are enabled', async () => {
      await registry.loadPlugins([
        { path: 'simple.plugin.ts' },
        { path: 'interceptor.plugin.ts' }
      ]);

      const plugins = registry.getEnabledPlugins();
      expect(plugins.length).toBe(2);
    });
  });

  describe('enablePlugin / disablePlugin', () => {
    test('should enable a disabled plugin', async () => {
      await registry.loadPlugin({
        path: 'simple.plugin.ts',
        enabled: false
      });

      expect(registry.getPlugin('simple-test-plugin')).toBeUndefined();

      registry.enablePlugin('simple-test-plugin');

      expect(registry.getPlugin('simple-test-plugin')).toBeDefined();
    });

    test('should disable an enabled plugin', async () => {
      await registry.loadPlugin({
        path: 'simple.plugin.ts',
        enabled: true
      });

      expect(registry.getPlugin('simple-test-plugin')).toBeDefined();

      registry.disablePlugin('simple-test-plugin');

      expect(registry.getPlugin('simple-test-plugin')).toBeUndefined();
    });

    test('should return false for non-existent plugin', () => {
      expect(registry.enablePlugin('non-existent')).toBe(false);
      expect(registry.disablePlugin('non-existent')).toBe(false);
    });
  });

  describe('executeOnRequestInit', () => {
    test('should execute onRequestInit hook', async () => {
      await registry.loadPlugin({ path: 'simple.plugin.ts' });

      const context: PluginContext = {
        method: 'GET',
        url: new URL('http://localhost/test'),
        headers: {},
        body: null,
        request: {}
      };

      await registry.executeOnRequestInit(context);

      expect(context.request.simple).toBe('initialized');
    });

    test('should handle errors in onRequestInit gracefully', async () => {
      await registry.loadPlugin({ path: 'error.plugin.ts' });

      const context: PluginContext = {
        method: 'GET',
        url: new URL('http://localhost/test'),
        headers: {},
        body: null,
        request: {}
      };

      // 不应该抛出错误
      await expect(registry.executeOnRequestInit(context)).resolves.toBeUndefined();
    });
  });

  describe('executeOnInterceptRequest', () => {
    test('should return null if no plugin intercepts', async () => {
      await registry.loadPlugin({ path: 'interceptor.plugin.ts' });

      const context: PluginContext = {
        method: 'GET',
        url: new URL('http://localhost/normal-path'),
        headers: {},
        body: null,
        request: {}
      };

      const result = await registry.executeOnInterceptRequest(context);
      expect(result).toBeNull();
    });

    test('should return response if plugin intercepts', async () => {
      await registry.loadPlugin({ path: 'interceptor.plugin.ts' });

      const context: PluginContext = {
        method: 'GET',
        url: new URL('http://localhost/intercept-me'),
        headers: {},
        body: null,
        request: {}
      };

      const result = await registry.executeOnInterceptRequest(context);
      expect(result).toBeInstanceOf(Response);
      expect(result?.status).toBe(200);

      const json = await result?.json();
      expect(json).toEqual({ intercepted: true });
    });

    test('should return first interceptor response', async () => {
      // 创建第二个 interceptor plugin
      const secondInterceptorCode = `
        export default class {
          name = 'second-interceptor';
          async onInterceptRequest(ctx) {
            return new Response('second', { status: 200 });
          }
        }
      `;
      fs.writeFileSync(
        path.join(TEST_PLUGINS_DIR, 'second-interceptor.plugin.ts'),
        secondInterceptorCode
      );

      await registry.loadPlugins([
        { path: 'interceptor.plugin.ts' },
        { path: 'second-interceptor.plugin.ts' }
      ]);

      const context: PluginContext = {
        method: 'GET',
        url: new URL('http://localhost/intercept-me'),
        headers: {},
        body: null,
        request: {}
      };

      const result = await registry.executeOnInterceptRequest(context);

      // 应该返回第一个 interceptor 的响应
      const json = await result?.json();
      expect(json).toEqual({ intercepted: true });
    });
  });

  describe('executePluginOnRequestInit', () => {
    test('should execute specific plugin onRequestInit hook', async () => {
      await registry.loadPlugin({ path: 'simple.plugin.ts' });

      const context: PluginContext = {
        method: 'GET',
        url: new URL('http://localhost/test'),
        headers: {},
        body: null,
        request: {}
      };

      await registry.executePluginOnRequestInit('simple-test-plugin', context);

      expect(context.request.simple).toBe('initialized');
    });

    test('should handle non-existent plugin gracefully', async () => {
      const context: PluginContext = {
        method: 'GET',
        url: new URL('http://localhost/test'),
        headers: {},
        body: null,
        request: {}
      };

      await expect(
        registry.executePluginOnRequestInit('non-existent', context)
      ).resolves.toBeUndefined();
    });

    test('should handle errors in hook gracefully', async () => {
      await registry.loadPlugin({ path: 'error.plugin.ts' });

      const context: PluginContext = {
        method: 'GET',
        url: new URL('http://localhost/test'),
        headers: {},
        body: null,
        request: {}
      };

      await expect(
        registry.executePluginOnRequestInit('error-test-plugin', context)
      ).resolves.toBeUndefined();
    });
  });

  describe('executePluginOnInterceptRequest', () => {
    test('should execute specific plugin onInterceptRequest hook', async () => {
      await registry.loadPlugin({ path: 'interceptor.plugin.ts' });

      const context: PluginContext = {
        method: 'GET',
        url: new URL('http://localhost/intercept-me'),
        headers: {},
        body: null,
        request: {}
      };

      const result = await registry.executePluginOnInterceptRequest('interceptor-test-plugin', context);
      expect(result).toBeInstanceOf(Response);
      expect(result?.status).toBe(200);

      const json = await result?.json();
      expect(json).toEqual({ intercepted: true });
    });

    test('should return null if plugin does not intercept', async () => {
      await registry.loadPlugin({ path: 'interceptor.plugin.ts' });

      const context: PluginContext = {
        method: 'GET',
        url: new URL('http://localhost/normal-path'),
        headers: {},
        body: null,
        request: {}
      };

      const result = await registry.executePluginOnInterceptRequest('interceptor-test-plugin', context);
      expect(result).toBeNull();
    });

    test('should return null for non-existent plugin', async () => {
      const context: PluginContext = {
        method: 'GET',
        url: new URL('http://localhost/test'),
        headers: {},
        body: null,
        request: {}
      };

      const result = await registry.executePluginOnInterceptRequest('non-existent', context);
      expect(result).toBeNull();
    });
  });

  describe('executePluginOnBeforeRequest', () => {
    test('should execute specific plugin onBeforeRequest hook', async () => {
      const beforeRequestPluginCode = `
        export default class {
          name = 'before-request-plugin';
          async onBeforeRequest(ctx) {
            ctx.headers['x-custom'] = 'modified';
            ctx.url.pathname = '/modified-path';
          }
        }
      `;
      fs.writeFileSync(
        path.join(TEST_PLUGINS_DIR, 'before-request.plugin.ts'),
        beforeRequestPluginCode
      );

      await registry.loadPlugin({ path: 'before-request.plugin.ts' });

      const context: PluginContext = {
        method: 'GET',
        url: new URL('http://localhost/original-path'),
        headers: {},
        body: null,
        request: {}
      };

      await registry.executePluginOnBeforeRequest('before-request-plugin', context);

      expect(context.headers['x-custom']).toBe('modified');
      expect(context.url.pathname).toBe('/modified-path');
    });

    test('should handle non-existent plugin gracefully', async () => {
      const context: PluginContext = {
        method: 'GET',
        url: new URL('http://localhost/test'),
        headers: {},
        body: null,
        request: {}
      };

      await expect(
        registry.executePluginOnBeforeRequest('non-existent', context)
      ).resolves.toBeUndefined();
    });
  });

  describe('executePluginOnResponse', () => {
    test('should execute specific plugin onResponse hook and return modified response', async () => {
      const responsePluginCode = `
        export default class {
          name = 'response-plugin';
          async onResponse(ctx) {
            const originalBody = await ctx.response.text();
            return new Response(
              JSON.stringify({ modified: true, original: originalBody }),
              {
                status: ctx.response.status,
                headers: { 'Content-Type': 'application/json' }
              }
            );
          }
        }
      `;
      fs.writeFileSync(
        path.join(TEST_PLUGINS_DIR, 'response.plugin.ts'),
        responsePluginCode
      );

      await registry.loadPlugin({ path: 'response.plugin.ts' });

      const originalResponse = new Response('original body', { status: 200 });
      const context: PluginContext & { response: Response } = {
        method: 'GET',
        url: new URL('http://localhost/test'),
        headers: {},
        body: null,
        request: {},
        response: originalResponse
      };

      const result = await registry.executePluginOnResponse('response-plugin', context);

      expect(result).toBeInstanceOf(Response);
      expect(result.status).toBe(200);

      const json = await result.json();
      expect(json.modified).toBe(true);
      expect(json.original).toBe('original body');
    });

    test('should return original response if plugin does not modify', async () => {
      const passthroughPluginCode = `
        export default class {
          name = 'passthrough-plugin';
          async onResponse(ctx) {
            // Don't return anything - should keep original response
          }
        }
      `;
      fs.writeFileSync(
        path.join(TEST_PLUGINS_DIR, 'passthrough.plugin.ts'),
        passthroughPluginCode
      );

      await registry.loadPlugin({ path: 'passthrough.plugin.ts' });

      const originalResponse = new Response('original', { status: 200 });
      const context: PluginContext & { response: Response } = {
        method: 'GET',
        url: new URL('http://localhost/test'),
        headers: {},
        body: null,
        request: {},
        response: originalResponse
      };

      const result = await registry.executePluginOnResponse('passthrough-plugin', context);
      expect(result).toBe(originalResponse);
    });

    test('should return original response for non-existent plugin', async () => {
      const originalResponse = new Response('original', { status: 200 });
      const context: PluginContext & { response: Response } = {
        method: 'GET',
        url: new URL('http://localhost/test'),
        headers: {},
        body: null,
        request: {},
        response: originalResponse
      };

      const result = await registry.executePluginOnResponse('non-existent', context);
      expect(result).toBe(originalResponse);
    });
  });

  describe('executePluginOnError', () => {
    test('should execute specific plugin onError hook', async () => {
      const errorHandlerPluginCode = `
        export default class {
          name = 'error-handler-plugin';
          async onError(ctx) {
            ctx.request.errorHandled = true;
            ctx.request.errorMessage = ctx.error.message;
          }
        }
      `;
      fs.writeFileSync(
        path.join(TEST_PLUGINS_DIR, 'error-handler.plugin.ts'),
        errorHandlerPluginCode
      );

      await registry.loadPlugin({ path: 'error-handler.plugin.ts' });

      const testError = new Error('Test error');
      const context: PluginContext & { error: Error } = {
        method: 'GET',
        url: new URL('http://localhost/test'),
        headers: {},
        body: null,
        request: {},
        error: testError
      };

      await registry.executePluginOnError('error-handler-plugin', context);

      expect(context.request.errorHandled).toBe(true);
      expect(context.request.errorMessage).toBe('Test error');
    });

    test('should handle non-existent plugin gracefully', async () => {
      const context: PluginContext & { error: Error } = {
        method: 'GET',
        url: new URL('http://localhost/test'),
        headers: {},
        body: null,
        request: {},
        error: new Error('Test error')
      };

      await expect(
        registry.executePluginOnError('non-existent', context)
      ).resolves.toBeUndefined();
    });
  });

  describe('unloadAll', () => {
    test('should call onDestroy for all plugins', async () => {
      const destroyTrackerCode = `
        export default class {
          name = 'destroy-tracker';
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

      await registry.loadPlugin({ path: 'destroy-tracker.plugin.ts' });

      (global as any).pluginDestroyed = false;
      await registry.unloadAll();

      expect((global as any).pluginDestroyed).toBe(true);
      delete (global as any).pluginDestroyed;
    });

    test('should clear all plugins', async () => {
      await registry.loadPlugins([
        { path: 'simple.plugin.ts' },
        { path: 'interceptor.plugin.ts' }
      ]);

      expect(registry.getEnabledPlugins().length).toBe(2);

      await registry.unloadAll();

      expect(registry.getEnabledPlugins().length).toBe(0);
    });
  });

  describe('loadTransformerPlugin', () => {
    test('should auto-load transformer plugin by name', async () => {
      // Use a registry pointing to the actual plugins directory
      const srcPath = path.join(import.meta.dir, '..', 'src');
      const prodRegistry = new PluginRegistry(srcPath);

      const plugin = await prodRegistry.loadTransformerPlugin('anthropic-to-gemini');

      expect(plugin).toBeDefined();
      expect(plugin?.name).toBe('anthropic-to-gemini');
      expect(plugin?.processStreamChunk).toBeDefined();

      await prodRegistry.unloadAll();
    });

    test('should return existing plugin if already loaded', async () => {
      const srcPath = path.join(import.meta.dir, '..', 'src');
      const prodRegistry = new PluginRegistry(srcPath);

      const plugin1 = await prodRegistry.loadTransformerPlugin('anthropic-to-gemini');
      const plugin2 = await prodRegistry.loadTransformerPlugin('anthropic-to-gemini');

      expect(plugin1).toBe(plugin2);

      await prodRegistry.unloadAll();
    });

    test('should return null for non-existent transformer', async () => {
      const srcPath = path.join(import.meta.dir, '..', 'src');
      const prodRegistry = new PluginRegistry(srcPath);

      const plugin = await prodRegistry.loadTransformerPlugin('non-existent-transformer');

      expect(plugin).toBeNull();

      await prodRegistry.unloadAll();
    });
  });
});
