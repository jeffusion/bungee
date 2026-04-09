import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PluginRegistry } from '../../src/plugin-registry';
import { CORE_HOST_VERSION } from '../../src/plugin-artifact-contract';
import { createPluginRegistryStateSnapshot, freezePluginRuntimeState } from '../../src/plugin-runtime-state-machine';
import { ScopedPluginRegistry } from '../../src/scoped-plugin-registry';
import type { MutableRequestContext } from '../../src/hooks';

const tempRoots: string[] = [];
const ROUTE_ID = '/rollback';
const TEST_PLUGIN_NAME = 'runtime-rollback-plugin';

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungee-plugin-runtime-rollback-'));
  tempRoots.push(root);
  return root;
}

function createMutableContext(routeId: string): MutableRequestContext {
  return {
    method: 'GET',
    originalUrl: new URL(`http://localhost${routeId}`),
    clientIP: '127.0.0.1',
    requestId: crypto.randomUUID(),
    routeId,
    url: new URL('http://example.com/upstream'),
    headers: {},
    body: null,
  };
}

function writeRuntimePluginModule(targetPath: string, options: {
  pluginName?: string;
  generation?: string;
  stateKey?: string;
  throwOnCreate?: boolean;
} = {}): void {
  const {
    pluginName = TEST_PLUGIN_NAME,
    generation = 'v1',
    stateKey,
    throwOnCreate = false,
  } = options;

  writeFileSync(
    targetPath,
    `const stateKey = ${stateKey ? JSON.stringify(stateKey) : 'null'};
const generation = ${JSON.stringify(generation)};

function getState() {
  if (!stateKey) {
    return null;
  }

  const root = globalThis;
  if (!root[stateKey]) {
    root[stateKey] = { created: [], destroyed: [] };
  }
  return root[stateKey];
}

export default class RuntimeRollbackPlugin {
  static name = ${JSON.stringify(pluginName)};
  static version = '1.0.0';

  static async createHandler(config) {
    if (${throwOnCreate ? 'true' : 'false'}) {
      throw new Error('createHandler failed for ' + generation);
    }

    const state = getState();
    state?.created.push(generation);

    return {
      pluginName: ${JSON.stringify(pluginName)},
      config,
      register(hooks) {
        hooks.onBeforeRequest.tapPromise({ name: ${JSON.stringify(pluginName)} }, async (ctx) => {
          ctx.headers['x-plugin-generation'] = generation;
          return ctx;
        });
      },
      async destroy() {
        getState()?.destroyed.push(generation);
      },
    };
  }
}
`
  );
}

