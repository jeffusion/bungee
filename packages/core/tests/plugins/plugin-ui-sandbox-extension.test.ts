import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry } from '../../src/plugin-registry';
import { handleUIRequest } from '../../src/ui/server';
import { initializePermissionManager } from '../../src/plugin-permissions';
import {
  initializePluginRuntime,
  cleanupPluginRegistry,
  getPluginRegistry,
  getPluginRuntimeOrchestrator,
  reconcilePluginRuntime,
} from '../../src/worker/state/plugin-manager';

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungee-plugin-ui-sandbox-'));
  tempRoots.push(root);
  return root;
}

function createPluginArtifact(
  root: string,
  pluginName: string,
  manifest: Record<string, unknown>,
  uiFiles: Record<string, string> = {},
  entrySource?: string,
): string {
  const pluginDir = join(root, 'plugins', pluginName);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // 模拟编译后的入口文件
  const mainPath = join(pluginDir, 'dist/index.js');
  mkdirSync(join(pluginDir, 'dist'), { recursive: true });
  writeFileSync(mainPath, entrySource ?? 'export default class Plugin { static name = "' + pluginName + '"; static version = "1.0.0"; }');

  // 模拟 UI 资源
  const uiDir = join(pluginDir, 'ui');
  mkdirSync(uiDir, { recursive: true });
  for (const [fileName, content] of Object.entries(uiFiles)) {
    writeFileSync(join(uiDir, fileName), content);
  }

  return pluginDir;
}

function createSandboxPlugin(root: string, pluginName: string, entrySource?: string): string {
  return createPluginArtifact(root, pluginName, {
    name: pluginName,
    version: '1.0.0',
    schemaVersion: 2,
    artifactKind: 'runtime-plugin',
    main: 'dist/index.js',
    capabilities: ['sandboxUiExtension'],
    uiExtensionMode: 'sandbox-iframe',
    engines: { bungee: '*' },
  }, {
    'index.html': '<html><body>Sandbox</body></html>',
    'app.js': 'window.sandboxReady = true;',
    'style.css': 'body { color: red; }',
  }, entrySource);
}

async function requestAsset(
  registry: PluginRegistry,
  pluginName: string,
  assetPath: string,
): Promise<Response> {
  return await handleUIRequest(
    new Request(`http://localhost:8088/__ui/plugins/${pluginName}/${assetPath}`),
    registry,
  ) as Response;
}

