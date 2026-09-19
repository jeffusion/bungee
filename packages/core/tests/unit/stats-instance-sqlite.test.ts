import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MigrationManager } from '../../src/migrations';
import { LogQueryService } from '../../src/api/logs';
import { AccessLogWriter } from '../../src/logger/access-log-writer';

describe('instance stats backed by access.db', () => {
  test('combines independent writers, retries, and a restart without file stats', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungee-instance-stats-'));
    const dbPath = join(root, 'access.db');
    const base = Math.floor((Date.now() - 20_000) / 10_000) * 10_000;

    try {
      expect((await new MigrationManager(dbPath).migrate()).success).toBeTrue();

      const first = new AccessLogWriter(dbPath);
      const second = new AccessLogWriter(dbPath);
      first.write({
        requestId: 'retry-1',
        parentRequestId: 'chain-1',
        timestamp: base,
        method: 'GET',
        path: '/test',
        status: 502,
        duration: 30,
        success: false,
        isFailoverAttempt: true,
        attemptNumber: 1,
        requestType: 'retry',
      });
      second.write({
        requestId: 'chain-1',
        timestamp: base + 100,
        method: 'GET',
        path: '/test',
        status: 200,
        duration: 40,
        success: true,
        attemptNumber: 2,
        requestType: 'final',
      });
      second.write({
        requestId: 'chain-2',
        timestamp: base + 1_000,
        method: 'GET',
        path: '/test',
        status: 503,
        duration: 20,
        success: false,
        requestType: 'final',
      });
      await Promise.all([first.close(), second.close()]);

      const restarted = new AccessLogWriter(dbPath);
      const service = new LogQueryService(restarted.getDatabase());
      await expect(service.getStats(base - 1, base + 2_000)).resolves.toEqual({
        totalRequests: 2,
        successRequests: 1,
        failedRequests: 1,
        avgResponseTime: 80,
      });

      const history = await service.getCumulativeHistory(base, base + 60 * 60 * 1000, '10s');
      expect(history).toHaveLength(360);
      expect(history.at(-1)).toEqual({
        timestamp: base + 60 * 60 * 1000,
        requests: 2,
        errors: 1,
        responseTime: 80,
      });
      expect((await service.getCumulativeHistory(
        Math.floor(base / 60_000) * 60_000,
        Math.floor(base / 60_000) * 60_000 + 60 * 60 * 1000,
        '1m',
      ))).toHaveLength(60);
      expect((await service.getCumulativeHistory(
        Math.floor(base / 300_000) * 300_000,
        Math.floor(base / 300_000) * 300_000 + 60 * 60 * 1000,
        '5m',
      ))).toHaveLength(12);

      await restarted.close();
      expect(existsSync(join(root, 'stats'))).toBeFalse();
      expect(existsSync(join(root, 'cumulative.json'))).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('returns zero stats for an empty access database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungee-empty-stats-'));
    const dbPath = join(root, 'access.db');
    try {
      expect((await new MigrationManager(dbPath).migrate()).success).toBeTrue();
      const writer = new AccessLogWriter(dbPath);
      const service = new LogQueryService(writer.getDatabase());
      await expect(service.getStats()).resolves.toEqual({
        totalRequests: 0,
        successRequests: 0,
        failedRequests: 0,
        avgResponseTime: 0,
      });
      expect(await service.getChainCount(0, 60_000)).toBe(0);
      expect((await service.getCumulativeHistory(0, 60 * 60 * 1000, '5m')).every(point => (
        point.requests === 0 && point.errors === 0 && point.responseTime === 0
      ))).toBeTrue();
      await writer.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
