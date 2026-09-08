import { describe, expect, test } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-types';
import {
  createConfigWorkerLifecycle,
  loadProductionResources,
  type ProductionResources,
} from '../../src/config-worker/lifecycle';
import { bodyStorageManager } from '../../src/logger/body-storage';
import { startCurrentMessage } from './config-publication-worker-runtime.fixtures';
import {
  privateWorkerHeaders,
  TEST_WORKER_TRANSPORT_SECRET,
} from '../fixtures/config-worker-private-transport';

const config: AppConfig = { config_version: 4, routes: [] };
const emptyStatus = {
  generation: 1,
  appliedAt: '2026-08-20T00:00:00.000Z',
  plugins: [],
  summary: { total: 0, serving: 0, disabled: 0, degraded: 0, quarantined: 0 },
};

function createTestLifecycle(loadResources: () => Promise<ProductionResources>) {
  const options = {
    transportSecret: TEST_WORKER_TRANSPORT_SECRET,
    loadResources,
  };
  return createConfigWorkerLifecycle(options);
}

function fixture(options: {
  failPluginRuntime?: boolean;
  failForceStop?: boolean;
  invalidPort?: boolean;
  failCleanup?: boolean;
} = {}) {
  const calls: string[] = [];
  let resolveDrain: (() => void) | undefined;
  let fetchHandler: ((request: Request) => Response | Promise<Response>) | undefined;
  let requestHandlerCalls = 0;
  let requestServingRevision: number | undefined;
  let servingActivatedPluginNames: readonly string[] = [];
  const drain = new Promise<void>((resolve) => { resolveDrain = resolve; });
  const resources = {
    configureBodyStorage() { calls.push('body'); },
    initializeRuntimeState() { calls.push('runtime'); },
    cleanupRuntimeState() { calls.push('cleanup-runtime'); },
    setServingConfig(_config: AppConfig, activatedPluginNames: readonly string[]) {
      servingActivatedPluginNames = activatedPluginNames;
      calls.push('serving-set');
    },
    clearServingConfig() { calls.push('serving-clear'); },
    initializePluginContext() { calls.push('context'); },
    async cleanupPluginContexts() {
      calls.push('cleanup-context');
      if (options.failCleanup) throw new Error('context cleanup failed');
    },
    async initializePluginRuntime() {
      calls.push('plugins');
      if (options.failPluginRuntime) throw new Error('plugin failure');
      return { generation: 1, status: emptyStatus };
    },
    async cleanupPluginRuntime() {
      calls.push('cleanup-plugins');
      if (options.failCleanup) throw new Error('plugin cleanup failed');
    },
    async handleRequest(request: Request, _config: AppConfig, context: { servingRevision: number }) {
      requestHandlerCalls += 1;
      requestServingRevision = context.servingRevision;
      return new Response(request.url);
    },
    serve(fetch: (request: Request) => Response | Promise<Response>) {
      fetchHandler = fetch;
      calls.push('serve');
      return {
        port: options.invalidPort ? 0 : 41_234,
        stop(force?: boolean) {
          calls.push(`stop:${String(force)}`);
          if (force === true && options.failForceStop) return Promise.reject(new Error('force stop failed'));
          return force === false ? drain : Promise.resolve();
        },
      };
    },
    async closeAccessLog() { calls.push('cleanup-access-log'); },
    async closeFileLog() { calls.push('cleanup-file-log'); },
  };
  return {
    calls,
    resources,
    resolveDrain: () => resolveDrain?.(),
    requestHandlerCalls: () => requestHandlerCalls,
    requestServingRevision: () => requestServingRevision,
    servingActivatedPluginNames: () => servingActivatedPluginNames,
    async dispatch(request: Request) {
      if (fetchHandler === undefined) throw new Error('server fetch handler is unavailable');
      return fetchHandler(request);
    },
  };
}

