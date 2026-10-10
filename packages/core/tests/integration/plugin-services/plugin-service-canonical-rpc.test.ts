import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { PluginServiceHost, defineRpcService, RpcServiceError, type PluginServices, type PluginServiceDeclarations, type PluginServiceProcess } from '../../../src/plugin-services';
import { CommandJournal } from '../../../src/plugin-services/command-journal';
import { readHostRpcCalleeFrame } from '../../../src/plugin-services/host-rpc';
import type { RpcEndpointHandle } from '../../../src/plugin-services/rpc-runtime';

const contract = defineRpcService({
  id: 'canonical.test', version: 1,
  methods: {
    echo: { kind: 'query', input: { type: 'string' }, output: { type: 'string' }, purposes: ['bootstrap', 'background', 'management', 'request', 'attempt'] },
    slow: { kind: 'query', input: { type: 'null' }, output: { type: 'null' }, purposes: ['background', 'request'] },
    set: { kind: 'command', input: { type: 'object', properties: { amount: { type: 'number', integer: true } } }, output: { type: 'number', integer: true }, purposes: ['management', 'background'], command: { deduplication: 'local-transaction', resultRetentionMs: null, quotaBytes: 8192, maxResultBytes: 1024 } },
  },
});
const databases: Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
async function idle() { for (let index = 0; index < 8; index += 1) await Promise.resolve(); }
async function code(call: Promise<unknown>): Promise<string> {
  try { await call; return 'success'; } catch (error) { return error instanceof RpcServiceError ? error.code : 'unexpected'; }
}
function setup(process: PluginServiceProcess = 'worker', scope = 'global') {
  const database = new Database(':memory:');
  databases.push(database);
  const journals = new Map<string, CommandJournal>();
  let placed: RpcEndpointHandle | undefined;
  let host!: PluginServiceHost;
  host = new PluginServiceHost(process, {
    identity: (plugin, ownerScope) => ({ endpoint: `${process}:${plugin}:${ownerScope}`, instance: `canonical-${process}`, generation: 1, catalog: 'unit-catalog', subject: plugin }),
    resolvePlacement: () => placed === undefined ? null : { kind: 'endpoint', endpoint: placed },
    resolveCallee: () => host.currentInvocation()?.callee ?? null,
    resolveJournal: request => {
      const key = `${request.provider}/${request.service}/${request.major}/${request.method}/${request.bindingScope ?? 'global'}`;
      let journal = journals.get(key);
      if (!journal) {
        journal = new CommandJournal({ db: database, setup: true, namespace: key, privateStateNamespace: `private/${key}`, resolveAtomic: () => request.atomic });
        journals.set(key, journal);
      }
      return journal;
    },
  });
  const provides: PluginServiceDeclarations = { provides: [{ id: contract.id, version: 1, kind: 'rpc', process, scope: 'global' }] };
  const consumes: PluginServiceDeclarations = { consumes: [{ plugin: 'provider', id: contract.id, version: 1, kind: 'rpc', process, scope: 'global' }] };
  host.setDeclarations(new Map([['provider', provides], ['consumer', consumes]]));
  const provider = host.createContext('provider');
  const consumer = host.createContext('consumer', scope, { provider: '^1' });
  return { host, database, provider, consumer, scope, place: (endpoint: RpcEndpointHandle) => { placed = endpoint; } };
}
function publish(provider: PluginServices, overrides: { echo?: (input: string) => string; slow?: () => Promise<null> } = {}) {
  provider.rpc!.publish(contract, { echo: input => input, slow: () => null, set: () => { throw new Error('Atomic commands must not execute the ordinary handler'); }, ...overrides }, {
    set: { atomic: (_reader, invocation) => {
      const amount = (invocation.input as { amount: number }).amount;
      return { mutations: [{ key: 'value', expectedVersion: 0, value: { amount } }], result: amount };
    } },
  });
}

