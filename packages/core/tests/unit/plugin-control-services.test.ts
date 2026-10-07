import { describe, expect, test } from 'bun:test';
import { createPluginControlHost, type BoundControlInvocation } from '../../src/plugin-control';
import type {
  BoundAttemptContext,
  ControlApiHandlerContext,
  ControlHostContext,
  ControlPlugin,
  ControlRpcContext,
  SecretStore,
} from '../../src/plugin-control/contracts';
import { PluginServiceHost, type PluginServices } from '../../src/plugin-services';
import type { PluginServiceDeclarations } from '../../src/plugin-services/contracts';
import type { PluginManifestRecord } from '../../src/plugin-manifest-catalog/types';
import type { PluginStorage, PluginStorageReadResult } from '../../src/plugin.types';
import type { SecretStoreFactory } from '../../src/plugin-control/host';

const WIDGET = 'widget';

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

type ServiceRecordOptions = {
  provides?: NonNullable<PluginServiceDeclarations['provides']>;
  consumes?: NonNullable<PluginServiceDeclarations['consumes']>;
  dependencies?: Readonly<Record<string, string>>;
  rpc?: boolean;
};

function serviceRecord(name: string, character: string, options: ServiceRecordOptions = {}): PluginManifestRecord {
  const provides = options.provides ?? [];
  const consumes = options.consumes ?? [];
  return {
    name,
    rootPath: '/tmp/opencode',
    pluginPath: `/tmp/opencode/${name}`,
    pluginDir: `/tmp/opencode/${name}`,
    manifestPath: `/tmp/opencode/${name}/manifest.json`,
    mainPath: `/tmp/opencode/${name}/main.ts`,
    controlPath: `/tmp/opencode/${name}/control.ts`,
    runtimeHash: digest(character),
    configSchema: [],
    manifest: {
      name,
      version: '1.0.0',
      schemaVersion: 3,
      artifactKind: 'runtime-plugin',
      main: 'main.ts',
      capabilities: ['api', 'dynamicRuntimeLoad', 'controlPlane'],
      runtimeScope: 'global',
      uiExtensionMode: 'none',
      engines: { bungee: '^4.3.0 || ^5.0.0' },
      control: { entry: 'control.ts', rpc: options.rpc === false ? [] : [{ name: 'refresh', access: 'bound-attempt' }] },
      contributes: { api: [{ path: '/read', methods: ['GET'], handler: 'read', execution: 'control' }] },
      ...(provides.length > 0 || consumes.length > 0
        ? { services: { ...(provides.length > 0 ? { provides } : {}), ...(consumes.length > 0 ? { consumes } : {}) } }
        : {}),
      ...(options.dependencies ? { dependencies: options.dependencies } : {}),
      configSchema: [],
    },
  };
}

function stores(): SecretStoreFactory {
  return {
    create(namespace) {
      return {
        namespace,
        get: async () => null,
        compareAndSet: async () => 1,
        delete: async () => undefined,
      } satisfies SecretStore;
    },
    revoke: () => undefined,
    clear: () => undefined,
  };
}

function storages() {
  return {
    create() {
      const values = new Map<string, unknown>();
      return {
        get: async <T = unknown>(key: string) => (values.get(key) as T | undefined) ?? null,
        readStrict: async <T = unknown>(key: string): Promise<PluginStorageReadResult<T>> =>
          values.has(key) ? { found: true, value: values.get(key) as T } : { found: false },
        set: async (key: string, value: unknown) => { values.set(key, value); },
        delete: async (key: string) => { values.delete(key); },
        keys: async (prefix?: string) => [...values.keys()].filter((key) => prefix === undefined || key.startsWith(prefix)),
        clear: async () => { values.clear(); },
        increment: async () => 0,
        compareAndSet: async () => false,
      } satisfies PluginStorage;
    },
    revoke: () => undefined,
  };
}

const requiredWidget: NonNullable<PluginServiceDeclarations['consumes']> = [
  { plugin: 'provider', id: WIDGET, version: 1, process: 'control' },
];
function invocation(name: string, signal = new AbortController().signal): BoundControlInvocation {
  const attempt: BoundAttemptContext = {
    attemptId: name,
    clientStreaming: false,
    signal,
    boundClient: { call: async <T>() => undefined as T },
  };
  return {
    pluginName: name,
    binding: { plugin: name, contributionId: 'source', bindingId: 'binding', bindingOptions: {} },
    attempt,
  };
}

