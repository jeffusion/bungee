import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTokenStatsWindowSnapshotQuery, createPluginStorageCapability, SQLitePluginStorage } from '../../src/plugin-storage';
import { migrations } from '../../src/migrations';
import type { TokenStatsAttempt } from '../../src/plugin.types';
import { STATEFUL_INTEGRATION_TEST_TIMEOUT_MS } from '../helpers/test-budgets';

const databases: Array<{ db: Database; directory?: string }> = [];

function createStorage(): { db: Database; storage: SQLitePluginStorage };
function createStorage(mode: 'file'): { db: Database; storage: SQLitePluginStorage; directory: string };
function createStorage(mode: 'memory' | 'file' = 'memory'):
  { db: Database; storage: SQLitePluginStorage; directory?: string } {
  const directory = mode === 'file'
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'token-stats-metering-'))
    : undefined;
  const db = directory
    ? new Database(path.join(directory, 'access.db'), { create: true, readwrite: true, strict: true })
    : new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  db.transaction(() => {
    for (const migration of migrations) migration.up(db);
  })();
  databases.push({ db, directory });
  return { db, storage: new SQLitePluginStorage(db, 'token-stats'), ...(directory ? { directory } : {}) };
}

function attempt(overrides: Partial<TokenStatsAttempt> = {}): TokenStatsAttempt {
  return {
    attempt_id: crypto.randomUUID(), request_id: crypto.randomUUID(), finished_at_ms: Date.now(),
    route_id: '/chat', upstream_id: 'pool-a', provider: 'openai', outcome: 'success', model: 'gpt-4o-mini',
    input_tokens: 0, output_tokens: 0, input_source: 'usage', output_source: 'usage',
    cache_read_tokens: null, cache_write_tokens: null, cost_usd: null, observation_incomplete: false, ...overrides,
  };
}

function busyTimeout(db: Database): number | undefined {
  return db.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()?.timeout;
}