function writeInvalidReplacementModule(targetPath: string, pluginName: string): void {
  writeFileSync(
    targetPath,
    `export default class InvalidReplacementPlugin {
  static name = ${JSON.stringify(pluginName)};
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
    writeRuntimePluginModule(entryPath, { pluginName, generation: 'artifact' });
  }

  return pluginDir;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('plugin runtime rollback semantics', () => {
  test('reconcile unplug only cuts new requests and keeps in-flight requests finishing naturally', async () => {
    const root = createTempRoot();
    const pluginPath = join(root, 'runtime-rollback-v1.plugin.ts');
    const stateKey = `runtime-rollback:${crypto.randomUUID()}`;
    writeRuntimePluginModule(pluginPath, { generation: 'v1', stateKey });

    const registry = new ScopedPluginRegistry(root);
    registry.setHotReloadDestroyDelayMs(20);

    try {
      const result = await registry.initializeFromConfig({
        plugins: [],
        routes: [{ path: ROUTE_ID, plugins: [{ name: TEST_PLUGIN_NAME, path: pluginPath }], upstreams: [] }],
      });

      expect(result.failed).toBe(0);

      const inFlightHooks = registry.getPrecompiledHooks(ROUTE_ID);
      expect(inFlightHooks).not.toBeNull();

      await registry.hotReloadRoutePlugins(ROUTE_ID, []);

      expect(registry.getPrecompiledHooks(ROUTE_ID)).toBeNull();

      const transformed = await inFlightHooks!.hooks.onBeforeRequest.promise(createMutableContext(ROUTE_ID));
      expect(transformed.headers['x-plugin-generation']).toBe('v1');

      const runtimeState = freezePluginRuntimeState(
        createPluginRegistryStateSnapshot({
          pluginName: TEST_PLUGIN_NAME,
          validation: 'validated',
          persistedEnabled: 'disabled',
        }),
        registry.getPluginRuntimeStateSnapshot(TEST_PLUGIN_NAME),
      );

      expect(runtimeState.lifecycle).toBe('disabled');
      expect(runtimeState.states.runtimeLoaded).toBe('loaded');
      expect(runtimeState.states.scopedServing).toBe('non-serving');

      const runtimeEvents = (globalThis as Record<string, any>)[stateKey];
      expect(runtimeEvents.destroyed).toEqual([]);

      await Bun.sleep(35);

      expect(runtimeEvents.destroyed).toEqual(['v1']);
    } finally {
      await registry.destroy();
      delete (globalThis as Record<string, any>)[stateKey];
    }
  });

  test('invalid replacement artifact does not steal the current serving generation', async () => {
    const root = createTempRoot();
    const goodPluginPath = join(root, 'runtime-rollback-good.plugin.ts');
    const badPluginPath = join(root, 'runtime-rollback-invalid.plugin.ts');
    const stateKey = `runtime-rollback:${crypto.randomUUID()}`;
    writeRuntimePluginModule(goodPluginPath, { generation: 'serving-v1', stateKey });
    writeInvalidReplacementModule(badPluginPath, TEST_PLUGIN_NAME);

    const registry = new ScopedPluginRegistry(root);

    try {
      const result = await registry.initializeFromConfig({
        plugins: [],
        routes: [{ path: ROUTE_ID, plugins: [{ name: TEST_PLUGIN_NAME, path: goodPluginPath }], upstreams: [] }],
      });

      expect(result.failed).toBe(0);

      await registry.hotReloadRoutePlugins(ROUTE_ID, [{ name: TEST_PLUGIN_NAME, path: badPluginPath }]);

      const hooks = registry.getPrecompiledHooks(ROUTE_ID);
      expect(hooks).not.toBeNull();

      const transformed = await hooks!.hooks.onBeforeRequest.promise(createMutableContext(ROUTE_ID));
      expect(transformed.headers['x-plugin-generation']).toBe('serving-v1');

      const runtimeState = registry.getPluginRuntimeStateSnapshot(TEST_PLUGIN_NAME);
      expect(runtimeState.loadState).toBe('loaded');
      expect(runtimeState.servingScopes).toEqual([{ type: 'route', routeId: ROUTE_ID }]);

      const stats = registry.getStats();
      expect(stats.observability.runtimeFailures[TEST_PLUGIN_NAME].loadState).toBe('degraded');
      expect(stats.observability.runtimeFailures[TEST_PLUGIN_NAME].failureReason).toContain("static 'version' property");
    } finally {
      await registry.destroy();
      delete (globalThis as Record<string, any>)[stateKey];
    }
  });

  test('freezes bad artifacts and init failures into non-serving degraded or quarantined states', async () => {
    const artifactRoot = createTempRoot();
    const artifactRegistry = new PluginRegistry(artifactRoot);

    try {
      createPluginArtifact(artifactRoot, 'artifact-quarantined', {
        name: 'artifact-quarantined',
        version: '1.0.0',
        schemaVersion: 2,
        artifactKind: 'runtime-plugin',
        main: 'dist/index.js',
        capabilities: ['hooks', 'nativeRuntimeInjection'],
        uiExtensionMode: 'none',
        engines: { bungee: `^${CORE_HOST_VERSION}` },
      });

      createPluginArtifact(artifactRoot, 'artifact-degraded', {
        name: 'artifact-degraded',
        version: '1.0.0',
        schemaVersion: 2,
        artifactKind: 'runtime-plugin',
        main: 'dist/index.js',
        capabilities: ['hooks'],
        uiExtensionMode: 'none',
        engines: { bungee: `^${CORE_HOST_VERSION}` },
      }, { writeBuiltEntry: false });

      const loadedPlugins = await artifactRegistry.scanAndLoadPlugins(artifactRoot, true);
      expect(loadedPlugins).toEqual([]);

      const quarantined = freezePluginRuntimeState(artifactRegistry.getPluginStateSnapshot('artifact-quarantined')!);
      const degraded = freezePluginRuntimeState(artifactRegistry.getPluginStateSnapshot('artifact-degraded')!);

      expect(quarantined.lifecycle).toBe('quarantined');
      expect(quarantined.states.runtimeLoaded).toBe('quarantined');
      expect(quarantined.states.scopedServing).toBe('non-serving');

      expect(degraded.lifecycle).toBe('degraded');
      expect(degraded.states.runtimeLoaded).toBe('degraded');
      expect(degraded.states.scopedServing).toBe('non-serving');
    } finally {
      await artifactRegistry.unloadAll();
    }

    const initFailureRoot = createTempRoot();
    const initFailurePath = join(initFailureRoot, 'runtime-rollback-init-failure.plugin.ts');
    writeRuntimePluginModule(initFailurePath, {
      pluginName: 'runtime-init-failure-plugin',
      generation: 'init-failure',
      throwOnCreate: true,
    });

    const runtimeRegistry = new ScopedPluginRegistry(initFailureRoot);
    const pluginRegistry = new PluginRegistry(initFailureRoot);

    try {
      await pluginRegistry.loadPlugin({
        name: 'runtime-init-failure-plugin',
        path: initFailurePath,
        enabled: true,
      });

      const result = await runtimeRegistry.initializeFromConfig({
        plugins: [{ name: 'runtime-init-failure-plugin', path: initFailurePath }],
        routes: [],
      });

      expect(result.success).toBe(0);
      expect(result.failed).toBe(1);

      const runtimeState = freezePluginRuntimeState(
        pluginRegistry.getPluginStateSnapshot('runtime-init-failure-plugin')!,
        runtimeRegistry.getPluginRuntimeStateSnapshot('runtime-init-failure-plugin'),
      );

      expect(runtimeState.lifecycle).toBe('degraded');
      expect(runtimeState.states.persistedEnabled).toBe('enabled');
      expect(runtimeState.states.runtimeLoaded).toBe('degraded');
      expect(runtimeState.states.scopedServing).toBe('non-serving');
      expect(runtimeState.reasons.runtime).toContain('createHandler failed');
    } finally {
      await runtimeRegistry.destroy();
      await pluginRegistry.unloadAll();
    }
  });
});
