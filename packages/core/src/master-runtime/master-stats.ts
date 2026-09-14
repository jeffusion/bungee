import { Database } from 'bun:sqlite';
import { dirname, join } from 'node:path';
import { StatsHandler } from '../api/handlers/stats';
import { LogQueryService } from '../api/logs';
import { LogsHandler, type LogsHandlerDependencies } from '../api/handlers/logs';
import { normalizeManagementPath } from '../api/management-path';
import { BodyStorageManager } from '../logger/body-storage';
import { HeaderStorageManager } from '../logger/header-storage';
import { LogCleanupService, type LogCleanupServiceOptions } from '../logger/log-cleanup';
import { initializeAccessDatabaseConnection } from '../access-database';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

const DATABASE_STATS_PATHS = new Set([
  '/api/stats',
  '/api/stats/history',
  '/api/stats/history/v2',
  '/api/stats/upstream-stats',
  '/api/stats/upstream-distribution',
  '/api/stats/upstream-failures',
  '/api/stats/upstream-status-codes',
]);

const LOG_PATHS = new Set([
  '/api/logs', '/api/logs/stream', '/api/logs/export', '/api/logs/stats',
  '/api/logs/stats/timeseries', '/api/logs/cleanup', '/api/logs/cleanup/config',
]);

export interface MasterStatsApi {
  matches(path: string): boolean;
  handle(request: Request): Promise<Response>;
  /** Shared master DB handle for staged plugin-storage wiring. */
  getDatabase(): Database;
  activeRequests?(): number;
  configureLogging?(logging?: MasterLoggingConfig): void;
  startCleanup?(): void;
  close(): Promise<void>;
}

export interface MasterLoggingConfig {
  readonly body?: {
    readonly enabled?: boolean;
    readonly max_size?: number;
    readonly retention_days?: number;
  };
}

export type MasterObservabilityApi = MasterStatsApi;

export type MasterStatsDatabaseFactory = (path: string) => Database;

export interface MasterStatsOptions {
  readonly accessDbPath?: string;
  readonly database?: Database;
  readonly openDatabase?: MasterStatsDatabaseFactory;
  readonly bodyStorage?: LogsHandlerDependencies['bodyStorage'] &
    Partial<Pick<BodyStorageManager, 'updateConfig'>>;
  readonly headerStorage?: LogsHandlerDependencies['headerStorage'] &
    Partial<Pick<HeaderStorageManager, 'updateConfig'>>;
  readonly cleanupService?: Pick<LogCleanupService, 'runCleanup' | 'getConfig' | 'isActive'>
    & Partial<Pick<LogCleanupService, 'configure' | 'start' | 'stop'>>;
  readonly cleanupConfig?: LogCleanupServiceOptions['config'];
}

export class MasterStatsInitializationError extends AggregateError {
  readonly resourceUnreleased = true;

  constructor(initializationError: unknown, cleanupError: unknown) {
    super([initializationError, cleanupError], 'master stats initialization cleanup failed');
    this.name = 'MasterStatsInitializationError';
  }
}

export function hasUnreleasedMasterStatsResource(error: unknown): boolean {
  return error instanceof MasterStatsInitializationError && error.resourceUnreleased;
}

function notFound(): Response {
  return Response.json({ error: 'not_found' }, { status: 404, headers: JSON_HEADERS });
}

