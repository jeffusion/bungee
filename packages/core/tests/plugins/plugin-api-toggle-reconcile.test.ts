import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@jeffusion/bungee-types';
import { handleGetPlugins, handleTogglePlugin } from '../../src/api/handlers/plugins';
import { loadConfig } from '../../src/config';
import { MigrationManager } from '../../src/migrations/migration-manager';
import {
  PluginRuntimeMultiWorkerCoordinator,
  PluginRuntimeMultiWorkerConvergenceTracker,
  type PluginRuntimeClusterReconcileRequestMessage,
} from '../../src/plugin-runtime-multi-worker-convergence';
import { getScopedPluginRegistry } from '../../src/scoped-plugin-registry';
import {
  cleanupPluginRegistry,
  getPluginRuntimeOrchestrator,
  initializePluginRuntime,
  reconcilePluginRuntime,
} from '../../src/worker/state/plugin-manager';
import type { MutableRequestContext } from '../../src/hooks';

const tempRoots: string[] = [];
const ROUTE_ID = '/toggle';
const TEST_PLUGIN_NAME = 'runtime-toggle-plugin';

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungee-plugin-api-toggle-'));
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

function writeRuntimePluginModule(targetPath: string, stateKey: string): void {
  writeFileSync(
    targetPath,
    `const stateKey = ${JSON.stringify(stateKey)};

function getState() {
  const root = globalThis;
  if (!root[stateKey]) {
    root[stateKey] = { created: [], destroyed: [] };
  }
  return root[stateKey];
}

export default class RuntimeTogglePlugin {
  static name = ${JSON.stringify(TEST_PLUGIN_NAME)};
  static version = '1.0.0';

  static async createHandler(config) {
    getState().created.push('v1');

    return {
      pluginName: ${JSON.stringify(TEST_PLUGIN_NAME)},
      config,
      register(hooks) {
        hooks.onBeforeRequest.tapPromise({ name: ${JSON.stringify(TEST_PLUGIN_NAME)} }, async (ctx) => {
          ctx.headers['x-plugin-generation'] = 'v1';
          return ctx;
        });
      },
      async destroy() {
        getState().destroyed.push('v1');
      },
    };
  }
}
`,
  );
}

function writeInvalidReplacementModule(targetPath: string): void {
  writeFileSync(
    targetPath,
    `export default class InvalidReplacementPlugin {
  static name = ${JSON.stringify(TEST_PLUGIN_NAME)};
}
`,
  );
}

function createConfig(pluginPath: string): AppConfig {
  return {
    plugins: [],
    routes: [{
      path: ROUTE_ID,
      plugins: [{ name: TEST_PLUGIN_NAME, path: pluginPath, enabled: true }],
      endpoints: [{ target: 'http://example.com' }],
    }],
  };
}