describe('config worker Bun lifecycle', () => {
  test('disables body storage when a later production config removes logging.body', async () => {
    const resources = await loadProductionResources();
    const enabledConfig: AppConfig = {
      ...config,
      logging: { body: { enabled: true, max_size: 321, retention_days: 7 } },
    };

    resources.configureBodyStorage(enabledConfig);
    expect(bodyStorageManager.getConfig()).toMatchObject({
      enabled: true,
      maxSize: 321,
      retentionDays: 7,
    });

    resources.configureBodyStorage(config);
    expect(bodyStorageManager.getConfig().enabled).toBe(false);
  });

  test('initializes resources in order before publishing the loopback port', async () => {
    const testFixture = fixture();
    const lifecycle = createTestLifecycle(async () => testFixture.resources);

    const started = await lifecycle.start(config, startCurrentMessage());

    expect(testFixture.calls).toEqual(['body', 'runtime', 'serving-set', 'context', 'plugins', 'serve']);
    expect(started.private_port).toBe(41_234);
    expect(started.plugin_runtime_generation).toBe(1);
    expect(testFixture.servingActivatedPluginNames()).toEqual(startCurrentMessage().activated_plugin_names);
  });

  test('passes the ACKed serving revision into every request', async () => {
    const testFixture = fixture();
    const lifecycle = createTestLifecycle(async () => testFixture.resources);
    const command = startCurrentMessage();
    const started = await lifecycle.start(config, command);

    const response = await testFixture.dispatch(new Request('http://127.0.0.1:41234/private', {
      headers: privateWorkerHeaders('https://public.example/private'),
    }));
    expect(response.status).toBe(200);
    expect(testFixture.requestServingRevision()).toBe(command.revision);
    await lifecycle.stop(started.handle);
  });

  test('stops accepting once without awaiting drain, then drain waits for requests', async () => {
    const testFixture = fixture();
    const lifecycle = createTestLifecycle(async () => testFixture.resources);
    const started = await lifecycle.start(config, startCurrentMessage());

    await lifecycle.stopAccepting(started.handle);
    await lifecycle.stopAccepting(started.handle);
    let drained = false;
    const drainResult = lifecycle.drain(started.handle).then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(testFixture.calls.filter((call) => call === 'stop:false')).toHaveLength(1);

    testFixture.resolveDrain();
    await drainResult;
    await lifecycle.stop(started.handle);
    expect(testFixture.calls).not.toContain('stop:true');
  });

  test('force stops and cleans resources idempotently', async () => {
    const testFixture = fixture();
    const lifecycle = createTestLifecycle(async () => testFixture.resources);
    const started = await lifecycle.start(config, startCurrentMessage());

    await lifecycle.stop(started.handle);
    await lifecycle.stop(started.handle);

    expect(testFixture.calls.filter((call) => call === 'stop:true')).toHaveLength(1);
    expect(testFixture.calls.filter((call) => call === 'cleanup-plugins')).toHaveLength(1);
    expect(testFixture.calls.filter((call) => call === 'cleanup-runtime')).toHaveLength(1);
    expect(testFixture.calls.filter((call) => call === 'cleanup-context')).toHaveLength(1);
    expect(testFixture.calls.filter((call) => call === 'cleanup-access-log')).toHaveLength(1);
    expect(testFixture.calls.filter((call) => call === 'cleanup-file-log')).toHaveLength(1);
  });

  test('cleans resources when force stop rejects', async () => {
    const testFixture = fixture({ failForceStop: true });
    const lifecycle = createTestLifecycle(async () => testFixture.resources);
    const started = await lifecycle.start(config, startCurrentMessage());

    await lifecycle.stop(started.handle).then(
      () => { throw new Error('expected force stop to fail'); },
      (error: unknown) => expect(String(error)).toContain('force stop failed'),
    );

    expect(testFixture.calls).toContain('cleanup-plugins');
    expect(testFixture.calls).toContain('cleanup-access-log');
    expect(testFixture.calls).toContain('cleanup-file-log');
  });

  test('cleans every partially initialized resource when start fails', async () => {
    const testFixture = fixture({ failPluginRuntime: true });
    const lifecycle = createTestLifecycle(async () => testFixture.resources);

    await lifecycle.start(config, startCurrentMessage()).then(
      () => { throw new Error('expected lifecycle start to fail'); },
      (error: unknown) => expect(String(error)).toContain('plugin failure'),
    );

    expect(testFixture.calls).toContain('cleanup-plugins');
    expect(testFixture.calls).toContain('cleanup-runtime');
    expect(testFixture.calls).toContain('cleanup-context');
    expect(testFixture.calls).toContain('cleanup-access-log');
    expect(testFixture.calls).toContain('cleanup-file-log');
    expect(testFixture.calls).not.toContain('serve');
  });

  test('retains invalid-port, stop, and every cleanup failure from startup', async () => {
    const testFixture = fixture({ invalidPort: true, failForceStop: true, failCleanup: true });
    const lifecycle = createTestLifecycle(async () => testFixture.resources);

    const error = await lifecycle.start(config, startCurrentMessage()).then(
      () => { throw new Error('expected lifecycle start to fail'); },
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error('expected aggregate startup failure');
    expect(error.errors.map(String)).toEqual([
      'Error: Bun server did not bind a positive port',
      'Error: force stop failed',
      'Error: plugin cleanup failed',
      'Error: context cleanup failed',
    ]);
    expect(testFixture.calls.filter((call) => call === 'cleanup-plugins')).toHaveLength(1);
    expect(testFixture.calls.filter((call) => call === 'cleanup-context')).toHaveLength(1);
  });

  test('propagates loadResources failure before resource ownership begins', async () => {
    const lifecycle = createTestLifecycle(async () => { throw new Error('resource import failed'); });
    await lifecycle.start(config, startCurrentMessage()).then(
      () => { throw new Error('expected resource loading to fail'); },
      (error: unknown) => expect(String(error)).toContain('resource import failed'),
    );
  });

  test('rejects missing required plugin readiness before binding', async () => {
    const testFixture = fixture();
    const lifecycle = createTestLifecycle(async () => testFixture.resources);
    const configWithPlugin = { ...config, plugins: [{ name: 'required-plugin', enabled: true }] };

    await lifecycle.start(configWithPlugin, startCurrentMessage()).then(
      () => { throw new Error('expected lifecycle readiness to fail'); },
      (error: unknown) => expect(String(error)).toContain('required plugins are not serving'),
    );

    expect(testFixture.calls).not.toContain('serve');
    expect(testFixture.calls).toContain('cleanup-plugins');
  });

  test('does not let an orphan service plugin block lifecycle start', async () => {
    const testFixture = fixture();
    const lifecycle = createTestLifecycle(async () => testFixture.resources);
    const configWithOrphan: AppConfig = {
      routes: [{ path: '/direct', endpoints: [{ target: 'http://direct.test' }] }],
      services: [{
        name: 'orphan',
        plugins: [{ name: 'orphan-plugin', enabled: true }],
        endpoints: [{ target: 'http://orphan.test' }],
      }],
    };

    const started = await lifecycle.start(configWithOrphan, startCurrentMessage());

    expect(started.private_port).toBe(41_234);
    expect(testFixture.calls).toContain('serve');
  });

  test('requires private transport proof before the injected handler', async () => {
    const testFixture = fixture();
    const lifecycle = createTestLifecycle(async () => testFixture.resources);
    const started = await lifecycle.start(config, startCurrentMessage());

    const rejected = await testFixture.dispatch(new Request('http://127.0.0.1:41234/health'));
    expect(rejected.status).toBe(403);
    expect(testFixture.requestHandlerCalls()).toBe(0);

    const accepted = await testFixture.dispatch(new Request('http://127.0.0.1:41234/health', {
      headers: privateWorkerHeaders('https://public.example/health'),
    }));
    expect(accepted.status).toBe(200);
    expect(testFixture.requestHandlerCalls()).toBe(1);
    await lifecycle.stop(started.handle);
  });

  test('forwards auth and management paths to the injected handler after private transport proof', async () => {
    const testFixture = fixture();
    const lifecycle = createTestLifecycle(async () => testFixture.resources);
    const started = await lifecycle.start(config, startCurrentMessage());

    const verification = await testFixture.dispatch(new Request('http://127.0.0.1:41234/health', {
      headers: privateWorkerHeaders('https://public.example/__ui/api/auth/verify'),
    }));
    const login = await testFixture.dispatch(new Request('http://127.0.0.1:41234/health', {
      method: 'POST',
      headers: privateWorkerHeaders('https://public.example/__ui/api/auth/login', {
        'content-type': 'application/json',
      }),
      body: JSON.stringify({ token: 'configured-token' }),
    }));
    const management = await testFixture.dispatch(new Request('http://127.0.0.1:41234/health', {
      headers: privateWorkerHeaders('https://public.example/__ui/api/routes'),
    }));

    expect([verification.status, login.status, management.status]).toEqual([200, 200, 200]);
    expect(testFixture.requestHandlerCalls()).toBe(3);
    await lifecycle.stop(started.handle);
  });

  test('trusts a master-authenticated management marker only after private transport validation', async () => {
    // Given
    const testFixture = fixture();
    const lifecycle = createTestLifecycle(async () => testFixture.resources);
    const started = await lifecycle.start(config, startCurrentMessage());
    const marker = 'x-bungee-internal-authenticated-management';

    // When
    const approved = await testFixture.dispatch(new Request('http://127.0.0.1:41234/private', {
      headers: privateWorkerHeaders('https://public.example/__ui/api/plugins', {
        authorization: 'Bearer final-token-unknown-to-stale-worker',
        [marker]: '1',
      }),
    }));
    const forged = await testFixture.dispatch(new Request('http://127.0.0.1:41234/private', {
      headers: { [marker]: '1' },
    }));
    const proxy = await testFixture.dispatch(new Request('http://127.0.0.1:41234/private', {
      headers: privateWorkerHeaders('https://public.example/api/test'),
    }));

    // Then
    expect(approved.status).toBe(200);
    expect(forged.status).toBe(403);
    expect(proxy.status).toBe(200);
    expect(testFixture.requestHandlerCalls()).toBe(2);
    await lifecycle.stop(started.handle);
  });
});
