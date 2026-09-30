import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectAccessDatabaseJournalMode } from '../../src/access-database';
import { migrations, MigrationManager } from '../../src/migrations';
import { SQLitePluginStorage } from '../../src/plugin-storage';
import type { TokenStatsAttempt } from '../../src/plugin.types';
import { createControl } from '../../../../plugins/token-stats/server/control';
import { STATEFUL_INTEGRATION_TEST_TIMEOUT_MS } from '../helpers/test-budgets';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function legacyDatabase(): { path: string; db: Database } {
  const root = mkdtempSync(join(tmpdir(), 'bungee-token-stats-upgrade-'));
  roots.push(root);
  const path = join(root, 'access.db');
  selectAccessDatabaseJournalMode(path);
  const db = new Database(path, { strict: true });
  db.run('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  db.transaction(() => {
    for (const migration of migrations.filter((migration) => migration.version < '005')) {
      migration.up(db);
      db.query('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(migration.version, migration.name, Date.now());
    }
    // Schema from an early deployed v005, which already has its migration record.
    db.run(`CREATE TABLE token_stats_attempts (
      attempt_id TEXT PRIMARY KEY, request_id TEXT NOT NULL,
      finished_at_ms INTEGER NOT NULL CHECK (finished_at_ms >= 0),
      route_id TEXT NOT NULL, upstream_id TEXT NOT NULL, provider TEXT NOT NULL, outcome TEXT NOT NULL,
      input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
      output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
      input_source TEXT NOT NULL CHECK (input_source IN ('usage', 'estimated', 'unknown')),
      output_source TEXT NOT NULL CHECK (output_source IN ('usage', 'estimated', 'unknown')),
      cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
      cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
      observation_incomplete INTEGER NOT NULL CHECK (observation_incomplete IN (0, 1)),
      CHECK ((input_source = 'unknown') = (input_tokens IS NULL)),
      CHECK ((output_source = 'unknown') = (output_tokens IS NULL))
    )`);
    db.run('CREATE INDEX idx_token_stats_attempts_finished ON token_stats_attempts(finished_at_ms)');
    db.query('INSERT INTO schema_migrations VALUES (?, ?, ?)').run('005', 'token_stats_metering', Date.now());
  })();
  return { path, db };
}

function row(overrides: Partial<TokenStatsAttempt> = {}): TokenStatsAttempt {
  return {
    attempt_id: 'new-partial', request_id: 'new-request', finished_at_ms: Date.now() - 1_000,
    route_id: 'route', upstream_id: 'upstream', provider: 'openai', outcome: 'completed', model: 'gpt-4o-mini',
    input_tokens: 7, output_tokens: null, input_source: 'partial', output_source: 'unknown',
    cache_read_tokens: null, cache_write_tokens: null, cost_usd: 0.25, observation_incomplete: true,
    ...overrides,
  };
}

function insertLegacy(db: Database): void {
  db.query(`INSERT INTO token_stats_attempts VALUES (?, ?, ?, 'route', 'upstream', 'openai', 'completed',
    11, 3, 'usage', 'estimated', 2, 1, 0)`)
    .run('legacy-attempt', 'legacy-request', Date.now() - 2_000);
}

async function stats(db: Database, groupBy: 'model' | 'time'): Promise<Response> {
  const host = {
    signal: new AbortController().signal,
    storage: new SQLitePluginStorage(db, 'token-stats'),
    secretStore: { namespace: 'migration-test', async get() { return null; }, async compareAndSet() { return 1; }, async delete() {} },
  };
  const control = createControl(host);
  try {
    return await control.api[0]!.invoke({
      ...host, request: new Request(`http://localhost/stats?range=1h&groupBy=${groupBy}`),
      requestSignal: new AbortController().signal,
    });
  } finally { control.dispose(); }
}

describe('token-stats deployed v005 schema upgrade', () => {
  test('repairs the deployed internal_error, preserves old usage, and accepts partial usage', async () => {
    const fixture = legacyDatabase();
    try {
      insertLegacy(fixture.db);
      const before = await stats(fixture.db, 'model');
      expect(before.status).toBe(500);
      expect(await before.json()).toEqual({ error: 'internal_error' });
      fixture.db.close();

      expect((await new MigrationManager(fixture.path).migrate()).success).toBeTrue();
      fixture.db = new Database(fixture.path, { strict: true });
      expect(fixture.db.query('SELECT * FROM token_stats_attempts WHERE attempt_id = ?').get('legacy-attempt'))
        .toMatchObject({ model: 'unknown', cost_usd: null, input_tokens: 11, output_tokens: 3, cache_read_tokens: 2, cache_write_tokens: 1 });
      await new SQLitePluginStorage(fixture.db, 'token-stats').metering!.recordAttempt(row());
      for (const groupBy of ['model', 'time'] as const) {
        const response = await stats(fixture.db, groupBy);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          groupBy, totalInputTokens: 18, totalOutputTokens: 3, logicalRequests: 2, upstreamAttempts: 2,
          estimatedCostUsd: 0.25,
        });
      }
      expect((await new MigrationManager(fixture.path).migrate()).success).toBeTrue();
      expect(fixture.db.query('SELECT COUNT(*) AS count FROM token_stats_attempts').get()).toEqual({ count: 2 });
      expect(fixture.db.query("SELECT version FROM schema_migrations WHERE version = '006'").get()).toEqual({ version: '006' });
    } finally { fixture.db.close(); }
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

  test('preserves model, cost, and partial rows when v005 already has the current schema', async () => {
    const fixture = legacyDatabase();
    try {
      fixture.db.run('DROP TABLE token_stats_attempts');
      migrations.find((migration) => migration.version === '005')!.up(fixture.db);
      await new SQLitePluginStorage(fixture.db, 'token-stats').metering!.recordAttempt(row());
      const before = fixture.db.query('SELECT * FROM token_stats_attempts').all();
      fixture.db.close();
      expect((await new MigrationManager(fixture.path).migrate()).success).toBeTrue();
      fixture.db = new Database(fixture.path, { strict: true });
      expect(fixture.db.query('SELECT * FROM token_stats_attempts').all()).toEqual(before);
      expect(fixture.db.query("SELECT name FROM sqlite_master WHERE name = 'idx_token_stats_attempts_finished'").get())
        .toEqual({ name: 'idx_token_stats_attempts_finished' });
    } finally { fixture.db.close(); }
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

  test('rolls back an incompatible source row without losing the old table or marking success', async () => {
    const fixture = legacyDatabase();
    try {
      insertLegacy(fixture.db);
      fixture.db.run('ALTER TABLE token_stats_attempts ADD COLUMN model TEXT');
      fixture.db.close();
      expect((await new MigrationManager(fixture.path).migrate()).success).toBeFalse();
      fixture.db = new Database(fixture.path, { strict: true });
      expect(fixture.db.query('SELECT input_tokens FROM token_stats_attempts').get()).toEqual({ input_tokens: 11 });
      expect(fixture.db.query("SELECT version FROM schema_migrations WHERE version = '006'").get()).toBeNull();
      expect(fixture.db.query("SELECT name FROM sqlite_master WHERE name = 'token_stats_attempts_v006'").get()).toBeNull();
    } finally { fixture.db.close(); }
  }, STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);
});