/** Master-owned access-log query, body/header storage and cleanup resources. */
export function createMasterStats(path: string, openDatabase?: MasterStatsDatabaseFactory): MasterStatsApi;
export function createMasterStats(options: MasterStatsOptions): MasterStatsApi;
export function createMasterStats(
  input: string | MasterStatsOptions,
  legacyOpenDatabase?: MasterStatsDatabaseFactory,
): MasterStatsApi {
  const options: MasterStatsOptions = typeof input === 'string'
    ? { accessDbPath: input, openDatabase: legacyOpenDatabase }
    : input;
  const accessDbPath = options.accessDbPath;
  if (options.database === undefined && accessDbPath === undefined) {
    throw new TypeError('accessDbPath or database is required');
  }

  let database: Database | undefined = options.database;
  let bodyStorage = options.bodyStorage;
  let headerStorage = options.headerStorage;
  let cleanupService = options.cleanupService;
  const storageRoot = accessDbPath === undefined ? join(process.cwd(), 'logs') : dirname(accessDbPath);
  try {
    if (database === undefined) {
      database = (options.openDatabase ?? ((databasePath) => new Database(databasePath)))(accessDbPath!);
    }
    initializeAccessDatabaseConnection(database);
    bodyStorage ??= new BodyStorageManager({}, process.env.BUNGEE_BODY_LOG_DIR ?? join(storageRoot, 'bodies'));
    headerStorage ??= new HeaderStorageManager({}, process.env.BUNGEE_HEADER_LOG_DIR ?? join(storageRoot, 'headers'));
    cleanupService ??= new LogCleanupService({
      database,
      bodyStorage,
      headerStorage,
      config: options.cleanupConfig,
    } as LogCleanupServiceOptions);
  } catch (error) {
    try { database?.close(); }
    catch (cleanupError) { throw new MasterStatsInitializationError(error, cleanupError); }
    throw error;
  }
  if (database === undefined || bodyStorage === undefined || headerStorage === undefined || cleanupService === undefined) {
    throw new Error('master observability resources were not initialized');
  }

  const logQueryService = new LogQueryService(database);
  const stats = new StatsHandler(logQueryService);
  const shutdown = new AbortController();
  const logs = new LogsHandler({
    database,
    logQueryService,
    bodyStorage,
    headerStorage,
    cleanupService,
    shutdownSignal: shutdown.signal,
  });

  let closed = false;
  let activeRequests = 0;
  let closePromise: Promise<void> | null = null;
  let resolveIdle: (() => void) | null = null;

  const release = (): void => {
    activeRequests -= 1;
    if (closed && activeRequests === 0) resolveIdle?.();
  };
  const waitForIdle = (): Promise<void> => activeRequests === 0
    ? Promise.resolve()
    : new Promise(resolve => { resolveIdle = resolve; });

  const knownLogPath = (requestPath: string): boolean => {
    if (LOG_PATHS.has(requestPath)) return true;
    if (!requestPath.startsWith('/api/logs/')) return false;
    const suffix = requestPath.slice('/api/logs/'.length);
    if (suffix.length === 0) return false;
    if (suffix.startsWith('body/') || suffix.startsWith('headers/')) {
      const parts = suffix.split('/');
      return parts.length === 3 && parts[1].length > 0 && parts[2].length > 0;
    }
    if (suffix.startsWith('chain/')) return suffix.split('/').length === 2 && suffix.slice('chain/'.length).length > 0;
    return !suffix.includes('/');
  };
  const knownPath = (requestPath: string): boolean => DATABASE_STATS_PATHS.has(requestPath)
    || knownLogPath(requestPath);
  const statsPath = (requestPath: string): boolean => DATABASE_STATS_PATHS.has(requestPath);
  const logsPath = (requestPath: string): boolean => knownLogPath(requestPath);

  const handleStats = async (request: Request, requestPath: string): Promise<Response> => {
    switch (requestPath) {
      case '/api/stats': return await stats.getSnapshot();
      case '/api/stats/history': return await stats.getHistory(request);
      case '/api/stats/history/v2': return await stats.getHistoryV2(request);
      case '/api/stats/upstream-stats': return await stats.getUnifiedUpstreamStats(request);
      case '/api/stats/upstream-distribution': return await stats.getUpstreamDistribution(request);
      case '/api/stats/upstream-failures': return await stats.getUpstreamFailures(request);
      case '/api/stats/upstream-status-codes': return await stats.getUpstreamStatusCodes(request);
      default: return notFound();
    }
  };

  const handleLogs = async (request: Request, requestPath: string): Promise<{ response: Response; stream: boolean }> => {
    if (requestPath === '/api/logs') return { response: await logs.query(request), stream: false };
    if (requestPath === '/api/logs/stream') {
      const response = await logs.stream(request, release);
      return { response, stream: response.status === 200 };
    }
    if (requestPath === '/api/logs/export') return { response: await logs.export(request), stream: false };
    if (requestPath === '/api/logs/stats') return { response: await logs.getStats(request), stream: false };
    if (requestPath === '/api/logs/stats/timeseries') return { response: await logs.getTimeSeriesStats(request), stream: false };
    if (requestPath === '/api/logs/cleanup') return { response: await logs.triggerCleanup(), stream: false };
    if (requestPath === '/api/logs/cleanup/config') return { response: logs.getCleanupConfig(), stream: false };
    if (requestPath.startsWith('/api/logs/body/')) return { response: await logs.getBodyById(requestPath.slice('/api/logs/body/'.length)), stream: false };
    if (requestPath.startsWith('/api/logs/headers/')) return { response: await logs.loadHeader(requestPath.slice('/api/logs/headers/'.length)), stream: false };
    if (requestPath.startsWith('/api/logs/chain/')) return { response: await logs.getChainDetail(requestPath.slice('/api/logs/chain/'.length)), stream: false };
    if (requestPath.startsWith('/api/logs/')) return { response: await logs.getById(requestPath.slice('/api/logs/'.length)), stream: false };
    return { response: notFound(), stream: false };
  };

  const databaseFailure = (error: unknown): Response | null => {
    const value = error as { code?: unknown; name?: unknown; message?: unknown };
    const code = String(value?.code ?? value?.name ?? '').toUpperCase();
    const message = String(value?.message ?? '').toUpperCase();
    if (code.includes('BUSY') || code.includes('LOCKED') || message.includes('DATABASE IS LOCKED')) {
      return Response.json({ error: 'database_busy' }, { status: 503, headers: JSON_HEADERS });
    }
    if (code.includes('CORRUPT') || code.includes('NOTADB') || message.includes('NOT A DATABASE') || message.includes('MALFORMED')) {
      return Response.json({ error: 'database_corrupt' }, { status: 503, headers: JSON_HEADERS });
    }
    return null;
  };

  return Object.freeze({
    getDatabase(): Database { return database!; },
    activeRequests(): number { return activeRequests; },
    configureLogging(logging?: MasterLoggingConfig): void {
      const retentionDays = logging?.body?.retention_days ?? 30;
      const enabled = logging?.body?.enabled ?? true;
      const maxSize = logging?.body?.max_size;
      bodyStorage!.updateConfig?.({
        enabled,
        ...(maxSize === undefined ? {} : { maxSize }),
        retentionDays,
      });
      headerStorage!.updateConfig?.({ enabled, retentionDays });
      cleanupService!.configure?.({ retentionDays });
    },
    startCleanup(): void { cleanupService!.start?.(); },
    matches(requestPath: string): boolean {
      const normalized = normalizeManagementPath(requestPath);
      return normalized !== '/api/stats/upstreams/last-used' && knownPath(normalized);
    },
    async handle(request: Request): Promise<Response> {
      const requestPath = normalizeManagementPath(new URL(request.url).pathname);
      if (!knownPath(requestPath) || requestPath === '/api/stats/upstreams/last-used') return notFound();
      if (closed) return notFound();
      const expectedMethod = statsPath(requestPath) || logsPath(requestPath) ?
        (requestPath === '/api/logs/cleanup' ? 'POST' : 'GET') : 'GET';
      if (request.method !== expectedMethod) {
        return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: JSON_HEADERS });
      }
      activeRequests += 1;
      let streamStarted = false;
      try {
        if (statsPath(requestPath)) return await handleStats(request, requestPath);
        const result = await handleLogs(request, requestPath);
        streamStarted = result.stream;
        return result.response;
      } catch (error) {
        return databaseFailure(error) ?? Response.json({ error: 'observability_unavailable' }, { status: 503, headers: JSON_HEADERS });
      } finally {
        // SSE owns the request slot until its body is cancelled or the owner shuts down.
        if (!streamStarted) release();
      }
    },
    close(): Promise<void> {
      if (closePromise !== null) return closePromise;
      closed = true;
      shutdown.abort('master observability stopped');
      closePromise = (async () => {
        let cleanupError: unknown;
        try { await cleanupService!.stop?.(); } catch (error) { cleanupError = error; }
        await waitForIdle();
        try { database!.close(); }
        catch (error) { throw cleanupError === undefined ? error : new AggregateError([cleanupError, error], 'master observability close failed'); }
        if (cleanupError !== undefined) throw cleanupError;
      })();
      return closePromise;
    },
  });
}

export const createMasterObservability = createMasterStats;
