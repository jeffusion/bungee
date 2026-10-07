import { describe, expect, test } from 'bun:test';
import { createPluginControlHost, type BoundControlInvocation } from '../../src/plugin-control';
import type { BoundAttemptContext, ControlPlugin } from '../../src/plugin-control/contracts';
import { PluginServiceHost, defineRpcService, type AsyncRpcClient } from '../../src/plugin-services';
import type { RpcEndpointHandle } from '../../src/plugin-services/rpc-runtime';
import type { PluginServiceDeclarations } from '../../src/plugin-services/contracts';
import { readHostRpcCalleeFrame, type HostRpcPlacementRequest } from '../../src/plugin-services/host-rpc';
import type { PluginManifestRecord } from '../../src/plugin-manifest-catalog/types';
import type { PluginStorage, PluginStorageReadResult } from '../../src/plugin.types';
import type { SecretStoreFactory } from '../../src/plugin-control/host';
import type { ManagementSubject } from '../../src/plugin-extensions';

const WIDGET = 'control.rpc.widget';

const contract = defineRpcService({
  id: WIDGET,
  version: 1,
  methods: {
    echo: { kind: 'query', input: { type: 'string' }, output: { type: 'string' }, purposes: ['bootstrap', 'background', 'management', 'attempt', 'request'] },
    admin: { kind: 'query', input: { type: 'null' }, output: { type: 'string' }, purposes: ['management'] },
    hold: { kind: 'query', input: { type: 'null' }, output: { type: 'string' }, purposes: ['attempt'] },
  },
});

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

type RecordOptions = {
  provides?: NonNullable<PluginServiceDeclarations['provides']>;
  consumes?: NonNullable<PluginServiceDeclarations['consumes']>;
  dependencies?: Readonly<Record<string, string>>;
  rpcMethods?: readonly string[];
};