describe('canonical service host RPC lifecycle', () => {
  test('relocating a logical client does not retain or lease an unrelated local provider', async () => {
    const { host, provider, consumer, place } = setup();
    publish(provider); host.markReady('provider'); host.markReady('consumer');
    const client = consumer.rpc!.consume('provider', contract);
    expect(await client.echo('local')).toBe('local');
    const proxy = host.rpc!.runtime.register({
      provider: 'provider', contract,
      binding: { endpoint: 'remote-control', process: 'control', instance: 'control-instance', generation: 1, catalog: 'catalog', scope: 'global', subject: 'provider' },
      handler: { echo: () => 'relocated', slow: () => null, set: () => 0 },
    });
    host.rpc!.runtime.markReady(proxy);
    place(proxy);
    expect(await client.echo('remote')).toBe('relocated');
    const release = host.acquireLease('consumer');
    expect(host.references('provider').find(reference => reference.plugin === 'provider')!.leases).toBe(0);
    release();
    await host.dispose('provider');
    expect(await client.echo('still-remote')).toBe('relocated');
    await host.dispose('consumer'); host.rpc!.runtime.revoke(proxy);
  });

  for (const process of ['control', 'worker', 'ingress'] as const) {
    test(`${process}: bootstrap, ready service, shared dependencies and input-driven atomic command`, async () => {
      const { host, provider, consumer, database } = setup(process);
      expect(() => host.markReady('provider')).toThrow('not ready');
      publish(provider);
      const client = consumer.rpc!.consume('provider', contract);
      expect(await client.echo('bootstrap')).toBe('bootstrap');
      host.markReady('provider'); host.markReady('consumer');
      expect(await client.echo('ready')).toBe('ready');
      expect(host.references('provider').some(reference => reference.plugin === 'consumer')).toBe(true);
      expect(await client.set({ amount: 7 }, { operationId: 'set-one' })).toBe(7);
      expect(await client.set({ amount: 7 }, { operationId: 'set-one' })).toBe(7);
      const row = database.query<{ value_json: string }, []>('SELECT value_json FROM plugin_durable_records WHERE key = \'value\'').get();
      expect(JSON.parse(row!.value_json)).toEqual({ amount: 7 });
      await expect(host.dispose('provider')).rejects.toThrow('referenced');
      expect(await client.echo('still-ready')).toBe('still-ready');
      expect(host.disposalOrder()).toEqual([{ plugin: 'consumer', scope: 'global' }, { plugin: 'provider', scope: 'global' }]);
      await host.dispose('consumer'); await host.dispose('provider');
      expect(await code(client.echo('late'))).toBe('closed');
      expect(host.rpc!.status().active).toBe(0); expect(host.rpc!.status().endpoints).toBe(0);
    });
  }

  test('a required RPC declaration cannot become ready on an unconfigured host', () => {
    const host = new PluginServiceHost();
    host.setDeclarations(new Map([['provider', { provides: [{ id: contract.id, version: 1, kind: 'rpc', process: 'worker' }] }]]));
    expect(() => host.createContext('provider')).toThrow('execution is unavailable');
  });

  test('caller retirement blocks new calls but retains the real task and cleanup until completion', async () => {
    const { host, provider, consumer } = setup();
    const pending = gate();
    let cleaned = false;
    publish(provider, { slow: () => pending.promise.then(() => null) });
    host.markReady('provider'); host.markReady('consumer');
    consumer.onDispose(() => { cleaned = true; });
    const client = consumer.rpc!.consume('provider', contract);
    const call = client.slow(null);
    await idle();
    const disposing = host.dispose('consumer');
    expect(await code(client.echo('new'))).toBe('unauthorized');
    expect(cleaned).toBe(false);
    expect(host.references('provider').find(reference => reference.plugin === 'consumer')!.leases).toBe(1);
    pending.open();
    expect(await call).toBeNull();
    await disposing;
    expect(cleaned).toBe(true);
    await host.dispose('provider');
  });

  test('exact acquired request lease permits old-request calls during provider/caller retirement', async () => {
    const { host, provider, consumer } = setup();
    publish(provider); host.markReady('provider'); host.markReady('consumer');
    const client = consumer.rpc!.consume('provider', contract);
    const release = host.acquireLease('consumer');
    host.retire('provider');
    expect(() => host.acquireLease('consumer')).toThrow('not ready');
    expect(await code(client.echo('background'))).toBe('retired');
    expect(await host.runInInvocation(consumer, { purpose: 'request', lease: release }, () => client.echo('pinned'))).toBe('pinned');
    const disposing = host.dispose('consumer');
    expect(await host.runInInvocation(consumer, { purpose: 'attempt', lease: release }, () => client.echo('old-attempt'))).toBe('old-attempt');
    expect(() => host.runInInvocation(consumer, { purpose: 'request', lease: () => undefined }, () => client.echo('forged'))).toThrow('authorized');
    release(); await disposing; await host.dispose('provider');
    expect(() => host.runInInvocation(consumer, { purpose: 'request', lease: release }, () => client.echo('released'))).toThrow('authorized');
  });

  test('release invalidates an inherited request frame even before its caller retires', async () => {
    const { host, provider, consumer } = setup();
    publish(provider); host.markReady('provider'); host.markReady('consumer');
    const client = consumer.rpc!.consume('provider', contract);
    const release = host.acquireLease('consumer');
    const result = await host.runInInvocation(consumer, { purpose: 'request', lease: release }, async () => {
      release();
      return code(client.echo('released-proof'));
    });
    expect(result).toBe('unauthorized');
    await host.dispose('consumer'); await host.dispose('provider');
  });

  test('management authority remains host-owned; callee projection contains no lease proof or release callback', async () => {
    const { host, provider, consumer } = setup();
    let frame: unknown;
    provider.rpc!.publish(contract, { echo: (input, context) => { frame = readHostRpcCalleeFrame(context.callee); return input; }, slow: () => null, set: () => 0 });
    host.markReady('provider'); host.markReady('consumer');
    const subject = Object.freeze({ id: 'authenticated-admin' });
    const client = consumer.rpc!.consume('provider', contract);
    expect(await host.runInInvocation(consumer, { purpose: 'management', callee: subject }, () => client.echo('admin'))).toBe('admin');
    expect(frame).toBe(subject);
    const release = host.acquireLease('consumer');
    host.runInInvocation(consumer, { purpose: 'request', lease: release }, () => {
      const projection = host.currentInvocation()!;
      expect('lease' in projection).toBe(false); expect('proof' in projection).toBe(false);
    });
    release(); await host.dispose('consumer'); await host.dispose('provider');
  });

  test('awaited management calls retain authority but detached handler continuations cannot reuse it', async () => {
    const { host, provider, consumer } = setup();
    const managed = defineRpcService({ id: contract.id, version: 1, methods: {
      outer: { kind: 'query', input: { type: 'null' }, output: { type: 'null' }, purposes: ['management'] },
      inner: { kind: 'query', input: { type: 'null' }, output: { type: 'null' }, purposes: ['management'] },
    } });
    const awaited = gate();
    const detached = gate();
    let calls = 0;
    let inner!: () => Promise<null>;
    let late!: Promise<string>;
    const subject = { id: 'admin' };
    provider.rpc!.publish(managed, {
      outer: async () => {
        late = detached.promise.then(() => code(inner()));
        await awaited.promise;
        return null;
      },
      inner: (_input, context) => { calls += 1; expect(readHostRpcCalleeFrame(context.callee)).toBe(subject); return null; },
    });
    host.markReady('provider'); host.markReady('consumer');
    const typed = consumer.rpc!.consume('provider', managed);
    inner = () => typed.inner(null);
    expect(await code(typed.inner(null))).toBe('wrong_purpose');
    const running = host.runInInvocation(consumer, { purpose: 'management', callee: subject }, async () => {
      const pending = typed.outer(null);
      await idle();
      expect(await typed.inner(null)).toBeNull();
      awaited.open();
      await pending;
    });
    await running;
    detached.open();
    expect(await late).toBe('unauthorized');
    expect(calls).toBe(1);
    await host.dispose('consumer'); await host.dispose('provider');
  });

  test('cleanup re-entry shares the exact disposal and cannot delete a replacement instance', async () => {
    const { host, provider, consumer } = setup();
    publish(provider); host.markReady('provider'); host.markReady('consumer');
    let replacement!: PluginServices;
    let nested!: Promise<void>;
    consumer.onDispose(() => {
      queueMicrotask(() => {
        replacement = host.createContext('consumer', 'global', { provider: '^1' });
        host.markReady('consumer');
      });
      nested = host.dispose('consumer', 'global', consumer);
    });
    const first = host.dispose('consumer', 'global', consumer);
    await first;
    expect(nested).toBe(first);
    expect(host.isReady('consumer')).toBe(true);
    expect(await replacement.rpc!.consume('provider', contract).echo('replacement')).toBe('replacement');
    await expect(host.dispose('consumer', 'global', consumer)).rejects.toThrow('Stale');
    await host.dispose('consumer', 'global', replacement); await host.dispose('provider');
  });

  test('scoped RPC lease proof retains the global provider and only the admitted caller binding', async () => {
    const { host, provider, consumer } = setup('worker', 'route:a');
    publish(provider); host.markReady('provider'); host.markReady('consumer', 'route:a');
    const otherConsumer = host.createContext('consumer', 'route:b', { provider: '^1' }); host.markReady('consumer', 'route:b');
    const client = consumer.rpc!.consume('provider', contract);
    const release = host.acquireLease('consumer', 'route:a');
    expect(host.references('provider').find(reference => reference.plugin === 'provider')!.leases).toBe(1);
    expect(host.references('consumer').find(reference => reference.scope === 'route:b')!.leases).toBe(0);
    expect(() => host.runInInvocation(otherConsumer, { purpose: 'request', lease: release }, () => undefined)).toThrow('authorized');
    release(); await host.dispose('consumer', 'route:b');
    expect(await client.echo('a')).toBe('a');
    await host.dispose('consumer', 'route:a'); await host.dispose('provider');
  });
});