afterEach(async () => {
  await cleanupPluginRegistry();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('UI Sandbox Extension Boundary', () => {
  test('serves index.html, JavaScript, and CSS while enabled, loaded, and serving', async () => {
    const root = createTempRoot();
    const pluginName = 'sandbox-lifecycle-plugin';
    createSandboxPlugin(root, pluginName);
    initializePermissionManager();

    const config = (enabled: boolean) => ({
      plugins: [{ name: pluginName, enabled, path: `plugins/${pluginName}/dist/index.js` }],
      routes: [],
    });

    await initializePluginRuntime(config(false), {
      basePath: root,
      activatedPluginNames: [pluginName],
    });

    let status = getPluginRuntimeOrchestrator()?.getStatusReport().plugins.find(
      (plugin) => plugin.pluginName === pluginName,
    );
    expect(status?.state.lifecycle).toBe('enabled');

    let registry = getPluginRegistry()!;
    for (const assetPath of ['index.html', 'app.js', 'style.css']) {
      expect((await requestAsset(registry, pluginName, assetPath)).status).toBe(200);
    }

    await reconcilePluginRuntime(config(true));

    status = getPluginRuntimeOrchestrator()?.getStatusReport().plugins.find(
      (plugin) => plugin.pluginName === pluginName,
    );
    expect(status?.state.lifecycle).toBe('serving');
    registry = getPluginRegistry()!;
    expect((await requestAsset(registry, pluginName, 'index.html')).status).toBe(200);

    await reconcilePluginRuntime({ plugins: [], routes: [] });

    status = getPluginRuntimeOrchestrator()?.getStatusReport().plugins.find(
      (plugin) => plugin.pluginName === pluginName,
    );
    expect(status?.state.lifecycle).toBe('loaded');
    registry = getPluginRegistry()!;
    expect((await requestAsset(registry, pluginName, 'app.js')).status).toBe(200);
  });

  for (const [lifecycle, errorMessage] of [
    ['degraded', 'runtime initialization failed'],
    ['quarantined', 'manifest negotiation error: engines.bungee is not compatible with host version'],
  ] as const) {
    test(`denies access when runtime lifecycle is ${lifecycle}`, async () => {
      const root = createTempRoot();
      const pluginName = `sandbox-${lifecycle}-plugin`;
      initializePermissionManager();
      createSandboxPlugin(root, pluginName, `export default class Plugin {
        static name = ${JSON.stringify(pluginName)};
        static version = '1.0.0';
        static async createHandler() { throw new Error(${JSON.stringify(errorMessage)}); }
      }`);

      await initializePluginRuntime({
        plugins: [{ name: pluginName, enabled: true, path: `plugins/${pluginName}/dist/index.js` }],
        routes: [],
      }, { basePath: root, activatedPluginNames: [pluginName] });

      const status = getPluginRuntimeOrchestrator()?.getStatusReport().plugins.find(
        (plugin) => plugin.pluginName === pluginName,
      );
      expect(status?.state.lifecycle).toBe(lifecycle);

      const res = await requestAsset(getPluginRegistry()!, pluginName, 'index.html');
      expect(res.status).toBe(403);
      expect(await res.text()).toContain(lifecycle);
    });
  }

  test('denies missing plugin and missing runtime with 403', async () => {
    const root = createTempRoot();
    initializePermissionManager();

    // Keep the real orchestrator empty, then build a separate metadata registry
    // to exercise the missing-runtime branch without mocking lifecycle state.
    await initializePluginRuntime({ plugins: [], routes: [] }, {
      basePath: root,
      activatedPluginNames: [],
    });

    const emptyRegistry = getPluginRegistry()!;
    const missingPlugin = await requestAsset(emptyRegistry, 'missing-plugin', 'index.html');
    expect(missingPlugin.status).toBe(403);

    const pluginName = 'runtime-missing-plugin';
    createSandboxPlugin(root, pluginName);
    const metadataRegistry = new PluginRegistry(root, new Set([pluginName]));
    await metadataRegistry.scanAndLoadPlugins(join(root, 'plugins'), false);

    const missingRuntime = await requestAsset(metadataRegistry, pluginName, 'index.html');
    expect(missingRuntime.status).toBe(403);
    expect(await missingRuntime.text()).toContain('not active in runtime');
    await metadataRegistry.unloadAll();
  });

  test('serves sandbox UI assets from /__ui/plugins/:pluginName/ when serving', async () => {
    const root = createTempRoot();
    initializePermissionManager();

    createPluginArtifact(root, 'sandbox-plugin', {
      name: 'sandbox-plugin',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['hooks', 'sandboxUiExtension'],
      uiExtensionMode: 'sandbox-iframe',
      engines: { bungee: '*' }
    }, {
      'index.html': '<html><body>Sandbox</body></html>',
      'style.css': 'body { color: red; }'
    });

    // 初始化运行时，使插件处于 serving 状态
    await initializePluginRuntime({
      plugins: [{
        name: 'sandbox-plugin',
        enabled: true,
        path: 'plugins/sandbox-plugin/dist/index.js'
      }],
      routes: []
    }, { basePath: root, activatedPluginNames: ['sandbox-plugin'] });


    const registry = getPluginRegistry()!;

    // 模拟请求 /__ui/plugins/sandbox-plugin/index.html
    const req = new Request('http://localhost:8088/__ui/plugins/sandbox-plugin/index.html');
    const res = await handleUIRequest(req, registry);

    expect(res).toBeDefined();
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe('<html><body>Sandbox</body></html>');
    expect(res?.headers.get('Content-Type')).toBe('text/html');
    // 验证 CSP 和 Sandbox 相关的安全头
    expect(res?.headers.get('Content-Security-Policy')).toBeDefined();
    expect(res?.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
  });

  test('denies access when sandboxUiExtension capability is missing', async () => {
    const root = createTempRoot();
    initializePermissionManager();

    createPluginArtifact(root, 'missing-cap-plugin', {
      name: 'missing-cap-plugin',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['hooks'], // 缺少 sandboxUiExtension
      uiExtensionMode: 'sandbox-iframe',
      engines: { bungee: '*' }
    }, {
      'index.html': '<html><body>Missing Cap</body></html>'
    });

    await initializePluginRuntime({
      plugins: [{
        name: 'missing-cap-plugin',
        enabled: true,
        path: 'plugins/missing-cap-plugin/dist/index.js'
      }],
      routes: []
    }, { basePath: root, activatedPluginNames: ['missing-cap-plugin'] });

    const registry = getPluginRegistry()!;

    const req = new Request('http://localhost:8088/__ui/plugins/missing-cap-plugin/index.html');
    const res = await handleUIRequest(req, registry);

    expect(res?.status).toBe(403);
    expect(await res?.text()).toContain('sandboxUiExtension');
  });

  test('denies access when plugin is disabled', async () => {
    const root = createTempRoot();
    initializePermissionManager();

    createPluginArtifact(root, 'disabled-plugin', {
      name: 'disabled-plugin',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['sandboxUiExtension'],
      uiExtensionMode: 'sandbox-iframe',
      engines: { bungee: '*' }
    }, {
      'index.html': '<html><body>Disabled</body></html>'
    });

    // 初始化运行时，但不启用该插件
    await initializePluginRuntime({
      plugins: [{
        name: 'disabled-plugin',
        enabled: false,
        path: 'plugins/disabled-plugin/dist/index.js'
      }],
      routes: []
    }, { basePath: root, activatedPluginNames: [] });

    const registry = getPluginRegistry()!;

    const req = new Request('http://localhost:8088/__ui/plugins/disabled-plugin/index.html');
    const res = await handleUIRequest(req, registry);

    expect(res?.status).toBe(403);
    expect(await res?.text()).toContain('disabled');
  });

  test('denies access when uiExtensionMode is not sandbox-iframe', async () => {
    const root = createTempRoot();
    initializePermissionManager();

    createPluginArtifact(root, 'native-plugin', {
      name: 'native-plugin',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['hooks'],
      uiExtensionMode: 'native-static',
      engines: { bungee: '*' }
    }, {
      'index.html': '<html><body>Native</body></html>'
    });

    await initializePluginRuntime({
      plugins: [{
        name: 'native-plugin',
        enabled: true,
        path: 'plugins/native-plugin/dist/index.js'
      }],
      routes: []
    }, { basePath: root, activatedPluginNames: ['native-plugin'] });

    const registry = getPluginRegistry()!;

    const req = new Request('http://localhost:8088/__ui/plugins/native-plugin/index.html');
    const res = await handleUIRequest(req, registry);

    expect(res?.status).toBe(403);
    expect(await res?.text()).toContain('sandbox-iframe');
  });

  test('sandbox UI extension is independent from native widgets', async () => {
    const root = createTempRoot();
    initializePermissionManager();

    createPluginArtifact(root, 'pure-sandbox-plugin', {
      name: 'pure-sandbox-plugin',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['sandboxUiExtension'],
      uiExtensionMode: 'sandbox-iframe',
      engines: { bungee: '*' }
    }, {
      'index.html': '<html><body>Independent Sandbox</body></html>'
    });

    await initializePluginRuntime({
      plugins: [{
        name: 'pure-sandbox-plugin',
        enabled: true,
        path: 'plugins/pure-sandbox-plugin/dist/index.js'
      }],
      routes: []
    }, { basePath: root, activatedPluginNames: ['pure-sandbox-plugin'] });

    const registry = getPluginRegistry()!;

    const req = new Request('http://localhost:8088/__ui/plugins/pure-sandbox-plugin/index.html');
    const res = await handleUIRequest(req, registry);

    expect(res?.status).toBe(200);
    const manifest = registry.getPluginManifest('pure-sandbox-plugin');
    // 验证它没有 nativeWidgets 声明，但依然能正常服务 UI
    expect(manifest?.contributes?.nativeWidgets).toBeUndefined();
    expect(manifest?.uiExtensionMode).toBe('sandbox-iframe');
  });

  test('denies access to files outside of ui/ directory', async () => {
    const root = createTempRoot();
    initializePermissionManager();

    createPluginArtifact(root, 'security-test-plugin', {
      name: 'security-test-plugin',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['sandboxUiExtension'],
      uiExtensionMode: 'sandbox-iframe',
      engines: { bungee: '*' }
    });

    // 初始化运行时，确保它能通过准入检查
    await initializePluginRuntime({
      plugins: [{
        name: 'security-test-plugin',
        enabled: true,
        path: 'plugins/security-test-plugin/dist/index.js'
      }],
      routes: []
    }, { basePath: root, activatedPluginNames: ['security-test-plugin'] });

    const registry = getPluginRegistry()!;

    // 尝试通过路径遍历访问 manifest.json
    const req = new Request('http://localhost:8088/__ui/plugins/security-test-plugin/../manifest.json');
    const res = await handleUIRequest(req, registry);

    // 应该返回 403 或 404 (取决于实现，server.ts 中有路径遍历检查)
    expect(res?.status).toBeGreaterThanOrEqual(400);
  });
});
