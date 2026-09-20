import { mock } from 'bun:test';

const accessDb = process.env.BUNGEE_ACCESS_DB_PATH;
if (!accessDb) throw new Error('BUNGEE_ACCESS_DB_PATH is required');

async function main(): Promise<void> {
  const { MigrationManager } = await import('../../src/migrations/migration-manager');
  const migration = await new MigrationManager(accessDb!).migrate();
  if (!migration.success) throw new Error(`migration failed: ${migration.error ?? 'unknown error'}`);

  const { AttemptCleanupError } = await import('../../src/worker/request/proxy');
  const proxyTargets: string[] = [];
  mock.module('../../src/worker/request/proxy', () => ({
    AttemptCleanupError,
    isManagedUpstreamAccessError: () => false,
    isUpstreamPhaseFailoverSignal: () => false,
    proxyRequest: async (_snapshot: unknown, _route: unknown, upstream: { target: string; upstream_id: string }) => {
      proxyTargets.push(upstream.target);
      return {
        response: new Response('retryable', { status: 503 }),
        completion: Promise.resolve({ status: 'completed' as const }),
        cleanup: async () => {
          throw new AttemptCleanupError('injected AttemptCleanupError at proxy boundary');
        },
        upstreamId: upstream.upstream_id,
      };
    },
  }));

  const { RequestLogger } = await import('../../src/logger/request-logger');
  const { accessLogWriter } = await import('../../src/logger/access-log-writer');
  const { fileLogWriter } = await import('../../src/logger/file-log-writer');
  const { LogQueryService } = await import('../../src/api/logs');
  const { handleRequest } = await import('../../src/worker/request/handler');
  const { initializeRuntimeState, runtimeState } = await import('../../src/worker/state/runtime-state');

  if (typeof RequestLogger !== 'function') throw new Error('real RequestLogger was not loaded');
  const config = {
    services: [{
      name: 'cleanup-terminal',
      failover: { enabled: true, retry_on: [503] },
      endpoints: [
        { id: 'first', target: 'https://first.example.test', priority: 0 },
        { id: 'fallback', target: 'https://fallback.example.test', priority: 1 },
      ],
    }],
    routes: [{ path: '/stats-cleanup-terminal', service: 'cleanup-terminal' }],
  } as any;

  try {
    initializeRuntimeState(config);
    const response = await handleRequest(new Request('http://proxy.test/stats-cleanup-terminal'), config);
    await accessLogWriter.flush();
    const stats = await new LogQueryService(accessLogWriter.getDatabase()).getStats();
    console.log(`RESULT:${JSON.stringify({ status: response.status, proxyTargets, stats })}`);
  } finally {
    runtimeState.clear();
    await Promise.all([accessLogWriter.close(), fileLogWriter.close()]);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
