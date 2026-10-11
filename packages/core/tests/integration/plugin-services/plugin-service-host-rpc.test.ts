import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { CommandJournal, type CommandAtomicPlanner } from '../../../src/plugin-services/command-journal';
import {
  HostRpcAdapter,
  RpcServiceError,
  readHostRpcCalleeFrame,
  type AsyncRpcClient,
  type HostRpcInvocationContext,
  type HostRpcJournalRequest,
  type HostRpcLeaseRequest,
  type HostRpcLifecycleIdentity,
  type HostRpcOwnerHandle,
  type HostRpcPlacementResolution,
} from '../../../src/plugin-services/host-rpc';
import type { PluginServiceConsumption, PluginServiceDeclarations, PluginServiceProcess } from '../../../src/plugin-services/contracts';
import type { RpcEndpointHandle, RpcRuntimeLimits } from '../../../src/plugin-services/rpc-runtime';

const WIDE = {
  globalBudgetBytes: 1_048_576, globalRequiredReserveBytes: 262_144, globalMaxRows: 8192,
  globalRequiredRowReserve: 2048, namespaceQuotaBytes: 524_288, requiredReserveBytes: 131_072,
  maxRecordsPerNamespace: 2048, requiredRowReserve: 512, maxRecordBytes: 262_144, entryOverheadBytes: 64,
};

const STORE = {
  id: 'store.v1',
  version: 1,
  methods: {
    echo: { kind: 'query', input: { type: 'string' }, output: { type: 'string' }, purposes: ['background', 'request', 'management'] },
    hello: { kind: 'query', input: { type: 'null' }, output: { type: 'literal', value: 'hi' }, purposes: ['bootstrap', 'background'] },
    boot: { kind: 'query', input: { type: 'null' }, output: { type: 'null' }, purposes: ['bootstrap'] },
    fail: { kind: 'query', input: { type: 'null' }, output: { type: 'null' }, purposes: ['background'] },
    slow: { kind: 'query', input: { type: 'null' }, output: { type: 'null' }, purposes: ['background', 'request'] },
    tight: { kind: 'query', input: { type: 'null' }, output: { type: 'string' }, purposes: ['background'], timeoutMs: 1_000 },
    outer: { kind: 'query', input: { type: 'null' }, output: { type: 'object', properties: { code: { type: 'string' } } }, purposes: ['background'] },
    inner: { kind: 'query', input: { type: 'null' }, output: { type: 'null' }, purposes: ['background'] },
    innerMgmt: { kind: 'query', input: { type: 'null' }, output: { type: 'null' }, purposes: ['management'] },
    slowInner: { kind: 'query', input: { type: 'null' }, output: { type: 'null' }, purposes: ['background'] },
    add: {
      kind: 'command', input: { type: 'object', properties: { amount: { type: 'number', integer: true } } },
      output: { type: 'object', properties: { count: { type: 'number', integer: true } } },
      purposes: ['background', 'management'],
      command: { deduplication: 'local-transaction', resultRetentionMs: null, quotaBytes: 8192, maxResultBytes: 1024 },
    },
    once: {
      kind: 'command', input: { type: 'null' },
      output: { type: 'object', properties: { seq: { type: 'number', integer: true } } },
      purposes: ['background', 'management'],
      command: { deduplication: 'local-transaction', resultRetentionMs: 10, quotaBytes: 8192, maxResultBytes: 1024 },
    },
    record: {
      kind: 'command', input: { type: 'null' }, output: { type: 'null' }, purposes: ['background', 'management'],
      command: { deduplication: 'none', resultRetentionMs: null, quotaBytes: 8192, maxResultBytes: 1024 },
    },
    recordFail: {
      kind: 'command', input: { type: 'null' }, output: { type: 'null' }, purposes: ['background', 'management'],
      command: { deduplication: 'none', resultRetentionMs: null, quotaBytes: 8192, maxResultBytes: 1024 },
    },
    ext: {
      kind: 'command', input: { type: 'null' },
      timeoutMs: 1_000,
      output: { type: 'object', properties: { n: { type: 'number', integer: true } } },
      purposes: ['background', 'management'],
      command: { deduplication: 'external-contract', resultRetentionMs: null, quotaBytes: 8192, maxResultBytes: 1024 },
    },
  },
} as const;

type StoreMethods = typeof STORE.methods;
const STORE_CONTRACT = { id: STORE.id, version: STORE.version, methods: STORE.methods };
const PROVIDES: PluginServiceDeclarations = { provides: [{ id: STORE.id, version: STORE.version, process: 'worker', kind: 'rpc' }] };
const CONSUMES: PluginServiceDeclarations = { consumes: [{ plugin: 'provider', id: STORE.id, version: STORE.version, process: 'worker', kind: 'rpc' }] };

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } } });

function memory(): Database {
  const db = new Database(':memory:');
  databases.push(db);
  return db;
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = () => resolve(); });
  return { promise, open };
}

async function idle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200 && !predicate(); index += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function rejection(promise: Promise<unknown>): Promise<RpcServiceError> {
  try { await promise; } catch (error) {
    if (error instanceof RpcServiceError) return error;
    throw error;
  }
  throw new Error('expected the RPC call to reject');
}

function codeOf(fn: () => unknown): string | null {
  try { fn(); } catch (error) { return error instanceof RpcServiceError ? error.code : null; }
  return null;
}

interface HarnessOptions {
  readonly process?: PluginServiceProcess;
  readonly limits?: RpcRuntimeLimits;
  readonly resolvePlacement?: (request: unknown) => HostRpcPlacementResolution;
  readonly resolveCallee?: (request: unknown, publication: unknown) => unknown;
  readonly resolveJournal?: (request: HostRpcJournalRequest) => CommandJournal | null;
  readonly journalSeen?: HostRpcJournalRequest[];
}

interface Harness { readonly adapter: HostRpcAdapter; readonly db: Database; readonly clock: { t: number }; }

function harness(options: HarnessOptions = {}): Harness {
  const db = memory();
  const clock = { t: 1_000_000 };
  const journals = new Map<string, CommandJournal>();
  const adapter = new HostRpcAdapter({
    process: options.process ?? 'worker',
    limits: options.limits,
    resolvePlacement: (options.resolvePlacement ?? (() => null)) as never,
    resolveCallee: (options.resolveCallee ?? (() => null)) as never,
    resolveJournal: (options.resolveJournal ?? ((request: HostRpcJournalRequest) => {
      options.journalSeen?.push(request);
      const key = [request.provider, request.service, request.major, request.method, request.scope, request.bindingScope ?? ''].join('|');
      let journal = journals.get(key);
      if (journal === undefined) {
        journal = new CommandJournal({
          db, namespace: `j.${journals.size}`, privateStateNamespace: `p.${journals.size}`, setup: true, limits: WIDE,
          now: () => clock.t,
          resolveAtomic: () => request.atomic ?? null,
          resolveExternal: () => request.external ?? null,
        });
        journals.set(key, journal);
      }
      return journal;
    })) as never,
  });
  return { adapter, db, clock };
}

function lifecycle(subject: string): HostRpcLifecycleIdentity {
  return { endpoint: `endpoint.${subject}`, instance: `instance.${subject}`, generation: 1, catalog: 'catalog.1', subject };
}

interface OwnerFixture {
  readonly handle: HostRpcOwnerHandle;
  readonly state: { ready: boolean; retiring: boolean; revoked: boolean; leases: number };
  readonly leases: HostRpcLeaseRequest[];
}

