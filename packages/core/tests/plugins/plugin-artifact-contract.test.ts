import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PluginRegistry } from '../../src/plugin-registry';
import {
  CORE_HOST_VERSION,
  isDevelopmentCompatPluginPath,
  loadPluginArtifactManifest,
} from '../../src/plugin-artifact-contract';

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungee-plugin-artifact-contract-'));
  tempRoots.push(root);
  return root;
}

function writePluginModule(targetPath: string): void {
  writeFileSync(
    targetPath,
    `export default class ArtifactContractPlugin {
  static version = '1.0.0';
}
`
  );
}

function createPluginArtifact(
  root: string,
  pluginName: string,
  manifest: Record<string, unknown>,
  options: {
    writeBuiltEntry?: boolean;
    writeUiAssets?: boolean;
    writeSourceEntry?: boolean;
  } = {}
): string {
  const pluginDir = join(root, pluginName);
  mkdirSync(pluginDir, { recursive: true });

  writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  if (options.writeBuiltEntry !== false && typeof manifest.main === 'string') {
    const builtEntryPath = join(pluginDir, manifest.main);
    mkdirSync(dirname(builtEntryPath), { recursive: true });
    writePluginModule(builtEntryPath);
  }

  if (options.writeUiAssets) {
    mkdirSync(join(pluginDir, 'ui'), { recursive: true });
    writeFileSync(join(pluginDir, 'ui', 'widget.js'), 'export const widget = true;\n');
  }

  if (options.writeSourceEntry) {
    const sourceEntryPath = join(pluginDir, 'server', 'index.ts');
    mkdirSync(dirname(sourceEntryPath), { recursive: true });
    writePluginModule(sourceEntryPath);
  }

  return pluginDir;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('plugin artifact contract', () => {
  test('loads manifest-first plugin artifact with built entry and optional ui assets', async () => {
    const root = createTempRoot();
    const pluginDir = createPluginArtifact(root, 'artifact-ok', {
      name: 'artifact-ok',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['hooks'],
      uiExtensionMode: 'sandbox-iframe',
      engines: {
        bungee: `^${CORE_HOST_VERSION}`,
      },
    }, {
      writeBuiltEntry: true,
      writeUiAssets: true,
    });

    const registry = new PluginRegistry(root);
    const loaded = await registry.scanAndLoadPlugins(root, true);
    const manifest = registry.getPluginManifest('artifact-ok');

    expect(loaded).toEqual(['artifact-ok']);
    expect(manifest).toBeDefined();
    expect(manifest?.pluginDir).toBe(pluginDir);
    expect(manifest?.mainPath).toBe(join(pluginDir, 'dist', 'index.js'));
    expect(manifest?.uiAssetsPath).toBe(join(pluginDir, 'ui'));
    expect(manifest?.schemaVersion).toBe(2);
    expect(manifest?.artifactKind).toBe('runtime-plugin');
    expect(manifest?.capabilities).toEqual(['hooks']);
    expect(manifest?.uiExtensionMode).toBe('sandbox-iframe');
  });

  test('rejects artifact manifest without schemaVersion even if source server entry exists', async () => {
    const root = createTempRoot();
    createPluginArtifact(root, 'missing-schema-version', {
      name: 'missing-schema-version',
      version: '1.0.0',
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['hooks'],
      uiExtensionMode: 'none',
      engines: {
        bungee: `^${CORE_HOST_VERSION}`,
      },
    }, {
      writeBuiltEntry: true,
      writeSourceEntry: true,
    });

    const registry = new PluginRegistry(root);
    const loaded = await registry.scanAndLoadPlugins(root, true);

    expect(loaded).toEqual([]);
    expect(registry.getPluginManifest('missing-schema-version')).toBeUndefined();
  });

  test('rejects artifact manifest missing required fields', async () => {
    const root = createTempRoot();
    const pluginDir = createPluginArtifact(root, 'missing-capabilities', {
      name: 'missing-capabilities',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      uiExtensionMode: 'none',
      engines: {
        bungee: `^${CORE_HOST_VERSION}`,
      },
    }, {
      writeBuiltEntry: true,
    });

    await expect(loadPluginArtifactManifest(pluginDir)).rejects.toThrow('manifest field "capabilities"');
  });

  test('rejects artifact manifest when built server entry is missing', async () => {
    const root = createTempRoot();
    const pluginDir = createPluginArtifact(root, 'missing-built-entry', {
      name: 'missing-built-entry',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['hooks'],
      uiExtensionMode: 'none',
      engines: {
        bungee: `^${CORE_HOST_VERSION}`,
      },
    }, {
      writeBuiltEntry: false,
    });

    await expect(loadPluginArtifactManifest(pluginDir)).rejects.toThrow('built server entry not found');
  });

  test('rejects invalid uiExtensionMode values', async () => {
    const root = createTempRoot();
    const pluginDir = createPluginArtifact(root, 'invalid-ui-extension-mode', {
      name: 'invalid-ui-extension-mode',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['hooks'],
      uiExtensionMode: 'native-runtime',
      engines: {
        bungee: `^${CORE_HOST_VERSION}`,
      },
    }, {
      writeBuiltEntry: true,
    });

    await expect(loadPluginArtifactManifest(pluginDir)).rejects.toThrow('uiExtensionMode');
  });

  test('marks server source entry as development compatibility input only', () => {
    expect(isDevelopmentCompatPluginPath('/tmp/plugins/demo/server/index.ts')).toBe(true);
    expect(isDevelopmentCompatPluginPath('/tmp/plugins/demo/server/index.js')).toBe(true);
    expect(isDevelopmentCompatPluginPath('/tmp/plugins/demo/dist/index.js')).toBe(false);
  });
});