describe('plugin control local services', () => {
  test('initializes required providers first and shares one captured service facade with createControl, API, and bound RPC', async () => {
    const providerRecord = serviceRecord('provider', 'a', { provides: [{ id: WIDGET, version: 1, process: 'control' }] });
    const consumerRecord = serviceRecord('consumer', 'b', { dependencies: { provider: '^1.0.0' }, consumes: requiredWidget });
    const events: string[] = [];
    let consumerContext: ControlHostContext | undefined;

    const host = createPluginControlHost({
      records: [providerRecord, consumerRecord],
      secretStores: stores(),
      storage: storages(),
      loadControl: async (record): Promise<ControlPlugin> => ({
        createControl: (context) => {
          if (record.name === 'provider') {
            return {
              api: [], rpc: [],
              start: () => { context.services!.publish(WIDGET, 1, { read: () => 41 }); events.push('provider:start'); },
              dispose: () => { events.push('provider:dispose'); },
            };
          }
          consumerContext = context;
          const widget = context.services!.consume<{ read(): number }>('provider', WIDGET, 1);
          return {
            api: [{
              handler: 'read', path: '/read', methods: ['GET'],
              invoke: async (apiContext: ControlApiHandlerContext) => {
                expect(apiContext.services).toBe(context.services);
                return Response.json({ value: widget.read() });
              },
            }],
            rpc: [{
              name: 'refresh', handler: 'refresh',
              invoke: async (_payload: unknown, rpcContext: ControlRpcContext) => {
                expect(rpcContext.services).toBe(context.services);
                return widget.read();
              },
            }],
            start: () => { events.push('consumer:start'); },
            dispose: () => { events.push('consumer:dispose'); },
          };
        },
      }),
    });

    await host.activate('consumer');
    expect(host.status('provider')).toBe('ready');
    expect(host.status('consumer')).toBe('ready');
    expect(events).toEqual(['provider:start', 'consumer:start']);

    const handle = host.get('consumer');
    expect(handle).not.toBeNull();
    expect(consumerContext!.services).toBe(handle!.services);

    const response = await host.api.handle(new Request('http://localhost/api/plugins/consumer/control/read'));
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ value: 41 });

    expect(await host.invokeRpc('consumer', 'refresh', {}, invocation('consumer'))).toBe(41);

    await host.dispose();
    expect(events).toEqual(['provider:start', 'consumer:start', 'consumer:dispose', 'provider:dispose']);
  });

  test('does not start or publish a consumer when its required control provider fails', async () => {
    const serviceHost = new PluginServiceHost('control');
    const providerRecord = serviceRecord('provider', 'a', { provides: [{ id: WIDGET, version: 1, process: 'control' }] });
    const consumerRecord = serviceRecord('consumer', 'b', { dependencies: { provider: '^1.0.0' }, consumes: requiredWidget });
    let consumerCreates = 0;

    const host = createPluginControlHost({
      records: [providerRecord, consumerRecord],
      services: serviceHost,
      secretStores: stores(),
      storage: storages(),
      loadControl: async (record): Promise<ControlPlugin> => ({
        createControl: () => record.name === 'provider'
          ? { api: [], rpc: [], start: () => { throw new Error('provider start failed'); }, dispose: () => undefined }
          : (() => {
            consumerCreates += 1;
            return { api: [], rpc: [], start: () => undefined, dispose: () => undefined };
          })(),
      }),
    });

    await expect(host.activate('consumer')).rejects.toMatchObject({ code: 'start_failed' });
    expect(host.status('provider')).toBe('degraded');
    expect(host.status('consumer')).toBe('inactive');
    expect(consumerCreates).toBe(0);
    expect(serviceHost.references('provider')).toEqual([]);
    await host.dispose();
  });

  test('rejects optional declarations before loading any control module', () => {
    let loads = 0;
    expect(() => createPluginControlHost({
      records: [serviceRecord('consumer', 'b', { consumes: [{ plugin: 'provider', id: WIDGET, version: 1, process: 'control', optional: true } as never] })],
      secretStores: stores(), storage: storages(), loadControl: async () => { loads++; throw new Error('must not load'); },
    })).toThrow('Optional service declarations');
    expect(loads).toBe(0);
  });

  test('rejects a direct provider deactivate while a required consumer references it and keeps it callable', async () => {
    const serviceHost = new PluginServiceHost('control');
    const events: string[] = [];
    let reads = 0;
    const providerRecord = serviceRecord('provider', 'a', { provides: [{ id: WIDGET, version: 1, process: 'control' }] });
    const consumerRecord = serviceRecord('consumer', 'b', { dependencies: { provider: '^1.0.0' }, consumes: requiredWidget });

    const host = createPluginControlHost({
      records: [providerRecord, consumerRecord],
      services: serviceHost,
      secretStores: stores(),
      storage: storages(),
      loadControl: async (record): Promise<ControlPlugin> => ({
        createControl: (context) => {
          if (record.name === 'provider') return { api: [], rpc: [], start: () => { context.services!.publish(WIDGET, 1, { read: () => { reads++; return 41; } }); }, dispose: () => { events.push('provider:dispose'); } };
          const widget = context.services!.consume<{ read(): number }>('provider', WIDGET, 1);
          return {
            api: [{ handler: 'read', path: '/read', methods: ['GET'], invoke: async () => Response.json({ value: widget.read() }) }],
            rpc: [],
            start: () => undefined,
            dispose: () => { events.push('consumer:dispose'); },
          };
        },
      }),
    });

    await host.activate('consumer');
    await expect(host.deactivate('provider')).rejects.toThrow(/referenced/);
    expect(host.status('provider')).toBe('ready');
    expect(host.status('consumer')).toBe('ready');

    const response = await host.api.handle(new Request('http://localhost/api/plugins/consumer/control/read'));
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ value: 41 });
    expect(reads).toBe(1);

    await host.reconcile([]);
    expect(events).toEqual(['consumer:dispose', 'provider:dispose']);
    expect(host.status('consumer')).toBe('inactive');
    expect(host.status('provider')).toBe('inactive');
    await host.dispose();
  });

  test('revokes the captured service context when start times out so no publication or owner survives', async () => {
    const serviceHost = new PluginServiceHost('control');
    const providerRecord = serviceRecord('provider', 'a', { provides: [{ id: WIDGET, version: 1, process: 'control' }] });
    let disposes = 0;

    const host = createPluginControlHost({
      records: [providerRecord],
      services: serviceHost,
      secretStores: stores(),
      storage: storages(),
      startTimeoutMs: 5,
      loadControl: async (): Promise<ControlPlugin> => ({
        createControl: (context) => ({
          api: [], rpc: [],
          start: async () => {
            context.services!.publish(WIDGET, 1, { read: () => 1 });
            await new Promise<void>(() => undefined);
          },
          dispose: () => { disposes += 1; },
        }),
      }),
    });

    await expect(host.activate('provider')).rejects.toMatchObject({ code: 'timeout' });
    expect(host.status('provider')).toBe('degraded');
    expect(disposes).toBe(1);
    expect(serviceHost.references('provider')).toEqual([]);
    await host.dispose();
    expect(disposes).toBe(1);
  });

  test('same-tick independent deactivations never restart either target from an old desired set', async () => {
    const starts: string[] = [];
    const host = createPluginControlHost({
      records: [serviceRecord('a', 'a'), serviceRecord('b', 'b')], secretStores: stores(), storage: storages(),
      loadControl: async record => ({ createControl: () => ({ api: [], rpc: [], start: () => { starts.push(record.name); }, dispose: () => undefined }) }),
    });
    await host.reconcile(['a', 'b']);
    await Promise.all([host.deactivate('a'), host.deactivate('b')]);
    expect(host.status('a')).toBe('inactive');
    expect(host.status('b')).toBe('inactive');
    expect(starts).toEqual(['a', 'b']);
    await host.dispose();
  });

  test('startup timeout cannot destroy a control while its actual provider service task is live', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let disposed!: () => void;
    const cleanup = new Promise<void>(resolve => { disposed = resolve; });
    let disposes = 0;
    const host = createPluginControlHost({
      records: [serviceRecord('provider', 'a', { provides: [{ id: WIDGET, version: 1, process: 'control' }] }), serviceRecord('consumer', 'b', { dependencies: { provider: '*' }, consumes: requiredWidget })],
      secretStores: stores(), storage: storages(), startTimeoutMs: 5,
      loadControl: async record => ({ createControl: context => {
        if (record.name === 'provider') return { api: [], rpc: [], start: () => { context.services!.publish(WIDGET, 1, { read: () => gate }); }, dispose: () => undefined };
        const widget = context.services!.consume<{ read(): Promise<void> }>('provider', WIDGET, 1);
        return { api: [], rpc: [], start: () => widget.read(), dispose: () => { disposes++; disposed(); } };
      } }),
    });
    await expect(host.activate('consumer')).rejects.toMatchObject({ code: 'timeout' });
    expect(disposes).toBe(0);
    release();
    await cleanup;
    expect(disposes).toBe(1);
    await host.dispose();
  });

  test('host shutdown cannot succeed while a failed activation is still disposing its control', async () => {
    let releaseService!: () => void, releaseDisposal!: () => void, disposalStarted!: () => void, disposalFinished!: () => void;
    const serviceGate = new Promise<void>(resolve => { releaseService = resolve; });
    const disposalGate = new Promise<void>(resolve => { releaseDisposal = resolve; });
    const started = new Promise<void>(resolve => { disposalStarted = resolve; });
    const finished = new Promise<void>(resolve => { disposalFinished = resolve; });
    const host = createPluginControlHost({
      records: [serviceRecord('provider', 'a', { provides: [{ id: WIDGET, version: 1, process: 'control' }] }), serviceRecord('consumer', 'b', { dependencies: { provider: '*' }, consumes: requiredWidget })],
      secretStores: stores(), storage: storages(), startTimeoutMs: 5,
      loadControl: async record => ({ createControl: context => {
        if (record.name === 'provider') return { api: [], rpc: [], start: () => { context.services!.publish(WIDGET, 1, { read: () => serviceGate }); }, dispose: () => undefined };
        const widget = context.services!.consume<{ read(): Promise<void> }>('provider', WIDGET, 1);
        return { api: [], rpc: [], start: () => widget.read(), dispose: async () => { disposalStarted(); await disposalGate; disposalFinished(); } };
      } }),
    });
    await expect(host.activate('consumer')).rejects.toMatchObject({ code: 'timeout' });
    releaseService();
    await started;
    await expect(host.dispose()).rejects.toMatchObject({ code: 'timeout' });
    releaseDisposal();
    await finished;
  });

  test('a starting required consumer prevents disabling provider admission', async () => {
    let release!: () => void, starting!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { starting = resolve; });
    let reads = 0;
    const host = createPluginControlHost({
      records: [serviceRecord('provider', 'a', { provides: [{ id: WIDGET, version: 1, process: 'control' }] }), serviceRecord('consumer', 'b', { dependencies: { provider: '*' }, consumes: requiredWidget })],
      secretStores: stores(), storage: storages(),
      loadControl: async record => ({ createControl: context => {
        if (record.name === 'provider') {
          const widget = { read: () => { reads++; return 41; } };
          return { api: [{ handler: 'read', path: '/read', methods: ['GET'], invoke: () => Response.json({ value: widget.read() }) }], rpc: [], start: () => { context.services!.publish(WIDGET, 1, widget); }, dispose: () => undefined };
        }
        context.services!.consume('provider', WIDGET, 1);
        return { api: [], rpc: [], start: async () => { starting(); await gate; }, dispose: () => undefined };
      } }),
    });
    const reconciliation = host.reconcile(['provider', 'consumer']);
    await entered;
    await expect(host.deactivate('provider')).rejects.toThrow('referenced');
    release();
    await reconciliation;
    const response = await host.api.handle(new Request('http://localhost/api/plugins/provider/control/read'));
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ value: 41 });
    expect(reads).toBe(1);
    await host.dispose();
  });
});
