import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@jeffusion/bungee-types';
import { logger } from '../../src/logger';
import { ScopedPluginRegistry } from '../../src/scoped-plugin-registry';

const PLUGIN_NAME = 'phase-shared-plugin';
const ROUTE_ID = '/phase';
const SERVICE_NAME = 'phase-service';
const PRIMARY_UPSTREAM_ID = 'primary';
const SECONDARY_UPSTREAM_ID = 'secondary';

type CreatedRecord = {
  label: string;
  scopeType?: string;
  phase?: string;
  routeId?: string;
  serviceName?: string;
  upstreamId?: string;
};

type PhaseState = {
  created: CreatedRecord[];
  errors: string[];
};

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungee-scoped-phase-'));
  tempRoots.push(root);
  return root;
}

function writePhasePlugin(root: string, stateKey: string): string {
  const pluginPath = join(root, 'phase-plugin.ts');
  writeFileSync(
    pluginPath,
    `function getState() {
  const root = globalThis;
  if (!root[${JSON.stringify(stateKey)}]) {
    root[${JSON.stringify(stateKey)}] = { created: [], errors: [] };
  }
  return root[${JSON.stringify(stateKey)}];
}

export default class PhaseSharedPlugin {
  static name = ${JSON.stringify(PLUGIN_NAME)};
  static version = '1.0.0';

  static createHandler(config, initContext) {
    const label = config.label;
    getState().created.push({
      label,
      scopeType: initContext.scope?.type,
      phase: initContext.scope?.phase,
      routeId: initContext.scope?.routeId,
      serviceName: initContext.scope?.serviceName,
      upstreamId: initContext.scope?.upstreamId,
    });

    return {
      pluginName: ${JSON.stringify(PLUGIN_NAME)},
      config,
      register(hooks) {
        hooks.onBeforeRequest.tapPromise({ name: label }, async (ctx) => {
          ctx.headers['x-phase-order'] = ctx.headers['x-phase-order'] ? ctx.headers['x-phase-order'] + ',' + label : label;
          return ctx;
        });
        hooks.onResponse.tapPromise({ name: label }, async (response) => {
          return new Response(await response.text() + '>' + label, { status: response.status, headers: response.headers });
        });
        hooks.onStreamChunk.tapPromise({ name: label }, async (chunk) => [String(chunk) + '>' + label + ':a', String(chunk) + '>' + label + ':b']);
        hooks.onFlushStream.tapPromise({ name: label }, async (chunks) => [...chunks, 'flush>' + label]);
        hooks.onError.tapPromise({ name: label }, async () => {
          getState().errors.push(label);
        });
      }
    };
  }
}
`
  );
  return pluginPath;
}

function pluginConfig(path: string, label: string) {
  return { name: PLUGIN_NAME, path, options: { label } };
}

function createConfig(pluginPath: string): AppConfig {
  return {
    plugins: [pluginConfig(pluginPath, 'global')],
    services: [
      {
        name: SERVICE_NAME,
        plugins: [pluginConfig(pluginPath, 'service')],
        endpoints: [
          { id: PRIMARY_UPSTREAM_ID, target: 'http://primary.test', plugins: [pluginConfig(pluginPath, 'endpoint-primary')] },
          { id: SECONDARY_UPSTREAM_ID, target: 'http://secondary.test', plugins: [pluginConfig(pluginPath, 'endpoint-secondary')] },
        ],
      },
    ],
    routes: [
      {
        path: ROUTE_ID,
        service: SERVICE_NAME,
        plugins: [pluginConfig(pluginPath, 'route')],
      },
    ],
  };
}

function getState(stateKey: string): PhaseState {
  const testGlobals = globalThis as typeof globalThis & Record<string, PhaseState>;
  return testGlobals[stateKey];
}

