import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PluginRegistry } from '../../src/plugin-registry';
import { PluginRuntimeOrchestrator } from '../../src/plugin-runtime-orchestrator';
import {
  CORE_HOST_VERSION,
  PLUGIN_MANIFEST_ENGINE_MISMATCH_ERROR,
  PLUGIN_MANIFEST_LEGACY_WARNING,
  PLUGIN_MANIFEST_MISSING_ARTIFACT_ERROR,
  PLUGIN_MANIFEST_SCHEMA_MISMATCH_ERROR,
  PLUGIN_MANIFEST_UNSUPPORTED_CAPABILITY_ERROR,
  SUPPORTED_PLUGIN_CAPABILITIES,
  loadPluginArtifactManifest,
} from '../../src/plugin-artifact-contract';

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungee-plugin-manifest-vnext-'));
  tempRoots.push(root);
  return root;
}

function writePluginModule(targetPath: string, pluginName: string): void {
  writeFileSync(
    targetPath,
    `export default class ManifestContractPlugin {
  static version = '1.0.0';

  static async createHandler(config) {
    return {
      pluginName: ${JSON.stringify(pluginName)},
      config,
      register() {},
    };
  }
}
`
  );
}

function createPluginArtifact(
  root: string,
  pluginName: string,
  manifest: Record<string, unknown>,
): string {
  const pluginDir = join(root, pluginName);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  if (typeof manifest.main === 'string') {
    const entryPath = join(pluginDir, manifest.main);
    mkdirSync(dirname(entryPath), { recursive: true });
    writePluginModule(entryPath, pluginName);
  }

  return pluginDir;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('plugin manifest vNext contract', () => {
  test('accepts valid vNext manifest with explicit schema, capabilities, artifact and engine contract', async () => {
    const root = createTempRoot();
    const pluginDir = createPluginArtifact(root, 'manifest-vnext-ok', {
      name: 'manifest-vnext-ok',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['hooks', 'api', 'nativeWidgetsStatic', 'sandboxUiExtension', 'dynamicRuntimeLoad'],
      uiExtensionMode: 'sandbox-iframe',
      engines: {
        bungee: `^${CORE_HOST_VERSION}`,
      },
      contributes: {
        api: [{ path: '/summary', methods: ['GET'], handler: 'getSummary' }],
      },
    });

    const loaded = await loadPluginArtifactManifest(pluginDir);

    expect(loaded.schemaVersion).toBe(2);
    expect(loaded.artifactKind).toBe('runtime-plugin');
    expect(loaded.capabilities).toEqual([...SUPPORTED_PLUGIN_CAPABILITIES]);
    expect(loaded.uiExtensionMode).toBe('sandbox-iframe');
    expect(loaded.engines.bungee).toBe(`^${CORE_HOST_VERSION}`);
    expect(loaded.manifestContract).toBe('vnext');
    expect(loaded.contractWarnings).toEqual([]);
  });

  test('deterministically rejects unsupported capabilities instead of silently falling back', async () => {
    const root = createTempRoot();
    const pluginDir = createPluginArtifact(root, 'manifest-vnext-unsupported-capability', {
      name: 'manifest-vnext-unsupported-capability',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['hooks', 'nativeRuntimeInjection'],
      uiExtensionMode: 'none',
      engines: {
        bungee: `^${CORE_HOST_VERSION}`,
      },
    });

    await expect(loadPluginArtifactManifest(pluginDir)).rejects.toThrow(
      `${PLUGIN_MANIFEST_UNSUPPORTED_CAPABILITY_ERROR}: nativeRuntimeInjection`
    );

    const registry = new PluginRegistry(root);
    const loadedPlugins = await registry.scanAndLoadPlugins(root, true);

    expect(loadedPlugins).toEqual([]);
    expect(registry.getPluginManifest('manifest-vnext-unsupported-capability')).toBeUndefined();
  });

  test('rejects vNext manifest when engines.bungee does not match host version', async () => {
    const root = createTempRoot();
    const pluginDir = createPluginArtifact(root, 'manifest-vnext-engine-mismatch', {
      name: 'manifest-vnext-engine-mismatch',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['hooks'],
      uiExtensionMode: 'none',
      engines: {
        bungee: '<3.0.0',
      },
    });

    await expect(loadPluginArtifactManifest(pluginDir)).rejects.toThrow(PLUGIN_MANIFEST_ENGINE_MISMATCH_ERROR);

    const registry = new PluginRegistry(root);
    const loadedPlugins = await registry.scanAndLoadPlugins(root, true);

    expect(loadedPlugins).toEqual([]);
    expect(registry.getPluginManifest('manifest-vnext-engine-mismatch')).toBeUndefined();
  });

  test('rejects vNext manifest when schemaVersion does not match supported host schema', async () => {
    const root = createTempRoot();
    const pluginDir = createPluginArtifact(root, 'manifest-vnext-schema-mismatch', {
      name: 'manifest-vnext-schema-mismatch',
      version: '1.0.0',
      schemaVersion: 999,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['hooks'],
      uiExtensionMode: 'none',
      engines: {
        bungee: `^${CORE_HOST_VERSION}`,
      },
    });

    await expect(loadPluginArtifactManifest(pluginDir)).rejects.toThrow(PLUGIN_MANIFEST_SCHEMA_MISMATCH_ERROR);

    const registry = new PluginRegistry(root);
    const loadedPlugins = await registry.scanAndLoadPlugins(root, true);
    const snapshot = registry.getPluginStateSnapshot('manifest-vnext-schema-mismatch');

    expect(loadedPlugins).toEqual([]);
    expect(snapshot?.validation).toBe('quarantined');
    expect(snapshot?.contract?.schemaVersion).toBe(999);
    expect(snapshot?.contract?.validationFailureCode).toBe('schema-mismatch');
  });

  test('loads legacy manifest only through compatibility path and surfaces migration warning', async () => {
    const root = createTempRoot();
    const pluginDir = createPluginArtifact(root, 'manifest-legacy-compat', {
      name: 'manifest-legacy-compat',
      version: '1.0.0',
      main: 'dist/index.js',
      contributes: {
        api: [{ path: '/summary', methods: ['GET'], handler: 'getSummary' }],
        nativeWidgets: [{ id: 'widget', title: 'Widget', size: 'small', component: 'WidgetCard' }],
        widgets: [{ title: 'Legacy Widget', path: '/legacy' }],
      },
    });

    const loaded = await loadPluginArtifactManifest(pluginDir);

    expect(loaded.manifestContract).toBe('legacy-compat');
    expect(loaded.contractWarnings).toContain(PLUGIN_MANIFEST_LEGACY_WARNING);
    expect(loaded.capabilities).toEqual([
      'hooks',
      'dynamicRuntimeLoad',
      'api',
      'nativeWidgetsStatic',
      'sandboxUiExtension',
    ]);
    expect(loaded.uiExtensionMode).toBe('native-static');
    expect(loaded.engines.bungee).toBe('*');

    const registry = new PluginRegistry(root);
    const loadedPlugins = await registry.scanAndLoadPlugins(root, true);
    const manifest = registry.getPluginManifest('manifest-legacy-compat');

    expect(loadedPlugins).toEqual(['manifest-legacy-compat']);
    expect(manifest?.manifestContract).toBe('legacy-compat');
    expect(manifest?.contractWarnings).toContain(PLUGIN_MANIFEST_LEGACY_WARNING);
  });

  test('wires manifest validation failures into orchestrator status and keeps them non-serving', async () => {
    const root = createTempRoot();
    const supportedCapabilityDir = createPluginArtifact(root, 'manifest-vnext-serve-ok', {
      name: 'manifest-vnext-serve-ok',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['hooks', 'dynamicRuntimeLoad'],
      uiExtensionMode: 'none',
      engines: { bungee: `^${CORE_HOST_VERSION}` },
    });
    const unsupportedCapabilityDir = createPluginArtifact(root, 'manifest-vnext-status-unsupported-capability', {
      name: 'manifest-vnext-status-unsupported-capability',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['hooks', 'nativeRuntimeInjection'],
      uiExtensionMode: 'none',
      engines: { bungee: `^${CORE_HOST_VERSION}` },
    });
    const missingArtifactDir = createPluginArtifact(root, 'manifest-vnext-status-missing-artifact', {
      name: 'manifest-vnext-status-missing-artifact',
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'dist/index.js',
      capabilities: ['hooks'],
      uiExtensionMode: 'none',
      engines: { bungee: `^${CORE_HOST_VERSION}` },
    });
    rmSync(join(missingArtifactDir, 'dist'), { recursive: true, force: true });

    const orchestrator = new PluginRuntimeOrchestrator(root);

    try {
      const result = await orchestrator.applyConfig({
        plugins: [
          { name: 'manifest-vnext-serve-ok', path: join(supportedCapabilityDir, 'dist/index.js'), enabled: true },
          { name: 'manifest-vnext-status-unsupported-capability', path: join(unsupportedCapabilityDir, 'dist/index.js'), enabled: true },
          { name: 'manifest-vnext-status-missing-artifact', path: join(missingArtifactDir, 'dist/index.js'), enabled: true },
        ],
        routes: [],
      });

      const serving = result.status.plugins.find((plugin) => plugin.pluginName === 'manifest-vnext-serve-ok');
      const unsupportedCapability = result.status.plugins.find((plugin) => plugin.pluginName === 'manifest-vnext-status-unsupported-capability');
      const missingArtifact = result.status.plugins.find((plugin) => plugin.pluginName === 'manifest-vnext-status-missing-artifact');
      const leakedClassName = result.status.plugins.find((plugin) => plugin.pluginName === 'ManifestContractPlugin');

      expect(serving?.state.lifecycle).toBe('serving');
      expect(result.runtime.success).toBe(1);
      expect(result.runtime.failed).toBe(0);
      expect(result.diff.added).not.toContain('ManifestContractPlugin');
      expect(leakedClassName).toBeUndefined();

      expect(unsupportedCapability?.state.lifecycle).toBe('quarantined');
      expect(unsupportedCapability?.state.states.scopedServing).toBe('non-serving');
      expect(unsupportedCapability?.sources.runtime).toBe(false);
      expect(unsupportedCapability?.state.contract?.schemaVersion).toBe(2);
      expect(unsupportedCapability?.state.contract?.capabilities).toEqual(['hooks', 'nativeRuntimeInjection']);
      expect(unsupportedCapability?.state.contract?.validationFailureCode).toBe('unsupported-capability');
      expect(unsupportedCapability?.state.failures.validation).toEqual({
        stage: 'validation',
        classification: 'quarantined',
        code: 'unsupported-capability',
        reason: expect.stringContaining(PLUGIN_MANIFEST_UNSUPPORTED_CAPABILITY_ERROR),
      });
      expect(unsupportedCapability?.state.reasons.validation).toContain(PLUGIN_MANIFEST_UNSUPPORTED_CAPABILITY_ERROR);

      expect(missingArtifact?.state.lifecycle).toBe('degraded');
      expect(missingArtifact?.state.states.scopedServing).toBe('non-serving');
      expect(missingArtifact?.sources.runtime).toBe(false);
      expect(missingArtifact?.state.contract?.schemaVersion).toBe(2);
      expect(missingArtifact?.state.contract?.main).toBe('dist/index.js');
      expect(missingArtifact?.state.contract?.validationFailureCode).toBe('missing-artifact');
      expect(missingArtifact?.state.failures.validation).toEqual({
        stage: 'validation',
        classification: 'degraded',
        code: 'missing-artifact',
        reason: expect.stringContaining(PLUGIN_MANIFEST_MISSING_ARTIFACT_ERROR),
      });
      expect(missingArtifact?.state.reasons.validation).toContain(PLUGIN_MANIFEST_MISSING_ARTIFACT_ERROR);
    } finally {
      await orchestrator.destroy();
    }
  });

  test('keeps legacy internal plugins serving through the transitional compatibility path with migration guidance', async () => {
    const root = createTempRoot();
    const pluginDir = createPluginArtifact(root, 'manifest-legacy-dev-compat', {
      name: 'manifest-legacy-dev-compat',
      version: '1.0.0',
      main: 'server/index.ts',
      contributes: {
        api: [{ path: '/summary', methods: ['GET'], handler: 'getSummary' }],
      },
    });

    const orchestrator = new PluginRuntimeOrchestrator(root);

    try {
      const result = await orchestrator.applyConfig({
        plugins: [{ name: 'manifest-legacy-dev-compat', path: join(pluginDir, 'server/index.ts'), enabled: true }],
        routes: [],
      });
      const plugin = result.status.plugins.find((entry) => entry.pluginName === 'manifest-legacy-dev-compat');
      const leakedClassName = result.status.plugins.find((entry) => entry.pluginName === 'ManifestContractPlugin');

      expect(plugin?.state.lifecycle).toBe('serving');
      expect(result.runtime.success).toBe(1);
      expect(result.diff.added).not.toContain('ManifestContractPlugin');
      expect(leakedClassName).toBeUndefined();
      expect(plugin?.state.contract?.manifestContract).toBe('legacy-compat');
      expect(plugin?.state.contract?.contractWarnings).toContain(PLUGIN_MANIFEST_LEGACY_WARNING);
      expect(plugin?.state.contract?.capabilities).toEqual(['hooks', 'dynamicRuntimeLoad', 'api']);
    } finally {
      await orchestrator.destroy();
    }
  });
});
