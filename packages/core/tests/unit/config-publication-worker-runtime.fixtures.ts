import type { AppConfig, ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import type { ConfigWorkerLifecycle, ConfigWorkerRuntimeResult } from '../../src/config-publication';
import type { PluginRuntimeOrchestratorStatusReport } from '../../src/plugin-runtime-orchestrator';
import { hashConfigurationContent, parseNormalizeCompileAggregate } from '../../src/config-storage';

export type Handle = { readonly id: number };
export const PLUGIN_CATALOG_HASH = `sha256:${'c'.repeat(64)}` as const;
export const PRIVATE_PORT = 41_003;

export const IDS = {
  service: '10000000-0000-4000-8000-000000000001',
  route: '20000000-0000-4000-8000-000000000001',
  upstreamA: '30000000-0000-4000-8000-000000000001',
  upstreamB: '30000000-0000-4000-8000-000000000002',
  globalBinding: '40000000-0000-4000-8000-000000000001',
  routeBinding: '40000000-0000-4000-8000-000000000002',
  serviceBinding: '40000000-0000-4000-8000-000000000003',
  upstreamBinding: '40000000-0000-4000-8000-000000000004',
  disabledBinding: '40000000-0000-4000-8000-000000000005',
} as const;

export const PROCESS_IDENTITY = {
  master_generation: '50000000-0000-4000-8000-000000000001',
  worker_instance_id: '60000000-0000-4000-8000-000000000001',
  worker_slot: 3,
} as const;

export function aggregate(): ConfigurationAggregateV2 {
  const result = parseNormalizeCompileAggregate({
    logical_configuration: {
      plugins: [
        { id: IDS.globalBinding, position: 2, name: 'zeta', enabled: true },
        { id: IDS.disabledBinding, position: 1, name: 'disabled-override', enabled: false },
      ],
      services: [{
        id: IDS.service, position: 1, name: 'primary',
        plugins: [{ id: IDS.serviceBinding, position: 1, name: 'service-plugin', enabled: true }],
        endpoints: [
          { id: IDS.upstreamA, position: 1, target: 'https://same.example' },
          {
            id: IDS.upstreamB, position: 2, target: 'https://same.example',
            plugins: [{ id: IDS.upstreamBinding, position: 1, name: 'upstream-plugin', enabled: true }],
          },
        ],
      }],
      routes: [{
        id: IDS.route, position: 1, path: '/v1', service_id: IDS.service,
        plugins: [{ id: IDS.routeBinding, position: 1, name: 'alpha', enabled: true }],
      }],
    },
    plugin_activations: [
      { plugin_name: 'activation-without-binding' }, { plugin_name: 'zeta' },
      { plugin_name: 'alpha' }, { plugin_name: 'service-plugin' },
      { plugin_name: 'upstream-plugin' }, { plugin_name: 'disabled-override' },
    ],
  });
  if (!result.ok) throw new Error('test aggregate must compile');
  return result.value;
}

export function startMessage(revision = 7, value = aggregate()) {
  return {
    command: 'start-config-worker' as const, ...PROCESS_IDENTITY, revision,
    content_hash: hashConfigurationContent(value), plugin_catalog_hash: PLUGIN_CATALOG_HASH,
    aggregate: value,
    activated_plugin_names: Object.freeze(value.plugin_activations.map(({ plugin_name }) => plugin_name)),
    publication: { mutation_id: 'mutation-1', attempt_no: 2, drain_recovery_generation: 3 },
  };
}

export function startCurrentMessage(revision = 7, value = aggregate()) {
  return {
    command: 'start-current-config-worker' as const, ...PROCESS_IDENTITY, revision,
    content_hash: hashConfigurationContent(value), plugin_catalog_hash: PLUGIN_CATALOG_HASH,
    aggregate: value,
    activated_plugin_names: Object.freeze(value.plugin_activations.map(({ plugin_name }) => plugin_name)),
    publication: null,
  };
}

export function drainMessage(input = startMessage()) {
  return {
    command: 'drain-worker', ...PROCESS_IDENTITY, revision: input.revision,
    content_hash: input.content_hash, plugin_catalog_hash: input.plugin_catalog_hash,
    publication: input.publication,
  };
}

function pluginStatus(
  pluginName: string,
  generation: number,
  lifecycle: 'serving' | 'loaded' | 'degraded' | 'quarantined' = 'serving',
) {
  return {
    pluginName, generation,
    state: {
      pluginName, lifecycle,
      authorities: {
        discovery: 'plugin-registry', validation: 'plugin-registry', persistedEnabled: 'configuration',
        runtimeLoaded: 'scoped-plugin-registry', scopedServing: 'scoped-plugin-registry',
      },
      states: {
        discovery: 'discovered', validation: 'validated', persistedEnabled: 'enabled',
        runtimeLoaded: lifecycle === 'serving' ? 'loaded' : lifecycle,
        scopedServing: lifecycle === 'serving' ? 'serving' : 'non-serving',
      },
      runtime: {
        servingScopes: lifecycle === 'serving' ? [{ type: 'global' }] : [],
        currentGeneration: generation, servingGeneration: lifecycle === 'serving' ? generation : null,
        drainingGenerations: [],
      },
      contract: null, reasons: {}, failures: {},
    },
    sources: { registry: true, runtime: true },
  } satisfies PluginRuntimeOrchestratorStatusReport['plugins'][number];
}

export function statusReport(
  names: readonly string[],
  generation = 11,
  overrides: Readonly<Record<string, 'loaded' | 'degraded' | 'quarantined'>> = {},
): PluginRuntimeOrchestratorStatusReport {
  const plugins = names.map((name) => pluginStatus(name, generation, overrides[name] ?? 'serving'));
  return {
    generation, appliedAt: '2026-08-12T00:00:00.000Z', plugins,
    summary: {
      total: plugins.length,
      serving: plugins.filter(({ state }) => state.lifecycle === 'serving').length,
      disabled: 0,
      degraded: plugins.filter(({ state }) => state.lifecycle === 'degraded').length,
      quarantined: plugins.filter(({ state }) => state.lifecycle === 'quarantined').length,
    },
  };
}

export function fakeLifecycle(report = statusReport(['alpha', 'service-plugin', 'upstream-plugin', 'zeta'])) {
  const calls: string[] = [];
  const configs: AppConfig[] = [];
  let releaseStart: (() => void) | undefined;
  let markStartStarted: (() => void) | undefined;
  const startStarted = new Promise<void>((resolve) => { markStartStarted = resolve; });
  let waitForStart = false;
  let waitForDrain = false;
  let releaseDrain: (() => void) | undefined;
  let markDrainStarted: (() => void) | undefined;
  const drainStarted = new Promise<void>((resolve) => { markDrainStarted = resolve; });
  const lifecycle: ConfigWorkerLifecycle<Handle> = {
    async start(config) {
      calls.push('start'); configs.push(config);
      markStartStarted?.();
      if (waitForStart) await new Promise<void>((resolve) => { releaseStart = resolve; });
      return { handle: { id: 1 }, private_port: PRIVATE_PORT,
        plugin_runtime_generation: report.generation, plugin_status: report };
    },
    async stop(handle) { calls.push(`stop:${handle.id}`); },
    async stopAccepting(handle) { calls.push(`stop-accepting:${handle.id}`); },
    async drain(handle) {
      calls.push(`drain:${handle.id}`);
      markDrainStarted?.();
      if (waitForDrain) await new Promise<void>((resolve) => { releaseDrain = resolve; });
    },
  };
  return {
    calls, configs, lifecycle,
    holdStart() { waitForStart = true; },
    releaseStart() { releaseStart?.(); },
    waitForStart() { return startStarted; },
    holdDrain() { waitForDrain = true; },
    releaseDrain() { releaseDrain?.(); },
    waitForDrainStart() { return drainStarted; },
  };
}

export function expectMessage(result: ConfigWorkerRuntimeResult) {
  if (!result.ok) throw result.error;
  return result.message;
}
