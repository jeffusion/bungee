import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PluginRegistry } from '../../src/plugin-registry';
import {
  CORE_HOST_VERSION,
} from '../../src/plugin-artifact-contract';
import {
  createPluginRegistryStateSnapshot,
  freezePluginRuntimeState,
} from '../../src/plugin-runtime-state-machine';
import { ScopedPluginRegistry } from '../../src/scoped-plugin-registry';

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungee-plugin-runtime-state-machine-'));
  tempRoots.push(root);
  return root;
}

function writePluginModule(targetPath: string): void {
  writeFileSync(
    targetPath,
    `export default class RuntimeStatePlugin {
  static name = 'runtime-state-plugin';
  static version = '1.0.0';

  constructor(options = {}) {
    this.options = options;
  }

  register() {}
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
  } = {},
): string {
  const pluginDir = join(root, pluginName);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  if (options.writeBuiltEntry !== false && typeof manifest.main === 'string') {
    const entryPath = join(pluginDir, manifest.main);
    mkdirSync(dirname(entryPath), { recursive: true });
    writePluginModule(entryPath);
  }

  return pluginDir;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('plugin runtime state machine', () => {
  test('keeps discovery separate from validation and persisted enablement', () => {
    const state = freezePluginRuntimeState(createPluginRegistryStateSnapshot({
      pluginName: 'discovered-only',
      discovery: 'discovered',
      validation: 'pending',
      persistedEnabled: 'unknown',
    }));

    expect(state.lifecycle).toBe('discovered');
    expect(state.states.discovery).toBe('discovered');
    expect(state.states.validation).toBe('pending');
    expect(state.states.persistedEnabled).toBe('unknown');
    expect(state.states.runtimeLoaded).toBe('not-loaded');
    expect(state.states.scopedServing).toBe('non-serving');
    expect(state.authorities.persistedEnabled).toBe('plugin-registry');
    expect(state.authorities.scopedServing).toBe('scoped-plugin-registry');
  });

  test('keeps validated separate from persisted enabled before reconcile writes state', () => {
    const state = freezePluginRuntimeState(createPluginRegistryStateSnapshot({
      pluginName: 'validated-only',
      validation: 'validated',
      persistedEnabled: 'unknown',
    }));

    expect(state.lifecycle).toBe('validated');
    expect(state.states.validation).toBe('validated');
    expect(state.states.persistedEnabled).toBe('unknown');
    expect(state.states.runtimeLoaded).toBe('not-loaded');
    expect(state.states.scopedServing).toBe('non-serving');
  });

  test('treats persisted enabled as distinct from runtime serving', async () => {
    const root = createTempRoot();
    const pluginPath = join(root, 'runtime-state.plugin.ts');
    writePluginModule(pluginPath);

    const registry = new PluginRegistry(root);
    await registry.loadPlugin({
      name: 'runtime-state-plugin',
      path: pluginPath,
      enabled: true,
    });

    const state = freezePluginRuntimeState(registry.getPluginStateSnapshot('runtime-state-plugin')!);

    expect(state.lifecycle).toBe('enabled');
    expect(state.states.persistedEnabled).toBe('enabled');
    expect(state.states.runtimeLoaded).toBe('not-loaded');
    expect(state.states.scopedServing).toBe('non-serving');
    expect(state.runtime.servingScopes).toEqual([]);

    await registry.unloadAll();
  });

  test('only becomes serving after runtime load and scoped registration are ready', async () => {
    const root = createTempRoot();
    const pluginPath = join(root, 'runtime-state.plugin.ts');
    writePluginModule(pluginPath);

    const registry = new PluginRegistry(root);
    await registry.loadPlugin({
      name: 'runtime-state-plugin',
      path: pluginPath,
      enabled: true,
    });

    const scopedRegistry = new ScopedPluginRegistry(root);
    await scopedRegistry.initializeFromConfig({
      plugins: [{
        name: 'runtime-state-plugin',
        path: pluginPath,
      }],
      routes: [],
    });

    const state = freezePluginRuntimeState(
      registry.getPluginStateSnapshot('runtime-state-plugin')!,
      scopedRegistry.getPluginRuntimeStateSnapshot('runtime-state-plugin'),
    );

    expect(state.lifecycle).toBe('serving');
    expect(state.states.persistedEnabled).toBe('enabled');
    expect(state.states.runtimeLoaded).toBe('loaded');
    expect(state.states.scopedServing).toBe('serving');
    expect(state.runtime.servingScopes).toEqual([{ type: 'global' }]);

    await scopedRegistry.destroy();
    await registry.unloadAll();
  });

  test('keeps bad artifacts out of serving by freezing degraded and quarantined states', async () => {
    const root = createTempRoot();
    const registry = new PluginRegistry(root);

    createPluginArtifact(root, 'artifact-quarantined', {
      name: 'artifact-quarantined',
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

    createPluginArtifact(root, 'artifact-degraded', {
      name: 'artifact-degraded',
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

    const loadedPlugins = await registry.scanAndLoadPlugins(root, true);
    const quarantined = freezePluginRuntimeState(registry.getPluginStateSnapshot('artifact-quarantined')!);
    const degraded = freezePluginRuntimeState(registry.getPluginStateSnapshot('artifact-degraded')!);

    expect(loadedPlugins).toEqual([]);

    expect(quarantined.lifecycle).toBe('quarantined');
    expect(quarantined.states.validation).toBe('quarantined');
    expect(quarantined.states.runtimeLoaded).toBe('quarantined');
    expect(quarantined.states.scopedServing).toBe('non-serving');
    expect(quarantined.reasons.validation).toContain('unsupported capability');

    expect(degraded.lifecycle).toBe('degraded');
    expect(degraded.states.validation).toBe('degraded');
    expect(degraded.states.runtimeLoaded).toBe('degraded');
    expect(degraded.states.scopedServing).toBe('non-serving');
    expect(degraded.reasons.validation).toContain('built server entry not found');
  });
});
