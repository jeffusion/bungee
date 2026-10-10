import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createPluginStorageCapability } from '../../src/plugin-storage';
import { initializeTokenStatsTestDatabase } from '../helpers/token-stats-database';
import type { TokenStatsAttempt } from '../../src/plugin.types';
import { SQLiteTokenStatsMetering } from '../../../../plugins/token-stats/server/storage';
import { TokenStatsRepository, REPORTING_INCOMPLETE_KEY } from '../../../../plugins/token-stats/server/repository';
import { createControl } from '../../../../plugins/token-stats/server/control';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function accessDatabase(): Database {
  const db = new Database(':memory:');
  initializeTokenStatsTestDatabase(db);
  databases.push(db);
  return db;
}
function attempt(): TokenStatsAttempt {
  return {
    attempt_id: 'shared-id', request_id: 'request', finished_at_ms: Date.now() - 1,
    route_id: 'route', upstream_id: 'upstream', provider: 'openai', outcome: 'completed', model: 'model',
    input_tokens: 7, output_tokens: 3, input_source: 'usage', output_source: 'usage',
    cache_read_tokens: null, cache_write_tokens: null, cost_usd: null, observation_incomplete: false,
  };
}

describe('plugin-owned stats storage extension', () => {
  test('arbitrary plugin names support cached KV and independent observation database lifetimes', async () => {
    const first = createPluginStorageCapability(accessDatabase(), 'report-a', { maxSize: 10, writeDelay: 60_000 });
    const second = createPluginStorageCapability(accessDatabase(), 'report-b', { maxSize: 10, writeDelay: 60_000 });
    expect('metering' in first.storage).toBe(false);
    expect(Object.isFrozen(first.storage)).toBe(true);
    expect(Object.isFrozen(first.storage.observation)).toBe(true);
    const one = new SQLiteTokenStatsMetering(first.storage.observation!);
    const two = new SQLiteTokenStatsMetering(second.storage.observation!);
    await first.storage.set('cached', { value: 1 });
    expect(await first.storage.get<{value: number}>('cached')).toEqual({ value: 1 });
    await first.storage.flush!();
    await one.recordAttempt(attempt());
    expect((await new TokenStatsRepository(first.storage).query('1h', 'model')).totalInputTokens).toBe(7);
    expect((await new TokenStatsRepository(second.storage).query('1h', 'model')).upstreamAttempts).toBe(0);
    const retainedView = first.storage.uncached!();
    first.revoke();
    await expect(retainedView.set('late', true)).rejects.toThrow('revoked');
    await expect(one.recordAttempt(attempt())).rejects.toThrow('revoked');
    await expect(one.queryWindowSnapshot({ asOfMs: Date.now(), range: '1h', groupBy: 'model' })).rejects.toThrow('revoked');
    await two.recordAttempt(attempt());
    expect((await new TokenStatsRepository(second.storage).query('1h', 'model')).totalOutputTokens).toBe(3);
    second.revoke();
  });

  test('immediate KV view sees cross-instance updates and keeps plugin namespaces isolated', async () => {
    const db = accessDatabase();
    const worker = createPluginStorageCapability(db, 'report', { maxSize: 10, writeDelay: 60_000 });
    const control = createPluginStorageCapability(db, 'report');
    const other = createPluginStorageCapability(db, 'another');
    const shared = worker.storage.uncached!();
    await control.storage.set('prices', 'old');
    expect(await worker.storage.get<string>('prices')).toBe('old');
    // Flush the cached read before replacing a shared value. Reporting uses only the immediate view.
    await worker.storage.flush!();
    await control.storage.set('prices', 'new');
    expect(await shared.get<string>('prices')).toBe('new');
    expect(await other.storage.get('prices')).toBeNull();
    expect(shared.observation).toBeDefined();
    worker.revoke(); control.revoke(); other.revoke();
  });

  test('configuration databases cannot yield an observation connection', () => {
    const db = new Database(':memory:'); databases.push(db);
    db.run('CREATE TABLE configuration_state (id INTEGER PRIMARY KEY)');
    db.run('CREATE TABLE plugin_storage (plugin_name TEXT, key TEXT, value TEXT, ttl INTEGER, updated_at INTEGER)');
    const capability = createPluginStorageCapability(db, 'report');
    expect(capability.storage.observation).toBeUndefined();
    expect(capability.storage.uncached!().observation).toBeUndefined();
    expect(() => new TokenStatsRepository(capability.storage)).toThrow('metering storage is required');
  });

  test('stats API exposes sticky reporting failures from another instance', async () => {
    const db = accessDatabase();
    const worker = createPluginStorageCapability(db, 'report', { maxSize: 10, writeDelay: 60_000 });
    const master = createPluginStorageCapability(db, 'report');
    await worker.storage.uncached!().set(REPORTING_INCOMPLETE_KEY, true);
    const host = {
      storage: master.storage, signal: new AbortController().signal,
      secretStore: { namespace: 'report', async get() { return null; }, async compareAndSet() { return 1; }, async delete() {} },
    };
    const control = createControl(host);
    try {
      const response = await control.api[0]!.invoke({ ...host,
        request: new Request('http://localhost/stats?range=1h'), requestSignal: new AbortController().signal,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ reportingIncomplete: true, upstreamAttempts: 0 });
    } finally { control.dispose(); worker.revoke(); master.revoke(); }
  });
});
