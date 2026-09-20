import { type LogQueryParams, type LogEntry, type LogQueryService } from '../logs';
import type { Database } from 'bun:sqlite';
import type { BodyStorageManager } from '../../logger/body-storage';
import type { HeaderStorageManager } from '../../logger/header-storage';
import type { LogCleanupService } from '../../logger/log-cleanup';

function getStrictIntegerParam(url: URL, name: string): number | undefined | null {
  const values = url.searchParams.getAll(name);
  if (values.length === 0) return undefined;
  if (values.length !== 1 || !/^-?\d+$/.test(values[0])) return null;
  const value = Number(values[0]);
  return Number.isSafeInteger(value) ? value : null;
}

function getSingleParam(url: URL, name: string): string | undefined | null {
  const values = url.searchParams.getAll(name);
  return values.length === 0 ? undefined : values.length === 1 && values[0] !== '' ? values[0] : null;
}

function getPollInterval(url: URL): number | null {
  const values = url.searchParams.getAll('interval');
  if (values.length === 0) return 1000;
  if (values.length !== 1 || !/^\d+$/.test(values[0])) return null;
  const value = Number(values[0]);
  return Number.isSafeInteger(value) && value >= 100 && value <= 60_000 ? value : null;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' } as const;

function databaseFailure(error: unknown): Response | null {
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
}

export interface LogsHandlerDependencies {
  readonly database?: Database;
  readonly logQueryService: LogQueryService;
  readonly bodyStorage: Pick<BodyStorageManager, 'load' | 'cleanup'>;
  readonly headerStorage: Pick<HeaderStorageManager, 'load' | 'cleanup'>;
  readonly cleanupService: Pick<LogCleanupService, 'runCleanup' | 'getConfig' | 'isActive'>;
  readonly shutdownSignal?: AbortSignal;
}

export class LogsHandler {
  constructor(private readonly dependencies: LogsHandlerDependencies) {}

  /**
   * GET /api/logs
   * Query logs with pagination, filtering, and sorting
   * Supports `groupBy=chain` for chain-dimension aggregation
   */
  async query(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const groupBy = url.searchParams.get('groupBy');

      const params: LogQueryParams = {
        page: url.searchParams.has('page') ? parseInt(url.searchParams.get('page')!) : undefined,
        limit: url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!) : undefined,
        startTime: url.searchParams.has('startTime') ? parseInt(url.searchParams.get('startTime')!) : undefined,
        endTime: url.searchParams.has('endTime') ? parseInt(url.searchParams.get('endTime')!) : undefined,
        method: url.searchParams.get('method') || undefined,
        path: url.searchParams.get('path') || undefined,
        status: url.searchParams.has('status') ? parseInt(url.searchParams.get('status')!) : undefined,
        routePath: url.searchParams.get('routePath') || undefined,
        upstream: url.searchParams.get('upstream') || undefined,
        transformer: url.searchParams.get('transformer') || undefined,
        success: url.searchParams.has('success') ? url.searchParams.get('success') === 'true' : undefined,
        searchTerm: url.searchParams.get('searchTerm') || undefined,
        sortBy: (url.searchParams.get('sortBy') as any) || undefined,
        sortOrder: (url.searchParams.get('sortOrder') as any) || undefined,
        requestType: url.searchParams.get('requestType') as 'final' | 'retry' | 'recovery' | undefined,
        hasRetry: url.searchParams.has('hasRetry') ? url.searchParams.get('hasRetry') === 'true' : undefined,
        chainStatusMin: url.searchParams.has('chainStatusMin') ? parseInt(url.searchParams.get('chainStatusMin')!) : undefined,
        chainStatusMax: url.searchParams.has('chainStatusMax') ? parseInt(url.searchParams.get('chainStatusMax')!) : undefined,
        minChainDurationMs: url.searchParams.has('minChainDurationMs') ? parseInt(url.searchParams.get('minChainDurationMs')!) : undefined,
        maxChainDurationMs: url.searchParams.has('maxChainDurationMs') ? parseInt(url.searchParams.get('maxChainDurationMs')!) : undefined,
      };

      if (groupBy === 'chain') {
        const result = await this.dependencies.logQueryService.queryChains(params);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const result = await this.dependencies.logQueryService.query(params);

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Failed to query logs:', error);
      return databaseFailure(error) ?? new Response(
        JSON.stringify({ error: 'Failed to query logs' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * GET /api/logs/chain/:chainId
   * Get chain detail: chain meta + all attempts
   */
  async getChainDetail(chainId: string): Promise<Response> {
    try {
      const decodedChainId = decodeURIComponent(chainId);
      const result = await this.dependencies.logQueryService.getChainDetail(decodedChainId);

      if (!result) {
        return new Response(
          JSON.stringify({ error: 'Chain not found' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Failed to get chain detail:', error);
      return databaseFailure(error) ?? new Response(
        JSON.stringify({ error: 'Failed to get chain detail' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * GET /api/logs/:requestId
   * Get single log entry by request ID
   */
  async getById(requestId: string): Promise<Response> {
    try {
      const log = await this.dependencies.logQueryService.getById(requestId);

      if (!log) {
        return new Response(
          JSON.stringify({ error: 'Log not found' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify(log), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Failed to get log:', error);
      return databaseFailure(error) ?? new Response(
        JSON.stringify({ error: 'Failed to get log' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * GET /api/logs/body/:bodyId
   * Load body content by ID
   */
  async getBodyById(bodyId: string): Promise<Response> {
    try {
      const body = await this.dependencies.bodyStorage.load(bodyId);

      if (body === null || body === undefined) {
        return new Response(
          JSON.stringify({ error: 'Body not found' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify({ bodyId, content: body }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Failed to load body:', error);
      return databaseFailure(error) ?? new Response(
        JSON.stringify({ error: 'Failed to load body' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * GET /api/logs/headers/:headerId
   * Load header content by header ID
   */
  async loadHeader(headerId: string): Promise<Response> {
    try {
      const headers = await this.dependencies.headerStorage.load(headerId);

      if (!headers) {
        return new Response(
          JSON.stringify({ error: 'Headers not found' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify(headers), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Failed to load headers:', error);
      return databaseFailure(error) ?? new Response(
        JSON.stringify({ error: 'Failed to load headers' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * GET /api/logs/stream
   * Server-Sent Events stream for real-time logs
   */
  async stream(req: Request, onFinished: () => void = () => {}): Promise<Response> {
    const url = new URL(req.url);
    const pollInterval = getPollInterval(url);
    if (pollInterval === null) {
      return new Response(JSON.stringify({ error: 'interval must be an integer between 100 and 60000' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    const heartbeatInterval = 8000;
    const logQueryService = this.dependencies.logQueryService;
    const shutdownSignal = this.dependencies.shutdownSignal;
    let cancelStream: () => void = () => {};

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let lastTimestamp = Date.now();
        let lastId = 0;
        let lastHeartbeat = Date.now();
        let running = true;
        let controllerClosed = false;
        let finished = false;
        let pendingTimer: ReturnType<typeof setTimeout> | null = null;
        let pendingResolve: (() => void) | null = null;
        let stop: () => void = () => {};

        const finish = () => {
          if (finished) return;
          finished = true;
          running = false;
          if (pendingTimer !== null) clearTimeout(pendingTimer);
          pendingTimer = null;
          pendingResolve?.();
          pendingResolve = null;
          req.signal.removeEventListener('abort', stop);
          shutdownSignal?.removeEventListener('abort', stop);
          onFinished();
        };

        stop = () => {
          running = false;
          if (pendingTimer !== null) clearTimeout(pendingTimer);
          pendingTimer = null;
          pendingResolve?.();
          pendingResolve = null;
        };
        cancelStream = stop;

        const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => {
          if (!running) { resolve(); return; }
          pendingResolve = resolve;
          pendingTimer = setTimeout(() => {
            pendingTimer = null;
            pendingResolve = null;
            resolve();
          }, milliseconds);
        });

        const waitForCapacity = async (): Promise<void> => {
          while (running && controller.desiredSize !== null && controller.desiredSize <= 0) {
            await wait(Math.min(Math.max(pollInterval, 1), 100));
          }
        };

        req.signal.addEventListener('abort', stop, { once: true });
        shutdownSignal?.addEventListener('abort', stop, { once: true });
        if (req.signal.aborted || shutdownSignal?.aborted === true) stop();

        const safeEnqueue = (data: Uint8Array): boolean => {
          if (controllerClosed || !running) return false;
          try {
            controller.enqueue(data);
            return true;
          } catch {
            controllerClosed = true;
            running = false;
            return false;
          }
        };

        const sendHeartbeat = () => {
          if (safeEnqueue(encoder.encode(': heartbeat\n\n'))) lastHeartbeat = Date.now();
        };

        try {
          while (running) {
            const rows = await logQueryService.querySince(lastTimestamp, lastId);
            for (const entry of rows) {
              if (!running) break;
              await waitForCapacity();
              if (!running) break;
              lastTimestamp = entry.timestamp;
              lastId = entry.id;
              if (!safeEnqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`))) break;
              lastHeartbeat = Date.now();
            }
            if (!running) break;
            if (Date.now() - lastHeartbeat >= heartbeatInterval) sendHeartbeat();
            // Keep heartbeat cadence independent from a deliberately slow poll interval.
            await wait(Math.min(Math.max(pollInterval, 1), heartbeatInterval));
          }
        } catch (error) {
          if (running) console.error('Stream poll error:', error);
        } finally {
          if (!controllerClosed) {
            try { controller.close(); } catch { /* client already cancelled */ }
            controllerClosed = true;
          }
          finish();
        }
      },
      cancel() {
        // Request and owner abort signals stop the loop and clear its pending timer.
        cancelStream();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  /**
   * GET /api/logs/export
   * Export logs as JSON or CSV
   */
  async export(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const format = (url.searchParams.get('format') || 'json') as 'json' | 'csv';

      const params: LogQueryParams = {
        startTime: url.searchParams.has('startTime') ? parseInt(url.searchParams.get('startTime')!) : undefined,
        endTime: url.searchParams.has('endTime') ? parseInt(url.searchParams.get('endTime')!) : undefined,
        method: url.searchParams.get('method') || undefined,
        path: url.searchParams.get('path') || undefined,
        status: url.searchParams.has('status') ? parseInt(url.searchParams.get('status')!) : undefined,
        routePath: url.searchParams.get('routePath') || undefined,
        upstream: url.searchParams.get('upstream') || undefined,
        transformer: url.searchParams.get('transformer') || undefined,
        success: url.searchParams.has('success') ? url.searchParams.get('success') === 'true' : undefined,
        searchTerm: url.searchParams.get('searchTerm') || undefined,
        requestType: url.searchParams.get('requestType') as 'final' | 'retry' | 'recovery' | undefined,
      };

      const data = await this.dependencies.logQueryService.exportLogs(params, format);

      const contentType = format === 'json' ? 'application/json' : 'text/csv';
      const filename = `access-logs-${Date.now()}.${format}`;

      return new Response(data, {
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    } catch (error) {
      console.error('Failed to export logs:', error);
      return databaseFailure(error) ?? new Response(
        JSON.stringify({ error: 'Failed to export logs' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * GET /api/logs/stats
   * Get aggregated statistics
   */
  async getStats(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const startTime = getStrictIntegerParam(url, 'startTime');
    const endTime = getStrictIntegerParam(url, 'endTime');
    if (startTime === null || endTime === null) {
      return new Response(JSON.stringify({ error: 'startTime and endTime must be strict integers' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (startTime !== undefined && endTime !== undefined && startTime > endTime) {
      return new Response(JSON.stringify({ error: 'startTime must not exceed endTime' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    const stats = await this.dependencies.logQueryService.getStats(startTime, endTime);
    return new Response(JSON.stringify(stats), { headers: { 'Content-Type': 'application/json' } });
  }

  /**
   * GET /api/logs/stats/timeseries
   * Get time series statistics for charts
   */
  async getTimeSeriesStats(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const startTime = getStrictIntegerParam(url, 'startTime');
    const endTime = getStrictIntegerParam(url, 'endTime');
    const interval = getSingleParam(url, 'interval');

    if (startTime === undefined || endTime === undefined || startTime === null || endTime === null) {
      return new Response(
        JSON.stringify({ error: 'startTime and endTime must be strict integers' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (startTime > endTime) {
      return new Response(
        JSON.stringify({ error: 'startTime must not exceed endTime' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (interval === null || (interval !== undefined && interval !== 'minute' && interval !== '30min' && interval !== 'hour' && interval !== 'day')) {
      return new Response(
        JSON.stringify({ error: 'interval must be one of minute, 30min, hour, day' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const data = await this.dependencies.logQueryService.getTimeSeriesStats(
      startTime,
      endTime,
      (interval ?? 'minute') as 'minute' | '30min' | 'hour' | 'day',
    );

    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  }

  /**
   * POST /api/logs/cleanup
   * Manually trigger log cleanup
   */
  async triggerCleanup(): Promise<Response> {
    try {
      const result = await this.dependencies.cleanupService.runCleanup();

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Failed to trigger cleanup:', error);
      return databaseFailure(error) ?? new Response(
        JSON.stringify({ error: 'Failed to trigger cleanup' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * GET /api/logs/cleanup/config
   * Get cleanup configuration
   */
  getCleanupConfig(): Response {
    const config = this.dependencies.cleanupService.getConfig();
    const isActive = this.dependencies.cleanupService.isActive();

    return new Response(JSON.stringify({ ...config, isActive }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

}