interface OwnerExtras {
  readonly scope?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly registerPublication?: () => void;
  readonly registerConsumption?: (consumption: PluginServiceConsumption) => void;
  readonly resolveInvocationContext?: () => HostRpcInvocationContext | null;
  readonly canCall?: (target: { provider: string; service: string; major: number; method: string }) => boolean;
}

function owner(adapter: HostRpcAdapter, plugin: string, declarations: PluginServiceDeclarations, extra: OwnerExtras = {}): OwnerFixture {
  const state = { ready: false, retiring: false, revoked: false, leases: 0 };
  const leases: HostRpcLeaseRequest[] = [];
  const required = Object.fromEntries((declarations.consumes ?? []).map((c) => [c.plugin, '*']));
  const handle = adapter.createOwner({
    token: {},
    plugin,
    scope: extra.scope ?? 'global',
    declarations,
    dependencies: extra.dependencies ?? required,
    lifecycle: lifecycle(extra.scope === undefined || extra.scope === 'global' ? plugin : `${plugin}@${extra.scope}`),
    getLifecycleState: () => ({ ready: state.ready, retiring: state.retiring, revoked: state.revoked }),
    acquireLease: (request) => {
      leases.push(request);
      if (state.revoked) throw new Error('revoked');
      if (state.retiring) {
        if (request.purpose !== 'request' && request.purpose !== 'attempt') throw new Error('retiring');
      } else if (!state.ready && request.purpose !== 'bootstrap') {
        throw new Error('not ready');
      }
      state.leases += 1;
      let released = false;
      return {
        release: () => { if (!released) { released = true; state.leases -= 1; } },
        allowRetired: state.retiring && (request.purpose === 'request' || request.purpose === 'attempt'),
      };
    },
    registerPublication: extra.registerPublication ?? (() => undefined),
    registerConsumption: extra.registerConsumption,
    resolveInvocationContext: extra.resolveInvocationContext ?? (() => null),
    canCall: extra.canCall,
  });
  return { handle, state, leases };
}

function markReady(fixture: OwnerFixture): void { fixture.state.ready = true; fixture.handle.markReady(); }
function retire(fixture: OwnerFixture): void { fixture.state.retiring = true; fixture.handle.retire(); }

function publisher(fixture: OwnerFixture, handlers: Record<string, unknown>, capabilities?: Record<string, unknown>) {
  return fixture.handle.publish(STORE_CONTRACT, handlers as never, capabilities as never);
}

function fullHandlers(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    echo: (input: string) => input, hello: () => 'hi' as const, boot: () => null, fail: () => null,
    slow: async () => null, tight: async () => 'ok', outer: async () => ({ code: 'ok' }), inner: () => null,
    innerMgmt: () => null, slowInner: () => null, add: () => ({ count: 0 }), once: () => ({ seq: 0 }),
    record: () => null, recordFail: () => null, ext: () => { throw new Error('unknown'); }, ...overrides,
  };
}

function consumers(fixture: OwnerFixture): AsyncRpcClient<StoreMethods> {
  return fixture.handle.consume('provider', STORE_CONTRACT);
}

describe('registration boundaries', () => {
  test('accessors, class instances, extra and missing methods are rejected before any read', () => {
    const provider = owner(harness().adapter, 'provider', PROVIDES);
    expect(codeOf(() => publisher(provider, { ...fullHandlers(), extra: () => null }))).toBe('invalid_registration');
    const { echo: _echo, ...missing } = fullHandlers();
    expect(codeOf(() => publisher(provider, missing))).toBe('invalid_registration');
    const withAccessor = fullHandlers();
    Object.defineProperty(withAccessor, 'echo', { get: () => () => 'x', enumerable: true });
    expect(codeOf(() => publisher(provider, withAccessor))).toBe('invalid_registration');
    class H { echo = () => 'x'; }
    expect(codeOf(() => publisher(provider, new H() as unknown as Record<string, unknown>))).toBe('invalid_registration');
    expect(codeOf(() => publisher(provider, fullHandlers()))).toBeNull();
  });

  test('duplicate publication is refused before register and never grows endpoint count', () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    publisher(provider, fullHandlers());
    expect(made.adapter.status().endpoints).toBe(1);
    expect(codeOf(() => publisher(provider, fullHandlers()))).toBe('invalid_registration');
    expect(made.adapter.status().endpoints).toBe(1);
  });

  test('a throwing registerPublication host callback rolls back the endpoint', () => {
    const made = harness();
    let fail = true;
    const provider = owner(made.adapter, 'provider', PROVIDES, {
      registerPublication: () => { if (fail) throw new Error('canonical aggregate rejected'); },
    });
    expect(codeOf(() => publisher(provider, fullHandlers()))).toBe('invalid_registration');
    expect(made.adapter.status().endpoints).toBe(0);
    fail = false;
    expect(codeOf(() => publisher(provider, fullHandlers()))).toBeNull();
    expect(made.adapter.status().endpoints).toBe(1);
  });

  test('descriptor-safe lifecycle rejects accessors without invoking them', () => {
    const made = harness();
    let reads = 0;
    const bad = {
      get endpoint() { reads += 1; return 'x'; },
      instance: 'i', generation: 1, catalog: 'c', subject: 's',
    };
    expect(codeOf(() => made.adapter.createOwner({
      token: {}, plugin: 'p', scope: 'global', declarations: PROVIDES,
      dependencies: {},
      lifecycle: bad as unknown as HostRpcLifecycleIdentity,
      getLifecycleState: () => ({ ready: false, retiring: false, revoked: false }),
      acquireLease: () => ({ release: () => undefined }),
      resolveInvocationContext: () => null,
    }))).toBe('invalid_registration');
    expect(reads).toBe(0);
  });
});

describe('manifest and dependency declarations', () => {
  test('publication must match provider id/major/kind/process/scope', () => {
    expect(codeOf(() => publisher(owner(harness().adapter, 'p', { provides: [] }), fullHandlers()))).toBe('undeclared');
    expect(codeOf(() => publisher(owner(harness().adapter, 'p', { provides: [{ id: STORE.id, version: 2, process: 'worker', kind: 'rpc' }] }), fullHandlers()))).toBe('undeclared');
    expect(codeOf(() => publisher(owner(harness().adapter, 'p', { provides: [{ id: STORE.id, version: 1, process: 'control', kind: 'rpc' }] }), fullHandlers()))).toBe('undeclared');
    expect(codeOf(() => publisher(owner(harness().adapter, 'p', { provides: [{ id: STORE.id, version: 1, process: 'worker', kind: 'rpc', scope: 'binding' } as never] }), fullHandlers()))).toBe('invalid_registration');
    expect(codeOf(() => publisher(owner(harness().adapter, 'p', { provides: [{ id: STORE.id, version: 1, process: 'worker' }] }), fullHandlers()))).toBe('undeclared');
  });

  test('consumption requires a matching declaration AND a canonical dependency record', () => {
    expect(codeOf(() => consumers(owner(harness().adapter, 'c', { consumes: [] })))).toBe('undeclared');
    expect(codeOf(() => consumers(owner(harness().adapter, 'c', CONSUMES, { dependencies: {} })))).toBe('undeclared');
  });

  test('optional RPC consumption is rejected before any owner is registered', () => {
    expect(codeOf(() => owner(harness().adapter, 'consumer', { consumes: [{ plugin: 'provider', id: STORE.id, version: 1, process: 'worker', kind: 'rpc', optional: true } as never] }))).toBe('invalid_registration');
  });
});

