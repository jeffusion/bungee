import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@jeffusion/bungee-types';
import { PluginRuntimeOrchestrator } from '../../src/plugin-runtime-orchestrator';
import {
  cleanupPluginRegistry,
  getPluginRegistry,
  getPluginRuntimeOrchestrator,
  initializePluginRuntime,
} from '../../src/worker/state/plugin-manager';

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungee-plugin-runtime-reconcile-'));
  tempRoots.push(root);
  return root;
}

function writeRuntimePluginModule(
  targetPath: string,
  pluginName: string,
  generation: string,
  className: string = 'RuntimeReconcilePlugin',
): void {
  writeFileSync(
    targetPath,
    `const generation = ${JSON.stringify(generation)};

export default class ${className} {
  static name = ${JSON.stringify(pluginName)};
  static version = '1.0.0';

  static async createHandler(config) {
    return {
      pluginName: ${JSON.stringify(pluginName)},
      config,
      register(hooks) {
        hooks.onBeforeRequest.tapPromise({ name: ${JSON.stringify(pluginName)} }, async (ctx) => {
          ctx.headers['x-runtime-generation'] = generation;
          return ctx;
        });
      },
    };
  }
}
`,
  );
}

function writeInvalidReplacementModule(targetPath: string, pluginName: string): void {
  writeFileSync(
    targetPath,
    `export default class InvalidReplacementPlugin {
  static name = ${JSON.stringify(pluginName)};
}
`,
  );
}

function writeManifestRuntimePlugin(root: string, pluginName: string, marker: string): string {
  const pluginDir = join(root, 'plugins', pluginName);
  const serverDir = join(pluginDir, 'server');
  const entryPath = join(serverDir, 'index.ts');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({
    name: pluginName,
    version: '1.0.0',
    schemaVersion: 2,
    artifactKind: 'runtime-plugin',
    main: 'server/index.ts',
    capabilities: ['hooks', 'dynamicRuntimeLoad'],
    uiExtensionMode: 'none',
    engines: { bungee: '*' },
  }));
  writeFileSync(entryPath, `
globalThis[${JSON.stringify(marker)}] = Number(globalThis[${JSON.stringify(marker)}] ?? 0) + 1;

export default class ManifestRuntimePlugin {
  static name = ${JSON.stringify(pluginName)};
  static version = '1.0.0';
  static async createHandler() {
    return { pluginName: ${JSON.stringify(pluginName)}, register() {} };
  }
}
`);
  return entryPath;
}

function createConfig(pluginPath: string): AppConfig {
  return {
    plugins: [{ name: 'runtime-reconcile-plugin', path: pluginPath, enabled: true }],
    routes: [],
  };
}