async function createInitializedRegistry(): Promise<{ registry: ScopedPluginRegistry; stateKey: string }> {
  const root = createTempRoot();
  const stateKey = `phase-registry:${crypto.randomUUID()}`;
  const pluginPath = writePhasePlugin(root, stateKey);
  const registry = new ScopedPluginRegistry(root);
  const result = await registry.initializeFromConfig(createConfig(pluginPath));
  expect(result.failed).toBe(0);
  return { registry, stateKey };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ScopedPluginRegistry phase-aware compilation', () => {
  test('builds route, service, and upstream phases with phase-local composition', async () => {
    const { registry } = await createInitializedRegistry();
    try {
      const routePhase = registry.buildRoutePhaseHooks(ROUTE_ID);
      const servicePhase = registry.buildServicePhaseHooks(ROUTE_ID, SERVICE_NAME);
      const upstreamPhase = registry.buildUpstreamPhaseHooks(ROUTE_ID, PRIMARY_UPSTREAM_ID);

      expect(routePhase.metadata.scope).toBe(`route-phase:${ROUTE_ID}`);
      expect(routePhase.metadata.pluginNames).toEqual([PLUGIN_NAME]);
      expect(routePhase.handlers[0]?.config.label).toBe('route');
      expect(servicePhase?.metadata.scope).toBe(`service-phase:${ROUTE_ID}#${SERVICE_NAME}`);
      expect(servicePhase?.handlers.map(handler => handler.config.label)).toEqual(['service']);
      expect(upstreamPhase.metadata.scope).toBe(`upstream-phase:${ROUTE_ID}#${PRIMARY_UPSTREAM_ID}`);
      expect(upstreamPhase.handlers.map(handler => handler.config.label)).toEqual(['endpoint-primary']);
    } finally {
      await registry.destroy();
    }
  });

  test('deduplicates only inside each phase and keeps same-name plugins in different phases independent', async () => {
    const { registry } = await createInitializedRegistry();
    try {
      const primaryHooks = registry.getPrecompiledHooks(ROUTE_ID, PRIMARY_UPSTREAM_ID, SERVICE_NAME);
      const secondaryHooks = registry.getPrecompiledHooks(ROUTE_ID, SECONDARY_UPSTREAM_ID, SERVICE_NAME);

      expect(primaryHooks.routePhase.handlers.map(handler => handler.config.label)).toEqual(['route']);
      expect(primaryHooks.servicePhase?.handlers.map(handler => handler.config.label)).toEqual(['service']);
      expect(primaryHooks.upstreamPhase.handlers.map(handler => handler.config.label)).toEqual(['endpoint-primary']);
      expect(secondaryHooks.upstreamPhase.handlers.map(handler => handler.config.label)).toEqual(['endpoint-secondary']);
    } finally {
      await registry.destroy();
    }
  });

  test('executes inbound hooks endpoint to service to route to global', async () => {
    const { registry, stateKey } = await createInitializedRegistry();
    try {
      const hooks = registry.getPrecompiledHooks(ROUTE_ID, PRIMARY_UPSTREAM_ID, SERVICE_NAME);
      const response = await hooks.inbound.onResponse(new Response('origin'), {});
      const chunks = await hooks.inbound.onStreamChunk('chunk', {});
      const flushed = await hooks.inbound.onFlushStream(['start'], {});
      await hooks.inbound.onError({});

      expect(await response.text()).toBe('origin>endpoint-primary>service>route>global');
      expect(chunks[0]).toBe('chunk>endpoint-primary:a>service:a>route:a>global:a');
      expect(chunks).toHaveLength(16);
      expect(flushed).toEqual(['start', 'flush>endpoint-primary', 'flush>service', 'flush>route', 'flush>global']);
      expect(getState(stateKey).errors).toEqual(['endpoint-primary', 'service', 'route', 'global']);
    } finally {
      await registry.destroy();
    }
  });

  test('uses phase-aware cache identity and phase-local metadata keys', async () => {
    const { registry } = await createInitializedRegistry();
    try {
      const first = registry.getPrecompiledHooks(ROUTE_ID, PRIMARY_UPSTREAM_ID, SERVICE_NAME);
      const second = registry.getPrecompiledHooks(ROUTE_ID, PRIMARY_UPSTREAM_ID, SERVICE_NAME);

      expect(second).toBe(first);
      expect(first.routePhase.metadata.scope).toBe(`route-phase:${ROUTE_ID}`);
      expect(first.servicePhase?.metadata.scope).toBe(`service-phase:${ROUTE_ID}#${SERVICE_NAME}`);
      expect(first.upstreamPhase.metadata.scope).toBe(`upstream-phase:${ROUTE_ID}#${PRIMARY_UPSTREAM_ID}`);
      expect(registry.getStats().precompiledCache.phaseAware).toBe(1);
    } finally {
      await registry.destroy();
    }
  });

  test('loads service plugins and tags plugin initialization scope with phases', async () => {
    const { registry, stateKey } = await createInitializedRegistry();
    try {
      const created = getState(stateKey).created;
      expect(created).toContainEqual(expect.objectContaining({ label: 'route', scopeType: 'route', phase: 'route', routeId: ROUTE_ID }));
      expect(created).toContainEqual(expect.objectContaining({ label: 'service', scopeType: 'service', phase: 'service', routeId: ROUTE_ID, serviceName: SERVICE_NAME }));
      expect(created).toContainEqual(expect.objectContaining({ label: 'endpoint-primary', scopeType: 'upstream', phase: 'upstream', routeId: ROUTE_ID, upstreamId: PRIMARY_UPSTREAM_ID }));
      expect(registry.getStats().serviceInstances).toBe(1);
      expect(registry.getAllPluginsMetadata()[0]?.instances.service).toBe(1);
    } finally {
      await registry.destroy();
    }
  });

  test('logs a startup warning when the same plugin name appears in multiple scopes', async () => {
    const originalWarn = logger.warn;
    const warnings: Array<{ pluginName?: unknown; scopes?: unknown; message?: string }> = [];
    logger.warn = ((objOrMsg: string | Record<string, unknown>, msg?: string) => {
      if (typeof objOrMsg === 'string') {
        warnings.push({ message: objOrMsg });
        return;
      }
      warnings.push({ pluginName: objOrMsg.pluginName, scopes: objOrMsg.scopes, message: msg });
    }) as typeof logger.warn;

    const { registry } = await createInitializedRegistry();
    try {
      const warning = warnings.find(entry => entry.pluginName === PLUGIN_NAME);
      expect(warning?.message).toContain('Same-name plugin configured in multiple scopes');
      expect(warning?.scopes).toEqual(expect.arrayContaining([
        'global(phase:route)',
        `route:${ROUTE_ID}(phase:route)`,
        `service:${ROUTE_ID}#${SERVICE_NAME}(phase:service)`,
        `upstream:${ROUTE_ID}#${PRIMARY_UPSTREAM_ID}(phase:upstream)`,
      ]));
    } finally {
      logger.warn = originalWarn;
      await registry.destroy();
    }
  });
});