describe('local RPC and durable commands', () => {
  function localHarness() {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    const counters = { record: 0 };
    let inner: AsyncRpcClient<StoreMethods> | null = null;
    publisher(provider, fullHandlers({
      fail: () => { throw new Error('super-secret-token'); },
      outer: async () => {
        try { await inner!.inner(null); return { code: 'ok' }; }
        catch (error) { return { code: error instanceof RpcServiceError ? error.code : 'unknown' }; }
      },
      record: () => { counters.record += 1; return null; },
      recordFail: () => { throw new Error('secret'); },
    }), {
      add: { atomic: ((reader) => {
        const current = reader.get('count');
        const version = current === null ? 0 : current.version;
        const count = current === null ? 0 : (current.value as { count: number }).count;
        const next = count + 1;
        return { mutations: [{ key: 'count', expectedVersion: version, value: { count: next } }], result: { count: next } };
      }) as CommandAtomicPlanner },
      once: { atomic: ((reader) => {
        const current = reader.get('seq');
        const version = current === null ? 0 : current.version;
        const seq = current === null ? 0 : (current.value as { seq: number }).seq;
        const next = seq + 1;
        return { mutations: [{ key: 'seq', expectedVersion: version, value: { seq: next } }], result: { seq: next } };
      }) as CommandAtomicPlanner },
    });
    const client = consumers(consumer);
    inner = client;
    markReady(provider);
    markReady(consumer);
    return { ...made, provider, consumer, client, counters };
  }

  test('local-transaction command commits once and returns the same stored result', async () => {
    const { client } = localHarness();
    expect(await client.add({ amount: 1 }, { operationId: 'op-1' })).toEqual({ count: 1 });
    expect(await client.add({ amount: 1 }, { operationId: 'op-1' })).toEqual({ count: 1 });
    expect(await client.add({ amount: 5 }, { operationId: 'op-2' })).toEqual({ count: 2 });
    expect(await client.hello(null)).toBe('hi');
  });

  test('a duplicate operation with a changed payload conflicts and is never overwritten', async () => {
    const { client } = localHarness();
    expect(await client.add({ amount: 1 }, { operationId: 'c' })).toEqual({ count: 1 });
    expect((await rejection(client.add({ amount: 9 }, { operationId: 'c' }))).code).toBe('conflict');
    expect(await client.add({ amount: 1 }, { operationId: 'c' })).toEqual({ count: 1 });
  });

  test('queryResult is async, carries the original operation id, and expires without recompute', async () => {
    const { client, db, clock } = localHarness();
    expect(await client.once(null, { operationId: 'once-1' })).toEqual({ seq: 1 });
    expect(await client.once.queryResult('once-1')).toEqual({ seq: 1 });
    clock.t += 1_000;
    const error = await rejection(client.once.queryResult('once-1'));
    expect(error.code).toBe('expired');
    expect(error.operationId).toBe('once-1');
    const stored = db.query<{ value_json: string }, [string]>('SELECT value_json FROM plugin_durable_records WHERE key = ?').get('seq');
    expect(JSON.parse(stored!.value_json)).toEqual({ seq: 1 });
  });

  test('an unknown command outcome is queryable and reconciliation is refused for a none policy', async () => {
    const { client } = localHarness();
    expect((await rejection(client.recordFail(null, { operationId: 'fail-1' }))).code).toBe('unknown');
    expect((await rejection(client.recordFail.queryResult('fail-1'))).code).toBe('unknown');
    expect((await rejection(client.recordFail.reconcile('fail-1', null))).code).toBe('capability_unavailable');
    expect(await client.record(null, { operationId: 'ok-1' })).toBeNull();
    expect(await client.record.queryResult('ok-1')).toBeNull();
  });

  test('a duplicate operation with the same payload does not repeat the effect', async () => {
    const { client, counters } = localHarness();
    expect(await client.record(null, { operationId: 'dup' })).toBeNull();
    expect(await client.record(null, { operationId: 'dup' })).toBeNull();
    expect(counters.record).toBe(1);
  });

  test('same operation id on different targets never shares state', async () => {
    const { client } = localHarness();
    expect(await client.add({ amount: 1 }, { operationId: 'shared' })).toEqual({ count: 1 });
    expect((await rejection(client.add({ amount: 7 }, { operationId: 'shared' }))).code).toBe('conflict');
    expect(await client.record(null, { operationId: 'shared' })).toBeNull();
  });

  test('a command without a bound journal is refused explicitly and never runs the handler', async () => {
    const made = harness({ resolveJournal: () => null });
    const provider = owner(made.adapter, 'provider', PROVIDES);
    let commandCalls = 0;
    publisher(provider, fullHandlers({ add: () => { commandCalls += 1; return { count: 0 }; } }));
    markReady(provider);
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    markReady(consumer);
    expect((await rejection(consumers(consumer).add({ amount: 1 }, { operationId: 'no-journal' }))).code).toBe('capability_unavailable');
    expect(commandCalls).toBe(0);
  });

  test('handler failures are sanitized to a fixed error with no cause or leaked message', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    publisher(provider, fullHandlers({ fail: () => { throw new Error('super-secret-token'); } }));
    markReady(provider);
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    markReady(consumer);
    const error = await rejection(consumers(consumer).fail(null));
    expect(error.code).toBe('failed');
    expect(error.message).toBe('RPC call failed');
    expect(error.message).not.toContain('super-secret-token');
    expect('cause' in error).toBe(false);
  });
});

describe('call options, purpose, and caller identity', () => {
  test('options are snapshotted: accessors, proxies, and unknown/principal keys are rejected without getters', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    const seen: Array<{ subject: string; purpose: string }> = [];
    publisher(provider, fullHandlers({
      echo: (_input: string, context: { caller: { subject: string }; purpose: string }) => { seen.push({ subject: context.caller.subject, purpose: context.purpose }); return context.purpose; },
    }));
    markReady(provider);
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    markReady(consumer);
    const client = consumers(consumer);
    const loose = client.echo as unknown as (input: string, options: unknown) => Promise<unknown>;

    let reads = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'operationId', { get: () => { reads += 1; return 'x'; }, enumerable: true });
    expect((await rejection(loose('x', accessor))).code).toBe('invalid_input');
    expect(reads).toBe(0);
    expect((await rejection(loose('x', new Proxy({}, {})))).code).toBe('invalid_input');
    expect((await rejection(loose('x', { subject: 'evil' }))).code).toBe('invalid_input');
    expect((await rejection(loose('x', { purpose: 'management' }))).code).toBe('invalid_input');

    expect(await client.echo('plain')).toBe('background');
    expect(seen).toEqual([{ subject: 'consumer', purpose: 'background' }]);
    expect((await rejection(client.echo('x', { operationId: 'q' } as never))).code).toBe('invalid_operation_id');
    expect((await rejection(client.add({ amount: 1 }))).code).toBe('invalid_operation_id');
  });

  test('management purpose is only reachable through a host invocation frame; the caller stays the owner', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    const seen: string[] = [];
    publisher(provider, fullHandlers({
      echo: (input: string, context: { caller: { subject: string }; purpose: string }) => { seen.push(`${context.caller.subject}:${context.purpose}`); return input; },
    }));
    markReady(provider);
    const gateway = owner(made.adapter, 'gateway', CONSUMES, {
      resolveInvocationContext: () => ({ purpose: 'management', token: {} }),
    });
    markReady(gateway);
    expect(await consumers(gateway).echo('x')).toBe('x');
    expect(seen).toEqual(['gateway:management']);
  });

  test('bootstrap is automatic while starting and only bootstrap methods are allowed', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    publisher(provider, fullHandlers());
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    const client = consumers(consumer);
    expect(await client.hello(null)).toBe('hi');
    expect((await rejection(client.echo('x'))).code).toBe('wrong_purpose');
    markReady(provider);
    markReady(consumer);
    expect((await rejection(client.boot(null))).code).toBe('wrong_purpose');
    expect(await client.echo('x')).toBe('x');
  });

  test('the trusted callee frame is available to the provider and opaque to input', async () => {
    let frame: unknown;
    const made = harness({ resolveCallee: () => ({ trusted: 'frame' }) });
    const provider = owner(made.adapter, 'provider', PROVIDES);
    publisher(provider, fullHandlers({ echo: (input: string, context: { callee: unknown }) => { frame = readHostRpcCalleeFrame(context.callee); return input; } }));
    markReady(provider);
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    markReady(consumer);
    expect(await consumers(consumer).echo('x')).toBe('x');
    expect(frame).toEqual({ trusted: 'frame' });
  });
});