afterEach(async () => {
  await cleanupPluginRegistry();

  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('plugin runtime reconcile orchestrator', () => {
  test('applies runtime generations through the orchestrator bridge and reports status diffs', async () => {
    const root = createTempRoot();
    const pluginDir = join(root, 'plugins');
    const pluginPath = join(pluginDir, 'runtime-reconcile.plugin.ts');
    mkdirSync(pluginDir, { recursive: true });
    writeRuntimePluginModule(pluginPath, 'runtime-reconcile-plugin', 'v1');

    const orchestrator = new PluginRuntimeOrchestrator(root, undefined, ['runtime-reconcile-plugin']);

    try {
      const firstApply = await orchestrator.applyConfig(createConfig(pluginPath));
      expect(firstApply.generation).toBe(1);
      expect(firstApply.diff.added).toContain('runtime-reconcile-plugin');
      expect(firstApply.runtime.failed).toBe(0);

      const firstStatus = firstApply.status.plugins.find((plugin) => plugin.pluginName === 'runtime-reconcile-plugin');
      expect(firstStatus).toBeDefined();
      expect(firstApply.status.plugins.some((plugin) => plugin.pluginName === 'RuntimeReconcilePlugin')).toBe(false);
      expect(firstApply.diff.added).not.toContain('RuntimeReconcilePlugin');
      expect(firstStatus?.generation).toBe(1);
      expect(firstStatus?.state.lifecycle).toBe('serving');
      expect(firstStatus?.state.states.runtimeLoaded).toBe('loaded');
      expect(firstStatus?.state.runtime.servingScopes).toEqual([{ type: 'global' }]);
      expect(firstStatus?.state.runtime.currentGeneration).toBe(1);
      expect(firstStatus?.state.runtime.servingGeneration).toBe(1);
      expect(firstStatus?.state.runtime.drainingGenerations).toEqual([]);
      expect(firstStatus?.state.failures.validation).toBeUndefined();
      expect(firstStatus?.state.failures.runtime).toBeUndefined();
      expect(firstStatus?.sources.registry).toBe(true);
      expect(firstStatus?.sources.runtime).toBe(true);

      const secondApply = await orchestrator.applyConfig({ plugins: [], routes: [] });
      expect(secondApply.generation).toBe(2);
      expect(secondApply.diff.changed).toContain('runtime-reconcile-plugin');

      const secondStatus = secondApply.status.plugins.find((plugin) => plugin.pluginName === 'runtime-reconcile-plugin');
      expect(secondStatus).toBeDefined();
      expect(secondStatus?.generation).toBe(2);
      expect(secondStatus?.state.lifecycle).toBe('loaded');
      expect(secondStatus?.state.states.persistedEnabled).toBe('enabled');
      expect(secondStatus?.state.states.scopedServing).toBe('non-serving');
      expect(secondStatus?.state.runtime.currentGeneration).toBe(2);
      expect(secondStatus?.state.runtime.servingGeneration).toBe(1);
      expect(secondStatus?.state.runtime.drainingGenerations).toEqual([1]);
      expect(secondStatus?.state.runtime.servingScopes).toEqual([{ type: 'global' }]);
    } finally {
      await orchestrator.destroy();
    }
  });

  test('test startup helper initializes plugin runtime via orchestrator bridge', async () => {
    const root = createTempRoot();
    const pluginPath = join(root, 'runtime-reconcile.plugin.ts');
    writeRuntimePluginModule(pluginPath, 'runtime-reconcile-plugin', 'startup');

    await initializePluginRuntime(createConfig(pluginPath), {
      basePath: root,
      activatedPluginNames: ['runtime-reconcile-plugin'],
    });

    const orchestrator = getPluginRuntimeOrchestrator();
    expect(orchestrator).not.toBeNull();

    const registry = getPluginRegistry();
    expect(registry).not.toBeNull();

    const pluginState = orchestrator?.getStatusReport().plugins.find((plugin) => plugin.pluginName === 'runtime-reconcile-plugin');
    expect(pluginState).toBeDefined();
      expect(pluginState?.generation).toBe(1);
      expect(pluginState?.state.lifecycle).toBe('serving');
      expect(pluginState?.sources.registry).toBe(true);
      expect(pluginState?.sources.runtime).toBe(true);
      expect(pluginState?.state.runtime.currentGeneration).toBe(1);
      expect(pluginState?.state.runtime.servingGeneration).toBe(1);
    });

  test('runtime status keys stay on logical plugin name when class name differs', async () => {
    const root = createTempRoot();
    const pluginPath = join(root, 'runtime-reconcile.plugin.ts');
    writeRuntimePluginModule(pluginPath, 'runtime-reconcile-plugin', 'logical-name', 'ManifestContractPlugin');

    const orchestrator = new PluginRuntimeOrchestrator(root, undefined, ['runtime-reconcile-plugin']);

    try {
      const result = await orchestrator.applyConfig(createConfig(pluginPath));
      const logicalEntry = result.status.plugins.find((plugin) => plugin.pluginName === 'runtime-reconcile-plugin');
      const leakedClassEntry = result.status.plugins.find((plugin) => plugin.pluginName === 'ManifestContractPlugin');

      expect(logicalEntry).toBeDefined();
      expect(logicalEntry?.sources.runtime).toBe(true);
      expect(logicalEntry?.state.states.runtimeLoaded).toBe('loaded');
      expect(leakedClassEntry).toBeUndefined();
      expect(result.diff.added).toEqual(expect.arrayContaining(['runtime-reconcile-plugin']));
      expect(result.diff.added).not.toContain('ManifestContractPlugin');
    } finally {
      await orchestrator.destroy();
    }
  });

  test('discovers disabled manifests without importing server code, then loads after activation', async () => {
    const root = createTempRoot();
    const pluginName = 'manifest-runtime-gated-plugin';
    const marker = '__bungeeManifestRuntimeGatedImportCount';
    const pluginPath = writeManifestRuntimePlugin(root, pluginName, marker);
    delete (globalThis as Record<string, unknown>)[marker];

    const disabledOrchestrator = new PluginRuntimeOrchestrator(root, undefined, [pluginName]);
    try {
      const disabled = await disabledOrchestrator.applyConfig({
        plugins: [{ name: pluginName, path: pluginPath, enabled: false }],
        routes: [],
      });

      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
      expect(disabledOrchestrator.getPluginRegistry()?.getPluginManifest(pluginName)).toBeDefined();
      expect(disabled.status.plugins.find((plugin) => plugin.pluginName === pluginName)?.state.lifecycle).toBe('disabled');
    } finally {
      await disabledOrchestrator.destroy();
    }

    const activeOrchestrator = new PluginRuntimeOrchestrator(root, undefined, [pluginName]);
    try {
      const active = await activeOrchestrator.applyConfig({
        plugins: [{ name: pluginName, path: pluginPath, enabled: true }],
        routes: [],
      });

      expect((globalThis as Record<string, unknown>)[marker]).toBe(1);
      expect(active.status.plugins.find((plugin) => plugin.pluginName === pluginName)?.state.lifecycle).toBe('serving');
    } finally {
      await activeOrchestrator.destroy();
      delete (globalThis as Record<string, unknown>)[marker];
    }
  });

  test('keeps prior serving generation observable when the current generation degrades on reconcile', async () => {
    const root = createTempRoot();
    const goodPluginPath = join(root, 'runtime-reconcile-good.plugin.ts');
    const badPluginPath = join(root, 'runtime-reconcile-bad.plugin.ts');
    writeRuntimePluginModule(goodPluginPath, 'runtime-reconcile-plugin', 'v1');
    writeInvalidReplacementModule(badPluginPath, 'runtime-reconcile-plugin');

    const orchestrator = new PluginRuntimeOrchestrator(root, undefined, ['runtime-reconcile-plugin']);

    try {
      const firstApply = await orchestrator.applyConfig(createConfig(goodPluginPath));
      expect(firstApply.status.plugins.find((plugin) => plugin.pluginName === 'runtime-reconcile-plugin')?.state.runtime.servingGeneration).toBe(1);

      const secondApply = await orchestrator.applyConfig(createConfig(badPluginPath));
      const pluginState = secondApply.status.plugins.find((plugin) => plugin.pluginName === 'runtime-reconcile-plugin');

      expect(secondApply.generation).toBe(2);
      expect(pluginState).toBeDefined();
      expect(pluginState?.state.lifecycle).toBe('degraded');
      expect(pluginState?.state.states.runtimeLoaded).toBe('degraded');
      expect(pluginState?.state.states.scopedServing).toBe('non-serving');
      expect(pluginState?.state.runtime.currentGeneration).toBe(2);
      expect(pluginState?.state.runtime.servingGeneration).toBe(1);
      expect(pluginState?.state.runtime.drainingGenerations).toEqual([1]);
      expect(pluginState?.state.runtime.servingScopes).toEqual([{ type: 'global' }]);
      expect(pluginState?.state.reasons.runtime).toContain("static 'version' property");
      expect(pluginState?.state.failures.runtime).toEqual({
        stage: 'runtime',
        classification: 'degraded',
        code: 'runtime-load-failure',
        generation: 2,
        reason: expect.stringContaining("static 'version' property"),
      });
    } finally {
      await orchestrator.destroy();
    }
  });
});