afterEach(async () => {
  delete process.env.CONFIG_PATH;
  delete process.env.BUNGEE_ROLE;
  delete (process as any).send;
  await cleanupPluginRegistry();

  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('plugin management API reconcile semantics', () => {
  test('disable API reconciles runtime and exposes persisted vs runtime vs serving state', async () => {
    const root = createTempRoot();
    const pluginPath = join(root, 'runtime-toggle.plugin.ts');
    const configPath = join(root, 'config.json');
    const dbPath = join(root, 'access.db');
    const stateKey = `runtime-toggle:${crypto.randomUUID()}`;
    writeRuntimePluginModule(pluginPath, stateKey);

    const config = createConfig(pluginPath);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    process.env.CONFIG_PATH = configPath;

    const migrationManager = new MigrationManager(dbPath);
    const migrationResult = await migrationManager.migrate();
    expect(migrationResult.success).toBe(true);

    const db = new Database(dbPath);

    try {
      await initializePluginRuntime(config, { basePath: root, db });

      const enableResponse = await handleTogglePlugin(
        new Request(`http://localhost/api/plugins/${TEST_PLUGIN_NAME}/enable`, { method: 'POST' }),
        TEST_PLUGIN_NAME,
        true,
      );
      const enableBody = await enableResponse.json() as any;

      expect(enableResponse.status).toBe(200);
      expect(enableBody.persistedEnabled).toBe('enabled');
      expect(enableBody.state.states.persistedEnabled).toBe('enabled');
      expect(enableBody.state.states.runtimeLoaded).toBe('loaded');
      expect(enableBody.state.states.scopedServing).toBe('serving');
      expect(enableBody.state.runtime.currentGeneration).toBe(2);
      expect(enableBody.state.runtime.servingGeneration).toBe(2);
      expect(enableBody.state.runtime.drainingGenerations).toEqual([]);
      expect(enableBody.state.failures.runtime).toBeUndefined();

      const scopedRegistry = getScopedPluginRegistry();
      expect(scopedRegistry).not.toBeNull();
      scopedRegistry!.setHotReloadDestroyDelayMs(20);

      const listBefore = await handleGetPlugins(new Request('http://localhost/api/plugins'));
      const pluginsBefore = await listBefore.json() as Array<any>;
      const beforeEntry = pluginsBefore.find((plugin) => plugin.name === TEST_PLUGIN_NAME);

      expect(beforeEntry).toBeDefined();
      expect(beforeEntry.state.states.persistedEnabled).toBe('enabled');
      expect(beforeEntry.state.states.runtimeLoaded).toBe('loaded');
      expect(beforeEntry.state.states.scopedServing).toBe('serving');
      expect(beforeEntry.state.runtime.currentGeneration).toBe(2);
      expect(beforeEntry.state.runtime.servingGeneration).toBe(2);

      const inFlightHooks = scopedRegistry!.getRoutePrecompiledHooks(ROUTE_ID);
      expect(inFlightHooks).not.toBeNull();

      const toggleResponse = await handleTogglePlugin(
        new Request(`http://localhost/api/plugins/${TEST_PLUGIN_NAME}/disable`, { method: 'POST' }),
        TEST_PLUGIN_NAME,
        false,
      );
      const toggleBody = await toggleResponse.json() as any;

      expect(toggleResponse.status).toBe(200);
      expect(toggleBody.persistedEnabled).toBe('disabled');
      expect(toggleBody.state.states.persistedEnabled).toBe('disabled');
      expect(toggleBody.state.states.runtimeLoaded).toBe('loaded');
      expect(toggleBody.state.states.scopedServing).toBe('non-serving');
      expect(toggleBody.state.lifecycle).toBe('disabled');
      expect(toggleBody.state.runtime.currentGeneration).toBe(3);
      expect(toggleBody.state.runtime.servingGeneration).toBe(2);
      expect(toggleBody.state.runtime.drainingGenerations).toEqual([2]);
      expect(toggleBody.state.failures.runtime).toBeUndefined();

      const nextRegistry = getScopedPluginRegistry();
      expect(nextRegistry?.getRoutePrecompiledHooks(ROUTE_ID)).toBeNull();

      const transformed = await inFlightHooks!.hooks.onBeforeRequest.promise(createMutableContext(ROUTE_ID));
      expect(transformed.headers['x-plugin-generation']).toBe('v1');

      const runtimeEvents = (globalThis as Record<string, any>)[stateKey];
      expect(runtimeEvents.destroyed).toEqual([]);

      const listDuringDrain = await handleGetPlugins(new Request('http://localhost/api/plugins'));
      const pluginsDuringDrain = await listDuringDrain.json() as Array<any>;
      const drainingEntry = pluginsDuringDrain.find((plugin) => plugin.name === TEST_PLUGIN_NAME);
      expect(drainingEntry.state.states.persistedEnabled).toBe('disabled');
      expect(drainingEntry.state.states.runtimeLoaded).toBe('loaded');
      expect(drainingEntry.state.states.scopedServing).toBe('non-serving');
      expect(drainingEntry.state.runtime.currentGeneration).toBe(3);
      expect(drainingEntry.state.runtime.servingGeneration).toBe(2);
      expect(drainingEntry.state.runtime.drainingGenerations).toEqual([2]);

      await Bun.sleep(35);

      expect(runtimeEvents.destroyed).toEqual(['v1']);

      const listAfterDrain = await handleGetPlugins(new Request('http://localhost/api/plugins'));
      const pluginsAfterDrain = await listAfterDrain.json() as Array<any>;
      const afterDrainEntry = pluginsAfterDrain.find((plugin) => plugin.name === TEST_PLUGIN_NAME);
      expect(afterDrainEntry.state.states.persistedEnabled).toBe('disabled');
      expect(afterDrainEntry.state.states.runtimeLoaded).toBe('not-loaded');
      expect(afterDrainEntry.state.states.scopedServing).toBe('non-serving');
      expect(afterDrainEntry.state.runtime.currentGeneration).toBe(3);
      expect(afterDrainEntry.state.runtime.servingGeneration).toBeNull();
      expect(afterDrainEntry.state.runtime.drainingGenerations).toEqual([]);
    } finally {
      db.close();
      delete (globalThis as Record<string, any>)[stateKey];
    }
  });

  test('plugin list API exposes failed generation while preserving prior serving generation observability', async () => {
    const root = createTempRoot();
    const goodPluginPath = join(root, 'runtime-toggle-good.plugin.ts');
    const badPluginPath = join(root, 'runtime-toggle-bad.plugin.ts');
    const configPath = join(root, 'config.json');
    const dbPath = join(root, 'access.db');
    const stateKey = `runtime-toggle:${crypto.randomUUID()}`;
    writeRuntimePluginModule(goodPluginPath, stateKey);
    writeInvalidReplacementModule(badPluginPath);

    const goodConfig = createConfig(goodPluginPath);
    writeFileSync(configPath, JSON.stringify(goodConfig, null, 2));
    process.env.CONFIG_PATH = configPath;

    const migrationManager = new MigrationManager(dbPath);
    const migrationResult = await migrationManager.migrate();
    expect(migrationResult.success).toBe(true);

    const db = new Database(dbPath);

    try {
      await initializePluginRuntime(goodConfig, { basePath: root, db });

      const enableResponse = await handleTogglePlugin(
        new Request(`http://localhost/api/plugins/${TEST_PLUGIN_NAME}/enable`, { method: 'POST' }),
        TEST_PLUGIN_NAME,
        true,
      );
      expect(enableResponse.status).toBe(200);

      const orchestrator = getPluginRuntimeOrchestrator();
      expect(orchestrator).not.toBeNull();

      const badConfig = createConfig(badPluginPath);
      const reconcileResult = await orchestrator!.applyConfig(badConfig);
      const reconcileEntry = reconcileResult.status.plugins.find((plugin) => plugin.pluginName === TEST_PLUGIN_NAME);

      expect(reconcileResult.generation).toBe(3);
      expect(reconcileEntry?.state.runtime.currentGeneration).toBe(3);
      expect(reconcileEntry?.state.runtime.servingGeneration).toBe(2);
      expect(reconcileEntry?.state.runtime.drainingGenerations).toEqual([2]);
      expect(reconcileEntry?.state.failures.runtime?.generation).toBe(3);
      expect(reconcileEntry?.state.failures.runtime?.code).toBe('runtime-load-failure');

      const listResponse = await handleGetPlugins(new Request('http://localhost/api/plugins'));
      const plugins = await listResponse.json() as Array<any>;
      const pluginEntry = plugins.find((plugin) => plugin.name === TEST_PLUGIN_NAME);

      expect(pluginEntry).toBeDefined();
      expect(pluginEntry.state.lifecycle).toBe('degraded');
      expect(pluginEntry.state.states.runtimeLoaded).toBe('degraded');
      expect(pluginEntry.state.states.scopedServing).toBe('non-serving');
      expect(pluginEntry.state.runtime.currentGeneration).toBe(3);
      expect(pluginEntry.state.runtime.servingGeneration).toBe(2);
      expect(pluginEntry.state.runtime.drainingGenerations).toEqual([2]);
      expect(pluginEntry.state.runtime.servingScopes).toEqual([{ type: 'route', phase: 'route', routeId: ROUTE_ID, id: ROUTE_ID }]);
      expect(pluginEntry.state.failures.runtime).toEqual({
        stage: 'runtime',
        classification: 'degraded',
        code: 'runtime-load-failure',
        generation: 3,
        reason: expect.stringContaining("static 'version' property"),
      });
      expect(pluginEntry.state.reasons.runtime).toContain("static 'version' property");
    } finally {
      db.close();
      delete (globalThis as Record<string, any>)[stateKey];
    }
  });

  test('API-triggered reconcile fans out through cluster path and returns convergence summary', async () => {
    const root = createTempRoot();
    const pluginPath = join(root, 'runtime-toggle.plugin.ts');
    const configPath = join(root, 'config.json');
    const dbPath = join(root, 'access.db');
    const stateKey = `runtime-toggle:${crypto.randomUUID()}`;
    writeRuntimePluginModule(pluginPath, stateKey);

    const config = createConfig(pluginPath);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    process.env.CONFIG_PATH = configPath;
    process.env.BUNGEE_ROLE = 'worker';

    const migrationManager = new MigrationManager(dbPath);
    const migrationResult = await migrationManager.migrate();
    expect(migrationResult.success).toBe(true);

    const db = new Database(dbPath);
    const sentCommands: Array<{ workerId: number; generation: number }> = [];

    try {
      await initializePluginRuntime(config, { basePath: root, db });

      (process as any).send = (message: PluginRuntimeClusterReconcileRequestMessage) => {
        const coordinator = new PluginRuntimeMultiWorkerCoordinator(
          new PluginRuntimeMultiWorkerConvergenceTracker(100),
          5,
        );
        coordinator.noteWorkerReady(1, 1, process.pid);
        coordinator.noteWorkerReady(2, 1, 20002);

        void coordinator.dispatchReconcile([
          {
            workerId: 1,
            status: 'ready',
            send: (command) => {
              sentCommands.push({ workerId: 1, generation: command.generation });
              queueMicrotask(async () => {
                try {
                  const result = await reconcilePluginRuntime(await loadConfig());
                  coordinator.noteWorkerReconcileSuccess(1, command.generation, result.generation, process.pid);
                } catch (error) {
                  // Handle potential race where orchestrator is destroyed between tests
                  if ((error as Error).message.includes('not initialized')) {
                    return;
                  }
                  throw error;
                }
              });
            },
          },
          {
            workerId: 2,
            status: 'ready',
            send: (command) => {
              sentCommands.push({ workerId: 2, generation: command.generation });
              queueMicrotask(() => {
                coordinator.noteWorkerReconcileSuccess(2, command.generation, command.generation, 20002);
              });
            },
          },
        ]).then((convergence) => {
          (process as any).emit('message', {
            status: 'cluster-plugin-runtime-reconcile-result',
            requestId: message.requestId,
            convergence,
          });
        });
      };

      const toggleResponse = await handleTogglePlugin(
        new Request(`http://localhost/api/plugins/${TEST_PLUGIN_NAME}/disable`, { method: 'POST' }),
        TEST_PLUGIN_NAME,
        false,
      );
      const body = await toggleResponse.json() as any;

      expect(toggleResponse.status).toBe(200);
      expect(sentCommands).toEqual([
        { workerId: 1, generation: 2 },
        { workerId: 2, generation: 2 },
      ]);
      expect(body.generation).toBe(2);
      expect(body.convergence).toEqual(expect.objectContaining({
        targetGeneration: 2,
        convergedGeneration: 2,
        status: 'converged',
        failedWorkers: [],
        staleWorkers: [],
        convergedWorkers: [1, 2],
      }));
    } finally {
      db.close();
      delete (globalThis as Record<string, any>)[stateKey];
    }
  });

  test('API-triggered reconcile keeps partial worker failure visible in convergence summary', async () => {
    const root = createTempRoot();
    const pluginPath = join(root, 'runtime-toggle.plugin.ts');
    const configPath = join(root, 'config.json');
    const dbPath = join(root, 'access.db');
    const stateKey = `runtime-toggle:${crypto.randomUUID()}`;
    writeRuntimePluginModule(pluginPath, stateKey);

    const config = createConfig(pluginPath);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    process.env.CONFIG_PATH = configPath;
    process.env.BUNGEE_ROLE = 'worker';

    const migrationManager = new MigrationManager(dbPath);
    const migrationResult = await migrationManager.migrate();
    expect(migrationResult.success).toBe(true);

    const db = new Database(dbPath);
    const sentCommands: Array<{ workerId: number; generation: number }> = [];

    try {
      await initializePluginRuntime(config, { basePath: root, db });

      (process as any).send = (message: PluginRuntimeClusterReconcileRequestMessage) => {
        const coordinator = new PluginRuntimeMultiWorkerCoordinator(
          new PluginRuntimeMultiWorkerConvergenceTracker(100),
          5,
        );
        coordinator.noteWorkerReady(1, 1, process.pid);
        coordinator.noteWorkerReady(2, 1, 20002);

        void coordinator.dispatchReconcile([
          {
            workerId: 1,
            status: 'ready',
            send: (command) => {
              sentCommands.push({ workerId: 1, generation: command.generation });
              queueMicrotask(async () => {
                try {
                  const result = await reconcilePluginRuntime(await loadConfig());
                  coordinator.noteWorkerReconcileSuccess(1, command.generation, result.generation, process.pid);
                } catch (error) {
                  if ((error as Error).message.includes('not initialized')) {
                    return;
                  }
                  throw error;
                }
              });
            },
          },
          {
            workerId: 2,
            status: 'ready',
            send: (command) => {
              sentCommands.push({ workerId: 2, generation: command.generation });
              queueMicrotask(() => {
                coordinator.noteWorkerReconcileFailure(2, command.generation, 'worker-2 replacement failed', 1, 20002);
              });
            },
          },
        ]).then((convergence) => {
          (process as any).emit('message', {
            status: 'cluster-plugin-runtime-reconcile-result',
            requestId: message.requestId,
            convergence,
          });
        });
      };

      const toggleResponse = await handleTogglePlugin(
        new Request(`http://localhost/api/plugins/${TEST_PLUGIN_NAME}/disable`, { method: 'POST' }),
        TEST_PLUGIN_NAME,
        false,
      );
      const body = await toggleResponse.json() as any;

      expect(toggleResponse.status).toBe(200);
      expect(sentCommands).toEqual([
        { workerId: 1, generation: 2 },
        { workerId: 2, generation: 2 },
      ]);
      expect(body.convergence).toEqual(expect.objectContaining({
        targetGeneration: 2,
        convergedGeneration: null,
        status: 'failed',
        failedWorkers: [2],
        staleWorkers: expect.arrayContaining([2]),
      }));
      expect(body.convergence.convergedWorkers).toEqual(expect.any(Array));
      expect(body.convergence.workers.find((worker: any) => worker.workerId === 2)).toEqual(
        expect.objectContaining({
          workerId: 2,
          status: 'failed',
          servingGeneration: 1,
          failureGeneration: 2,
          error: 'worker-2 replacement failed',
        }),
      );
    } finally {
      db.close();
      delete (globalThis as Record<string, any>)[stateKey];
    }
  });
});
