import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@jeffusion/bungee-types';
import type { FinallyContext, MutableRequestContext } from '../../src/hooks';
import { ScopedPluginRegistry } from '../../src/scoped-plugin-registry';

const ROUTE_ALPHA = '/phase-alpha';
const ROUTE_BETA = '/phase-beta';
const SERVICE_NAME = 'phase-service';
const PRIMARY_UPSTREAM_ID = 'primary';
const SECONDARY_UPSTREAM_ID = 'secondary';

type CreatedRecord = {
  pluginName: string;
  label: string;
  instanceKey: string;
  scopeType?: string;
  phase?: string;
  routeId?: string;
  serviceName?: string;
  upstreamId?: string;
};

type PhaseLifecycleState = {
  created: CreatedRecord[];
  before: string[];
  intercept: string[];
  finally: string[];
};

interface TestFinallyContext extends FinallyContext {
  phase: 'request-level' | 'final-upstream-level';
  serviceName?: string;
}

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungee-plugin-phase-lifecycle-'));
  tempRoots.push(root);
  return root;
}

function writeLifecyclePlugin(root: string, stateKey: string, pluginName: string): string {
  const pluginPath = join(root, `${pluginName}.ts`);
  writeFileSync(
    pluginPath,
    `function getState() {
  const root = globalThis;
  if (!root[${JSON.stringify(stateKey)}]) {
    root[${JSON.stringify(stateKey)}] = { created: [], before: [], intercept: [], finally: [] };
  }
  return root[${JSON.stringify(stateKey)}];
}

function scopePart(scope, key) {
  return scope && scope[key] ? scope[key] : '';
}

export default class PhaseLifecyclePlugin {
  static name = ${JSON.stringify(pluginName)};
  static version = '1.0.0';

  static createHandler(config, initContext) {
    const label = config.label;
    const scope = initContext.scope;
    const instanceKey = [label, scopePart(scope, 'routeId'), scopePart(scope, 'serviceName'), scopePart(scope, 'upstreamId')].filter(Boolean).join('@');
    getState().created.push({
      pluginName: ${JSON.stringify(pluginName)},
      label,
      instanceKey,
      scopeType: scope && scope.type,
      phase: scope && scope.phase,
      routeId: scope && scope.routeId,
      serviceName: scope && scope.serviceName,
      upstreamId: scope && scope.upstreamId,
    });

    return {
      pluginName: ${JSON.stringify(pluginName)},
      config: { ...config, instanceKey },
      register(hooks) {
        hooks.onRequestInit.tapPromise({ name: instanceKey }, async () => {
          getState().before.push('init:' + instanceKey);
        });
        hooks.onBeforeRequest.tapPromise({ name: instanceKey }, async (ctx) => {
          getState().before.push(instanceKey);
          ctx.headers['x-before-order'] = ctx.headers['x-before-order'] ? ctx.headers['x-before-order'] + ',' + instanceKey : instanceKey;
          return ctx;
        });
        hooks.onInterceptRequest.tapPromise({ name: instanceKey }, async () => {
          getState().intercept.push(instanceKey);
          return undefined;
        });
        hooks.onResponse.tapPromise({ name: instanceKey }, async (response) => {
          return new Response(await response.text() + '>' + instanceKey, { status: response.status, headers: response.headers });
        });
        hooks.onFinally.tapPromise({ name: instanceKey }, async (ctx) => {
          getState().finally.push(instanceKey + ':' + ctx.phase + ':' + (ctx.upstreamId || 'none'));
        });
      }
    };
  }
}
`
  );
  return pluginPath;
}

function pluginConfig(path: string, name: string, label: string) {
  return { name, path, options: { label } };
}

function createLifecycleConfig(paths: Record<string, string>): AppConfig {
  return {
    plugins: [
      pluginConfig(paths.globalOnly, 'phase-global-only', 'global'),
      pluginConfig(paths.sameName, 'phase-shared', 'shared-global'),
    ],
    services: [
      {
        name: SERVICE_NAME,
        plugins: [
          pluginConfig(paths.serviceOnly, 'phase-service-only', 'service'),
          pluginConfig(paths.sameName, 'phase-shared', 'shared-service'),
        ],
        endpoints: [
          {
            id: PRIMARY_UPSTREAM_ID,
            target: 'http://primary.test',
            plugins: [pluginConfig(paths.endpointOnly, 'phase-endpoint-only', 'endpoint-primary')],
          },
          {
            id: SECONDARY_UPSTREAM_ID,
            target: 'http://secondary.test',
            plugins: [pluginConfig(paths.endpointOnly, 'phase-endpoint-only', 'endpoint-secondary')],
          },
        ],
      },
    ],
    routes: [
      {
        path: ROUTE_ALPHA,
        service: SERVICE_NAME,
        plugins: [
          pluginConfig(paths.routeOnly, 'phase-route-only', 'route'),
          pluginConfig(paths.sameName, 'phase-shared', 'shared-route'),
        ],
      },
      {
        path: ROUTE_BETA,
        service: SERVICE_NAME,
        plugins: [pluginConfig(paths.routeOnly, 'phase-route-only', 'route-beta')],
      },
    ],
  };
}

