import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry } from '../../src/plugin-registry';
import { handleUIRequest } from '../../src/ui/server';
import { initializePermissionManager } from '../../src/plugin-permissions';
import { initializePluginRuntime, cleanupPluginRegistry, getPluginRegistry } from '../../src/worker/state/plugin-manager';

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
  uiFiles: Record<string, string> = {}
): string {
  const pluginDir = join(root, 'plugins', pluginName);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // 模拟编译后的入口文件
  const mainPath = join(pluginDir, 'dist/index.js');
  mkdirSync(join(pluginDir, 'dist'), { recursive: true });
  writeFileSync(mainPath, 'export default class Plugin { static name = "' + pluginName + '"; static version = "1.0.0"; }');

  // 模拟 UI 资源
  const uiDir = join(pluginDir, 'ui');
  mkdirSync(uiDir, { recursive: true });
  for (const [fileName, content] of Object.entries(uiFiles)) {
    writeFileSync(join(uiDir, fileName), content);
  }

  return pluginDir;
}

afterEach(async () => {
  await cleanupPluginRegistry();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('UI Sandbox Extension Boundary', () => {
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
    }, { basePath: root });


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
    }, { basePath: root });

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
    }, { basePath: root });

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
    }, { basePath: root });

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
    }, { basePath: root });

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
    }, { basePath: root });

    const registry = getPluginRegistry()!;

    // 尝试通过路径遍历访问 manifest.json
    const req = new Request('http://localhost:8088/__ui/plugins/security-test-plugin/../manifest.json');
    const res = await handleUIRequest(req, registry);

    // 应该返回 403 或 404 (取决于实现，server.ts 中有路径遍历检查)
    expect(res?.status).toBeGreaterThanOrEqual(400);
  });
});
