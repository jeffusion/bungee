import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncConfigRepository, ConfigRepository, ConfigRepositoryError,
  ConfigurationStorageResultUnknownError, hashConfigurationContent } from '../../src/config-storage';
import type { ConfigurationStorageWorker } from '../../src/config-storage/async-config-repository';
import { CONFIG_MIGRATIONS } from '../../src/config-storage/migrations';
import { readRepositorySnapshot } from '../../src/config-storage/repository-snapshot';
import { PluginDependencyGraph } from '../../src/plugin-dependencies';
import { acquireMasterInstanceLock, mintControllerClaimCapability } from '../../src/master-runtime/instance-lock';

const aggregate = { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] } as const;
const snapshot = { revision: 1, content_hash: hashConfigurationContent(aggregate), aggregate };
const clients: AsyncConfigRepository[] = [];
const backends: ConfigRepository[] = [];
const roots: string[] = [];
const path = () => { const root = mkdtempSync(join(tmpdir(), 'async-configuration-')); roots.push(root); return join(root, 'config.db'); };
const command = (mutationId = 'async-commit') => ({ mutation_id: mutationId, expected_revision: 1,
  aggregate, kind: 'config' as const, created_at: 1, target_worker_slots: [0] });
async function open(dbPath = path()) { const client = await AsyncConfigRepository.open(dbPath); clients.push(client); return client; }

