import { afterEach, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { MigrationManager } from '../../../src/migrations';
import { AccessLogWriter } from '../../../src/logger/access-log-writer';
import { LogQueryService } from '../../../src/api/logs';
import { LogsHandler } from '../../../src/api/handlers/logs';
import { StatsHandler } from '../../../src/api/handlers/stats';

const roots: string[] = [];
const writers: AccessLogWriter[] = [];
afterEach(async () => {
  for (const writer of writers.splice(0)) await writer.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bungee-transport-')); roots.push(root);
  const dbPath = join(root, 'access.db');
  expect((await new MigrationManager(dbPath).migrate()).success).toBeTrue();
  const writer = new AccessLogWriter(dbPath); writers.push(writer);
  return { writer, db: writer.getDatabase(), query: new LogQueryService(writer.getDatabase()) };
}
const row = (requestId: string, extra: Record<string, any> = {}) => ({ requestId, timestamp: 60_000, method: 'POST', path: '/test',
  status: 200, duration: 10, upstream: 'http://upstream', ...extra });

test('transport updates survive before enqueue, queued, persisted and provisional final replacement', async () => {
  const { writer, db } = await fixture();
  for (const phase of ['before', 'queued', 'persisted']) {
    if (phase === 'before') writer.updateTransportOutcome(phase, 'failed', 'request_timeout');
    writer.write(row(phase, { transportOutcome: 'pending' }));
    if (phase === 'persisted') await writer.flush();
    if (phase !== 'before') writer.updateTransportOutcome(phase, 'failed', 'request_timeout');
    await writer.flush();
    expect(db.query('SELECT status,transport_outcome,transport_code FROM access_logs WHERE request_id=?').get(phase))
      .toEqual({ status: 200, transport_outcome: 'failed', transport_code: 'request_timeout' });
  }
  writer.write(row('stream', { transportOutcome: 'pending' })); await writer.flush();
  writer.updateTransportOutcome('stream', 'completed');
  writer.write(row('stream', { duration: 100, respBodyId: 'body', transportOutcome: 'completed', replacePendingTransport: true }));
  await writer.flush();
  expect(db.query('SELECT COUNT(*) n,duration,resp_body_id,transport_outcome FROM access_logs WHERE request_id=?').get('stream'))
    .toEqual({ n: 1, duration: 100, resp_body_id: 'body', transport_outcome: 'completed' });
});

test('final chain filtering, details, exports and stats share independent HTTP and transport outcomes', async () => {
  const { writer, query } = await fixture();
  writer.write(row('retry', { parentRequestId: 'chain', requestType: 'retry', attemptNumber: 1, status: 503, success: false, transportOutcome: 'failed',
    transportCode: 'request_timeout', protocolOutcome: 'failed', protocolCode: 'request_timeout' }));
  writer.write(row('final', { parentRequestId: 'chain', requestType: 'final', attemptNumber: 2, transportOutcome: 'completed' }));
  writer.write(row('cancel', { transportOutcome: 'cancelled', protocolOutcome: 'failed', success: false }));
  writer.write(row('http500', { status: 500, transportOutcome: 'completed', protocolOutcome: 'failed', success: false }));
  writer.write(row('business', { transportOutcome: 'completed', protocolOutcome: 'failed', success: false }));
  writer.write(row('historical', { success: true }));
  writer.write(row('excluded', { timestamp: 120_000, transportOutcome: 'failed' }));
  await writer.flush();
  const window = { startTime: 60_000, endTime: 120_000 };
  const chains = await query.queryChains({ ...window, transportOutcome: 'completed' });
  expect(chains.total).toBe(3);
  expect(chains.data.find(entry => entry.chainId === 'chain')).toMatchObject({ status: 503, chainStatus: 200, chainTransportOutcome: 'completed' });
  expect((await query.getChainDetail('chain'))?.chain.chainTransportOutcome).toBe('completed');
  const exported = JSON.parse(await query.exportLogs({ ...window, transportOutcome: 'completed', groupBy: 'chain' }));
  expect(exported.map((entry: any) => entry.chainId).sort()).toEqual(chains.data.map(entry => entry.chainId).sort());
  const chainCsv = await query.exportLogs({ ...window, transportOutcome: 'completed', groupBy: 'chain' }, 'csv');
  const [header, ...lines] = chainCsv.split('\n').map(line => line.split(','));
  const retry = Object.fromEntries(header.map((key, index) => [key, lines.find(line => line[0] === 'retry')![index]]));
  expect(retry).toMatchObject({ requestId: 'retry', status: '503', requestType: 'retry', transportOutcome: 'failed',
    transportCode: 'request_timeout', protocolOutcome: 'failed', protocolCode: 'request_timeout',
    chainId: 'chain', chainStatus: '200', chainTransportOutcome: 'completed', chainTransportCode: '' });
  const csv = await query.exportLogs({ ...window, transportOutcome: 'cancelled' }, 'csv');
  expect(csv).toContain('transportOutcome,transportCode,protocolOutcome,protocolCode');
  expect(csv).toContain(',cancelled,,failed,');
  const stats = await query.getDashboardStats(60_000, 120_000, 'minute');
  expect(stats.httpStatusCounts).toEqual({ status2xx: 4, status3xx: 0, status4xx: 0, status5xx: 1, statusOther: 0 });
  expect(stats.transportCounts).toEqual({ pending: 0, completed: 3, failed: 0, cancelled: 1, unknown: 1 });
  expect(stats.upstreams[0].transportCounts).toEqual({ pending: 0, completed: 3, failed: 1, cancelled: 1, unknown: 1 });
  const dto = await (await new StatsHandler(query).getDashboard(new Request('http://localhost/api/stats/dashboard?range=1h'))).json();
  expect(dto.transportCounts).toEqual({ pending: 0, completed: 0, failed: 0, cancelled: 0, unknown: 0 });
});

test('a late transport update retries after a transient database failure even with no queued rows', async () => {
  const { writer, db } = await fixture();
  writer.write(row('late', { transportOutcome: 'pending' })); await writer.flush();
  const originalQuery = db.query.bind(db);
  db.query = ((sql: string) => {
    if (sql.startsWith('UPDATE access_logs SET transport_outcome')) throw new Error('database is locked');
    return originalQuery(sql);
  }) as typeof db.query;
  try { writer.updateTransportOutcome('late', 'failed', 'stream_read_failed'); }
  finally { db.query = originalQuery; }
  await writer.flush();
  expect(db.query('SELECT transport_outcome,transport_code FROM access_logs WHERE request_id=?').get('late'))
    .toEqual({ transport_outcome: 'failed', transport_code: 'stream_read_failed' });
});

test('HTTP multi-value and transport filter validation is identical for query and export', async () => {
  const { writer, query } = await fixture();
  writer.write(row('cancel', { transportOutcome: 'cancelled' }));
  writer.write(row('ok', { transportOutcome: 'completed' })); await writer.flush();
  const handler = new LogsHandler({ logQueryService: query, bodyStorage: {} as any, headerStorage: {} as any, cleanupService: {} as any });
  for (const method of [handler.query.bind(handler), handler.export.bind(handler)]) {
    for (const invalid of ['transportOutcome=', 'transportOutcome=failed&transportOutcome=completed', 'transportOutcome=business_error', 'status=200junk', 'status=999']) {
      expect((await method(new Request(`http://localhost/api/logs?${invalid}`))).status).toBe(400);
    }
    const response = await method(new Request('http://localhost/api/logs?status=200&status=500&transportOutcome=cancelled'));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect((Array.isArray(data) ? data : data.data).map((entry: any) => entry.requestId)).toEqual(['cancel']);
  }
});

test('unknown transport remains null regardless of HTTP or protocol results', async () => {
  const {writer,db}=await fixture();
  writer.write(row('historical',{status:200,success:true,protocolOutcome:'completed'}));await writer.flush();
  expect(db.query('SELECT transport_outcome,transport_code FROM access_logs WHERE request_id=?').get('historical')).toEqual({transport_outcome:null,transport_code:null});
});

test('request counts combine HTTP and completed transport while excluding cancellation, pending and unknown', async () => {
  const { writer, query } = await fixture();
  const statuses = [0, 200, 204, 299, 301, 404, 503];
  const outcomes = ['completed', 'failed', 'cancelled', 'pending', undefined] as const;
  for (const status of statuses) for (const transportOutcome of outcomes) {
    writer.write(row(`${status}-${transportOutcome}`, { status, transportOutcome,
      upstream: `http://status-${status}-${transportOutcome}`, success: false, protocolOutcome: 'failed' }));
  }
  // A recovered retry contributes a failed upstream attempt, but a successful client chain.
  writer.write(row('retry-result', { status: 503, transportOutcome: 'completed', parentRequestId: 'recovered', requestType: 'retry', attemptNumber: 1 }));
  writer.write(row('final-result', { transportOutcome: 'completed', parentRequestId: 'recovered', requestType: 'final', attemptNumber: 2 }));
  writer.write(row('cancelled-only', { timestamp: 120_000, status: 503, transportOutcome: 'cancelled', success: false }));
  await writer.flush();
  const stats = await query.getDashboardStats(60_000, 180_000, 'minute');
  expect(stats.requestCounts).toEqual({ success: 4, failed: 11 });
  expect(stats.timeSeries.map(point => point.requestCounts)).toEqual([{ success: 4, failed: 11 }, { success: 0, failed: 0 }]);
  expect((await query.getStats(60_000, 180_000)).requestCounts).toEqual(stats.requestCounts);
  for (const status of statuses) for (const outcome of outcomes) {
    const expected = outcome === 'completed' && status >= 200 && status < 300 ? { success: 1, failed: 0 }
      : outcome === 'failed' || outcome === 'completed' ? { success: 0, failed: 1 } : { success: 0, failed: 0 };
    expect(stats.upstreams.find(entry => entry.upstream === `http://status-${status}-${outcome}`)?.requestCounts).toEqual(expected);
  }
  expect(stats.upstreams.find(entry => entry.upstream === 'http://upstream')?.requestCounts).toEqual({ success: 1, failed: 1 });
  expect((await query.getDashboardStats(180_000, 240_000, 'minute')).requestCounts).toEqual({ success: 0, failed: 0 });
  // DTOs use the same joint counts; transport/HTTP totals remain independently available.
  const handler = new StatsHandler(query);
  const clock = spyOn(Date, 'now').mockReturnValue(180_000);
  try {
    const history = await (await handler.getHistoryV2(new Request('http://localhost/api/stats/history/v2?range=1h'))).json();
    expect(history.requestCounts.success.reduce((sum: number, value: number) => sum + value, 0)).toBe(4);
    expect(history.requestCounts.failed.reduce((sum: number, value: number) => sum + value, 0)).toBe(11);
    const dashboard = await (await handler.getDashboard(new Request('http://localhost/api/stats/dashboard?range=1h'))).json();
    expect(dashboard.requestCounts).toEqual({ success: 4, failed: 11 });
    expect(dashboard.history.requestCounts).toEqual(history.requestCounts);
  } finally { clock.mockRestore(); }
  const snapshot = await (await handler.getSnapshot()).json();
  expect(snapshot.requestCounts).toEqual({ success: 4, failed: 11 });
});