describe('leases, bootstrap, and placement', () => {
  test('bootstrap to a ready provider still holds a real callee lease during the call', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    const pending = gate();
    publisher(provider, fullHandlers({ hello: () => pending.promise.then(() => 'hi' as const) }));
    markReady(provider);
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    const call = consumers(consumer).hello(null);
    await idle();
    expect(provider.state.leases).toBe(1);
    expect(consumer.state.leases).toBe(1);
    pending.open();
    expect(await call).toBe('hi');
    await idle();
    expect(provider.state.leases).toBe(0);
    expect(consumer.state.leases).toBe(0);
  });

  test('bootstrap to an unready provider requires an explicit host lease grant', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    publisher(provider, fullHandlers());
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    expect(await consumers(consumer).hello(null)).toBe('hi');
    expect(provider.leases.some((lease) => lease.role === 'callee' && lease.purpose === 'bootstrap')).toBe(true);
    expect(provider.state.leases).toBe(0);
  });

  test('a non-publishing consumer still holds its own lease across the call lifespan', async () => {
    let remoteEndpoint: RpcEndpointHandle = Object.freeze({});
    const made = harness({ resolvePlacement: () => ({ kind: 'endpoint', endpoint: remoteEndpoint }) });
    const endpoint = made.adapter.runtime.register({
      provider: 'control-provider',
      binding: { endpoint: 'control.remote', process: 'control', instance: 'ci', generation: 1, catalog: 'cc', scope: 'global', subject: 'control' },
      contract: { id: 'remote.v1', version: 1, methods: { lookup: { kind: 'query', input: { type: 'null' }, output: { type: 'string' }, purposes: ['background'] } } },
      handler: { lookup: () => 'remote' },
    });
    remoteEndpoint = endpoint;
    made.adapter.runtime.markReady(endpoint);
    const consumer = owner(made.adapter, 'consumer', {
      consumes: [{ plugin: 'control-provider', id: 'remote.v1', version: 1, process: 'worker', kind: 'rpc' }],
    });
    markReady(consumer);
    const client = consumer.handle.consume('control-provider', {
      id: 'remote.v1', version: 1, methods: { lookup: { kind: 'query', input: { type: 'null' }, output: { type: 'string' }, purposes: ['background'] } },
    });
    expect(await client.lookup(null)).toBe('remote');
    expect(consumer.leases.some((lease) => lease.role === 'caller')).toBe(true);
    expect(consumer.state.leases).toBe(0);
  });

  test('placement resolver runs first: ambiguous and exact remote results are honoured', async () => {
    const REMOTE_DECL: PluginServiceDeclarations = { consumes: [{ plugin: 'control-provider', id: 'remote.v1', version: 1, process: 'worker', kind: 'rpc' }] };
    let placement: HostRpcPlacementResolution = null;
    const made = harness({ resolvePlacement: () => placement });
    const endpoint = made.adapter.runtime.register({
      provider: 'control-provider',
      binding: { endpoint: 'control.remote', process: 'control', instance: 'ci', generation: 1, catalog: 'cc', scope: 'global', subject: 'control' },
      contract: { id: 'remote.v1', version: 1, methods: { lookup: { kind: 'query', input: { type: 'null' }, output: { type: 'string' }, purposes: ['background'] } } },
      handler: { lookup: () => 'remote' },
    });
    made.adapter.runtime.markReady(endpoint);
    placement = { kind: 'endpoint', endpoint };
    const consumer = owner(made.adapter, 'consumer', REMOTE_DECL);
    markReady(consumer);
    const client = consumer.handle.consume('control-provider', {
      id: 'remote.v1', version: 1, methods: { lookup: { kind: 'query', input: { type: 'null' }, output: { type: 'string' }, purposes: ['background'] } },
    });
    expect(await client.lookup(null)).toBe('remote');
    placement = { kind: 'ambiguous' };
    expect((await rejection(client.lookup(null))).code).toBe('ambiguous_placement');
    placement = null;
    expect((await rejection(client.lookup(null))).code).toBe('unavailable');
  });

  test('scoped RPC callers keep separate command identity against a global provider', async () => {
    const seen: HostRpcJournalRequest[] = [];
    const made = harness({ journalSeen: seen });
    const provider = owner(made.adapter, 'provider', PROVIDES);
    let calls = 0;
    publisher(provider, fullHandlers({ record: () => { calls++; return null; } })); markReady(provider);
    for (const scope of ['route:a', 'route:b']) {
      const consumer = owner(made.adapter, 'consumer', CONSUMES, { scope }); markReady(consumer);
      const client = consumers(consumer);
      await client.record(null, { operationId: 'shared' });
      await client.record(null, { operationId: 'shared' });
      expect(consumer.leases[0].scope).toBe(scope);
    }
    expect(calls).toBe(2);
    expect(seen.every(request => request.scope === 'global' && request.bindingScope === undefined)).toBe(true);
  });
});

