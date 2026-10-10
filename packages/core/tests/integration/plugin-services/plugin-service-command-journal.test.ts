import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CommandJournal,
  CommandJournalError,
  type CommandAtomicPlanner,
  type CommandAtomicReader,
  type CommandAtomicResolver,
  type CommandExternalExecutor,
  type CommandExternalReconciliation,
  type CommandJournalOptions,
} from '../../../src/plugin-services/command-journal';
import { PluginCommunicationStore, type PluginCommunicationLimits } from '../../../src/plugin-services/persistence';
import type { RpcCommandExecution } from '../../../src/plugin-services/rpc-runtime';
import type { RpcCommandDeduplication, RpcDataSchema, RpcJson } from '../../../src/plugin-services/wire-contract';

const WIDE: PluginCommunicationLimits = {
  globalBudgetBytes: 1_048_576,
  globalRequiredReserveBytes: 262_144,
  globalMaxRows: 8192,
  globalRequiredRowReserve: 2048,
  namespaceQuotaBytes: 524_288,
  requiredReserveBytes: 131_072,
  maxRecordsPerNamespace: 2048,
  requiredRowReserve: 512,
  maxRecordBytes: 262_144,
  entryOverheadBytes: 64,
};

const NARROW: PluginCommunicationLimits = {
  globalBudgetBytes: 131_072,
  globalRequiredReserveBytes: 32_768,
  globalMaxRows: 512,
  globalRequiredRowReserve: 128,
  namespaceQuotaBytes: 32_768,
  requiredReserveBytes: 8_192,
  maxRecordsPerNamespace: 64,
  requiredRowReserve: 16,
  maxRecordBytes: 8_192,
  entryOverheadBytes: 64,
};

const TIGHT: PluginCommunicationLimits = {
  globalBudgetBytes: 65_536,
  globalRequiredReserveBytes: 8_192,
  globalMaxRows: 512,
  globalRequiredRowReserve: 64,
  namespaceQuotaBytes: 16_384,
  requiredReserveBytes: 4_096,
  maxRecordsPerNamespace: 128,
  requiredRowReserve: 16,
  maxRecordBytes: 8_192,
  entryOverheadBytes: 64,
};

const databases: Database[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    try { db.close(); } catch { /* a test may have closed it already */ }
  }
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function memory(): Database {
  const db = new Database(':memory:');
  databases.push(db);
  return db;
}

function fileDatabase(): { db: Database; file: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'command-journal-'));
  directories.push(directory);
  const file = path.join(directory, 'journal.db');
  const db = new Database(file, { create: true, readwrite: true });
  databases.push(db);
  return { db, file };
}

function reopen(file: string): Database {
  const db = new Database(file, { create: true, readwrite: true });
  databases.push(db);
  return db;
}

function journal(db: Database, overrides: Partial<CommandJournalOptions> = {}): CommandJournal {
  return new CommandJournal({
    db,
    namespace: 'svc.journal',
    privateStateNamespace: 'svc.private',
    setup: true,
    limits: WIDE,
    ...overrides,
  });
}

function journalOn(db: Database, overrides: Partial<CommandJournalOptions> = {}): CommandJournal {
  return new CommandJournal({
    db,
    namespace: 'svc.journal',
    privateStateNamespace: 'svc.private',
    setup: false,
    limits: WIDE,
    ...overrides,
  });
}

function seedRecord(db: Database, namespace: string, key: string, version: number, value: unknown): void {
  db.run(
    'INSERT OR REPLACE INTO plugin_durable_records(namespace,key,version,value_json) VALUES (?,?,?,?)',
    [namespace, key, version, JSON.stringify(value)],
  );
}

/** Counts only statements that read the private durable-records table. */
function countingDatabase(db: Database): { db: Database; durableQueries: () => number } {
  let durableQueries = 0;
  const proxy = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (property === 'query' && typeof args[0] === 'string' && args[0].includes('plugin_durable_records')) {
          durableQueries += 1;
        }
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { db: proxy as Database, durableQueries: () => durableQueries };
}

interface ExecutionOptions {
  readonly operationId: string;
  readonly subject?: string;
  readonly scope?: 'global' | 'binding';
  readonly input?: RpcJson;
  readonly output?: RpcDataSchema;
  readonly deduplication?: RpcCommandDeduplication;
  readonly resultRetentionMs?: number | null;
  readonly maxResultBytes?: number;
  readonly quotaBytes?: number;
  readonly generation?: number;
  readonly version?: number;
  readonly serviceId?: string;
  readonly instance?: string;
  readonly catalog?: string;
  readonly business?: () => Promise<RpcJson>;
}

function execution(options: ExecutionOptions): RpcCommandExecution<unknown> {
  const subject = options.subject ?? 'caller-a';
  const scope = options.scope;
  const definition = {
    kind: 'command',
    input: { type: 'json' },
    output: options.output ?? { type: 'json' },
    purposes: ['management'],
    command: {
      deduplication: options.deduplication ?? 'local-transaction',
      resultRetentionMs: options.resultRetentionMs === undefined ? null : options.resultRetentionMs,
      quotaBytes: options.quotaBytes ?? 8192,
      maxResultBytes: options.maxResultBytes ?? 1024,
    },
  };
  const context = {
    endpoint: {
      endpoint: 'svc.endpoint', process: 'worker', instance: options.instance ?? 'instance-1',
      generation: options.generation ?? 1, catalog: options.catalog ?? 'catalog-1', scope: 'global',
      subject: 'callee', service: options.serviceId ?? 'svc', version: options.version ?? 1,
    },
    caller: scope === undefined ? { subject } : { subject, scope },
    method: 'run',
    kind: 'command',
    purpose: 'management',
    operationId: options.operationId,
    signal: new AbortController().signal,
    callee: null,
  };
  const built = {
    contract: { id: options.serviceId ?? 'svc', version: options.version ?? 1, methods: {} },
    method: 'run',
    definition,
    context,
    operationId: options.operationId,
    input: options.input ?? { id: options.operationId },
    executeBusiness: options.business ?? (async () => ({ ok: true })),
  };
  return built as unknown as RpcCommandExecution<unknown>;
}

function codeOfSync(run: () => unknown): string | undefined {
  try { run(); } catch (error) { return error instanceof CommandJournalError ? error.code : undefined; }
  return undefined;
}

async function codeOf(run: () => unknown): Promise<string | undefined> {
  try { await run(); } catch (error) { return error instanceof CommandJournalError ? error.code : undefined; }
  return undefined;
}

