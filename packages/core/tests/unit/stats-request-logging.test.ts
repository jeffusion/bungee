import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { basename } from 'node:path';
import type { AppConfig } from '@jeffusion/bungee-types';
import {
  dataPlaneAccessDb,
  ensureDataPlaneSchema,
} from '../helpers/data-plane-runtime';
import {
  setWorkerRateLimitClient,
  type WorkerRateLimitHttpProvider,
} from '../../src/config-worker/rate-limit-provider';

let handleRequest: typeof import('../../src/worker/request/handler').handleRequest;
let accessLogWriter: typeof import('../../src/logger/access-log-writer').accessLogWriter;
const paths: string[] = [];

beforeAll(async () => {
  await ensureDataPlaneSchema();
  ({ handleRequest } = await import('../../src/worker/request/handler'));
  ({ accessLogWriter } = await import('../../src/logger/access-log-writer'));
});

afterEach(async () => {
  await accessLogWriter.flush();
  const db = accessLogWriter.getDatabase();
  for (const path of paths.splice(0)) {
    db.prepare('DELETE FROM access_logs WHERE path = ?').run(path);
  }
});

function pathFor(name: string): string {
  const path = `/stats-root-${name}-${crypto.randomUUID()}`;
  paths.push(path);
  return path;
}

async function request(
  path: string,
  config: AppConfig,
  expectedStatus: number,
  init?: RequestInit,
  runtimeContext?: { servingRevision?: number },
): Promise<Record<string, unknown>[]> {
  const response = await handleRequest(new Request(`http://localhost${path}`, init), config, runtimeContext);
  await accessLogWriter.flush();
  expect(response.status).toBe(expectedStatus);
  return accessLogWriter.getDatabase().prepare(
    'SELECT status, upstream, request_type, success FROM access_logs WHERE path = ? ORDER BY id DESC',
  ).all(path) as Record<string, unknown>[];
}

afterAll(() => {
  setWorkerRateLimitClient(null);
});

describe('root final access logging', () => {
  test('persists exactly one root final for route/auth/direct/redirect/CORS/no-upstream responses', async () => {
    const cases: Array<{ name: string; config: AppConfig; init?: RequestInit; status: number; success: number }> = [
      { name: '404', config: { routes: [] }, status: 404, success: 0 },
      {
        name: '401',
        config: { routes: [{ path: '/stats-root-401', auth: { enabled: true, tokens: ['expected'] }, endpoints: [] }] },
        init: { headers: { Authorization: 'Bearer wrong' } },
        status: 401,
        success: 0,
      },
      {
        name: 'direct',
        config: { routes: [{ path: '/stats-root-direct', endpoints: [], direct_response: { enabled: true, status: 200 } }] },
        status: 200,
        success: 1,
      },
      {
        name: 'redirect',
        config: { routes: [{ path: '/stats-root-redirect', endpoints: [], redirect: { enabled: true, url: 'https://example.com' } }] },
        status: 302,
        success: 1,
      },
      {
        name: 'cors',
        config: { routes: [{ path: '/stats-root-cors', endpoints: [], cors: { enabled: true, allowed_origins: ['*'] } }] },
        init: { method: 'OPTIONS', headers: { Origin: 'https://example.com' } },
        status: 204,
        success: 1,
      },
      {
        name: 'no-upstream',
        config: { routes: [{ path: '/stats-root-no-upstream', endpoints: [] }] },
        status: 500,
        success: 0,
      },
    ];

    for (const testCase of cases) {
      const path = pathFor(testCase.name);
      const rows = await request(path, testCase.config, testCase.status, testCase.init);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        status: testCase.status,
        upstream: null,
        request_type: 'final',
        success: testCase.success,
      });
    }

    const rateLimitConfig: AppConfig = {
      routes: [{
        path: '/stats-root-429',
        id: crypto.randomUUID(),
        endpoints: [],
        rate_limit: { enabled: true, requests_per_second: 1, burst: 1, key_expression: '{{ method }}' },
      }],
    };
    let debitCount = 0;
    const fakeRateLimitProvider: WorkerRateLimitHttpProvider = {
      client: {} as WorkerRateLimitHttpProvider['client'],
      async debit() {
        debitCount += 1;
        return debitCount === 1
          ? { allowed: true, reason: 'consumed', retry_after_ms: 0 }
          : { allowed: false, reason: 'rate_limited', retry_after_ms: 1_000 };
      },
      dispose() {},
    };
    setWorkerRateLimitClient(fakeRateLimitProvider);

    try {
      await request(pathFor('429-first'), rateLimitConfig, 500, undefined, { servingRevision: 1 });
      const rateLimitedRows = await request(pathFor('429-second'), rateLimitConfig, 429, undefined, { servingRevision: 1 });
      expect(rateLimitedRows).toHaveLength(1);
      expect(debitCount).toBe(2);
    } finally {
      setWorkerRateLimitClient(null);
    }

    expect(basename(dataPlaneAccessDb)).toBe('access.db');
  });
});