describe('retirement, drain, cancellation, and deadlines', () => {
  function slowHarness(limits?: RpcRuntimeLimits) {
    const made = harness({ limits });
    const provider = owner(made.adapter, 'provider', PROVIDES);
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    const pending = gate();
    let calls = 0;
    publisher(provider, fullHandlers({ slow: () => { calls += 1; return pending.promise.then(() => null); } }));
    const client = consumers(consumer);
    markReady(provider);
    markReady(consumer);
    return { ...made, provider, consumer, client, pending, calls: () => calls };
  }

  test('a new background call after retire is refused while the existing lease drains', async () => {
    const made = slowHarness();
    const call = made.client.slow(null);
    await idle();
    expect(made.provider.state.leases).toBe(1);
    retire(made.provider);
    expect((await rejection(made.client.slow(null))).code).toBe('retired');
    made.pending.open();
    expect(await call).toBeNull();
    await idle();
    expect(made.provider.state.leases).toBe(0);
  });

  test('dispose reports the real drain verdict and never returns early while work is live', async () => {
    const made = slowHarness();
    const call = made.client.slow(null);
    await idle();
    const disposal = made.provider.handle.dispose();
    expect((await rejection(call)).code).toBe('revoked');
    let settled = false;
    void disposal.then(() => { settled = true; });
    await idle();
    expect(settled).toBe(false);
    made.pending.open();
    expect(await disposal).toEqual({ drained: true, active: 0 });
    expect(made.provider.state.leases).toBe(0);
  });

  test('a bounded drain timeout reports drained:false rather than silent success', async () => {
    const made = slowHarness({ drainTimeoutMs: 20 });
    const call = made.client.slow(null);
    const failure = rejection(call);
    await idle();
    expect(await made.provider.handle.dispose()).toEqual({ drained: false, active: 1 });
    made.pending.open();
    expect((await failure).code).toBe('revoked');
    await idle();
    expect(await made.provider.handle.dispose()).toEqual({ drained: true, active: 0 });
  });

  test('cancel and timeout retain the real runtime lease until the business settles', async () => {
    const made = slowHarness();
    const controller = new AbortController();
    const cancelled = made.client.slow(null, { signal: controller.signal });
    await idle();
    controller.abort();
    expect((await rejection(cancelled)).code).toBe('cancelled');
    expect(made.provider.state.leases).toBe(1);
    made.pending.open();
    await idle();
    expect(made.provider.state.leases).toBe(0);

    const timed = slowHarness();
    const timeout = timed.client.slow(null, { timeoutMs: 5 });
    expect((await rejection(timeout)).code).toBe('timeout');
    expect(timed.provider.state.leases).toBe(1);
    timed.pending.open();
    await idle();
    expect(timed.provider.state.leases).toBe(0);
  });

  test('a nested call cannot extend the parent deadline and same-method re-entry is a deadlock', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    const pending = gate();
    let inner: AsyncRpcClient<StoreMethods> | null = null;
    let innerCalls = 0;
    let parentDeadline = Infinity;
    let childDeadline = Infinity;
    publisher(provider, fullHandlers({
      outer: async () => {
        try { await inner!.outer(null); return { code: 'ok' }; }
        catch (error) { return { code: error instanceof RpcServiceError ? error.code : 'unknown' }; }
      },
      inner: () => { innerCalls += 1; return null; },
      slowInner: (_input: unknown, context: { deadlineAt: number }) => {
        innerCalls += 1;
        childDeadline = context.deadlineAt;
        return pending.promise.then(() => null);
      },
      tight: async (_input: unknown, context: { deadlineAt: number }) => {
        parentDeadline = context.deadlineAt;
        try { await inner!.slowInner(null, { timeoutMs: 5_000 }); return 'ok'; }
        catch (error) { return error instanceof RpcServiceError ? error.code : 'unknown'; }
      },
    }));
    const client = consumers(consumer);
    inner = client;
    markReady(provider);
    markReady(consumer);
    expect(await client.outer(null)).toEqual({ code: 'deadlock' });
    expect(innerCalls).toBe(0);
    const started = Date.now();
    const outcome = await client.tight(null, { timeoutMs: 20 }).catch(error => error instanceof RpcServiceError ? error.code : 'unexpected');
    expect(outcome).toBe('timeout');
    expect(innerCalls).toBe(1);
    expect(childDeadline).toBeLessThanOrEqual(parentDeadline);
    expect(Date.now() - started).toBeLessThan(1_000);
    pending.open();
    await idle();
  });

  test('nested calls cannot convert purpose: a method without the parent purpose is refused', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    let inner: AsyncRpcClient<StoreMethods> | null = null;
    publisher(provider, fullHandlers({
      outer: async () => {
        try { await inner!.innerMgmt(null); return { code: 'ok' }; }
        catch (error) { return { code: error instanceof RpcServiceError ? error.code : 'unknown' }; }
      },
    }));
    const client = consumers(consumer);
    inner = client;
    markReady(provider);
    markReady(consumer);
    expect(await client.outer(null)).toEqual({ code: 'wrong_purpose' });
  });

  test('queryResult and reconcile are rejected once the target is retiring or detached', async () => {
    const made = slowHarness();
    expect(await made.client.record(null, { operationId: 'r1' })).toBeNull();
    retire(made.provider);
    expect((await rejection(made.client.record.queryResult('r1'))).code).toBe('retired');
    expect((await rejection(made.client.record.reconcile('r1', null))).code).toBe('retired');
    made.pending.open();
    const disposal = await made.provider.handle.dispose();
    expect(disposal.drained).toBe(true);
    const detached = await rejection(made.client.record.queryResult('r1'));
    expect(['unavailable', 'closed', 'revoked']).toContain(detached.code);
  });

  test('a drained owner releases resources, can be recreated, and the old handle is closed', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    publisher(provider, fullHandlers());
    markReady(provider);
    expect(await provider.handle.dispose()).toEqual({ drained: true, active: 0 });
    expect(codeOf(() => provider.handle.markReady())).toBe('closed');
    expect(codeOf(() => publisher(provider, fullHandlers()))).toBe('closed');
    const recreated = owner(made.adapter, 'provider', PROVIDES);
    publisher(recreated, fullHandlers());
    markReady(recreated);
    expect(made.adapter.status().endpoints).toBe(1);
  });
});

describe('declaration drift at call time', () => {
  test('a consumption removed from the manifest is refused as undeclared on the next call', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    publisher(provider, fullHandlers());
    markReady(provider);
    const consumes: PluginServiceConsumption[] = [{ plugin: 'provider', id: STORE.id, version: 1, process: 'worker', kind: 'rpc' }];
    const consumer = owner(made.adapter, 'consumer', { consumes });
    markReady(consumer);
    const client = consumer.handle.consume('provider', STORE_CONTRACT);
    expect(await client.echo('x')).toBe('x');
    consumes.splice(0);
    expect((await rejection(client.echo('y'))).code).toBe('undeclared');
    expect((await rejection(client.record.queryResult('drift-1'))).code).toBe('undeclared');
    expect((await rejection(client.record.reconcile('drift-1', null))).code).toBe('undeclared');
  });
});