function getState(stateKey: string): PhaseLifecycleState {
  const testGlobals = globalThis as typeof globalThis & Record<string, PhaseLifecycleState | undefined>;
  const state = testGlobals[stateKey];
  if (!state) {
    throw new Error(`Missing phase lifecycle state for ${stateKey}`);
  }
  return state;
}

async function createInitializedRegistry(): Promise<{ registry: ScopedPluginRegistry; stateKey: string }> {
  const root = createTempRoot();
  const stateKey = `plugin-phase-lifecycle:${crypto.randomUUID()}`;
  const paths = {
    globalOnly: writeLifecyclePlugin(root, stateKey, 'phase-global-only'),
    routeOnly: writeLifecyclePlugin(root, stateKey, 'phase-route-only'),
    serviceOnly: writeLifecyclePlugin(root, stateKey, 'phase-service-only'),
    endpointOnly: writeLifecyclePlugin(root, stateKey, 'phase-endpoint-only'),
    sameName: writeLifecyclePlugin(root, stateKey, 'phase-shared'),
  };

  const registry = new ScopedPluginRegistry(root);
  const result = await registry.initializeFromConfig(createLifecycleConfig(paths));
  expect(result.failed).toBe(0);
  return { registry, stateKey };
}

function createRequestContext(routeId: string, upstreamId?: string): MutableRequestContext {
  return {
    method: 'GET',
    originalUrl: new URL(`http://localhost${routeId}`),
    clientIP: '127.0.0.1',
    requestId: crypto.randomUUID(),
    routeId,
    upstreamId,
    url: new URL(`http://localhost${routeId}`),
    headers: {},
    body: null,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ScopedPluginRegistry phase lifecycle integration', () => {
  test('loads global, route, service, and upstream plugin instances', async () => {
    const { registry, stateKey } = await createInitializedRegistry();
    try {
      const created = getState(stateKey).created;

      expect(created).toContainEqual(expect.objectContaining({ label: 'global', scopeType: 'global', phase: 'route' }));
      expect(created).toContainEqual(expect.objectContaining({ label: 'route', scopeType: 'route', phase: 'route', routeId: ROUTE_ALPHA }));
      expect(created).toContainEqual(expect.objectContaining({ label: 'service', scopeType: 'service', phase: 'service', routeId: ROUTE_ALPHA, serviceName: SERVICE_NAME }));
      expect(created).toContainEqual(expect.objectContaining({ label: 'endpoint-primary', scopeType: 'upstream', phase: 'upstream', routeId: ROUTE_ALPHA, upstreamId: PRIMARY_UPSTREAM_ID }));

      expect(registry.getStats()).toMatchObject({ globalInstances: 2, routeInstances: 2, serviceInstances: 2, upstreamInstances: 4 });
    } finally {
      await registry.destroy();
    }
  });

  test('composes route, service, and upstream phases without leaking adjacent scopes', async () => {
    const { registry } = await createInitializedRegistry();
    try {
      const hooks = registry.getPrecompiledHooks(ROUTE_ALPHA, PRIMARY_UPSTREAM_ID, SERVICE_NAME);

      expect(hooks.routePhase.handlers.map(handler => handler.config.label)).toEqual(['global', 'route', 'shared-route']);
      expect(hooks.servicePhase?.handlers.map(handler => handler.config.label)).toEqual(['service', 'shared-service']);
      expect(hooks.upstreamPhase.handlers.map(handler => handler.config.label)).toEqual(['endpoint-primary']);
    } finally {
      await registry.destroy();
    }
  });

  test('executes same-name route and service plugins independently across phases', async () => {
    const { registry } = await createInitializedRegistry();
    try {
      const hooks = registry.getPrecompiledHooks(ROUTE_ALPHA, PRIMARY_UPSTREAM_ID, SERVICE_NAME);
      const context = createRequestContext(ROUTE_ALPHA, PRIMARY_UPSTREAM_ID);

      await hooks.routePhase.hooks.onBeforeRequest.promise(context);
      await hooks.servicePhase?.hooks.onBeforeRequest.promise(context);

      expect(context.headers['x-before-order']).toContain('shared-route@/phase-alpha');
      expect(context.headers['x-before-order']).toContain('shared-service@/phase-alpha@phase-service');
    } finally {
      await registry.destroy();
    }
  });

  test('uses most-specific same-name plugin within the route phase', async () => {
    const { registry } = await createInitializedRegistry();
    try {
      const routePhase = registry.buildRoutePhaseHooks(ROUTE_ALPHA);

      expect(routePhase.handlers.map(handler => handler.config.label)).toContain('shared-route');
      expect(routePhase.handlers.map(handler => handler.config.label)).not.toContain('shared-global');
    } finally {
      await registry.destroy();
    }
  });

  test('creates independent service instances for routes referencing the same service', async () => {
    const { registry, stateKey } = await createInitializedRegistry();
    try {
      const alphaHooks = registry.getPrecompiledHooks(ROUTE_ALPHA, PRIMARY_UPSTREAM_ID, SERVICE_NAME);
      const betaHooks = registry.getPrecompiledHooks(ROUTE_BETA, PRIMARY_UPSTREAM_ID, SERVICE_NAME);
      const alphaContext = createRequestContext(ROUTE_ALPHA, PRIMARY_UPSTREAM_ID);
      const betaContext = createRequestContext(ROUTE_BETA, PRIMARY_UPSTREAM_ID);

      await alphaHooks.servicePhase?.hooks.onBeforeRequest.promise(alphaContext);
      await betaHooks.servicePhase?.hooks.onBeforeRequest.promise(betaContext);

      expect(alphaHooks.servicePhase?.handlers.map(handler => handler.config.instanceKey)).toEqual(['service@/phase-alpha@phase-service', 'shared-service@/phase-alpha@phase-service']);
      expect(betaHooks.servicePhase?.handlers.map(handler => handler.config.instanceKey)).toEqual(['service@/phase-beta@phase-service', 'shared-service@/phase-beta@phase-service']);
      expect(getState(stateKey).created).toContainEqual(expect.objectContaining({ label: 'service', routeId: ROUTE_ALPHA }));
      expect(getState(stateKey).created).toContainEqual(expect.objectContaining({ label: 'service', routeId: ROUTE_BETA }));
      expect(alphaContext.headers['x-before-order']).not.toBe(betaContext.headers['x-before-order']);
    } finally {
      await registry.destroy();
    }
  });

  test('executes inbound chain from endpoint to service to route to global', async () => {
    const { registry } = await createInitializedRegistry();
    try {
      const hooks = registry.getPrecompiledHooks(ROUTE_ALPHA, PRIMARY_UPSTREAM_ID, SERVICE_NAME);
      const response = await hooks.inbound.onResponse(new Response('origin'), createRequestContext(ROUTE_ALPHA, PRIMARY_UPSTREAM_ID));

      expect(await response.text()).toBe('origin>endpoint-primary@/phase-alpha@primary>service@/phase-alpha@phase-service>shared-service@/phase-alpha@phase-service>route@/phase-alpha>shared-route@/phase-alpha>global>shared-global');
    } finally {
      await registry.destroy();
    }
  });

  test('splits onFinally into request-level hooks and final-upstream-level hooks', async () => {
    const { registry, stateKey } = await createInitializedRegistry();
    try {
      const hooks = registry.getPrecompiledHooks(ROUTE_ALPHA, SECONDARY_UPSTREAM_ID, SERVICE_NAME);
      const finallyBaseContext = {
        method: 'GET',
        originalUrl: new URL(`http://localhost${ROUTE_ALPHA}`),
        clientIP: '127.0.0.1',
        requestId: crypto.randomUUID(),
        success: true,
        statusCode: 200,
        latencyMs: 12,
      };

      const upstreamFinallyContext: TestFinallyContext = {
        ...finallyBaseContext,
        phase: 'final-upstream-level',
        routeId: ROUTE_ALPHA,
        serviceName: SERVICE_NAME,
        upstreamId: SECONDARY_UPSTREAM_ID,
      };
      const requestFinallyContext: TestFinallyContext = {
        ...finallyBaseContext,
        phase: 'request-level',
        routeId: ROUTE_ALPHA,
        serviceName: SERVICE_NAME,
      };

await hooks.upstreamPhase.hooks.onFinally.promise(upstreamFinallyContext);
await hooks.servicePhase?.hooks.onFinally.promise(requestFinallyContext);
await hooks.routePrecompiled?.hooks.onFinally.promise(requestFinallyContext);
await hooks.globalPrecompiled?.hooks.onFinally.promise(requestFinallyContext);

expect(getState(stateKey).finally).toEqual([
  'endpoint-secondary@/phase-alpha@secondary:final-upstream-level:secondary',
  'service@/phase-alpha@phase-service:request-level:none',
  'shared-service@/phase-alpha@phase-service:request-level:none',
  'route@/phase-alpha:request-level:none',
  'shared-route@/phase-alpha:request-level:none',
  'global:request-level:none',
  'shared-global:request-level:none',
]);
    } finally {
      await registry.destroy();
    }
  });
});