async function errorOf(run: () => unknown): Promise<unknown> {
  try { await run(); } catch (error) { return error; }
  return undefined;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function markerCount(db: Database): number {
  const row = db.query<{ n: number }, [string, string]>(
    'SELECT COUNT(*) AS n FROM plugin_communication_records WHERE namespace = ? AND key = ?',
  ).get('svc.journal', 'journal-policy-binding');
  return row?.n ?? 0;
}

describe('CommandJournal', () => {
  test('atomic resolvers and planners receive invocation data without the business capability', async () => {
    const db = memory();
    let effects = 0;
    let plans = 0;
    const j = journal(db, {
      resolveAtomic: request => {
        expect(Object.hasOwn(request, 'executeBusiness')).toBe(false);
        return (_reader, invocation) => {
          plans += 1;
          expect(Object.isFrozen(invocation)).toBe(true);
          expect(Reflect.ownKeys(invocation).sort()).toEqual(['context', 'contract', 'definition', 'input', 'method', 'operationId']);
          expect(invocation.input).toEqual({ amount: 3 });
          const leaked = (invocation as RpcCommandExecution<unknown>).executeBusiness;
          if (typeof leaked === 'function') void leaked();
          return { mutations: [], result: 'invalid' };
        };
      },
    });
    const request = execution({
      operationId: 'planner-isolation', input: { amount: 3 }, output: { type: 'number' },
      business: async () => { effects += 1; return 0; },
    });
    for (let index = 0; index < 2; index += 1) {
      expect(await codeOf(() => j.execute(request))).toBe('invalid_output');
      expect(effects).toBe(0);
      expect(j.inspect('planner-isolation', { subject: 'caller-a' }).status).toBe('missing');
    }
    expect(plans).toBe(2);
  });

  test('commits a local transaction atomically and deduplicates on the stable key', async () => {
    const db = memory();
    let plans = 0;
    const j = journal(db, {
      resolveAtomic: () => (reader) => {
        plans += 1;
        expect(reader.get('counter')).toBeNull();
        return { mutations: [{ key: 'counter', expectedVersion: 0, value: { total: 7 } }], result: { ok: true } };
      },
    });

    expect(await j.execute(execution({ operationId: 'op-1' }))).toEqual({ ok: true });
    expect(plans).toBe(1);
    const row = db.query<{ version: number; value_json: string }, [string, string]>(
      'SELECT version,value_json FROM plugin_durable_records WHERE namespace = ? AND key = ?',
    ).get('svc.private', 'counter');
    expect(row?.version).toBe(1);
    expect(JSON.parse(row?.value_json ?? 'null')).toEqual({ total: 7 });

    expect(await j.execute(execution({ operationId: 'op-1' }))).toEqual({ ok: true });
    expect(plans).toBe(1);
    expect(j.inspect('op-1', { subject: 'caller-a' }).status).toBe('committed');
    expect(j.query('op-1', { subject: 'caller-a' })).toEqual({ ok: true });
    expect(j.status().reservedBytes).toBe(0);
  });

  test('accepts an empty-mutation plan as a pure result command', async () => {
    const db = memory();
    const j = journal(db, { resolveAtomic: () => () => ({ mutations: [], result: { ok: true } }) });
    expect(await j.execute(execution({ operationId: 'empty' }))).toEqual({ ok: true });
    expect(j.inspect('empty', { subject: 'caller-a' }).status).toBe('committed');
  });

  test('survives a restart without duplicating effects or re-running the planner', async () => {
    const { db, file } = fileDatabase();
    let plans = 0;
    const first = journal(db, {
      resolveAtomic: () => () => {
        plans += 1;
        return { mutations: [{ key: 'counter', expectedVersion: 0, value: 1 }], result: { n: 1 } };
      },
    });
    await first.execute(execution({ operationId: 'op-restart' }));
    expect(plans).toBe(1);
    db.close();

    const reopened = reopen(file);
    let after = 0;
    const second = journalOn(reopened, {
      resolveAtomic: () => () => {
        after += 1;
        return { mutations: [], result: { n: 2 } };
      },
    });
    expect(await second.execute(execution({ operationId: 'op-restart' }))).toEqual({ n: 1 });
    expect(after).toBe(0);
    const row = reopened.query<{ version: number }, [string, string]>(
      'SELECT version FROM plugin_durable_records WHERE namespace = ? AND key = ?',
    ).get('svc.private', 'counter');
    expect(row?.version).toBe(1);
  });

  test('isolates the same operation id across callers and scopes', async () => {
    const db = memory();
    let plans = 0;
    const j = journal(db, { resolveAtomic: () => () => { plans += 1; return { mutations: [], result: { ok: true } }; } });
    await j.execute(execution({ operationId: 'shared', subject: 'alice' }));
    await j.execute(execution({ operationId: 'shared', subject: 'bob' }));
    await j.execute(execution({ operationId: 'shared', subject: 'alice', scope: 'binding' }));
    expect(plans).toBe(3);
    expect(j.inspect('shared', { subject: 'alice' }).status).toBe('committed');
    expect(j.inspect('shared', { subject: 'bob' }).status).toBe('committed');
    expect(j.inspect('shared', { subject: 'alice', scope: 'binding' }).status).toBe('committed');
    expect(j.inspect('shared', { subject: 'carol' }).status).toBe('missing');
  });

  test('never includes the runtime generation in the deduplication key', async () => {
    const db = memory();
    let plans = 0;
    const j = journal(db, { resolveAtomic: () => () => { plans += 1; return { mutations: [], result: { ok: true } }; } });
    await j.execute(execution({ operationId: 'gen', generation: 1 }));
    await j.execute(execution({ operationId: 'gen', generation: 99 }));
    expect(plans).toBe(1);
  });

  test('canonicalizes object key order but rejects a changed array order', async () => {
    const db = memory();
    let plans = 0;
    const j = journal(db, { resolveAtomic: () => () => { plans += 1; return { mutations: [], result: { ok: true } }; } });
    await j.execute(execution({ operationId: 'fp', input: { a: 1, b: { x: 1, y: 2 } } }));
    expect(await j.execute(execution({ operationId: 'fp', input: { b: { y: 2, x: 1 }, a: 1 } }))).toEqual({ ok: true });
    expect(plans).toBe(1);
    expect(await codeOf(() => j.execute(execution({ operationId: 'fp', input: { a: 1, b: [1, 2] } })))).toBe('conflict');
    expect(plans).toBe(1);

    await j.execute(execution({ operationId: 'fp-array', input: { list: [1, 2] } }));
    expect(await codeOf(() => j.execute(execution({ operationId: 'fp-array', input: { list: [2, 1] } })))).toBe('conflict');
    expect(plans).toBe(2);
  });

  test('rejects a tampered contract major as a conflict', async () => {
    const db = memory();
    const j = journal(db, { resolveAtomic: () => () => ({ mutations: [], result: { ok: true } }) });
    await j.execute(execution({ operationId: 'major', version: 1 }));
    expect(await codeOf(() => j.execute(execution({ operationId: 'major', version: 2 })))).toBe('conflict');
  });

  test('rolls back durable CAS conflicts together with the journal terminal record', async () => {
    const db = memory();
    const j = journal(db, {
      resolveAtomic: () => () => ({
        mutations: [{ key: 'counter', expectedVersion: 0, value: { total: 2 } }],
        result: null,
      }),
    });
    seedRecord(db, 'svc.private', 'counter', 1, { total: 1 });

    expect(await codeOf(() => j.execute(execution({ operationId: 'cas', output: { type: 'null' } })))).toBe('conflict');
    const row = db.query<{ version: number; value_json: string }, [string, string]>(
      'SELECT version,value_json FROM plugin_durable_records WHERE namespace = ? AND key = ?',
    ).get('svc.private', 'counter');
    expect(row?.version).toBe(1);
    expect(JSON.parse(row?.value_json ?? 'null')).toEqual({ total: 1 });
    expect(j.inspect('cas', { subject: 'caller-a' }).status).toBe('rejected');
  });

  test('rejects an invalid planner result before any SQL mutation', async () => {
    const db = memory();
    const j = journal(db, {
      resolveAtomic: () => () => ({
        mutations: [{ key: 'counter', expectedVersion: 0, value: 1 }],
        result: { wrong: true },
      }),
    });
    expect(await codeOf(() => j.execute(execution({ operationId: 'schema', output: { type: 'string' } })))).toBe('invalid_output');
    const row = db.query<{ version: number }, [string, string]>(
      'SELECT version FROM plugin_durable_records WHERE namespace = ? AND key = ?',
    ).get('svc.private', 'counter');
    expect(row).toBeNull();
    expect(j.inspect('schema', { subject: 'caller-a' }).status).toBe('missing');
  });

  test('rejects non pure-JSON plan values as invalid input before effects', async () => {
    const db = memory();
    const planner = (() => ({
      mutations: [{ key: 'counter', expectedVersion: 0, value: undefined }],
      result: null,
    })) as unknown as CommandAtomicPlanner;
    const j = journal(db, { resolveAtomic: () => planner });
    expect(await codeOf(() => j.execute(execution({ operationId: 'undef' })))).toBe('invalid_input');
    const row = db.query<{ version: number }, [string, string]>(
      'SELECT version FROM plugin_durable_records WHERE namespace = ? AND key = ?',
    ).get('svc.private', 'counter');
    expect(row).toBeNull();
    expect(j.inspect('undef', { subject: 'caller-a' }).status).toBe('missing');
  });

  test('rejects accessor and class-instance plan values as invalid input', async () => {
    const db = memory();
    const withGetter = {
      mutations: [{ key: 'counter', expectedVersion: 0, value: 1 }],
      result: null,
      get hidden() { return 1; },
    };
    const j1 = journal(db, { resolveAtomic: () => ((() => withGetter) as unknown as CommandAtomicPlanner) });
    expect(await codeOf(() => j1.execute(execution({ operationId: 'getter' })))).toBe('invalid_input');
    expect(j1.inspect('getter', { subject: 'caller-a' }).status).toBe('missing');

    const db2 = memory();
    const withDate = { mutations: [], result: new Date(0) };
    const j2 = journal(db2, { resolveAtomic: () => ((() => withDate) as unknown as CommandAtomicPlanner) });
    expect(await codeOf(() => j2.execute(execution({ operationId: 'date' })))).toBe('invalid_input');
  });

  test('refuses a thenable planner and a thenable plan before side effects', async () => {
    const db = memory();
    const thenableResolver: CommandAtomicResolver = () =>
      (() => ({ then: () => undefined })) as unknown as CommandAtomicPlanner;
    const j1 = journal(db, { resolveAtomic: thenableResolver });
    expect(await codeOf(() => j1.execute(execution({ operationId: 'thenable-plan' })))).toBe('capability_unavailable');
    expect(j1.inspect('thenable-plan', { subject: 'caller-a' }).status).toBe('missing');

    const db2 = memory();
    const asyncResolver = (() => Promise.resolve(() => ({ mutations: [], result: null }))) as unknown as CommandAtomicResolver;
    const j2 = journal(db2, { resolveAtomic: asyncResolver });
    expect(await codeOf(() => j2.execute(execution({ operationId: 'thenable-resolver' })))).toBe('capability_unavailable');
  });

  test('bounds and revokes the atomic read capability after the transaction', async () => {
    const db = memory();
    let captured: CommandAtomicReader | null = null;
    const j = journal(db, {
      atomicReadRows: 2,
      resolveAtomic: () => (reader: CommandAtomicReader) => {
        expect(reader.list()).toHaveLength(2);
        captured = reader;
        return { mutations: [], result: 'ok' };
      },
    });
    for (const key of ['a', 'b']) seedRecord(db, 'svc.private', key, 1, key);
    expect(await j.execute(execution({ operationId: 'reader', output: { type: 'string' } }))).toBe('ok');
    expect(captured).not.toBeNull();
    expect(codeOfSync(() => (captured as unknown as CommandAtomicReader).get('a'))).toBe('capability_unavailable');
    seedRecord(db,'svc.private','c',1,'c');
    expect(await codeOf(()=>j.execute(execution({operationId:'overflow-list',output:{type:'string'}})))).toBe('capability_unavailable');
    expect(j.inspect('overflow-list',{subject:'caller-a'}).status).toBe('missing');
  });

  test('rejects a reader list on the byte budget before fetching or parsing any body', async () => {
    const db = memory();
    const j = journal(db, {
      atomicReadRows: 8,
      atomicReadBytes: 512,
      resolveAtomic: () => (reader: CommandAtomicReader) => {
        reader.list();
        return { mutations: [], result: null };
      },
    });
    db.run(
      'INSERT INTO plugin_durable_records(namespace,key,version,value_json) VALUES (?,?,?,?)',
      ['svc.private', 'big', 1, 'x'.repeat(4096)],
    );
    expect(await codeOf(() => j.execute(execution({ operationId: 'big-list', output: { type: 'null' } })))).toBe('capability_unavailable');
  });

  test('bounds atomic reader SQL queries before issuing them, even when the planner swallows errors', async () => {
    const real = memory();
    const { db, durableQueries } = countingDatabase(real);
    const j = journal(db, {
      atomicReadRows: 1000,
      atomicReadQueries: 3,
      resolveAtomic: () => (reader: CommandAtomicReader) => {
        for (let index = 0; index < 1000; index += 1) {
          try { reader.get(`k${index}`); } catch { /* budget exhausted; never re-queries */ }
        }
        return { mutations: [], result: { ok: true } };
      },
    });
    expect(await j.execute(execution({ operationId: 'spy' }))).toEqual({ ok: true });
    expect(durableQueries()).toBe(3);
    expect(j.inspect('spy', { subject: 'caller-a' }).status).toBe('committed');
  });

  test('returns deep-frozen reader copies', async () => {
    const db = memory();
    let frozen = false;
    const j = journal(db, {
      resolveAtomic: () => (reader: CommandAtomicReader) => {
        const record = reader.get('nested');
        if (record === null) throw new Error('missing');
        const value = record.value as { inner: object };
        frozen = Object.isFrozen(record) && Object.isFrozen(record.value) && Object.isFrozen(value.inner);
        return { mutations: [], result: null };
      },
    });
    seedRecord(db, 'svc.private', 'nested', 1, { inner: { deep: true } });
    await j.execute(execution({ operationId: 'frozen', output: { type: 'null' } }));
    expect(frozen).toBe(true);
  });

  test('maps a reader SQL failure to storage_failure', async () => {
    const db = memory();
    const j = journal(db, {
      resolveAtomic: () => (reader: CommandAtomicReader) => {
        db.run('DROP TABLE plugin_durable_records');
        reader.get('a');
        return { mutations: [], result: null };
      },
    });
    expect(await codeOf(() => j.execute(execution({ operationId: 'read-fail', output: { type: 'null' } })))).toBe('storage_failure');
  });

  test('rejects before effects when the required capability is missing', async () => {
    const db = memory();
    let business = 0;
    const j = journal(db);
    expect(await codeOf(() => j.execute(execution({ operationId: 'no-atomic', business: async () => { business += 1; return null; } })))).toBe('capability_unavailable');
    expect(business).toBe(0);
    expect(j.inspect('no-atomic', { subject: 'caller-a' }).status).toBe('missing');

    expect(await codeOf(() => j.execute(execution({
      operationId: 'no-external',
      deduplication: 'external-contract',
      business: async () => { business += 1; return null; },
    })))).toBe('capability_unavailable');
    expect(business).toBe(0);
    expect(j.inspect('no-external', { subject: 'caller-a' }).status).toBe('missing');
  });

  test('keeps a lost external response unknown with its reservation and never re-executes it', async () => {
    const db = memory();
    let business = 0;
    const j = journal(db, { resolveExternal: () => ({ reconcile: async () => ({ status: 'unknown' }) }) });
    expect(await codeOf(() => j.execute(execution({
      operationId: 'ext',
      deduplication: 'external-contract',
      business: async () => { business += 1; throw new Error('socket reset'); },
    })))).toBe('unknown');
    expect(business).toBe(1);
    expect(j.inspect('ext', { subject: 'caller-a' }).status).toBe('unknown');
    expect(j.status().reservedBytes).toBeGreaterThan(0);

    expect(await codeOf(() => j.execute(execution({
      operationId: 'ext',
      deduplication: 'external-contract',
      business: async () => { business += 1; return { ok: true }; },
    })))).toBe('unknown');
    expect(business).toBe(1);
  });

  test('reconciles unknown through a trusted confirmation and reuses the reservation', async () => {
    const db = memory();
    let business = 0;
    let outcome: CommandExternalReconciliation = { status: 'unknown' };
    const j = journal(db, { resolveExternal: () => ({ reconcile: async () => outcome }) });
    await codeOf(() => j.execute(execution({
      operationId: 'rec',
      deduplication: 'external-contract',
      business: async () => { business += 1; throw new Error('lost'); },
    })));
    expect(j.inspect('rec', { subject: 'caller-a' }).status).toBe('unknown');

    expect(await codeOf(() => j.reconcile(execution({ operationId: 'rec', deduplication: 'external-contract' })))).toBe('unknown');
    outcome = { status: 'committed', result: { ok: true } };
    expect(await j.reconcile(execution({ operationId: 'rec', deduplication: 'external-contract' }))).toEqual({ ok: true });
    expect(j.inspect('rec', { subject: 'caller-a' }).status).toBe('committed');
    expect(j.status().reservedBytes).toBe(0);

    expect(await j.execute(execution({
      operationId: 'rec',
      deduplication: 'external-contract',
      business: async () => { business += 1; return { ok: false }; },
    }))).toEqual({ ok: true });
    expect(business).toBe(1);
  });

  test('a second confirmation keeps the first committed result stable', async () => {
    const db = memory();
    const first = journal(db, { resolveExternal: () => ({ reconcile: async () => ({ status: 'committed', result: { who: 'first' } }) }) });
    await codeOf(() => first.execute(execution({
      operationId: 'rc',
      deduplication: 'external-contract',
      business: async () => { throw new Error('lost'); },
    })));
    expect(await first.reconcile(execution({ operationId: 'rc', deduplication: 'external-contract' }))).toEqual({ who: 'first' });

    const second = journalOn(db, { resolveExternal: () => ({ reconcile: async () => ({ status: 'committed', result: { who: 'second' } }) }) });
    expect(await second.reconcile(execution({ operationId: 'rc', deduplication: 'external-contract' }))).toEqual({ who: 'first' });
    expect(first.query('rc', { subject: 'caller-a' })).toEqual({ who: 'first' });
  });

  test('a not-executed reconciliation cannot overwrite a confirmed result', async () => {
    const db = memory();
    const gate = deferred<CommandExternalReconciliation>();
    const slow = journal(db, { resolveExternal: () => ({ reconcile: () => gate.promise }) });
    await codeOf(() => slow.execute(execution({
      operationId: 'race',
      deduplication: 'external-contract',
      business: async () => { throw new Error('lost'); },
    })));
    expect(slow.inspect('race', { subject: 'caller-a' }).status).toBe('unknown');

    const pending = slow.reconcile(execution({ operationId: 'race', deduplication: 'external-contract' }));
    await Promise.resolve();

    const fast = journalOn(db, { resolveExternal: () => ({ reconcile: async () => ({ status: 'committed', result: { who: 'fast' } }) }) });
    expect(await fast.reconcile(execution({ operationId: 'race', deduplication: 'external-contract' }))).toEqual({ who: 'fast' });

    gate.resolve({ status: 'not-executed' });
    expect(await codeOf(() => pending)).toBe('conflict');
    expect(slow.query('race', { subject: 'caller-a' })).toEqual({ who: 'fast' });
  });

  test('a stale unknown confirmation never downgrades a committed result', async () => {
    const db = memory();
    const gate = deferred<CommandExternalReconciliation>();
    const slow = journal(db, { resolveExternal: () => ({ reconcile: () => gate.promise }) });
    await codeOf(() => slow.execute(execution({
      operationId: 'ug',
      deduplication: 'external-contract',
      business: async () => { throw new Error('lost'); },
    })));
    const pending = slow.reconcile(execution({ operationId: 'ug', deduplication: 'external-contract' }));
    await Promise.resolve();

    const fast = journalOn(db, { resolveExternal: () => ({ reconcile: async () => ({ status: 'committed', result: { ok: true } }) }) });
    await fast.reconcile(execution({ operationId: 'ug', deduplication: 'external-contract' }));

    gate.resolve({ status: 'unknown' });
    expect(await codeOf(() => pending)).toBe('unknown');
    expect(slow.query('ug', { subject: 'caller-a' })).toEqual({ ok: true });
  });

  test('a peer journal returns the committed result without adding effects', async () => {
    const db = memory();
    let plansA = 0;
    const a = journal(db, { resolveAtomic: () => () => { plansA += 1; return { mutations: [], result: { who: 'A' } }; } });
    expect(await a.execute(execution({ operationId: 'peer' }))).toEqual({ who: 'A' });

    let plansB = 0;
    const b = journalOn(db, { resolveAtomic: () => () => { plansB += 1; return { mutations: [], result: { who: 'B' } }; } });
    expect(await b.execute(execution({ operationId: 'peer' }))).toEqual({ who: 'A' });
    expect(plansA).toBe(1);
    expect(plansB).toBe(0);
    expect(a.inspect('peer', { subject: 'caller-a' }).status).toBe('committed');
  });

  test('a nested peer execute from inside an atomic resolver cannot duplicate effects', async () => {
    const db = memory();
    let plansA = 0;
    let plansB = 0;
    const b = journalOn(db, { resolveAtomic: () => () => { plansB += 1; return { mutations: [], result: { who: 'B' } }; } });
    const a = journal(db, {
      resolveAtomic: () => () => {
        plansA += 1;
        void b.execute(execution({ operationId: 'nested' })).catch(() => undefined);
        return { mutations: [], result: { who: 'A' } };
      },
    });
    expect(await a.execute(execution({ operationId: 'nested' }))).toEqual({ who: 'B' });
    expect(plansA).toBe(1);
    expect(plansB).toBe(1);
    expect(b.inspect('nested', { subject: 'caller-a' }).status).toBe('committed');
    expect(b.query('nested', { subject: 'caller-a' })).toEqual({ who: 'B' });
  });

  test('records permanent rejected evidence and releases the reservation when reconciliation says not-executed', async () => {
    const db = memory();
    const j = journal(db, { resolveExternal: () => ({ reconcile: async () => ({ status: 'not-executed' }) }) });
    await codeOf(() => j.execute(execution({
      operationId: 'rec-ne',
      deduplication: 'external-contract',
      business: async () => { throw new Error('lost'); },
    })));
    expect(j.status().reservedBytes).toBeGreaterThan(0);
    expect(await codeOf(() => j.reconcile(execution({ operationId: 'rec-ne', deduplication: 'external-contract' })))).toBe('rejected');
    expect(j.inspect('rec-ne', { subject: 'caller-a' }).status).toBe('rejected');
    expect(j.status().reservedBytes).toBe(0);
    expect(await codeOf(() => j.reconcile(execution({ operationId: 'rec-ne', deduplication: 'external-contract' })))).toBe('rejected');
  });

  test('refuses reconciliation when no external capability is registered', async () => {
    const db = memory();
    const j = journal(db);
    await codeOf(() => j.execute(execution({
      operationId: 'none-unknown',
      deduplication: 'none',
      business: async () => { throw new Error('lost'); },
    })));
    expect(j.inspect('none-unknown', { subject: 'caller-a' }).status).toBe('unknown');
    expect(await codeOf(() => j.reconcile(execution({ operationId: 'none-unknown', deduplication: 'none' })))).toBe('capability_unavailable');
  });

  test('rejects a replayed operation whose result retention has expired', async () => {
    const db = memory();
    let now = 1_000;
    const j = journal(db, {
      now: () => now,
      resolveAtomic: () => () => ({ mutations: [], result: { ok: true } }),
    });
    await j.execute(execution({ operationId: 'ttl', resultRetentionMs: 1_000 }));
    expect(j.inspect('ttl', { subject: 'caller-a' }).status).toBe('committed');
    expect(j.status().reservedBytes).toBe(0);

    now = 5_000;
    expect(j.inspect('ttl', { subject: 'caller-a' }).status).toBe('expired');
    expect(await codeOf(() => j.execute(execution({ operationId: 'ttl', resultRetentionMs: 1_000 })))).toBe('expired');

    expect(j.collect()).toBe(1);
    expect(j.inspect('ttl', { subject: 'caller-a' }).status).toBe('expired');
    expect(codeOfSync(() => j.query('ttl', { subject: 'caller-a' }))).toBe('expired');
    expect(await codeOf(() => j.execute(execution({ operationId: 'ttl', resultRetentionMs: 1_000 })))).toBe('expired');
  });

  test('reports a stale committed result as expired instead of confirming it after the clock advances', async () => {
    const db = memory();
    let now = 1_000;
    const gate = deferred<CommandExternalReconciliation>();
    const slow = journal(db, {
      now: () => now,
      resolveExternal: () => ({ reconcile: () => gate.promise }),
    });
    await codeOf(() => slow.execute(execution({
      operationId: 'exp',
      deduplication: 'external-contract',
      resultRetentionMs: 500,
      business: async () => { throw new Error('lost'); },
    })));
    const pending = slow.reconcile(execution({ operationId: 'exp', deduplication: 'external-contract', resultRetentionMs: 500 }));
    await Promise.resolve();

    const fast = journalOn(db, {
      now: () => now,
      resolveExternal: () => ({ reconcile: async () => ({ status: 'committed', result: { ok: true } }) }),
    });
    expect(await fast.reconcile(execution({ operationId: 'exp', deduplication: 'external-contract', resultRetentionMs: 500 }))).toEqual({ ok: true });

    now = 10_000;
    gate.resolve({ status: 'committed', result: { ok: true } });
    expect(await codeOf(() => pending)).toBe('expired');
    expect(slow.inspect('exp', { subject: 'caller-a' }).status).toBe('expired');
  });

  test('keeps a null-retention result permanently replayable', async () => {
    const db = memory();
    let now = 1_000;
    const j = journal(db, {
      now: () => now,
      resolveAtomic: () => () => ({ mutations: [], result: { ok: true } }),
    });
    await j.execute(execution({ operationId: 'forever', resultRetentionMs: null }));
    now = 1_000_000_000;
    expect(await j.execute(execution({ operationId: 'forever', resultRetentionMs: null }))).toEqual({ ok: true });
    expect(j.inspect('forever', { subject: 'caller-a' }).status).toBe('committed');
    expect(j.collect()).toBe(0);
  });

  test('gates the real namespace cumulative against the bound policy quota before effects', async () => {
    const db = memory();
    let effects = 0;
    const j = journal(db, { limits: WIDE });
    const run = (operationId: string) => j.execute(execution({
      operationId,
      deduplication: 'none',
      quotaBytes: 4_200,
      business: async () => { effects += 1; return { ok: true }; },
    }));
    expect(await run('q1')).toEqual({ ok: true });
    expect(await codeOf(() => run('q2'))).toBe('overloaded');
    expect(effects).toBe(1);
    expect(j.inspect('q2', { subject: 'caller-a' }).status).toBe('missing');
  });

  test('shares one quota binding across callers', async () => {
    const db = memory();
    const j = journal(db, { limits: WIDE });
    const run = (subject: string, operationId: string) => j.execute(execution({
      operationId,
      subject,
      deduplication: 'none',
      quotaBytes: 4_200,
      business: async () => ({ ok: true }),
    }));
    await run('alice', 'x1');
    expect(await codeOf(() => run('bob', 'x2'))).toBe('overloaded');
  });

  test('rejects a first binding mismatch without registering or any effect, then persists on restart', async () => {
    const { db, file } = fileDatabase();
    let plans = 0;
    const j = journal(db, {
      quotaBytes: 8_192,
      resolveAtomic: () => () => {
        plans += 1;
        return { mutations: [{ key: 'k', expectedVersion: 0, value: 1 }], result: { ok: true } };
      },
    });
    expect(await codeOf(() => j.execute(execution({ operationId: 'm1', quotaBytes: 2_048 })))).toBe('invalid_input');
    expect(plans).toBe(0);
    expect(markerCount(db)).toBe(0);
    expect(j.inspect('m1', { subject: 'caller-a' }).status).toBe('missing');

    expect(await j.execute(execution({ operationId: 'm2', quotaBytes: 8_192 }))).toEqual({ ok: true });
    expect(plans).toBe(1);
    db.close();

    const reopened = reopen(file);
    const wrong = journalOn(reopened, {
      quotaBytes: 4_096,
      resolveAtomic: () => () => ({ mutations: [], result: { ok: true } }),
    });
    expect(await codeOf(() => wrong.execute(execution({ operationId: 'm3', quotaBytes: 8_192 })))).toBe('invalid_input');
    const right = journalOn(reopened, {
      quotaBytes: 8_192,
      resolveAtomic: () => () => ({ mutations: [], result: { ok: true } }),
    });
    expect(await right.execute(execution({ operationId: 'm3', quotaBytes: 8_192 }))).toEqual({ ok: true });
  });

  test('persists the namespace quota binding and rejects a different declared quota', async () => {
    const db = memory();
    const j = journal(db, { resolveAtomic: () => () => ({ mutations: [], result: { ok: true } }) });
    await j.execute(execution({ operationId: 'bind-1', quotaBytes: 8_192 }));
    expect(await codeOf(() => j.execute(execution({ operationId: 'bind-2', quotaBytes: 4_096 })))).toBe('invalid_input');
    expect(markerCount(db)).toBe(1);
  });

  test('treats a corrupt policy binding marker as a storage failure', async () => {
    const db = memory();
    const j = journal(db, { resolveAtomic: () => () => ({ mutations: [], result: { ok: true } }) });
    await j.execute(execution({ operationId: 'mk' }));
    db.run(
      'UPDATE plugin_communication_records SET charged_bytes = charged_bytes + 1 WHERE namespace = ? AND key = ?',
      ['svc.journal', 'journal-policy-binding'],
    );
    expect(await codeOf(() => j.execute(execution({ operationId: 'mk2' })))).toBe('storage_failure');
  });

  test('applies private-state CAS without a second command-history table', async () => {
    const db = memory();
    const j = journal(db, {
      resolveAtomic: () => () => ({
        mutations: [{ key: 'blob', expectedVersion: 0, value: 'x'.repeat(700_000) }],
        result: { ok: true },
      }),
    });
    expect(await j.execute(execution({ operationId: 'big-state' }))).toEqual({ ok: true });
    const commands = db.query<{ name: string }, [string, string]>(
      'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
    ).all('table', 'plugin_durable_commands');
    expect(commands).toEqual([]);
    const row = db.query<{ version: number; value_json: string }, [string, string]>(
      'SELECT version,value_json FROM plugin_durable_records WHERE namespace = ? AND key = ?',
    ).get('svc.private', 'blob');
    expect(row?.version).toBe(1);
    expect((row?.value_json ?? '').length).toBeGreaterThan(600_000);
  });

  test('refuses work before effects when the namespace storage cap is exhausted', async () => {
    const db = memory();
    let effects = 0;
    const j = journal(db, { limits: NARROW });
    let accepted = 0;
    let rejected = false;
    for (let index = 0; index < 40; index += 1) {
      try {
        await j.execute(execution({
          operationId: `fill-${index}`,
          deduplication: 'none',
          quotaBytes: 100_000,
          output: { type: 'string' },
          business: async () => { effects += 1; return 'x'.repeat(1_000); },
        }));
        accepted += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(CommandJournalError);
        expect(['overloaded']).toContain((error as CommandJournalError).code);
        rejected = true;
        break;
      }
    }
    expect(rejected).toBe(true);
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(40);
    expect(effects).toBe(accepted);
    expect(j.inspect(`fill-${accepted}`, { subject: 'caller-a' }).status).toBe('missing');
  });

  test('an accepted command still finalizes after other work fills the namespace', async () => {
    const db = memory();
    const gate = deferred<RpcJson>();
    const j = journal(db, {
      limits: NARROW,
      resolveExternal: () => ({ reconcile: async () => ({ status: 'unknown' }) }),
    });
    const accepted = j.execute(execution({
      operationId: 'accepted',
      deduplication: 'external-contract',
      business: async () => gate.promise,
    }));
    await Promise.resolve();
    expect(j.inspect('accepted', { subject: 'caller-a' }).status).toBe('pending');

    let rejected = false;
    for (let index = 0; index < 40; index += 1) {
      try {
        await j.execute(execution({
          operationId: `other-${index}`,
          deduplication: 'external-contract',
          output: { type: 'string' },
          business: async () => 'x'.repeat(1_000),
        }));
      } catch { rejected = true; }
    }
    expect(rejected).toBe(true);

    gate.resolve({ ok: true });
    expect(await accepted).toEqual({ ok: true });
    expect(j.inspect('accepted', { subject: 'caller-a' }).status).toBe('committed');
  });

  test('deduplicates concurrent same-operation calls onto one in-flight promise', async () => {
    const db = memory();
    let business = 0;
    const gate = deferred<RpcJson>();
    const j = journal(db, { resolveExternal: () => ({ reconcile: async () => ({ status: 'unknown' }) }) });
    const build = () => execution({
      operationId: 'dup',
      deduplication: 'external-contract',
      business: async () => { business += 1; return gate.promise; },
    });
    const first = j.execute(build());
    const second = j.execute(build());
    await Promise.resolve();
    expect(business).toBe(1);
    gate.resolve({ ok: true });
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
  });

  test('a synchronous reentrant same-op call cannot start a second effect', async () => {
    const db = memory();
    let plans = 0;
    let reentrant: Promise<unknown> | null = null;
    const j = journal(db, {
      resolveAtomic: () => () => {
        plans += 1;
        reentrant = j.execute(execution({ operationId: 'reenter' }));
        return { mutations: [], result: { ok: true } };
      },
    });
    expect(await j.execute(execution({ operationId: 'reenter' }))).toEqual({ ok: true });
    expect(plans).toBe(1);
    expect(await reentrant).toBeDefined();
  });

  test('never collects or deletes unresolved required evidence', async () => {
    const db = memory();
    const gate = deferred<void>();
    const j = journal(db, { resolveExternal: () => ({ reconcile: async () => ({ status: 'unknown' }) }) });
    const pending = j.execute(execution({
      operationId: 'pending-keep',
      deduplication: 'external-contract',
      business: async () => { await gate.promise; throw new Error('lost'); },
    }));
    await Promise.resolve();
    expect(j.collect()).toBe(0);
    expect(j.inspect('pending-keep', { subject: 'caller-a' }).status).toBe('pending');

    gate.resolve();
    expect(await codeOf(() => pending)).toBe('unknown');
    expect(j.collect()).toBe(0);
    expect(j.inspect('pending-keep', { subject: 'caller-a' }).status).toBe('unknown');
    expect(j.status().reservedBytes).toBeGreaterThan(0);
  });

  test('keeps a restarted pending command pending until an exact-owner recovery permit', async () => {
    const { db, file } = fileDatabase();
    const never = new Promise<RpcJson>(() => undefined);
    const first = journal(db, { resolveExternal: () => ({ reconcile: async () => ({ status: 'unknown' }) }) });
    void first.execute(execution({
      operationId: 'crash',
      deduplication: 'external-contract',
      business: () => never,
    })).catch(() => undefined);
    await Promise.resolve();
    expect(first.inspect('crash', { subject: 'caller-a' }).status).toBe('pending');
    db.close();

    const second = journalOn(reopen(file), { resolveExternal: () => ({ reconcile: async () => ({ status: 'unknown' }) }) });
    expect(second.inspect('crash', { subject: 'caller-a' }).status).toBe('pending');
    expect(second.recoverPending()).toBe(0);
    expect(second.inspect('crash', { subject: 'caller-a' }).status).toBe('pending');
    expect(await codeOf(() => second.execute(execution({ operationId: 'crash', deduplication: 'external-contract' })))).toBe('pending');

    const third = journalOn(reopen(file), {
      authorizeRecovery: (request) => ({ owner: request.owner, epoch: request.epoch, issuedAt: 1 }),
      resolveExternal: () => ({ reconcile: async () => ({ status: 'unknown' }) }),
    });
    expect(third.recoverPending()).toBe(1);
    expect(third.inspect('crash', { subject: 'caller-a' }).status).toBe('unknown');
    expect(third.status().reservedBytes).toBeGreaterThan(0);
  });

  test('recovery needs the exact saved owner and never changes the entry byte charge', async () => {
    const db = memory();
    const now = 1_000;
    const never = new Promise<RpcJson>(() => undefined);
    const j = journal(db, {
      now: () => now,
      resolveExternal: () => ({ reconcile: async () => ({ status: 'unknown' }) }),
    });
    void j.execute(execution({ operationId: 'rec-size', deduplication: 'external-contract', business: () => never })).catch(() => undefined);
    await Promise.resolve();
    expect(j.inspect('rec-size', { subject: 'caller-a' }).status).toBe('pending');
    const before = j.status().usedBytes;

    const wrongOwner = journalOn(db, {
      now: () => now,
      authorizeRecovery: () => ({ owner: 'x'.repeat(100), epoch: 1, issuedAt: 1 }),
      resolveExternal: () => ({ reconcile: async () => ({ status: 'unknown' }) }),
    });
    expect(wrongOwner.recoverPending()).toBe(0);
    expect(wrongOwner.inspect('rec-size', { subject: 'caller-a' }).status).toBe('pending');

    const rightOwner = journalOn(db, {
      now: () => now,
      authorizeRecovery: (request) => ({ owner: request.owner, epoch: request.epoch, issuedAt: 1 }),
      resolveExternal: () => ({ reconcile: async () => ({ status: 'unknown' }) }),
    });
    expect(rightOwner.recoverPending()).toBe(1);
    expect(rightOwner.inspect('rec-size', { subject: 'caller-a' }).status).toBe('unknown');
    expect(rightOwner.status().usedBytes).toBe(before);
  });

  test('reports a durable read failure distinctly from a missing entry', async () => {
    const db = memory();
    const j = journal(db, { resolveAtomic: () => () => ({ mutations: [], result: { ok: true } }) });
    expect(j.inspect('absent', { subject: 'caller-a' }).status).toBe('missing');
    expect(codeOfSync(() => j.query('absent', { subject: 'caller-a' }))).toBe('missing');

    await j.execute(execution({ operationId: 'corrupt' }));
    db.run(
      'UPDATE plugin_communication_records SET charged_bytes = charged_bytes + 1 WHERE namespace = ? AND key != ?',
      ['svc.journal', 'journal-policy-binding'],
    );
    expect(codeOfSync(() => j.inspect('corrupt', { subject: 'caller-a' }))).toBe('storage_failure');
  });

  test('never invokes a hostile capability accessor', async () => {
    const db = memory();
    let invoked = false;
    const capability = {
      get reconcile(): never { invoked = true; throw new Error('SECRET'); },
    };
    const j = journal(db, { resolveExternal: () => capability as unknown as CommandExternalExecutor });
    expect(await codeOf(() => j.execute(execution({
      operationId: 'hostile-cap',
      deduplication: 'external-contract',
      business: async () => ({ ok: true }),
    })))).toBe('capability_unavailable');
    expect(invoked).toBe(false);
  });

  test('snapshots a reconciliation outcome without invoking a hostile status accessor', async () => {
    const db = memory();
    let invoked = false;
    const outcome = {
      get status(): never { invoked = true; throw new Error('SECRET'); },
    };
    const j = journal(db, {
      resolveExternal: () => ({ reconcile: async () => outcome as unknown as CommandExternalReconciliation }),
    });
    await codeOf(() => j.execute(execution({
      operationId: 'hostile-outcome',
      deduplication: 'external-contract',
      business: async () => { throw new Error('lost'); },
    })));
    const error = await errorOf(() => j.reconcile(execution({ operationId: 'hostile-outcome', deduplication: 'external-contract' })));
    expect(error).toBeInstanceOf(CommandJournalError);
    expect((error as CommandJournalError).code).toBe('unknown');
    expect(invoked).toBe(false);
    expect((error as Error).message).not.toContain('SECRET');
    expect((error as Error).cause).toBeUndefined();
  });

  test('mints a fresh fixed error instead of propagating a provider-shaped error', async () => {
    const db = memory();
    const fake = Object.create(CommandJournalError.prototype, {
      code: { value: 'capability_unavailable', enumerable: true, configurable: true, writable: true },
      message: { value: 'SECRET', enumerable: true, configurable: true, writable: true },
      cause: { value: 'SECRET', enumerable: true, configurable: true, writable: true },
    });
    const j = journal(db, { resolveAtomic: () => () => { throw fake; } });
    const error = await errorOf(() => j.execute(execution({ operationId: 'fake' })));
    expect(error).toBeInstanceOf(CommandJournalError);
    expect(error).not.toBe(fake);
    expect((error as CommandJournalError).code).toBe('capability_unavailable');
    expect((error as Error).message).not.toContain('SECRET');
    expect((error as Error).cause).toBeUndefined();
  });

  test('refuses a first admit whose policy quota cannot even hold the binding marker', async () => {
    const db = memory();
    let effects = 0;
    const j = journal(db);
    expect(await codeOf(() => j.execute(execution({
      operationId: 'tiny',
      deduplication: 'none',
      quotaBytes: 1,
      maxResultBytes: 1,
      output: { type: 'number' },
      business: async () => { effects += 1; return 0; },
    })))).toBe('overloaded');
    expect(effects).toBe(0);
    expect(markerCount(db)).toBe(0);
    const status = j.status();
    expect(status.usedBytes).toBe(0);
    expect(status.reservedBytes).toBe(0);
    expect(j.inspect('tiny', { subject: 'caller-a' }).status).toBe('missing');
  });

  test('accepts and commits a NUL-escaped subject whose JSON header exceeds its raw byte length', async () => {
    const db = memory();
    let effects = 0;
    const subject = '\u0000'.repeat(256);
    const j = journal(db);
    const result = await j.execute(execution({
      operationId: 'nul-subject',
      subject,
      deduplication: 'none',
      quotaBytes: 8192,
      maxResultBytes: 1,
      output: { type: 'number' },
      business: async () => { effects += 1; return 0; },
    }));
    expect(result).toBe(0);
    expect(effects).toBe(1);
    expect(j.inspect('nul-subject', { subject }).status).toBe('committed');
    expect(j.query('nul-subject', { subject })).toBe(0);
    expect(j.status().reservedBytes).toBe(0);
  });

  test('carries a source identity into a committed entry', async () => {
    const db = memory();
    const j = journal(db, { resolveAtomic: () => () => ({ mutations: [], result: { ok: true } }) });
    expect(await j.execute(execution({
      operationId: 'src-bound',
      instance: 'i'.repeat(48),
      catalog: 'c'.repeat(48),
    }))).toEqual({ ok: true });
    expect(j.inspect('src-bound', { subject: 'caller-a' }).status).toBe('committed');
  });

  test('accepts the rpc-runtime production source bounds (instance 128 / catalog 64)', async () => {
    // Production catalog ids are 64-character hashes; runtime instance ids need not fit 48 characters.
    const db = memory();
    const j = journal(db, { resolveAtomic: () => () => ({ mutations: [], result: { ok: true } }) });
    expect(await j.execute(execution({
      operationId: 'src-compat',
      instance: 'i'.repeat(128),
      catalog: 'c'.repeat(64),
    }))).toEqual({ ok: true });
  });

  test('a peer commit during resolver setup wins without an extra A effect', async () => {
    const db = memory();
    let plansA = 0;
    let plansB = 0;
    const b = journalOn(db, { resolveAtomic: () => () => { plansB += 1; return { mutations: [], result: { who: 'B' } }; } });
    const a = journal(db, {
      resolveAtomic: (request) => {
        void b.execute(execution({ operationId: request.operationId })).catch(() => undefined);
        return () => { plansA += 1; return { mutations: [], result: { who: 'A' } }; };
      },
    });
    expect(await a.execute(execution({ operationId: 'nested-resolver' }))).toEqual({ who: 'B' });
    expect(await b.execute(execution({ operationId: 'nested-resolver' }))).toEqual({ who: 'B' });
    expect(plansA).toBe(0);
    expect(plansB).toBe(1);
    expect(a.inspect('nested-resolver', { subject: 'caller-a' }).status).toBe('committed');
    expect(a.query('nested-resolver', { subject: 'caller-a' })).toEqual({ who: 'B' });
  });

  test('a not-executed judgement is permanent and a later committed confirmation cannot revive it', async () => {
    const db = memory();
    const j = journal(db, { resolveExternal: () => ({ reconcile: async () => ({ status: 'not-executed' }) }) });
    await codeOf(() => j.execute(execution({
      operationId: 'perm',
      deduplication: 'external-contract',
      business: async () => { throw new Error('lost'); },
    })));
    expect(await codeOf(() => j.reconcile(execution({ operationId: 'perm', deduplication: 'external-contract' })))).toBe('rejected');

    const other = journalOn(db, { resolveExternal: () => ({ reconcile: async () => ({ status: 'committed', result: { ok: true } }) }) });
    expect(await codeOf(() => other.reconcile(execution({ operationId: 'perm', deduplication: 'external-contract' })))).toBe('rejected');
    expect(j.inspect('perm', { subject: 'caller-a' }).status).toBe('rejected');
    expect(codeOfSync(() => j.query('perm', { subject: 'caller-a' }))).toBe('rejected');
  });

  test('a late unknown write from the original business never overwrites a peer committed result', async () => {
    const db = memory();
    const gate = deferred<void>();
    const original = journal(db, {
      authorizeRecovery: (request) => ({ owner: request.owner, epoch: request.epoch, issuedAt: 1 }),
      resolveExternal: () => ({ reconcile: async () => ({ status: 'unknown' }) }),
    });
    const running = original.execute(execution({
      operationId: 'late',
      deduplication: 'external-contract',
      business: async () => { await gate.promise; throw new Error('lost'); },
    }));
    await Promise.resolve();
    expect(original.inspect('late', { subject: 'caller-a' }).status).toBe('pending');

    // The host proves the saved owner terminal while the original business is still lost.
    expect(original.recoverPending()).toBe(1);
    expect(original.inspect('late', { subject: 'caller-a' }).status).toBe('unknown');

    const peer = journalOn(db, { resolveExternal: () => ({ reconcile: async () => ({ status: 'committed', result: { ok: true } }) }) });
    expect(await peer.reconcile(execution({ operationId: 'late', deduplication: 'external-contract' }))).toEqual({ ok: true });

    // The original business finally fails and tries to write unknown; it must not overwrite.
    gate.resolve();
    expect(await codeOf(() => running)).toBe('unknown');
    expect(original.inspect('late', { subject: 'caller-a' }).status).toBe('committed');
    expect(original.query('late', { subject: 'caller-a' })).toEqual({ ok: true });
  });

  test('recovery preserves charges and does not steal other live pending commands near global capacity', async () => {
    const db = memory();
    const neverA = deferred<RpcJson>();
    const neverB = deferred<RpcJson>();
    const subjectA = 'esc\n\t"x';
    const j = journal(db, {
      limits: TIGHT,
      resolveExternal: () => ({ reconcile: async () => ({ status: 'unknown' }) }),
    });
    void j.execute(execution({
      operationId: 'fill-a', subject: subjectA, deduplication: 'external-contract',
      quotaBytes: 8192, maxResultBytes: 64, business: () => neverA.promise,
    })).catch(() => undefined);
    void j.execute(execution({
      operationId: 'fill-b', deduplication: 'external-contract',
      quotaBytes: 8192, maxResultBytes: 64, business: () => neverB.promise,
    })).catch(() => undefined);
    await Promise.resolve();
    expect(j.inspect('fill-a', { subject: subjectA }).status).toBe('pending');
    expect(j.inspect('fill-b', { subject: 'caller-a' }).status).toBe('pending');

    // Fill the shared P3 global budget from independent namespaces; the journal policy is untouched.
    const filler = new PluginCommunicationStore(db, TIGHT, { setup: false });
    let filled = 0;
    for (let ns = 0; ns < 64; ns += 1) {
      const store = filler.forNamespace(`fill.ns.${ns}`);
      let namespaceFilled = 0;
      for (let index = 0; index < 64; index += 1) {
        try { store.put(`k${index}`, new Uint8Array(1024), { required: false }); filled += 1; namespaceFilled += 1; }
        catch { break; }
      }
      if (namespaceFilled === 0) break; // a fresh namespace cannot take a row: the global budget is full
    }
    expect(filled).toBeGreaterThan(0);

    const before = j.status();
    const recoverer = journalOn(db, {
      limits: TIGHT,
      authorizeRecovery: (request) => request.operationId === 'fill-a'
        ? { owner: request.owner, epoch: request.epoch, issuedAt: Number.MAX_SAFE_INTEGER }
        : null,
      resolveExternal: () => ({ reconcile: async () => ({ status: 'unknown' }) }),
    });
    expect(recoverer.recoverPending()).toBe(1);
    expect(recoverer.inspect('fill-a', { subject: subjectA }).status).toBe('unknown');
    expect(recoverer.inspect('fill-b', { subject: 'caller-a' }).status).toBe('pending');
    const after = recoverer.status();
    expect(after.usedBytes).toBe(before.usedBytes);
    expect(after.reservedBytes).toBe(before.reservedBytes);
  });
});

describe('peer journal Host maintenance', () => {
  test('resumes namespaces after storage restart, advances past 128 pending rows, and preserves receipts', async () => {
    const { createPluginPeerJournalResolver } = await import('../../../src/plugin-services/peer-journal');
    const { PluginStateClient } = await import('../../../src/plugin-state/client');
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'peer-journal-worker-'));directories.push(directory);
    const file=path.join(directory,'plugin-state.db');
    let client=await PluginStateClient.open(file,{initialize:true,limits:WIDE,maxPendingRequests:256});
    let terminal=false;
    const make=()=>createPluginPeerJournalResolver({client,authorizeRecovery:request=>terminal
      ? {owner:request.owner,epoch:request.epoch,issuedAt:Date.now()}:null});
    const request={provider:'provider',service:'svc',major:1,method:'run',scope:'global' as const,
      policy:{deduplication:'none' as const,resultRetentionMs:10,maxResultBytes:128,quotaBytes:1_048_576}};
    try {
      const first=make(),accepted=first.resolve(request)!;
      let started=0;let allStarted!:()=>void;const begun=new Promise<void>(resolve=>{allStarted=resolve;});
      for(let index=0;index<140;index++)void accepted.execute(execution({operationId:`pending-${index}`,deduplication:'none',
        resultRetentionMs:10,maxResultBytes:128,quotaBytes:1_048_576,business:()=>{
          if(++started===140)allStarted();return new Promise<RpcJson>(()=>undefined);
        }})).catch(()=>undefined);
      await begun;
      const committed=first.resolve({...request,service:'other'})!;
      await committed.execute(execution({operationId:'expired-result',serviceId:'other',deduplication:'none',resultRetentionMs:10,
        maxResultBytes:128,quotaBytes:1_048_576}));
      await first.close();await client.close();
      client=await PluginStateClient.open(file,{limits:WIDE});
      const restarted=make(),observed=restarted.resolve(request)!,other=restarted.resolve({...request,service:'other'})!;
      const initial=await restarted.maintain({namespaceLimit:1,recordLimit:128});expect(initial.recovered).toBe(0);
      expect((await observed.inspect('pending-139',{subject:'caller-a'})).status).toBe('pending');
      terminal=true;await new Promise(resolve=>setTimeout(resolve,20));
      let recovered=0,collected=initial.collected;
      for(let index=0;index<12;index++) {
        const result=await restarted.maintain({namespaceLimit:1,recordLimit:128});
        expect(result.failures).toEqual([]);recovered+=result.recovered;collected+=result.collected;
      }
      expect(recovered).toBe(140);expect(collected).toBe(1);
      for(let index=0;index<140;index++)expect((await observed.inspect(`pending-${index}`,{subject:'caller-a'})).status).toBe('unknown');
      expect((await observed.status()).reservedBytes).toBeGreaterThan(0);
      expect((await other.inspect('expired-result',{subject:'caller-a'})).status).toBe('expired');
      await restarted.close();await client.close();
      const db=new Database(file,{readonly:true});
      expect(db.query<{n:number},[]>('SELECT count(*) AS n FROM plugin_communication_receipts').get()!.n).toBe(1);db.close();
    } finally {await client.close();}
  });

  test('each command facade keeps its publication capability and maintenance never runs it', async () => {
    const { createPluginPeerJournalResolver } = await import('../../../src/plugin-services/peer-journal');
    const { PluginStateClient } = await import('../../../src/plugin-state/client');
    const client=await PluginStateClient.open(':memory:',{initialize:true});
    const resolver=createPluginPeerJournalResolver({client});
    try {
      const policy={deduplication:'local-transaction' as const,resultRetentionMs:null,quotaBytes:8192,maxResultBytes:1024};
      const key={provider:'provider',service:'svc',major:1,method:'run',scope:'global' as const,policy,atomicReadSet:()=>({keys:[]})};
      let oldCalls=0,newCalls=0;
      const old=resolver.resolve({...key,atomic:()=>{oldCalls++;return {mutations:[],result:'old'};}})!;
      const replacement=resolver.resolve({...key,atomic:()=>{newCalls++;return {mutations:[],result:'new'};}})!;
      expect(await old.execute(execution({operationId:'old-call'}))).toBe('old');
      expect(await replacement.execute(execution({operationId:'new-call'}))).toBe('new');
      await resolver.maintain();expect([oldCalls,newCalls]).toEqual([1,1]);
      expect(await replacement.execute(execution({operationId:'old-call'}))).toBe('old');expect([oldCalls,newCalls]).toEqual([1,1]);
    } finally {await resolver.close();await client.close();}
  });
});