afterEach(() => {
  const created = databases.splice(0);
  for (const { db } of created) db.close();
  for (const directory of new Set(created.flatMap(({ directory }) => directory ? [directory] : []))) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('token-stats dashboard storage', () => {
  test('KV operations release their statements and the database file on ordinary owner close', async () => {
    const { db, storage, directory } = createStorage('file');
    const prepare = spyOn(db, 'prepare');
    const query = spyOn(db, 'query');
    try {
      expect(await storage.get('missing')).toBeNull();
      await storage.set('price', { cost: 1 });
      expect(await storage.get('price')).toEqual({ cost: 1 });
      expect(await storage.increment('count', 'value')).toBe(1);
      expect(await storage.compareAndSet('state', 'value', null, 'ready')).toBe(true);
      expect(await storage.compareAndSet('state', 'value', 'ready', 'done')).toBe(true);
      expect(await storage.keys('price')).toEqual(['price']);
      await storage.delete('price');
      await storage.clear();
      const statements = [...prepare.mock.results, ...query.mock.results]
        .filter(result => result.type === 'return').map(result => result.value);
      expect(statements.length).toBeGreaterThan(0);
      db.close();
      // Retain references so GC cannot hide an unfinalized statement on POSIX.
      for (const statement of statements) expect(statement.toString()).toBe('');
      fs.rmSync(directory, { recursive: true });
      expect(fs.existsSync(directory)).toBe(false);
    } finally {
      prepare.mockRestore();
      query.mockRestore();
      db.close(true);
    }
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

  test('migration clears only exact token-stats v2 keys and creates no ledger/aggregate tables', () => {
    const db = new Database(':memory:');
    let transactionActive = false;
    try {
      db.run('BEGIN TRANSACTION'); transactionActive = true;
      for (const migration of migrations) {
        if (migration.version === '005') {
          const insert = db.query('INSERT INTO plugin_storage (plugin_name, key, value, updated_at) VALUES (?, ?, ?, 0)');
          insert.run('token-stats', 'token-stats:v2:old', '{}');
          insert.run('token-stats', 'token-stats:v3:keep', '{}');
          insert.run('token-stats', 'other:keep', '{}');
          insert.run('another-plugin', 'token-stats:v2:keep', '{}');
        }
        migration.up(db);
      }
      db.run('COMMIT'); transactionActive = false;
      expect(db.query('SELECT plugin_name, key FROM plugin_storage ORDER BY plugin_name, key').all()).toEqual([
        { plugin_name: 'another-plugin', key: 'token-stats:v2:keep' },
        { plugin_name: 'token-stats', key: 'other:keep' },
        { plugin_name: 'token-stats', key: 'token-stats:v3:keep' },
      ]);
      const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
      expect(tables).toContain('token_stats_attempts');
      expect(tables).not.toContain('token_stats_settlements');
      expect(tables).not.toContain('token_stats_contributions');
      expect(tables).not.toContain('token_stats_minute_aggregates');
    } catch (error) {
      if (transactionActive) db.run('ROLLBACK');
      throw error;
    } finally { db.close(); }
  });

  test('stores valid usage zero and represents missing observations as null/unknown', async () => {
    const { db, storage } = createStorage();
    const now = Date.now();
    await storage.metering!.recordAttempt(attempt({
      attempt_id: 'known-zero', request_id: 'request-zero', finished_at_ms: now,
      input_tokens: 0, output_tokens: 0, input_source: 'usage', output_source: 'usage',
    }));
    await storage.metering!.recordAttempt(attempt({
      attempt_id: 'unknown', request_id: 'request-unknown', finished_at_ms: now,
      input_tokens: null, output_tokens: null, input_source: 'unknown', output_source: 'unknown',
    }));
    expect(db.query('SELECT input_tokens, input_source FROM token_stats_attempts WHERE attempt_id = ?').get('known-zero'))
      .toEqual({ input_tokens: 0, input_source: 'usage' });
    const snapshot = await storage.metering!.queryWindowSnapshot({ asOfMs: now + 1, range: '1h', groupBy: 'model' });
    expect(snapshot.all).toMatchObject({ officialInputTokens: 0, officialOutputTokens: 0,
      inputAuthorityOfficial: 1, outputAuthorityOfficial: 1, inputAuthorityNone: 1, outputAuthorityNone: 1,
      logicalRequests: 2, upstreamAttempts: 2 });
  });

  test('round-trips partial media accounting through SQLite snapshots without double counting', async () => {
    const { db, storage } = createStorage();
    const now = Date.now();
    await storage.metering!.recordAttempt(attempt({
      attempt_id: 'media-input-partial', request_id: 'media-input-partial', finished_at_ms: now,
      input_tokens: 14, input_source: 'partial', output_tokens: null, output_source: 'unknown',
      cache_read_tokens: 3, cache_write_tokens: 4,
    }));
    await storage.metering!.recordAttempt(attempt({
      attempt_id: 'media-output-partial', request_id: 'media-output-partial', finished_at_ms: now,
      input_tokens: null, input_source: 'unknown', output_tokens: 9, output_source: 'partial',
    }));
    await storage.metering!.recordAttempt(attempt({
      attempt_id: 'real-official-zero', request_id: 'real-official-zero', finished_at_ms: now,
      input_tokens: 0, input_source: 'usage', output_tokens: 0, output_source: 'usage',
    }));
    await storage.metering!.recordAttempt(attempt({
      attempt_id: 'missing-observation', request_id: 'missing-observation', finished_at_ms: now,
      input_tokens: null, input_source: 'unknown', output_tokens: null, output_source: 'unknown',
    }));

    expect(db.query('SELECT input_tokens, input_source FROM token_stats_attempts WHERE attempt_id = ?').get('media-input-partial'))
      .toEqual({ input_tokens: 14, input_source: 'partial' });
    expect(db.query('SELECT output_tokens, output_source FROM token_stats_attempts WHERE attempt_id = ?').get('media-output-partial'))
      .toEqual({ output_tokens: 9, output_source: 'partial' });

    const all = await storage.metering!.queryWindowSnapshot({ asOfMs: now + 1, range: '1h', groupBy: 'model' });
    expect(all.all).toMatchObject({
      inputTokens: 14, outputTokens: 9,
      estimatedInputTokens: 14, estimatedOutputTokens: 9,
      officialInputTokens: 0, officialOutputTokens: 0,
      inputAuthorityPartial: 1, outputAuthorityPartial: 1,
      inputAuthorityHeuristic: 0, outputAuthorityHeuristic: 0,
      inputAuthorityOfficial: 1, outputAuthorityOfficial: 1,
      inputAuthorityNone: 2, outputAuthorityNone: 2,
      cacheReadTokens: 3, cacheWriteTokens: 4,
      partialOutputs: 0, observationIncompleteAttempts: 0,
      logicalRequests: 4, upstreamAttempts: 4,
    });
    const grouped = await storage.metering!.queryWindowSnapshot({ asOfMs: now + 1, range: '1h', groupBy: 'model' });
    expect(grouped.data).toHaveLength(1);
    expect(grouped.data[0]!.metrics).toMatchObject({
      inputTokens: 14, estimatedInputTokens: 14, inputAuthorityPartial: 1,
      outputTokens: 9, estimatedOutputTokens: 9, outputAuthorityPartial: 1,
      partialOutputs: 0, observationIncompleteAttempts: 0,
    });

    await expect(storage.metering!.recordAttempt(attempt({
      input_tokens: null, input_source: 'partial',
    }))).rejects.toThrow('value/source mismatch');
    await expect(storage.metering!.recordAttempt(attempt({
      input_tokens: Number.MAX_SAFE_INTEGER + 1, input_source: 'partial',
    }))).rejects.toThrow('invalid token-stats input_tokens');
    const invalidSource = db.query(`INSERT INTO token_stats_attempts (
      attempt_id, request_id, finished_at_ms, route_id, upstream_id, provider, outcome, model,
      input_tokens, output_tokens, input_source, output_source,
      cache_read_tokens, cache_write_tokens, observation_incomplete
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    expect(() => invalidSource.run(
      'invalid-source-check', 'invalid-source-check', now, '/chat', 'pool-a', 'openai', 'success', 'gpt-4o-mini',
      1, 0, 'invalid', 'usage', null, null, 0,
    )).toThrow(/CHECK constraint failed/);
  });

  test('ignores a duplicate attempt id across two worker-like SQLite connections', async () => {
    const { db, storage, directory } = createStorage('file');
    const otherDb = new Database(path.join(directory, 'access.db'), { readwrite: true, strict: true });
    databases.push({ db: otherDb, directory });
    const other = new SQLitePluginStorage(otherDb, 'token-stats');
    const row = attempt({ attempt_id: 'shared-attempt', request_id: 'shared-request', input_tokens: 9, cost_usd: 0.125 });
    await Promise.all([storage.metering!.recordAttempt(row), other.metering!.recordAttempt({ ...row, input_tokens: 99, cost_usd: 99 })]);
    expect((await storage.metering!.queryWindowSnapshot({ asOfMs: row.finished_at_ms + 1, range: '1h', groupBy: 'model' })).all)
      .toMatchObject({ inputTokens: 9, estimatedCostUsd: 0.125, upstreamAttempts: 1, logicalRequests: 1 });
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

  test('groups model totals by model, retains unknown, sorts by counted tokens, and uses one indexed snapshot query', async () => {
    const { db, storage } = createStorage();
    const now = Date.now();
    await storage.metering!.recordAttempt(attempt({ attempt_id: 'a1', request_id: 'logical-a', finished_at_ms: now, model: 'model-heavy', input_tokens: 10, output_tokens: 2 }));
    await storage.metering!.recordAttempt(attempt({ attempt_id: 'a2', request_id: 'logical-a', finished_at_ms: now, model: 'model-heavy', input_tokens: 5, output_tokens: 2 }));
    await storage.metering!.recordAttempt(attempt({ attempt_id: 'b1', request_id: 'logical-b', finished_at_ms: now, model: 'model-light', input_tokens: 1, output_tokens: 1 }));
    await storage.metering!.recordAttempt(attempt({ attempt_id: 'u1', request_id: 'logical-unknown', finished_at_ms: now, model: 'unknown', input_tokens: null, output_tokens: null, input_source: 'unknown', output_source: 'unknown' }));
    const snapshot = await storage.metering!.queryWindowSnapshot({ asOfMs: now + 1, range: '1h', groupBy: 'model' });
    expect(snapshot.all).toMatchObject({ logicalRequests: 3, upstreamAttempts: 4 });
    expect(snapshot.data.map((r) => [r.dimension, r.metrics.logicalRequests, r.metrics.upstreamAttempts, r.metrics.inputTokens + r.metrics.outputTokens]))
      .toEqual([['model-heavy', 1, 2, 19], ['model-light', 1, 1, 2], ['unknown', 1, 1, 0]]);
    const query = buildTokenStatsWindowSnapshotQuery({ startMs: now - 60_000, endMs: now + 1, groupBy: 'model' });
    const plan = db.query(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as Array<{ detail: string }>;
    expect(plan.some((item) => item.detail.includes('idx_token_stats_attempts_finished'))).toBe(true);
  });

  test('groups time buckets by model in ascending order with range-specific bucket widths', async () => {
    const { storage } = createStorage();
    const asOf = Math.floor(Date.now() / 7_200_000) * 7_200_000;
    const start = asOf - 60 * 60_000;
    await storage.metering!.recordAttempt(attempt({
      attempt_id: 'time-a1', request_id: 'time-a1', finished_at_ms: start, model: 'model-alpha', input_tokens: 10, output_tokens: 2, cost_usd: 0.1,
    }));
    await storage.metering!.recordAttempt(attempt({
      attempt_id: 'time-a2', request_id: 'time-a2', finished_at_ms: start + 299_999, model: 'model-alpha', input_tokens: 5, output_tokens: 2,
    }));
    await storage.metering!.recordAttempt(attempt({
      attempt_id: 'time-b', request_id: 'time-b', finished_at_ms: start + 300_000, model: 'model-beta', input_tokens: 0, output_tokens: 0, cost_usd: 0,
    }));
    await storage.metering!.recordAttempt(attempt({
      attempt_id: 'time-a3', request_id: 'time-a3', finished_at_ms: start + 300_000, model: 'model-alpha', input_tokens: 3, output_tokens: 0,
    }));
    await storage.metering!.recordAttempt(attempt({
      attempt_id: 'time-unknown', request_id: 'time-unknown', finished_at_ms: asOf - 1, model: 'unknown',
      input_tokens: null, output_tokens: null, input_source: 'unknown', output_source: 'unknown',
    }));
    await storage.metering!.recordAttempt(attempt({
      attempt_id: 'time-upper', request_id: 'time-upper', finished_at_ms: asOf, model: 'outside', input_tokens: 99,
    }));

    const oneHour = await storage.metering!.queryWindowSnapshot({ asOfMs: asOf, range: '1h', groupBy: 'time' });
    expect(oneHour.bucketMs).toBe(300_000);
    expect(oneHour.all).toMatchObject({ inputTokens: 18, outputTokens: 4, upstreamAttempts: 5 });
    expect(oneHour.data.map((row) => [row.bucketStartMs, row.dimension, row.metrics.inputTokens, row.metrics.upstreamAttempts]))
      .toEqual([
        [start, 'model-alpha', 15, 2],
        [start + 300_000, 'model-alpha', 3, 1],
        [start + 300_000, 'model-beta', 0, 1],
        [asOf - 300_000, 'unknown', 0, 1],
      ]);
    expect((await storage.metering!.queryWindowSnapshot({ asOfMs: asOf, range: '12h', groupBy: 'time' })).bucketMs)
      .toBe(3_600_000);
    expect((await storage.metering!.queryWindowSnapshot({ asOfMs: asOf, range: '24h', groupBy: 'time' })).bucketMs)
      .toBe(7_200_000);
  });

  test('uses exact inclusive/exclusive bounds for 1h and 24h windows', async () => {
    const { storage } = createStorage();
    const asOf = Date.now();
    await storage.metering!.recordAttempt(attempt({ attempt_id: 'lower', request_id: 'lower', finished_at_ms: asOf - 24 * 60 * 60_000, input_tokens: 1 }));
    await storage.metering!.recordAttempt(attempt({ attempt_id: 'inside', request_id: 'inside', finished_at_ms: asOf - 1, input_tokens: 2 }));
    await storage.metering!.recordAttempt(attempt({ attempt_id: 'upper', request_id: 'upper', finished_at_ms: asOf, input_tokens: 4 }));
    expect((await storage.metering!.queryWindowSnapshot({ asOfMs: asOf, range: '24h', groupBy: 'model' })).all.inputTokens).toBe(3);
    const hourStart = asOf - 60 * 60_000;
    await storage.metering!.recordAttempt(attempt({ attempt_id: 'hour-lower', request_id: 'hour-lower', finished_at_ms: hourStart, input_tokens: 8 }));
    expect((await storage.metering!.queryWindowSnapshot({ asOfMs: asOf, range: '1h', groupBy: 'model' })).all.inputTokens).toBe(10);
  });

  test('page ranges query consecutive elapsed windows with hourly or daily buckets and matching model totals', async () => {
    const { storage } = createStorage();
    const asOf = Date.now();
    const day = 86_400_000;
    for (const [id, offset, tokens] of [['today', 1, 1], ['two-days', 2 * day, 2], ['six-days', 6 * day, 4], ['twenty-days', 20 * day, 8], ['thirty-days', 30 * day, 16]] as const) {
      await storage.metering!.recordAttempt(attempt({ attempt_id: id, finished_at_ms: asOf - offset, input_tokens: tokens }));
    }
    await storage.metering!.recordAttempt(attempt({ attempt_id: 'upper-exclusive', finished_at_ms: asOf, input_tokens: 1000 }));
    for (const [range, count, bucketMs, total] of [['1d', 24, 3_600_000, 1], ['7d', 7, day, 7], ['30d', 30, day, 31]] as const) {
      const snapshot = await storage.metering!.queryWindowSnapshot({ asOfMs: asOf, range, groupBy: 'time' });
      const models = await storage.metering!.queryWindowSnapshot({ asOfMs: asOf, range, groupBy: 'model' });
      expect(snapshot.bucketMs).toBe(bucketMs);
      expect(snapshot.bucketStarts).toHaveLength(count);
      expect(snapshot.bucketStarts![0]).toBe(asOf - count * bucketMs);
      expect(snapshot.bucketStarts!.at(-1)! + bucketMs).toBe(asOf);
      expect(snapshot.all.inputTokens).toBe(total);
      expect(models.all).toEqual(snapshot.all);
      expect(snapshot.data.reduce((sum, row) => sum + row.metrics.inputTokens, 0)).toBe(total);
      expect(snapshot.data.every(row => snapshot.bucketStarts!.includes(row.bucketStartMs!))).toBe(true);
    }
  });

  test('31-day retention preserves the first day of a full 31-day local month and rejects older writes', async () => {
    const { storage, db } = createStorage();
    const asOf = Date.UTC(2026, 9, 31, 12);
    const clock = spyOn(Date, 'now').mockReturnValue(asOf);
    const day = 86_400_000;
    try {
      const first = Date.UTC(2026, 8, 30, 16); // Oct 1 midnight in Shanghai.
      await storage.metering!.recordAttempt(attempt({ attempt_id: 'month-lower', finished_at_ms: first, input_tokens: 10 }));
      await storage.metering!.recordAttempt(attempt({ attempt_id: 'before-month', finished_at_ms: first - 1, input_tokens: 100 }));
      await storage.metering!.recordAttempt(attempt({ attempt_id: 'retention-boundary', finished_at_ms: asOf - 31 * day, input_tokens: 500 }));
      await storage.metering!.recordAttempt(attempt({ attempt_id: 'month-last', finished_at_ms: asOf - 1, input_tokens: 5 }));
      const month = await storage.metering!.queryWindowSnapshot({ asOfMs: asOf, range: 'month', groupBy: 'time', timeZone: 'Asia/Shanghai' });
      expect(month.bucketStarts).toHaveLength(31);
      expect(month.bucketStarts![0]).toBe(first);
      expect(month.all.inputTokens).toBe(15);
      expect(month.data.map(row => row.metrics.inputTokens)).toEqual([10, 5]);
      expect(db.query('SELECT count(*) AS count FROM token_stats_attempts').get()).toEqual({ count: 4 });
      await expect(storage.metering!.recordAttempt(attempt({ finished_at_ms: asOf - 31 * day - 1 }))).rejects.toThrow('31-day retention');
    } finally { clock.mockRestore(); }
  });

  test('calendar buckets honor Monday, month boundaries, timezone and DST transitions', async () => {
    const { storage } = createStorage();
    const asOf = Date.UTC(2026, 10, 2, 18);
    const clock = spyOn(Date, 'now').mockReturnValue(asOf);
    try {
      await storage.metering!.recordAttempt(attempt({ finished_at_ms: Date.UTC(2026, 10, 1, 4), input_tokens: 2 }));
      await storage.metering!.recordAttempt(attempt({ finished_at_ms: Date.UTC(2026, 10, 2, 4, 59), input_tokens: 3 }));
      await storage.metering!.recordAttempt(attempt({ finished_at_ms: Date.UTC(2026, 10, 2, 5), input_tokens: 7 }));
      const month = await storage.metering!.queryWindowSnapshot({ asOfMs: asOf, range: 'month', groupBy: 'time', timeZone: 'America/New_York' });
      expect(month.bucketStarts).toEqual([Date.UTC(2026, 10, 1, 4), Date.UTC(2026, 10, 2, 5)]);
      expect(month.data.map(row => row.metrics.inputTokens)).toEqual([5, 7]);
      const week = await storage.metering!.queryWindowSnapshot({ asOfMs: asOf, range: 'week', groupBy: 'time', timeZone: 'America/New_York' });
      expect(week.bucketStarts).toEqual([Date.UTC(2026, 10, 2, 5)]);
      expect(week.all.inputTokens).toBe(7);
    } finally { clock.mockRestore(); }
  });

  test('empty source table returns zero totals and no grouped rows', async () => {
    const { storage } = createStorage();
    const result = await storage.metering!.queryWindowSnapshot({ asOfMs: Date.now(), range: '1h', groupBy: 'model' });
    expect(result.present).toBe(false);
    expect(result.all.upstreamAttempts).toBe(0);
    expect(result.all.estimatedCostUsd).toBeNull();
    expect(result.data).toEqual([]);
  });

  test('round-trips cost NULL, zero, sums, windows, groups, and CHECK validation', async () => {
    const { db, storage } = createStorage();
    const now = Date.now();
    await storage.metering!.recordAttempt(attempt({
      attempt_id: 'cost-priced', request_id: 'cost-priced', finished_at_ms: now, model: 'xai/grok', cost_usd: 0.2585,
    }));
    await storage.metering!.recordAttempt(attempt({
      attempt_id: 'cost-zero', request_id: 'cost-zero', finished_at_ms: now, model: 'gpt-zero', route_id: '/zero', cost_usd: 0,
    }));
    await storage.metering!.recordAttempt(attempt({
      attempt_id: 'cost-unknown', request_id: 'cost-unknown', finished_at_ms: now, model: 'unknown', route_id: '/unknown', cost_usd: null,
    }));
    await storage.metering!.recordAttempt(attempt({
      attempt_id: 'cost-older', request_id: 'cost-older', finished_at_ms: now - 2 * 60 * 60_000, model: 'xai/grok', cost_usd: 0.125,
    }));

    expect(db.query('SELECT cost_usd FROM token_stats_attempts WHERE attempt_id = ?').get('cost-priced'))
      .toEqual({ cost_usd: 0.2585 });
    const oneHour = await storage.metering!.queryWindowSnapshot({ asOfMs: now + 1, range: '1h', groupBy: 'model' });
    expect(oneHour.all.estimatedCostUsd).toBe(0.2585);
    expect(oneHour.data.map((row) => [row.dimension, row.metrics.estimatedCostUsd]))
      .toEqual([['gpt-zero', 0], ['unknown', null], ['xai/grok', 0.2585]]);
    const twelveHours = await storage.metering!.queryWindowSnapshot({ asOfMs: now + 1, range: '12h', groupBy: 'model' });
    expect(twelveHours.all.estimatedCostUsd).toBe(0.3835);

    await expect(storage.metering!.recordAttempt(attempt({ cost_usd: -0.01 })))
      .rejects.toThrow('invalid token-stats cost_usd');
    const invalidCost = db.query(`INSERT INTO token_stats_attempts (
      attempt_id, request_id, finished_at_ms, route_id, upstream_id, provider, outcome, model,
      input_tokens, output_tokens, input_source, output_source,
      cache_read_tokens, cache_write_tokens, cost_usd, observation_incomplete
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    expect(() => invalidCost.run(
      'cost-check-failed', 'cost-check-failed', now, '/chat', 'pool-a', 'openai', 'success', 'gpt-4o-mini',
      0, 0, 'usage', 'usage', null, null, -0.01, 0,
    )).toThrow(/CHECK constraint failed/);
  });

  test('rejects malformed rows before persistence and leaves SQLite usable after write failure', async () => {
    const { db, storage } = createStorage();
    db.run('PRAGMA busy_timeout = 5000');
    expect(busyTimeout(db)).toBe(5000);
    await expect(storage.metering!.recordAttempt(attempt({ input_tokens: -1 }))).rejects.toThrow('invalid token-stats input_tokens');
    await expect(storage.metering!.recordAttempt(attempt({ input_tokens: null }))).rejects.toThrow('value/source mismatch');
    expect(busyTimeout(db)).toBe(5000);
    db.run("CREATE TRIGGER reject_attempt BEFORE INSERT ON token_stats_attempts BEGIN SELECT RAISE(ABORT, 'injected'); END");
    const row = attempt();
    await expect(storage.metering!.recordAttempt(row)).rejects.toThrow('injected');
    expect(busyTimeout(db)).toBe(5000);
    db.run('DROP TRIGGER reject_attempt');
    await storage.metering!.recordAttempt(row);
    expect(busyTimeout(db)).toBe(5000);
    expect((await storage.metering!.queryWindowSnapshot({ asOfMs: row.finished_at_ms + 1, range: '1h', groupBy: 'model' })).all.upstreamAttempts).toBe(1);
  });

  test('removes at most one fixed 500-row expired batch per write', async () => {
    const { db, storage } = createStorage();
    const expired = Date.now() - 31 * 24 * 60 * 60_000 - 1;
    const insert = db.query(`INSERT INTO token_stats_attempts (
      attempt_id, request_id, finished_at_ms, route_id, upstream_id, provider, outcome, model,
      input_tokens, output_tokens, input_source, output_source, cache_read_tokens, cache_write_tokens, cost_usd, observation_incomplete
    ) VALUES (?, ?, ?, '/r', 'u', 'openai', 'ok', 'unknown', NULL, NULL, 'unknown', 'unknown', NULL, NULL, NULL, 0)`);
    db.run('BEGIN TRANSACTION');
    try {
      for (let i = 0; i < 503; i++) insert.run(`expired-${i}`, `request-${i}`, expired);
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
    await storage.metering!.recordAttempt(attempt());
    expect(db.query("SELECT count(*) AS count FROM token_stats_attempts WHERE attempt_id LIKE 'expired-%'").get())
      .toEqual({ count: 3 });
  });

  test('metering remains a frozen, revocable token-stats-only capability', async () => {
    const { db, storage } = createStorage();
    expect(new SQLitePluginStorage(db, 'other-plugin').metering).toBeUndefined();
    const capability = createPluginStorageCapability(db, 'token-stats');
    const metering = capability.storage.metering!;
    expect(Object.isFrozen(metering)).toBe(true);
    capability.revoke();
    await expect(metering.recordAttempt(attempt())).rejects.toThrow('plugin storage capability is revoked');
    await expect(metering.queryWindowSnapshot({ asOfMs: Date.now(), range: '1h', groupBy: 'model' }))
      .rejects.toThrow('plugin storage capability is revoked');
  });
});