function serviceRecord(name: string, character: string, options: RecordOptions = {}): PluginManifestRecord {
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
      control: { entry: 'control.ts', rpc: (options.rpcMethods ?? ['refresh']).map(method => ({ name: method, access: 'bound-attempt' as const })) },
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
      return { namespace, get: async () => null, compareAndSet: async () => 1, delete: async () => undefined };
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

/** Real canonical control-process service host; trusted callbacks only, no wire transport. */
function makeServiceHost(placement?: (request: HostRpcPlacementRequest) => RpcEndpointHandle | null): PluginServiceHost {
  let host!: PluginServiceHost;
  host = new PluginServiceHost('control', {
    identity: (plugin, scope) => ({ endpoint: `control:${plugin}:${scope}`, instance: 'control-unit', generation: 1, catalog: 'unit-catalog', subject: plugin }),
    resolvePlacement: request => {
      const endpoint = placement?.(request);
      return endpoint ? { kind: 'endpoint', endpoint } : null;
    },
    resolveCallee: () => host.currentInvocation()?.callee ?? null,
    resolveJournal: () => null,
  });
  return host;
}

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

async function idle(): Promise<void> { for (let index = 0; index < 8; index += 1) await Promise.resolve(); }

const requiredRpc: NonNullable<PluginServiceDeclarations['consumes']> = [
  { plugin: 'provider', id: WIDGET, version: 1, process: 'control', kind: 'rpc' },
];
const providesRpc: NonNullable<PluginServiceDeclarations['provides']> = [
  { id: WIDGET, version: 1, process: 'control', kind: 'rpc' },
];

describe('plugin control canonical RPC integration', () => {
  test('waiting for a second required provider protects the first provider before consumer resources exist', async () => {
    const services = makeServiceHost();
    const records = [serviceRecord('alpha', 'a', { provides: providesRpc }), serviceRecord('beta', 'b', { provides: providesRpc }),
      serviceRecord('consumer', 'c', { dependencies: { alpha: '^1', beta: '^1' }, consumes: [
        { plugin: 'alpha', id: WIDGET, version: 1, process: 'control', kind: 'rpc' },
        { plugin: 'beta', id: WIDGET, version: 1, process: 'control', kind: 'rpc' },
      ] })];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const loading = new Promise<void>(resolve => { entered = resolve; });
    let result: string | undefined;
    const host = createPluginControlHost({
      records, services, secretStores: stores(), storage: storages(),
      loadControl: async record => {
        if (record.name === 'beta') { entered(); await gate; }
        return { createControl: context => {
          if (record.name !== 'consumer') return { api: [{ handler: 'read', path: '/read', methods: ['GET'], invoke: () => Response.json({ ready: true }) }], rpc: [],
            start: () => { context.services!.rpc!.publish(contract, { echo: input => input, admin: () => 'admin', hold: () => 'hold' }); }, dispose: () => undefined };
          const alpha = context.services!.rpc!.consume('alpha', contract), beta = context.services!.rpc!.consume('beta', contract);
          return { api: [], rpc: [], start: async () => { result = (await alpha.echo('a')) + (await beta.echo('b')); }, dispose: () => undefined };
        } };
      },
    });
    const starting = host.activate('consumer');
    await loading;
    expect(host.status('alpha')).toBe('ready');
    await expect(host.deactivate('alpha')).rejects.toThrow('required consumer');
    expect((await host.api.handle(new Request('http://localhost/api/plugins/alpha/control/read')))?.status).toBe(200);
    release(); await starting;
    expect(result).toBe('ab');
    await host.dispose();
  });

  test('a ready logical client relocated remotely permits retirement of an unrelated local control provider', async () => {
    let placement: RpcEndpointHandle | null = null;
    const services = makeServiceHost(() => placement);
    const records = [serviceRecord('provider', 'a', { provides: providesRpc }), serviceRecord('consumer', 'b', { dependencies: { provider: '^1' }, consumes: requiredRpc })];
    let client!: AsyncRpcClient<typeof contract.methods>;
    const host = createPluginControlHost({
      records, services, secretStores: stores(), storage: storages(),
      loadControl: async record => ({ createControl: context => {
        if (record.name === 'provider') return { api: [], rpc: [], start: () => {
          context.services!.rpc!.publish(contract, { echo: () => 'local', admin: () => 'admin', hold: () => 'held' });
        }, dispose: () => undefined };
        client = context.services!.rpc!.consume('provider', contract);
        return { api: [], rpc: [], start: async () => { expect(await client.echo('initial')).toBe('local'); }, dispose: () => undefined };
      } }),
    });
    await host.activate('consumer');
    placement = services.rpc!.runtime.register({ provider: 'provider', contract,
      binding: { endpoint: 'worker:provider', process: 'worker', instance: 'worker-instance', generation: 1, catalog: 'unit-catalog', scope: 'global', subject: 'provider' },
      handler: { echo: () => 'remote', admin: () => 'remote-admin', hold: () => 'remote-held' } });
    services.rpc!.runtime.markReady(placement);
    expect(await client.echo('moved')).toBe('remote');
    await host.deactivate('provider');
    expect(host.status('provider')).toBe('inactive');
    expect(host.status('consumer')).toBe('ready');
    expect(await client.echo('after-local-retirement')).toBe('remote');
    await host.dispose(); services.rpc!.runtime.revoke(placement);
  });

  test('an unresolved starting RPC consumer protects its required provider before client creation', async () => {
    const services = makeServiceHost();
    const records = [serviceRecord('provider', 'a', { provides: providesRpc }), serviceRecord('consumer', 'b', { dependencies: { provider: '^1.0.0' }, consumes: requiredRpc })];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const loading = new Promise<void>(resolve => { entered = resolve; });
    let value: string | undefined;
    const host = createPluginControlHost({
      records, services, secretStores: stores(), storage: storages(),
      loadControl: async record => {
        if (record.name === 'consumer') { entered(); await gate; }
        return { createControl: context => {
          if (record.name === 'provider') return {
            api: [{ handler: 'read', path: '/read', methods: ['GET'], invoke: () => Response.json({ value: 'still-ready' }) }], rpc: [],
            start: () => { context.services!.rpc!.publish(contract, { echo: input => input, admin: () => 'admin', hold: () => 'hold' }); }, dispose: () => undefined,
          };
          const client = context.services!.rpc!.consume('provider', contract);
          return { api: [], rpc: [], start: async () => { value = await client.echo('bootstrapped'); }, dispose: () => undefined };
        } };
      },
    });
    const starting = host.activate('consumer');
    await loading;
    await expect(host.deactivate('provider')).rejects.toThrow('required consumer');
    expect((await host.api.handle(new Request('http://localhost/api/plugins/provider/control/read')))?.status).toBe(200);
    release(); await starting;
    expect(value).toBe('bootstrapped');
    await host.dispose();
  });

  test('provider-first bootstrap, management subject frame, bound-attempt frame, and deactivate guard', async () => {
    const serviceHost = makeServiceHost();
    const providerRecord = serviceRecord('provider', 'a', { provides: providesRpc });
    const consumerRecord = serviceRecord('consumer', 'b', { dependencies: { provider: '^1.0.0' }, consumes: requiredRpc, rpcMethods: ['refresh'] });
    const frames: unknown[] = [];
    const events: string[] = [];
    let bootstrapValue: string | undefined;

    const host = createPluginControlHost({
      records: [providerRecord, consumerRecord],
      services: serviceHost,
      secretStores: stores(),
      storage: storages(),
      loadControl: async (record): Promise<ControlPlugin> => ({
        createControl: (context) => record.name === 'provider'
          ? (() => {
            const provides = context.services!.rpc!;
            return {
              api: [], rpc: [],
              start: () => {
                provides.publish(contract, {
                  echo: (input, handlerContext) => { frames.push(readHostRpcCalleeFrame(handlerContext.callee)); return input; },
                  admin: (_input, handlerContext) => { frames.push(readHostRpcCalleeFrame(handlerContext.callee)); return 'admin'; },
                  hold: () => 'held',
                });
                events.push('provider:start');
              },
              dispose: () => { events.push('provider:dispose'); },
            };
          })()
          : (() => {
            const client = context.services!.rpc!.consume('provider', contract);
            return {
              api: [{
                handler: 'read', path: '/read', methods: ['GET'],
                invoke: async () => Response.json({ value: await client.admin(null) }),
              }],
              rpc: [{
                name: 'refresh', handler: 'refresh',
                invoke: async () => client.echo('attempt'),
              }],
              start: async () => { bootstrapValue = await client.echo('bootstrap'); events.push('consumer:start'); },
              dispose: () => { events.push('consumer:dispose'); },
            };
          })(),
      }),
    });

    await host.activate('consumer');
    expect(host.status('provider')).toBe('ready');
    expect(host.status('consumer')).toBe('ready');
    expect(events).toEqual(['provider:start', 'consumer:start']);
    expect(bootstrapValue).toBe('bootstrap');
    // Bootstrap has no management/attempt principal.
    expect(frames[0]).toBeNull();

    const subject: ManagementSubject = { id: 'authenticated-admin', provider: 'local', capabilities: ['plugin.control'] };
    const response = await host.api.handle(new Request('http://localhost/api/plugins/consumer/control/read'), subject);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ value: 'admin' });
    const managementFrame = frames[1] as { subject?: ManagementSubject; request?: Request } | undefined;
    expect(managementFrame?.subject).toBe(subject);
    expect(managementFrame?.request).toBeInstanceOf(Request);

    expect(await host.invokeRpc('consumer', 'refresh', {}, invocation('consumer'))).toBe('attempt');
    const attemptFrame = frames[2] as { binding?: { plugin?: string }; attempt?: { attemptId?: string; signal?: AbortSignal } } | undefined;
    expect(attemptFrame?.binding?.plugin).toBe('consumer');
    expect(attemptFrame?.attempt?.attemptId).toBe('consumer');
    expect(attemptFrame?.attempt?.signal).toBeInstanceOf(AbortSignal);

    await expect(host.deactivate('provider')).rejects.toThrow(/referenced/);
    const stillServed = await host.api.handle(new Request('http://localhost/api/plugins/consumer/control/read'), subject);
    expect(stillServed?.status).toBe(200);

    await host.dispose();
    expect(events).toEqual(['provider:start', 'consumer:start', 'consumer:dispose', 'provider:dispose']);
  });

  test('a cancelled bound attempt keeps the lease and cleanup until the non-cooperative task settles', async () => {
    const serviceHost = makeServiceHost();
    const consumerRecord = serviceRecord('consumer', 'c', { rpcMethods: ['hold'] });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let holdStarted!: () => void;
    const entered = new Promise<void>(resolve => { holdStarted = resolve; });
    let disposes = 0;

    const host = createPluginControlHost({
      records: [consumerRecord],
      services: serviceHost,
      secretStores: stores(),
      storage: storages(),
      loadControl: async (): Promise<ControlPlugin> => ({
        createControl: () => ({
          api: [],
          rpc: [{
            name: 'hold', handler: 'hold',
            // Deliberately ignores the invocation signal: cancellation must not
            // release the actual task's lease or cleanup early.
            invoke: async () => { holdStarted(); await gate; return 'done'; },
          }],
          start: () => undefined,
          dispose: () => { disposes += 1; },
        }),
      }),
    });

    await host.activate('consumer');
    const controller = new AbortController();
    const pending = host.invokeRpc('consumer', 'hold', {}, invocation('consumer', controller.signal));
    await entered;

    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'deadline' });
    // The real task is still live: the captured lease is retained and nothing is cleaned.
    expect(serviceHost.references('consumer').find(reference => reference.plugin === 'consumer')?.leases).toBe(1);
    expect(disposes).toBe(0);

    release();
    await idle();
    expect(serviceHost.references('consumer').find(reference => reference.plugin === 'consumer')?.leases ?? 0).toBe(0);
    expect(disposes).toBe(0);

    await host.dispose();
    expect(disposes).toBe(1);
  });

  test('a remote-only RPC contract never starts its provider locally', async () => {
    const serviceHost = makeServiceHost();
    const providerRecord = serviceRecord('provider', 'a', { provides: [{ id: WIDGET, version: 1, process: 'worker', kind: 'rpc' }] });
    const consumerRecord = serviceRecord('consumer', 'b', { dependencies: { provider: '^1.0.0' }, consumes: requiredRpc });
    let providerStarts = 0;

    const host = createPluginControlHost({
      records: [providerRecord, consumerRecord],
      services: serviceHost,
      secretStores: stores(),
      storage: storages(),
      loadControl: async (record): Promise<ControlPlugin> => ({
        createControl: () => ({
          api: [], rpc: [],
          start: () => { if (record.name === 'provider') providerStarts += 1; },
          dispose: () => undefined,
        }),
      }),
    });

    await host.reconcile(['consumer']);
    expect(host.status('consumer')).toBe('ready');
    expect(host.status('provider')).toBe('inactive');
    expect(providerStarts).toBe(0);

    await host.dispose();
  });
});