class FakeWorker implements ConfigurationStorageWorker {
  readonly requests: any[] = [];
  private readonly listeners = new Map<string, Array<(event: any) => void>>();
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }
  emit(type: string, event: any = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  postMessage(request: any): void {
    this.requests.push(request);
    if (request.method === 'open') queueMicrotask(() => this.emit('message', { data: { id: request.id, ok: true,
      result: { snapshot, supervision: { instance_id: '10000000-0000-4000-8000-000000000001',
        controller_epoch: 0, current_controller_id: null, updated_at: 0 } } } }));
    if (request.method === 'close') queueMicrotask(() => this.emit('message', { data: { id: request.id, ok: true, result: null } }));
  }
  terminate() { this.emit('close'); }
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const backend of backends.splice(0)) backend.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('configuration storage execution boundary', () => {
  test('repeated backend snapshots execute zero SQL and are deeply immutable', () => {
    const backend = ConfigRepository.open(path()); backends.push(backend);
    const projection = backend.getSnapshot();
    const prepare = spyOn(backend.getDatabase(), 'prepare');
    const run = spyOn(backend.getDatabase(), 'run');
    for (let index = 0; index < 100; index++) expect(backend.getSnapshot()).toBe(projection);
    expect(prepare).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    expect(Object.isFrozen(projection.aggregate.logical_configuration.routes)).toBe(true);
    expect(() => (projection.aggregate.logical_configuration.routes as unknown[]).push({})).toThrow();
    prepare.mockRestore(); run.mockRestore();
  });

  test('failed SQL commit rolls back without replacing the backend snapshot', () => {
    const backend = ConfigRepository.open(path(), { faultInjection(stage) {
      if (stage === 'after_targets') throw new Error('injected transaction failure');
    } }); backends.push(backend);
    const before = backend.getSnapshot();
    expect(() => backend.commit(command())).toThrow(ConfigRepositoryError);
    expect(backend.getSnapshot()).toBe(before);
    expect(backend.getOperation('async-commit')).toBeNull();
  });

  test('reads operation and recovery by ID/current revision without schema or history scans', () => {
    const backend = ConfigRepository.open(path()); backends.push(backend);
    const prepared = backend.getDatabase().prepare.bind(backend.getDatabase());
    const sql: string[] = [];
    const intercept = spyOn(backend.getDatabase(), 'prepare').mockImplementation((query: string, ...args: any[]) => {
      sql.push(query); return prepared(query, ...args);
    });
    backend.getOperation('missing'); backend.getOperationState('missing'); backend.getRecovery('missing');
    backend.getCurrentOperationState(); backend.getCurrentRecovery(); backend.getActivePublication();
    expect(sql.length).toBeGreaterThan(0);
    expect(sql.some(query => /PRAGMA|sqlite_schema|FROM configuration_revisions|FROM services/i.test(query))).toBe(false);
    for (const query of sql.filter(query => /FROM configuration_operations/.test(query))) {
      expect(query).toMatch(/WHERE (mutation_id|committed_revision)=\?/);
    }
    intercept.mockRestore();
  });

  test('commit, publication and recovery mutations audit only schema and affected rows', () => {
    const backend = ConfigRepository.open(path()); backends.push(backend);
    const db = backend.getDatabase(); const prepared = db.prepare.bind(db);
    const sql: string[] = [];
    const intercept = spyOn(db, 'prepare').mockImplementation((query: string, ...args: any[]) => {
      sql.push(query); return prepared(query, ...args);
    });
    try {
      expect(backend.commit(command('bounded-mutations')).kind).toBe('committed');
      backend.beginPublication('bounded-mutations', 2);
      backend.beginWorkerAttempt('bounded-mutations', 0, 0, 'initial', 3);
      backend.recordWorkerResult('bounded-mutations', 0, { kind: 'failed', attempt_no: 1, error: 'unavailable' }, 4);
      backend.finalizePublication('bounded-mutations', { outcome: 'degraded',
        error_code: 'replacement_convergence_failed', error_detail: 'unavailable', recovery_disposition: 'retryable' }, 5);
      const recovery = backend.getCurrentRecovery(); if (!recovery) throw new Error('recovery missing');
      backend.stopRecovery(recovery.recovery_id, 0, 'deterministic_worker_rejection', null, 6);
      expect(backend.commit({ ...command('bounded-next'), expected_revision: 2, created_at: 7 }).kind).toBe('committed');
      expect(sql.some(query => /PRAGMA|pragma_|FROM configuration_state ORDER|FROM configuration_revisions ORDER/i.test(query))).toBe(false);
      for (const query of sql.filter(query => /FROM configuration_(operations|operation_workers|revisions|recoveries)\b/i.test(query))) {
        expect(query).toMatch(/WHERE\s+(?:mutation_id|revision|committed_revision|recovery_id|target_revision)=\?|ORDER BY recovery_sequence DESC LIMIT 1/);
      }
      expect(sql.some(query => /FROM sqlite_schema/.test(query))).toBe(true);
    } finally { intercept.mockRestore(); }
  });

  test('worker owns storage, snapshots stay immutable, and restart recovers committed state', async () => {
    const dbPath = path(); const client = await open(dbPath);
    const before = client.getSnapshot();
    const committed = await client.commit(command()); expect(committed.kind).toBe('committed');
    const after = client.getSnapshot(); expect(after.revision).toBe(2); expect(after).not.toBe(before);
    expect(Object.isFrozen(after.aggregate.logical_configuration)).toBe(true);
    for (let index = 0; index < 100; index++) expect(client.getSnapshot()).toBe(after);
    const rejected = await client.commit(command('stale')); expect(rejected.kind).toBe('stale_revision');
    expect(client.getSnapshot()).toBe(after);
    expect((await client.getOperation('async-commit'))?.committed_revision).toBe(2);
    await client.close(); clients.splice(clients.indexOf(client), 1);
    const restarted = await open(dbPath); expect(restarted.getSnapshot()).toEqual(after);
  });

  test('slow SQLite lock waiting leaves the master timer responsive', async () => {
    const dbPath = path(); const client = await open(dbPath);
    const blocker = new Database(dbPath, { readwrite: true, strict: true });
    blocker.run('BEGIN EXCLUSIVE');
    let ticks = 0; const interval = setInterval(() => ticks++, 10);
    const release = setTimeout(() => blocker.run('ROLLBACK'), 140);
    const startedAt = performance.now();
    try {
      expect(await client.getOperation('missing')).toBeNull();
      expect(performance.now() - startedAt).toBeGreaterThan(100);
      expect(ticks).toBeGreaterThanOrEqual(5);
    } finally {
      clearInterval(interval); clearTimeout(release);
      if (blocker.inTransaction) blocker.run('ROLLBACK'); blocker.close();
    }
  });

  test('worker exit rejects a pending commit as unknown and preserves its mutation ID/projection', async () => {
    const worker = new FakeWorker();
    const client = await AsyncConfigRepository.open('fixture', { workerFactory: () => worker }); clients.push(client);
    const before = client.getSnapshot(); const pending = client.commit(command('original-mutation'));
    const settled = pending.catch(error => error); worker.emit('close');
    const error = await settled; expect(error).toBeInstanceOf(ConfigurationStorageResultUnknownError);
    expect(error.mutationId).toBe('original-mutation'); expect(client.getSnapshot()).toBe(before);
    expect(worker.requests.filter(request => request.method === 'commitPrepared')).toHaveLength(1);
    await expect(client.getOperation('original-mutation')).rejects.toMatchObject({ code: 'repository_failure' });
  });

  test('real worker exit after durable commit requires querying the original mutation ID on restart', async () => {
    const dbPath = path();
    const client = await AsyncConfigRepository.open(dbPath,
      { workerUrl: new URL('../fixtures/config-storage-exit-worker.ts', import.meta.url) }); clients.push(client);
    const before = client.getSnapshot();
    await expect(client.commit(command('lost-acknowledgement'))).rejects.toMatchObject({
      code: 'result_unknown', mutationId: 'lost-acknowledgement',
    });
    expect(client.getSnapshot()).toBe(before);
    const restarted = await open(dbPath);
    expect(restarted.getSnapshot().revision).toBe(2);
    expect((await restarted.getOperation('lost-acknowledgement'))?.committed_revision).toBe(2);
  });

  test('plugin dependency graph compiles on the client and only prepared JSON crosses the worker boundary', async () => {
    const graph = new PluginDependencyGraph([
      { name: 'consumer', version: '1.0.0', dependencies: { provider: '^1.0.0' } },
      { name: 'provider', version: '1.0.0' },
    ]);
    const client = await AsyncConfigRepository.open(path(), { compileOptions: {
      pluginDependencies: graph, pluginSchemas: new Map([['consumer', []], ['provider', []]]),
      availablePlugins: new Set(['consumer', 'provider']),
    } }); clients.push(client);
    const result = await client.commit({ ...command('dependency-json'), aggregate: {
      ...aggregate, plugin_activations: [{ plugin_name: 'consumer' }],
    } });
    expect(result.kind).toBe('committed');
    expect(client.getSnapshot().aggregate.plugin_activations.map(value => value.plugin_name)).toEqual(['consumer', 'provider']);
  });

  test('bounded queue rejects overflow, close rejects pending work, and subsequent calls fail', async () => {
    const worker = new FakeWorker();
    const client = await AsyncConfigRepository.open('fixture', { workerFactory: () => worker, maxPendingRequests: 1 }); clients.push(client);
    const pending = client.getOperation('missing').catch(error => error);
    await expect(client.getCurrentRecovery()).rejects.toMatchObject({ code: 'queue_full' });
    await client.close(); expect(await pending).toMatchObject({ code: 'repository_failure' });
    await expect(client.getCurrentRecovery()).rejects.toMatchObject({ code: 'repository_failure' });
  });

  test('controller claim consumes the authentic main-thread capability before worker SQL', async () => {
    const dbPath = path(); const client = await open(dbPath);
    const configLock = await acquireMasterInstanceLock(`${dbPath}.config-lock`);
    const pluginLock = await acquireMasterInstanceLock(`${dbPath}.plugin-lock`);
    try {
      const id = '10000000-0000-4000-8000-000000000099';
      await expect(client.claimControllerWithCapability({}, id, 1)).rejects.toMatchObject({ code: 'held' });
      expect(client.getSupervisionState().controller_epoch).toBe(0);
      const capability = mintControllerClaimCapability(configLock, pluginLock);
      const claimed = await client.claimControllerWithCapability(capability, id, 1);
      expect(claimed.controller_epoch).toBe(1); expect(claimed.current_controller_id).toBe(id);
      expect(client.getSupervisionState()).toBe(claimed); expect(Object.isFrozen(claimed)).toBe(true);
      await expect(client.claimControllerWithCapability(capability, id, 2)).rejects.toMatchObject({ code: 'held' });
      const inspector = new Database(dbPath, { readonly: true, strict: true });
      expect(inspector.query('SELECT controller_epoch,current_controller_id FROM supervision_state WHERE id=1').get())
        .toEqual({ controller_epoch: 1, current_controller_id: id }); inspector.close();
    } finally { await pluginLock.release(); await configLock.release(); }
  });
});