describe('capability registration is descriptor-safe and fail-closed', () => {
  test('a hostile capability accessor fails closed before register and leaves the owner retryable', () => {
    const made = harness();
    let published = 0;
    const provider = owner(made.adapter, 'provider', PROVIDES, { registerPublication: () => { published += 1; } });
    let reads = 0;
    const caps: Record<string, unknown> = {};
    Object.defineProperty(caps, 'add', {
      get: () => { reads += 1; return { atomic: () => ({ mutations: [], result: { count: 1 } }) }; },
      enumerable: true,
    });
    expect(codeOf(() => publisher(provider, fullHandlers(), caps))).toBe('invalid_registration');
    expect(reads).toBe(0);
    expect(made.adapter.status().endpoints).toBe(0);
    expect(published).toBe(0);
    expect(codeOf(() => publisher(provider, fullHandlers(), { add: { atomic: () => ({ mutations: [], result: { count: 1 } }) } }))).toBeNull();
    expect(made.adapter.status().endpoints).toBe(1);
    expect(published).toBe(1);
  });

  test('proxies, symbols, unknown/non-command keys, and malformed capabilities are rejected before register', () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    let reads = 0;
    const atomicGetter: Record<string, unknown> = {};
    Object.defineProperty(atomicGetter, 'atomic', {
      get: () => { reads += 1; return () => ({ mutations: [], result: { count: 1 } }); },
      enumerable: true,
    });
    expect(codeOf(() => publisher(provider, fullHandlers(), { add: atomicGetter }))).toBe('invalid_registration');
    expect(reads).toBe(0);
    expect(codeOf(() => publisher(provider, fullHandlers(), new Proxy({}, {}) as Record<string, unknown>))).toBe('invalid_registration');
    expect(codeOf(() => publisher(provider, fullHandlers(), { nope: { atomic: () => ({ mutations: [], result: { count: 1 } }) } } as never))).toBe('invalid_registration');
    expect(codeOf(() => publisher(provider, fullHandlers(), { echo: { atomic: () => ({ mutations: [], result: { count: 1 } }) } } as never))).toBe('invalid_registration');
    expect(codeOf(() => publisher(provider, fullHandlers(), { add: { atomic: 'nope' } } as never))).toBe('invalid_registration');
    expect(codeOf(() => publisher(provider, fullHandlers(), { add: { external: { reconcile: 'nope' } } } as never))).toBe('invalid_registration');
    const symbolKey: Record<string | symbol, unknown> = {};
    symbolKey[Symbol('cap')] = { atomic: () => ({ mutations: [], result: { count: 1 } }) };
    expect(codeOf(() => publisher(provider, fullHandlers(), symbolKey as never))).toBe('invalid_registration');
    expect(made.adapter.status().endpoints).toBe(0);
    expect(codeOf(() => publisher(provider, fullHandlers()))).toBeNull();
    expect(made.adapter.status().endpoints).toBe(1);
  });

  test('a published capability is a frozen snapshot that later mutation cannot change', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    const caps = { add: { atomic: () => ({ mutations: [], result: { count: 7 } }) } };
    publisher(provider, fullHandlers(), caps);
    markReady(provider);
    markReady(consumer);
    const client = consumers(consumer);
    (caps.add as { atomic: unknown }).atomic = () => { throw new Error('mutated capability'); };
    expect(await client.add({ amount: 1 }, { operationId: 'snap-1' })).toEqual({ count: 7 });
  });
});

describe('consumer contract enforcement before the provider sees the call', () => {
  test('host callback re-entry cannot mutate the validated consumer input before dispatch', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    publisher(provider, fullHandlers(), { add: { atomic: (_reader: unknown, execution: { input: { amount: number } }) => ({ mutations: [], result: { count: execution.input.amount } }) } });
    markReady(provider);
    const original = { amount: 1 };
    const consumer = owner(made.adapter, 'consumer', CONSUMES, {
      resolveInvocationContext: () => { original.amount = 9; return null; },
    });
    markReady(consumer);
    const client = consumer.handle.consume('provider', {
      id: STORE.id, version: 1,
      methods: { add: { ...STORE.methods.add, input: { type: 'object', properties: { amount: { type: 'literal', value: 1 } } } } },
    } as const);
    expect(await client.add(original as { amount: 1 }, { operationId: 'immutable-input' })).toEqual({ count: 1 });
    expect(original.amount).toBe(9);
  });

  test('a consumer literal schema rejects input the provider would accept, without running the handler', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    let calls = 0;
    publisher(provider, fullHandlers({ echo: (input: string) => { calls += 1; return input; } }));
    markReady(provider);
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    markReady(consumer);
    const contract = {
      id: STORE.id, version: 1,
      methods: { echo: { kind: 'query', input: { type: 'literal', value: 'ok' }, output: { type: 'string' }, purposes: ['background'] } },
    } as const;
    const client = consumer.handle.consume('provider', contract);
    const loose = client.echo as unknown as (input: string) => Promise<unknown>;
    expect((await rejection(loose('nope'))).code).toBe('invalid_input');
    expect(calls).toBe(0);
    expect(await client.echo('ok')).toBe('ok');
    expect(calls).toBe(1);
  });

  test('a consumer maxInputBytes bound rejects oversized input before the provider', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    let calls = 0;
    publisher(provider, fullHandlers({ echo: (input: string) => { calls += 1; return input; } }));
    markReady(provider);
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    markReady(consumer);
    const contract = {
      id: STORE.id, version: 1,
      methods: { echo: { kind: 'query', input: { type: 'string' }, output: { type: 'string' }, purposes: ['background'], maxInputBytes: 8 } },
    } as const;
    const client = consumer.handle.consume('provider', contract);
    expect((await rejection(client.echo('x'.repeat(64)))).code).toBe('invalid_input');
    expect(calls).toBe(0);
    expect(await client.echo('short')).toBe('short');
    expect(calls).toBe(1);
  });

  test('input validation never invokes a consumer input accessor', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    publisher(provider, fullHandlers(), { add: { atomic: () => ({ mutations: [], result: { count: 1 } }) } });
    markReady(provider);
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    markReady(consumer);
    const client = consumers(consumer);
    let reads = 0;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'amount', { get: () => { reads += 1; return 1; }, enumerable: true });
    expect((await rejection(client.add(hostile as never, { operationId: 'getter-1' }))).code).toBe('invalid_input');
    expect(reads).toBe(0);
  });

  test('queryResult skips business input validation but still validates the output', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    publisher(provider, fullHandlers({ record: () => null }));
    markReady(provider);
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    markReady(consumer);
    const base = consumer.handle.consume('provider', STORE_CONTRACT);
    expect(await base.record(null, { operationId: 'qr-skip' })).toBeNull();
    const typed = consumer.handle.consume('provider', {
      id: STORE.id, version: 1,
      methods: { record: { kind: 'command', input: { type: 'string' }, output: { type: 'null' }, purposes: ['background', 'management'], command: { deduplication: 'none', resultRetentionMs: null, quotaBytes: 8192, maxResultBytes: 1024 } } },
    } as const);
    expect(await typed.record.queryResult('qr-skip')).toBeNull();
  });
});

