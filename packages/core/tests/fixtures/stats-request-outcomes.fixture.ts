import type { AppConfig } from '@jeffusion/bungee-types';

type Scenario = 'managed' | 'failover' | 'cancelled' | 'edges' | 'aborted' | 'stats-api';

const scenario = process.argv[2] as Scenario;
const accessDb = process.env.BUNGEE_ACCESS_DB_PATH;

if (!accessDb || !['managed', 'failover', 'cancelled', 'edges', 'aborted', 'stats-api'].includes(scenario)) {
  throw new Error('usage: stats-request-outcomes.fixture.ts <managed|failover|cancelled|edges|aborted|stats-api>');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function closeWithin(action: () => Promise<void>): Promise<void> {
  await Promise.race([action(), sleep(500)]);
}

async function waitForLogs(
  writer: typeof import('../../src/logger/access-log-writer').accessLogWriter,
  path: string,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    await writer.flush();
    const result = writer.getDatabase().prepare('SELECT COUNT(*) AS count FROM access_logs WHERE path = ?').get(path) as { count: number };
    if (result.count >= count) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${count} access log(s) at ${path}`);
}

async function main(): Promise<void> {
  const { MigrationManager } = await import('../../src/migrations/migration-manager');
  const migration = await new MigrationManager(accessDb!).migrate();
  if (!migration.success) throw new Error(`migration failed: ${migration.error ?? 'unknown error'}`);

  const { accessLogWriter } = await import('../../src/logger/access-log-writer');
  const { fileLogWriter } = await import('../../src/logger/file-log-writer');
  const { handleRequest } = await import('../../src/worker/request/handler');
  const { initializeRuntimeState, runtimeState } = await import('../../src/worker/state/runtime-state');
  const { setPluginRegistry } = await import('../../src/worker/state/plugin-manager');
  const { setBoundControlClientProvider } = await import('../../src/config-worker/runtime-dependencies');
  const { LogQueryService } = await import('../../src/api/logs');

  const servers: Array<ReturnType<typeof Bun.serve>> = [];
  try {
    const serve = (config: AppConfig) => {
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request) => handleRequest(request, config, { servingRevision: 1 }),
      });
      servers.push(server);
      return server;
    };

    if (scenario === 'stats-api') {
      const { StatsHandler } = await import('../../src/api/handlers/stats');
      const { LogsHandler } = await import('../../src/api/handlers/logs');
      const statsHandler = new StatsHandler(new LogQueryService(accessLogWriter.getDatabase()));
      const logsHandler = new LogsHandler({
        logQueryService: new LogQueryService(accessLogWriter.getDatabase()),
        bodyStorage: {} as any,
        headerStorage: {} as any,
        cleanupService: {} as any,
      });
      const responseJson = async (response: Response | Promise<Response>) => {
        const resolved = await response;
        return { status: resolved.status, body: await resolved.json() };
      };
      const ranges = ['1h', '12h', '24h'];
      const upstream = await Promise.all(ranges.flatMap((range) => [
        responseJson(statsHandler.getUpstreamDistribution(new Request(`http://localhost/api/stats/upstream-distribution?range=${range}`))),
        responseJson(statsHandler.getUpstreamFailures(new Request(`http://localhost/api/stats/upstream-failures?range=${range}`))),
        responseJson(statsHandler.getUpstreamStatusCodes(new Request(`http://localhost/api/stats/upstream-status-codes?range=${range}`))),
        ...(['all', 'success', 'failure'] as const).map((type) => responseJson(statsHandler.getUnifiedUpstreamStats(new Request(`http://localhost/api/stats/upstream-stats?range=${range}&type=${type}`)))),
      ]));
      const logs = [
        await responseJson(await logsHandler.getStats(new Request('http://localhost/api/logs/stats?startTime=0&endTime=1'))),
        await responseJson(await logsHandler.getTimeSeriesStats(new Request('http://localhost/api/logs/stats/timeseries?startTime=0&endTime=60000&interval=minute'))),
      ];
      console.log(`RESULT:${JSON.stringify({ upstream, logs })}`);
      return;
    }

    if (scenario === 'managed') {
      let upstreamHits = 0;
      const upstream = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => {
          upstreamHits++;
          return new Response('must not reach managed upstream');
        },
      });
      servers.push(upstream);

      // Only the managed-control boundary is injected; client, handler, database and upstream are real.
      setPluginRegistry({
        getPluginStateSnapshot: () => ({
          pluginName: 'provider', discovery: 'discovered', validation: 'validated', persistedEnabled: 'enabled',
          manifest: {
            contributes: { upstreamSources: [{
              id: 'provider',
              credentialPolicy: {
                allowedOrigins: [`http://127.0.0.1:${upstream.port}`],
                allowedRequests: [{ pathname: '/control-unavailable', methods: ['POST'] }],
                allowedHeaderNames: ['authorization'],
              },
            }] },
          },
        }),
      } as any);
      const config = {
        services: [{
          name: 'managed',
          failover: { enabled: true, retry_on: [503] },
          endpoints: [{
            id: 'managed', target: `http://127.0.0.1:${upstream.port}`, priority: 0,
            plugins: [{ id: 'binding', name: 'provider', enabled: true, options: {} }],
            managedBy: { plugin: 'provider', contributionId: 'provider', bindingId: 'binding' },
          }, { id: 'fallback', target: `http://127.0.0.1:${upstream.port}`, priority: 1 }],
        }],
        routes: [{ path: '/control-unavailable', service: 'managed' }],
      } as any;
      initializeRuntimeState(config);
      const gateway = serve(config);
      const response = await fetch(`http://127.0.0.1:${gateway.port}/control-unavailable`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'test' }),
      });
      await waitForLogs(accessLogWriter, '/control-unavailable', 1);
      const stats = await new LogQueryService(accessLogWriter.getDatabase()).getStats();
      console.log(`RESULT:${JSON.stringify({ status: response.status, upstreamHits, stats })}`);
      return;
    }

    if (scenario === 'failover') {
      let upstreamHits = 0;
      const upstream = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        fetch: () => new Response(upstreamHits++ === 0 ? 'retry' : 'ok', { status: upstreamHits === 1 ? 503 : 200 }),
      });
      servers.push(upstream);
      const config = {
        services: [{
          name: 'failover', failover: { enabled: true, retry_on: [503] },
          endpoints: [
            { id: 'first', target: `http://127.0.0.1:${upstream.port}`, priority: 0 },
            { id: 'second', target: `http://127.0.0.1:${upstream.port}`, priority: 1 },
          ],
        }],
        routes: [{ path: '/failover', service: 'failover' }],
      } as any;
      initializeRuntimeState(config);
      const gateway = serve(config);
      const response = await fetch(`http://127.0.0.1:${gateway.port}/failover`, { method: 'POST', body: '{}' });
      await response.text();
      await waitForLogs(accessLogWriter, '/failover', 2);
      const stats = await new LogQueryService(accessLogWriter.getDatabase()).getStats();
      console.log(`RESULT:${JSON.stringify({ status: response.status, upstreamHits, stats })}`);
      return;
    }

    if (scenario === 'cancelled') {
      let interval: Timer | undefined;
      const upstream = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        fetch: () => new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: first\n\n'));
            interval = setInterval(() => controller.enqueue(new TextEncoder().encode('data: later\n\n')), 100);
          },
          cancel() {
            if (interval) clearInterval(interval);
          },
        }), { headers: { 'content-type': 'text/event-stream' } }),
      });
      servers.push(upstream);
      const config = {
        services: [{ name: 'sse', endpoints: [{ id: 'sse', target: `http://127.0.0.1:${upstream.port}` }] }],
        routes: [{ path: '/cancelled', service: 'sse' }],
      } as any;
      initializeRuntimeState(config);
      const gateway = serve(config);
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${gateway.port}/cancelled`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: true }),
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      if (!reader || (await reader.read()).done) throw new Error('expected first SSE chunk');
      await sleep(50);
      controller.abort('test client cancellation');
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      await waitForLogs(accessLogWriter, '/cancelled', 1);
      const stats = await new LogQueryService(accessLogWriter.getDatabase()).getStats();
      console.log(`RESULT:${JSON.stringify({ status: response.status, stats })}`);
      return;
    }

    if (scenario === 'aborted') {
      let fallbackHits = 0;
      const pending = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Promise<Response>(() => {}) });
      const fallback = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { fallbackHits++; return new Response('unexpected'); } });
      servers.push(pending, fallback);
      const config = {
        services: [{ name: 'aborted', failover: { enabled: true, retry_on: [503] }, endpoints: [
          { id: 'first', target: `http://127.0.0.1:${pending.port}`, priority: 0 },
          { id: 'second', target: `http://127.0.0.1:${fallback.port}`, priority: 1 },
        ] }],
        routes: [{ path: '/aborted', service: 'aborted' }],
      } as any;
      initializeRuntimeState(config);
      const gateway = serve(config);
      const controller = new AbortController();
      const request = fetch(`http://127.0.0.1:${gateway.port}/aborted`, { method: 'POST', body: '{}', signal: controller.signal });
      await sleep(100);
      controller.abort('test abort');
      await request.catch(() => undefined);
      await waitForLogs(accessLogWriter, '/aborted', 1);
      const stats = await new LogQueryService(accessLogWriter.getDatabase()).getStats();
      console.log(`RESULT:${JSON.stringify({ fallbackHits, stats })}`);
      return;
    }

    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('retry', { status: 503 }) });
    servers.push(upstream);
    const unavailable = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('unused') });
    const unavailablePort = unavailable.port;
    unavailable.stop(true);
    const config = {
      services: [{
        name: 'edges', failover: { enabled: true, retry_on: [503] },
        endpoints: [
          { id: 'retry', target: `http://127.0.0.1:${upstream.port}`, priority: 0 },
          { id: 'throws', target: `http://127.0.0.1:${unavailablePort}`, priority: 1 },
        ],
      }],
      routes: [
        { path: '/before-attempt', endpoints: [] },
        { path: '/after-attempt', service: 'edges' },
      ],
    } as any;
    initializeRuntimeState(config);
    const gateway = serve(config);
    const before = await fetch(`http://127.0.0.1:${gateway.port}/before-attempt`);
    const after = await fetch(`http://127.0.0.1:${gateway.port}/after-attempt`);
    await before.text();
    await after.text();
    await waitForLogs(accessLogWriter, '/before-attempt', 1);
    await waitForLogs(accessLogWriter, '/after-attempt', 2);
    const stats = await new LogQueryService(accessLogWriter.getDatabase()).getStats();
    console.log(`RESULT:${JSON.stringify({ before: before.status, after: after.status, stats })}`);
  } finally {
    setPluginRegistry(null);
    setBoundControlClientProvider(null);
    runtimeState.clear();
    for (const server of servers) {
      try { server.stop(true); } catch { /* best-effort fixture teardown */ }
    }
    await Promise.all([closeWithin(() => accessLogWriter.close()), closeWithin(() => fileLogWriter.close())]);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
