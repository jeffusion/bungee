import { logQueryService, type LogQueryParams, type LogEntry } from '../logs';
import { logCleanupService } from '../../logger/log-cleanup';
import { bodyStorageManager } from '../../logger/body-storage';
import { headerStorageManager } from '../../logger/header-storage';
import { accessLogWriter } from '../../logger/access-log-writer';

export class LogsHandler {
  /**
   * GET /api/logs
   * Query logs with pagination, filtering, and sorting
   */
  static async query(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
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
      };

      const result = await logQueryService.query(params);

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Failed to query logs:', error);
      return new Response(
        JSON.stringify({ error: 'Failed to query logs' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * GET /api/logs/:requestId
   * Get single log entry by request ID
   */
  static async getById(requestId: string): Promise<Response> {
    try {
      const log = await logQueryService.getById(requestId);

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
      return new Response(
        JSON.stringify({ error: 'Failed to get log' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * GET /api/logs/body/:bodyId
   * Load body content by ID
   */
  static async getBodyById(bodyId: string): Promise<Response> {
    try {
      const body = await bodyStorageManager.load(bodyId);

      if (!body) {
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
      return new Response(
        JSON.stringify({ error: 'Failed to load body' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * GET /api/logs/headers/:headerId
   * Load header content by header ID
   */
  static async loadHeader(headerId: string): Promise<Response> {
    try {
      const headers = await headerStorageManager.load(headerId);

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
      return new Response(
        JSON.stringify({ error: 'Failed to load headers' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * GET /api/logs/stream
   * Server-Sent Events stream for real-time logs
   */
  static async stream(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pollInterval = url.searchParams.has('interval')
      ? parseInt(url.searchParams.get('interval')!)
      : 1000;
    const heartbeatInterval = 8000; // Send heartbeat every 8 seconds

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let lastTimestamp = Date.now();
        let lastHeartbeat = Date.now();
        let running = true;
        let controllerClosed = false;

        // Safe enqueue wrapper to handle controller state
        const safeEnqueue = (data: Uint8Array): boolean => {
          if (controllerClosed) {
            return false;
          }
          try {
            controller.enqueue(data);
            return true;
          } catch (error) {
            // Controller closed by client disconnect
            controllerClosed = true;
            running = false;
            return false;
          }
        };

        const sendHeartbeat = () => {
          if (safeEnqueue(encoder.encode(': heartbeat\n\n'))) {
            lastHeartbeat = Date.now();
          }
        };

        const poll = async () => {
          const db = accessLogWriter.getDatabase();

          while (running) {
            try {
              // Query new logs since last poll
              const query = `
                SELECT * FROM access_logs
                WHERE timestamp > ?
                ORDER BY timestamp ASC
              `;
              const rows = db.prepare(query).all(lastTimestamp) as any[];

              // Send new logs
              for (const row of rows) {
                if (!running) break; // Stop if client disconnected

                const entry: LogEntry = {
                  id: row.id,
                  requestId: row.request_id,
                  timestamp: row.timestamp,
                  method: row.method,
                  path: row.path,
                  query: row.query || undefined,
                  status: row.status,
                  duration: row.duration,
                  routePath: row.route_path || undefined,
                  upstream: row.upstream || undefined,
                  transformer: row.transformer || undefined,
                  processingSteps: row.processing_steps ? JSON.parse(row.processing_steps) : undefined,
                  authSuccess: row.auth_success === 1,
                  authLevel: row.auth_level || undefined,
                  errorMessage: row.error_message || undefined,
                  success: row.success === 1,
                  reqBodyId: row.req_body_id || undefined,
                  respBodyId: row.resp_body_id || undefined,
                };

                lastTimestamp = entry.timestamp;
                const data = `data: ${JSON.stringify(entry)}\n\n`;

                if (!safeEnqueue(encoder.encode(data))) {
                  break; // Stop if enqueue failed (client disconnected)
                }

                lastHeartbeat = Date.now(); // Reset heartbeat timer when sending data
              }

              // Send heartbeat if no data sent for a while
              if (running) {
                const timeSinceLastHeartbeat = Date.now() - lastHeartbeat;
                if (timeSinceLastHeartbeat >= heartbeatInterval) {
                  sendHeartbeat();
                }
              }

              // Wait before next poll
              if (running) {
                await new Promise(resolve => setTimeout(resolve, pollInterval));
              }
            } catch (error) {
              console.error('Stream poll error:', error);
              running = false;
            }
          }
        };

        // Start polling
        poll().catch(error => {
          console.error('Stream error:', error);
          running = false;
        });
      },
      cancel() {
        // Called when client disconnects
        // The running flag will be checked in the next poll iteration
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
  static async export(req: Request): Promise<Response> {
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
      };

      const data = await logQueryService.exportLogs(params, format);

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
      return new Response(
        JSON.stringify({ error: 'Failed to export logs' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * GET /api/logs/stats
   * Get aggregated statistics
   */
  static async getStats(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const startTime = url.searchParams.has('startTime')
        ? parseInt(url.searchParams.get('startTime')!)
        : undefined;
      const endTime = url.searchParams.has('endTime')
        ? parseInt(url.searchParams.get('endTime')!)
        : undefined;

      const stats = await logQueryService.getStats(startTime, endTime);

      return new Response(JSON.stringify(stats), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Failed to get stats:', error);
      return new Response(
        JSON.stringify({ error: 'Failed to get stats' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * GET /api/logs/stats/timeseries
   * Get time series statistics for charts
   */
  static async getTimeSeriesStats(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const startTime = parseInt(url.searchParams.get('startTime')!);
      const endTime = parseInt(url.searchParams.get('endTime')!);
      const interval = (url.searchParams.get('interval') || 'minute') as 'minute' | 'hour' | 'day';

      if (!startTime || !endTime) {
        return new Response(
          JSON.stringify({ error: 'startTime and endTime are required' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const data = await logQueryService.getTimeSeriesStats(startTime, endTime, interval);

      return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Failed to get time series stats:', error);
      return new Response(
        JSON.stringify({ error: 'Failed to get time series stats' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * POST /api/logs/cleanup
   * Manually trigger log cleanup
   */
  static async triggerCleanup(req: Request): Promise<Response> {
    try {
      const result = await logCleanupService.runCleanup();

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Failed to trigger cleanup:', error);
      return new Response(
        JSON.stringify({ error: 'Failed to trigger cleanup' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * GET /api/logs/cleanup/config
   * Get cleanup configuration
   */
  static getCleanupConfig(): Response {
    const config = logCleanupService.getConfig();
    const isActive = logCleanupService.isActive();

    return new Response(JSON.stringify({ ...config, isActive }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * PUT /api/logs/cleanup/config
   * Update cleanup configuration
   */
  static async updateCleanupConfig(req: Request): Promise<Response> {
    try {
      const body = await req.json();
      logCleanupService.updateConfig(body);

      const config = logCleanupService.getConfig();
      const isActive = logCleanupService.isActive();

      return new Response(JSON.stringify({ ...config, isActive }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Failed to update cleanup config:', error);
      return new Response(
        JSON.stringify({ error: 'Failed to update cleanup config' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }
}