describe('kernel-bound callee identity', () => {
  test('the callee publication uses the real endpoint process, not the adapter process', async () => {
    const seen: Array<Record<string, unknown>> = [];
    let remoteEndpoint: RpcEndpointHandle = Object.freeze({});
    const made = harness({
      resolvePlacement: () => ({ kind: 'endpoint', endpoint: remoteEndpoint }),
      resolveCallee: (_request, publication) => { seen.push(publication as Record<string, unknown>); return null; },
    });
    remoteEndpoint = made.adapter.runtime.register({
      provider: 'control-provider',
      binding: { endpoint: 'control.remote', process: 'control', instance: 'ci', generation: 1, catalog: 'cc', scope: 'global', subject: 'control' },
      contract: { id: 'remote.v1', version: 1, methods: { lookup: { kind: 'query', input: { type: 'null' }, output: { type: 'string' }, purposes: ['background'] } } },
      handler: { lookup: () => 'remote' },
    });
    made.adapter.runtime.markReady(remoteEndpoint);
    const consumer = owner(made.adapter, 'consumer', { consumes: [{ plugin: 'control-provider', id: 'remote.v1', version: 1, process: 'worker', kind: 'rpc' }] });
    markReady(consumer);
    const client = consumer.handle.consume('control-provider', {
      id: 'remote.v1', version: 1, methods: { lookup: { kind: 'query', input: { type: 'null' }, output: { type: 'string' }, purposes: ['background'] } },
    });
    expect(await client.lookup(null)).toBe('remote');
    expect(seen[0]).toMatchObject({ provider: 'control-provider', service: 'remote.v1', major: 1, kind: 'rpc', process: 'control', scope: 'global' });
  });

  test('a placed endpoint whose kernel identity disagrees with the requested target is refused', async () => {
    let remoteEndpoint: RpcEndpointHandle = Object.freeze({});
    const made = harness({ resolvePlacement: () => ({ kind: 'endpoint', endpoint: remoteEndpoint }) });
    remoteEndpoint = made.adapter.runtime.register({
      provider: 'other-provider',
      binding: { endpoint: 'other.remote', process: 'worker', instance: 'oi', generation: 1, catalog: 'oc', scope: 'global', subject: 'other' },
      contract: { id: 'remote.v1', version: 1, methods: { lookup: { kind: 'query', input: { type: 'null' }, output: { type: 'string' }, purposes: ['background'] } } },
      handler: { lookup: () => 'other' },
    });
    made.adapter.runtime.markReady(remoteEndpoint);
    const consumer = owner(made.adapter, 'consumer', { consumes: [{ plugin: 'control-provider', id: 'remote.v1', version: 1, process: 'worker', kind: 'rpc' }] });
    markReady(consumer);
    const client = consumer.handle.consume('control-provider', {
      id: 'remote.v1', version: 1, methods: { lookup: { kind: 'query', input: { type: 'null' }, output: { type: 'string' }, purposes: ['background'] } },
    });
    expect((await rejection(client.lookup(null))).code).toBe('unauthorized');
  });

  test('an unregistered placement handle is refused', async () => {
    const made = harness({ resolvePlacement: () => ({ kind: 'endpoint', endpoint: Object.freeze({}) }) });
    const consumer = owner(made.adapter, 'consumer', { consumes: [{ plugin: 'control-provider', id: 'remote.v1', version: 1, process: 'worker', kind: 'rpc' }] });
    markReady(consumer);
    const client = consumer.handle.consume('control-provider', {
      id: 'remote.v1', version: 1, methods: { lookup: { kind: 'query', input: { type: 'null' }, output: { type: 'string' }, purposes: ['background'] } },
    });
    expect((await rejection(client.lookup(null))).code).toBe('unauthorized');
  });
});

describe('command frames, external reconciliation, and disposal', () => {
  test('the host invocation frame is resolved exactly once per call', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    publisher(provider, fullHandlers());
    markReady(provider);
    let resolutions = 0;
    const gateway = owner(made.adapter, 'gateway', CONSUMES, {
      resolveInvocationContext: () => { resolutions += 1; return { purpose: 'management', token: {} }; },
    });
    markReady(gateway);
    expect(await consumers(gateway).echo('x')).toBe('x');
    expect(resolutions).toBe(1);
  });

  test('an external reconcile runs inside the command frame and nested calls inherit the deadline', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    let nested: AsyncRpcClient<StoreMethods> | null = null;
    let reconcileDeadline = Infinity;
    let childDeadline = Infinity;
    publisher(provider, fullHandlers({
      ext: () => { throw new Error('unknown outcome'); },
      inner: (_input: unknown, context: { deadlineAt: number }) => { childDeadline = context.deadlineAt; return null; },
    }), {
      ext: { external: {
        reconcile: async (execution: { context: { deadlineAt?: number } }) => {
          reconcileDeadline = execution.context.deadlineAt ?? Infinity;
          await nested!.inner(null, { timeoutMs: 5_000 });
          return { status: 'committed' as const, result: { n: 1 } };
        },
      } },
    });
    const client = consumers(consumer);
    nested = client;
    markReady(provider);
    markReady(consumer);
    expect((await rejection(client.ext(null, { operationId: 'ext-1' }))).code).toBe('unknown');
    expect(await client.ext.reconcile('ext-1', null)).toEqual({ n: 1 });
    expect(Number.isFinite(reconcileDeadline)).toBe(true);
    expect(childDeadline).toBeLessThanOrEqual(reconcileDeadline);
  });

  test('a nested call issued from an external reconcile aborts when the parent call is cancelled', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    let nested: AsyncRpcClient<StoreMethods> | null = null;
    let childStarted = false;
    let childAborted = false;
    const gateNested = gate();
    publisher(provider, fullHandlers({
      ext: () => { throw new Error('unknown outcome'); },
      slowInner: (_input: unknown, context: { signal: AbortSignal }) => {
        childStarted = true;
        context.signal.addEventListener('abort', () => { childAborted = true; }, { once: true });
        return gateNested.promise.then(() => null);
      },
      outer: async () => {
        try { await nested!.ext(null, { operationId: 'ext-2' }); } catch { /* expected unknown */ }
        try { await nested!.ext.reconcile('ext-2', null); return { code: 'ok' }; }
        catch (error) { return { code: error instanceof RpcServiceError ? error.code : 'unknown' }; }
      },
    }), {
      ext: { external: {
        reconcile: async () => {
          await nested!.slowInner(null, { timeoutMs: 30_000 });
          return { status: 'unknown' as const };
        },
      } },
    });
    const client = consumers(consumer);
    nested = client;
    markReady(provider);
    markReady(consumer);
    const controller = new AbortController();
    const outerCall = client.outer(null, { signal: controller.signal });
    await waitFor(() => childStarted);
    expect(childStarted).toBe(true);
    controller.abort();
    expect((await rejection(outerCall)).code).toBe('cancelled');
    await waitFor(() => childAborted);
    expect(childAborted).toBe(true);
    gateNested.open();
    await idle();
  });

  test('a command handler cannot re-enter its own method but may call a different one', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    let nested: AsyncRpcClient<StoreMethods> | null = null;
    let reentry: string | null = null;
    let sibling: string | null = null;
    publisher(provider, fullHandlers({
      record: async () => {
        try { await nested!.record(null, { operationId: 'inner' }); reentry = 'allowed'; }
        catch (error) { reentry = error instanceof RpcServiceError ? error.code : 'other'; }
        try { sibling = await nested!.echo('x'); }
        catch (error) { sibling = error instanceof RpcServiceError ? error.code : 'other'; }
        return null;
      },
    }));
    const client = consumers(consumer);
    nested = client;
    markReady(provider);
    markReady(consumer);
    expect(await client.record(null, { operationId: 'outer' })).toBeNull();
    expect<string | null>(reentry).toBe('deadlock');
    expect<string | null>(sibling).toBe('x');
  });

  test('a non-publishing consumer releases only after its real call settles and can be recreated', async () => {
    const made = harness();
    const provider = owner(made.adapter, 'provider', PROVIDES);
    const pending = gate();
    publisher(provider, fullHandlers({ slow: () => pending.promise.then(() => null) }));
    markReady(provider);
    const consumer = owner(made.adapter, 'consumer', CONSUMES);
    markReady(consumer);
    const call = consumers(consumer).slow(null);
    await idle();
    expect(consumer.state.leases).toBe(1);
    const disposal = consumer.handle.dispose();
    expect((await rejection(call)).code).toBe('revoked');
    let settled = false;
    void disposal.then(() => { settled = true; });
    await idle();
    expect(consumer.state.leases).toBe(1);
    expect(settled).toBe(false);
    pending.open();
    expect(await disposal).toEqual({ drained: true, active: 0 });
    expect(consumer.state.leases).toBe(0);
    const recreated = owner(made.adapter, 'consumer', CONSUMES);
    markReady(recreated);
    expect(codeOf(() => consumers(recreated))).toBeNull();
  });
});