describe('real configuration storage deadline and close failure evidence',()=>{
  const silentUrl=new URL('../fixtures/config-storage-silent-worker.ts',import.meta.url);
  test('silence bounds the production queue and expires reads without reporting database release',async()=>{
    let notifications=0;
    const client=await AsyncConfigRepository.open(path(),{workerUrl:silentUrl,requestTimeoutMs:250,maxPendingRequests:1,
      onWorkerFailure:()=>{notifications++;}});clients.push(client);
    const read=client.getOperation('silent').catch(error=>error);
    await expect(client.getCurrentRecovery()).rejects.toMatchObject({code:'queue_full'});
    expect(await read).toMatchObject({code:'repository_failure'});expect(notifications).toBe(1);
    await expect(client.close()).rejects.toMatchObject({code:'repository_failure'});
    await expect(client.close()).rejects.toMatchObject({code:'repository_failure'});
  });
  test('close shares one request, refuses new work and expires without false release',async()=>{
    let notifications=0;
    const client=await AsyncConfigRepository.open(path(),{workerUrl:silentUrl,closeTimeoutMs:60,onWorkerFailure:()=>{notifications++;}});clients.push(client);
    const close=client.close();expect(client.close()).toBe(close);
    await expect(client.getOperation('late')).rejects.toMatchObject({code:'repository_failure'});
    await expect(close).rejects.toMatchObject({code:'repository_failure'});expect(notifications).toBe(1);
    expect(client.close()).toBe(close);await expect(client.close()).rejects.toMatchObject({code:'repository_failure'});
  });
  test('real production client refuses oversized queued bytes before issuing a mutation',async()=>{
    const client=await AsyncConfigRepository.open(path(),{maxPendingBytes:256});clients.push(client);
    await expect(client.commit(command('x'.repeat(127)))).rejects.toMatchObject({code:'queue_full'});
    expect(client.getSnapshot().revision).toBe(1);
  });
  test('real write blocked in SQLite times out as unknown while control timers continue',async()=>{
    const dbPath=path();let notifications=0;
    const client=await AsyncConfigRepository.open(dbPath,{requestTimeoutMs:250,onWorkerFailure:()=>{notifications++;}});clients.push(client);
    const blocker=new Database(dbPath);blocker.exec('BEGIN EXCLUSIVE');
    let ticks=0;const timer=setInterval(()=>ticks++,5);
    try{
      await expect(client.commit(command('blocked-original-id'))).rejects.toMatchObject({code:'result_unknown',mutationId:'blocked-original-id'});
      expect(notifications).toBe(1);expect(ticks).toBeGreaterThan(5);
      await expect(client.close()).rejects.toMatchObject({code:'repository_failure'});
    }finally{clearInterval(timer);blocker.exec('ROLLBACK');blocker.close();}
  });
});
