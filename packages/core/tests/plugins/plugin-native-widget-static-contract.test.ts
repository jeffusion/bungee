import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry } from '../../src/plugin-registry';
import { loadPluginArtifactManifest } from '../../src/plugin-artifact-contract';

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungee-plugin-native-widget-static-'));
  tempRoots.push(root);
  return root;
}

function createPluginArtifact(
  root: string,
  pluginName: string,
  manifest: Record<string, unknown>,
): string {
  const pluginDir = join(root, pluginName);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // 模拟编译后的入口文件
  const mainPath = join(pluginDir, 'dist/index.js');
  mkdirSync(join(pluginDir, 'dist'), { recursive: true });
  writeFileSync(mainPath, 'export default class Plugin { static name = "' + pluginName + '"; static version = "1.0.0"; }');

  return pluginDir;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Native Widget Static Contract', () => {
  test('Native Widget must be declared with uiExtensionMode: "native-static"', async () => {
    const root = createTempRoot();
    const pluginDir = createPluginArtifact(root, 'native-widget-plugin', {
      name: 'native-widget-plugin',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['nativeWidgetsStatic'],
      uiExtensionMode: 'native-static',
      engines: { bungee: '*' },
      contributes: {
        nativeWidgets: [
          { id: 'test-widget', title: 'Test Widget', size: 'small', component: 'TestWidget' }
        ]
      }
    });

    const loaded = await loadPluginArtifactManifest(pluginDir);
    expect(loaded.uiExtensionMode).toBe('native-static');
    expect(loaded.capabilities).toContain('nativeWidgetsStatic');
  });

  test('Native Widget declaration does NOT provide runtime injection mechanism', async () => {
    const root = createTempRoot();
    const registry = new PluginRegistry(root);
    
    createPluginArtifact(root, 'native-widget-plugin', {
      name: 'native-widget-plugin',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['nativeWidgetsStatic'],
      uiExtensionMode: 'native-static',
      engines: { bungee: '*' },
      contributes: {
        nativeWidgets: [
          { id: 'test-widget', title: 'Test Widget', size: 'small', component: 'TestWidget' }
        ]
      }
    });

    await registry.scanAndLoadPlugins(root, true);
    const manifest = registry.getPluginManifest('native-widget-plugin');
    
    expect(manifest).toBeDefined();
    // 核心层只存储元数据，不负责将组件注入到 UI 运行时
    // UI 运行时必须通过构建期生成的 generated.ts 来加载组件
    expect(manifest?.contributes?.nativeWidgets?.[0].component).toBe('TestWidget');
  });

  test('rejects nativeWidgets if uiExtensionMode is not native-static', async () => {
    const root = createTempRoot();
    const pluginDir = createPluginArtifact(root, 'invalid-native-widget', {
      name: 'invalid-native-widget',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['nativeWidgetsStatic'],
      uiExtensionMode: 'sandbox-iframe', // 冲突：声明了 nativeWidgets 但模式是 sandbox-iframe
      engines: { bungee: '*' },
      contributes: {
        nativeWidgets: [
          { id: 'test-widget', title: 'Test Widget', size: 'small', component: 'TestWidget' }
        ]
      }
    });

    await expect(loadPluginArtifactManifest(pluginDir)).rejects.toThrow(
      'artifact validation error: manifest contributes.nativeWidgets requires uiExtensionMode "native-static"',
    );
  });
});
