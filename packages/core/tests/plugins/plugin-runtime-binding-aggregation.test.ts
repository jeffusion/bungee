import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@jeffusion/bungee-types';
import { derivePluginReadiness, requiredPluginNames } from '../../src/config-publication/worker-runtime-plugins';
import { PluginRuntimeOrchestrator } from '../../src/plugin-runtime-orchestrator';

const roots: string[] = [];
const pluginName = 'binding-aggregation-plugin';

function fixture(): { root: string; pluginPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'bungee-binding-aggregation-'));
  const pluginPath = join(root, 'binding-aggregation.plugin.ts');
  roots.push(root);
  writeFileSync(pluginPath, `export default class BindingAggregationPlugin {
    static name = '${pluginName}';
    static version = '1.0.0';
    static async createHandler() { return { pluginName: '${pluginName}', register() {} }; }
  }`);
  return { root, pluginPath };
}

function writePlugin(root: string, name: string): string {
  const pluginPath = join(root, `${name}.plugin.ts`);
  writeFileSync(pluginPath, `export default class TestPlugin {
    static name = '${name}';
    static version = '1.0.0';
    static async createHandler() { return { pluginName: '${name}', register() {} }; }
  }`);
  return pluginPath;
}

function config(pluginPath: string, globalEnabled: boolean, routeEnabled: boolean): AppConfig {
  return {
    plugins: [{ name: pluginName, path: pluginPath, enabled: globalEnabled }],
    routes: [{
      path: '/mixed',
      plugins: [{ name: pluginName, path: pluginPath, enabled: routeEnabled }],
      endpoints: [{ target: 'http://example.test' }],
    }],
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('plugin binding activation aggregation', () => {
  for (const [globalEnabled, routeEnabled, scope] of [
    [false, true, 'route'],
    [true, false, 'global'],
  ] as const) {
    test(`serves when ${scope} binding is the enabled declaration`, async () => {
      const { root, pluginPath } = fixture();
      const orchestrator = new PluginRuntimeOrchestrator(root, undefined, [pluginName]);
      const runtimeConfig = config(pluginPath, globalEnabled, routeEnabled);
      try {
        const result = await orchestrator.applyConfig(runtimeConfig);
        const status = result.status.plugins.find((plugin) => plugin.pluginName === pluginName);
        expect(status?.state.lifecycle).toBe('serving');
        expect(status?.state.runtime.servingScopes).toEqual(scope === 'route'
          ? [{ type: 'route', routeId: '/mixed' }]
          : [{ type: 'global' }]);
        expect(requiredPluginNames(runtimeConfig)).toEqual([pluginName]);
        expect(derivePluginReadiness([pluginName], result.generation, result.status).failed).toEqual([]);
      } finally {
        await orchestrator.destroy();
      }
    });
  }

  test('keeps all-disabled declarations disabled and not required', async () => {
    const { root, pluginPath } = fixture();
    const orchestrator = new PluginRuntimeOrchestrator(root, undefined, [pluginName]);
    const runtimeConfig = config(pluginPath, false, false);
    try {
      const result = await orchestrator.applyConfig(runtimeConfig);
      const status = result.status.plugins.find((plugin) => plugin.pluginName === pluginName);
      expect(status?.state.lifecycle).toBe('enabled');
      expect(status?.state.runtime.servingScopes).toEqual([]);
      expect(requiredPluginNames(runtimeConfig)).toEqual([]);
    } finally {
      await orchestrator.destroy();
    }
  });

  test('agrees with route-reachable service and endpoint readiness', async () => {
    const { root } = fixture();
    const servicePlugin = 'reachable-service-plugin';
    const endpointPlugin = 'reachable-endpoint-plugin';
    const runtimeConfig: AppConfig = {
      routes: [{ path: '/reachable', service: 'reachable' }],
      services: [
        {
          name: 'reachable',
          plugins: [{ name: servicePlugin, path: writePlugin(root, servicePlugin), enabled: true }],
          endpoints: [{
            target: 'http://reachable.test',
            plugins: [{ name: endpointPlugin, path: writePlugin(root, endpointPlugin), enabled: true }],
          }],
        },
        {
          name: 'orphan',
          plugins: [{ name: 'orphan-missing-plugin', enabled: true }],
          endpoints: [{ target: 'http://orphan.test' }],
        },
      ],
    };
    const orchestrator = new PluginRuntimeOrchestrator(root, undefined, [servicePlugin, endpointPlugin]);
    try {
      const result = await orchestrator.applyConfig(runtimeConfig);
      const required = requiredPluginNames(runtimeConfig);
      expect(new Set(required)).toEqual(new Set([servicePlugin, endpointPlugin]));
      expect(result.status.plugins.find(({ pluginName: name }) => name === servicePlugin)?.state.lifecycle).toBe('serving');
      expect(result.status.plugins.find(({ pluginName: name }) => name === endpointPlugin)?.state.lifecycle).toBe('serving');
      expect(derivePluginReadiness(required, result.generation, result.status).failed).toEqual([]);
    } finally {
      await orchestrator.destroy();
    }
  });
});