describe('application-owned command transaction', () => {
  test('none without a journal retains real work on cancellation and offers no journal replay API', async () => {
    const {adapter,db}=harness({resolveJournal:()=>null,limits:{drainTimeoutMs:10}});
    const provider=owner(adapter,'provider',{provides:[{id:STORE.id,version:1,process:'worker',kind:'rpc'}]});
    const consumer=owner(adapter,'consumer',{consumes:[{plugin:'provider',id:STORE.id,version:1,process:'worker',kind:'rpc'}]});
    let release!:()=>void,entered=false;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    publisher(provider,fullHandlers({record:async()=>{entered=true;await gate;return null;}}));markReady(provider);markReady(consumer);
    const client=consumer.handle.consume('provider',STORE_CONTRACT);
    const abort=new AbortController();
    const call=client.record(null,{operationId:'own-ledger',signal:abort.signal});
    await waitFor(()=>entered);abort.abort();
    expect(['cancelled','unknown']).toContain((await rejection(call)).code);
    expect(provider.state.leases).toBe(1);expect(consumer.state.leases).toBe(1);
    const result=await provider.handle.dispose();expect(result.drained).toBe(false);
    release();await idle();expect(provider.state.leases).toBe(0);expect(consumer.state.leases).toBe(0);
    // No result journal is manufactured for application-owned idempotency.
    expect(db.query("SELECT count(*) AS n FROM sqlite_master WHERE name = 'plugin_communication_records'").get()).toEqual({n:0});
    const provider2=owner(adapter,'provider2',{provides:[{id:STORE.id,version:1,process:'worker',kind:'rpc'}]});
    const consumer2=owner(adapter,'consumer2',{consumes:[{plugin:'provider2',id:STORE.id,version:1,process:'worker',kind:'rpc'}]});
    publisher(provider2,fullHandlers());markReady(provider2);markReady(consumer2);
    const independent=consumer2.handle.consume('provider2',STORE_CONTRACT);
    expect((await rejection(independent.record.queryResult('own-ledger'))).code).toBe('capability_unavailable');
    expect((await rejection(independent.record.reconcile('own-ledger',null))).code).toBe('capability_unavailable');
  });
});

describe('Host RPC production storage outcome and cleanup separation',()=>{
  test('real Worker commit with lost ACK remains unknown through Host RPC cleanup and replay does not replan',async()=>{
    const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
    const {PluginStateClient}=await import('../../../src/plugin-state/client');
    const {createPluginPeerJournalResolver}=await import('../../../src/plugin-services/peer-journal');
    const dir=mkdtempSync(join(tmpdir(),'host-rpc-production-crash-')),file=join(dir,'lost-ack.db');
    const resourceFailures:string[]=[];const cleanupFailures:{operationId:string;code:string}[]=[];const cleanup=gate();
    let storage=await PluginStateClient.open(file,{initialize:true,workerUrl:new URL('../../fixtures/plugin-state-fault-worker.ts',import.meta.url),
      onWorkerFailure:error=>{resourceFailures.push(error.code);}});
    let resolver=createPluginPeerJournalResolver({client:storage});
    let plans=0,business=0;
    const configure=()=>{
      const adapter=new HostRpcAdapter({process:'worker',resolvePlacement:()=>null,resolveCallee:()=>null,resolveJournal:resolver.resolve,
        onJournalCleanupFailure:failure=>{cleanupFailures.push(failure);cleanup.open();}});
      const provider=owner(adapter,'provider',PROVIDES),consumer=owner(adapter,'consumer',CONSUMES);
      publisher(provider,fullHandlers({add:()=>{business++;return {count:999};}}),{add:{atomicReadSet:()=>({keys:['count']}),atomic:(reader:any)=>{
        plans++;const old=reader.get('count');const count=(old?.value?.count??0)+1;
        return {mutations:[{key:'count',expectedVersion:old?.version??0,value:{count}}],result:{count}};
      }}});
      markReady(provider);markReady(consumer);return {adapter,client:consumers(consumer)};
    };
    let configured=configure();
    try{
      const error=await rejection(configured.client.add({amount:1},{operationId:'host-original-lost-ack'}));
      expect(error).toMatchObject({code:'unknown',operationId:'host-original-lost-ack'});
      await cleanup.promise;
      expect(cleanupFailures).toEqual([{code:'worker_failed',operationId:'host-original-lost-ack'}]);
      expect(resourceFailures).toEqual(['worker_failed']);expect([plans,business]).toEqual([1,0]);
      await configured.adapter.dispose();await resolver.close();await storage.close().catch(()=>undefined);
      storage=await PluginStateClient.open(file);resolver=createPluginPeerJournalResolver({client:storage});configured=configure();
      expect(await configured.client.add.queryResult('host-original-lost-ack')).toEqual({count:1});
      expect(await configured.client.add({amount:1},{operationId:'host-original-lost-ack'})).toEqual({count:1});
      expect([plans,business]).toEqual([1,0]);
      expect((await storage.durableState('provider').get('count'))?.version).toBe(1);
    }finally{await configured.adapter.dispose();await resolver.close();await storage.close().catch(()=>undefined);rmSync(dir,{recursive:true,force:true});}
  });
  test('an acknowledged command returns before silent cleanup expires, and resource failure is reported separately',async()=>{
    const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
    const {PluginStateClient}=await import('../../../src/plugin-state/client');
    const {createPluginPeerJournalResolver}=await import('../../../src/plugin-services/peer-journal');
    const dir=mkdtempSync(join(tmpdir(),'host-rpc-cleanup-timeout-')),file=join(dir,'silent-release.db');
    const resourceFailures:string[]=[];const cleanupFailures:{operationId:string;code:string}[]=[];const cleanup=gate();
    const storage=await PluginStateClient.open(file,{initialize:true,requestTimeoutMs:400,
      workerUrl:new URL('../../fixtures/plugin-state-fault-worker.ts',import.meta.url),onWorkerFailure:error=>{resourceFailures.push(error.code);}});
    const resolver=createPluginPeerJournalResolver({client:storage});
    const adapter=new HostRpcAdapter({process:'worker',limits:{hardDeadlineMs:150},resolvePlacement:()=>null,resolveCallee:()=>null,
      resolveJournal:resolver.resolve,onJournalCleanupFailure:failure=>{cleanupFailures.push(failure);cleanup.open();throw Error('reporter must not overwrite');}});
    const provider=owner(adapter,'provider',PROVIDES),consumer=owner(adapter,'consumer',CONSUMES);
    publisher(provider,fullHandlers(),{add:{atomicReadSet:()=>({keys:[]}),atomic:()=>({mutations:[],result:{count:7}})}});
    markReady(provider);markReady(consumer);
    try{
      expect(await consumers(consumer).add({amount:1},{operationId:'acknowledged-before-cleanup'})).toEqual({count:7});
      expect(cleanupFailures).toEqual([]);await cleanup.promise;
      expect(cleanupFailures).toEqual([{code:'request_timeout',operationId:'acknowledged-before-cleanup'}]);
      expect(resourceFailures).toEqual(['request_timeout']);
      await expect(storage.close()).rejects.toMatchObject({code:'request_timeout'});
    }finally{await adapter.dispose();await resolver.close();await storage.close().catch(()=>undefined);rmSync(dir,{recursive:true,force:true});}
  });
});
