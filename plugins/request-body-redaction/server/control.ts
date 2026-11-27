import type { ControlHostContext, ControlPlugin, PluginControl, PluginObservationStorage } from '@jeffusion/bungee-core/plugin';
import type { RedactionStats } from './stats';

export function createObservationAdapter(observation: PluginObservationStorage) {
  return {
    async record(processed: number, redacted: number, replacements: number, incomplete: boolean): Promise<void> {
      if (![processed, redacted, replacements].every(value => Number.isSafeInteger(value) && value >= 0)
        || redacted > processed || replacements < redacted || typeof incomplete !== 'boolean') throw new Error('invalid_redaction_stats');
      observation.withDatabase(db => {
        const result = db.query(`UPDATE request_body_redaction_stats SET
          processed_requests = processed_requests + ?, redacted_requests = redacted_requests + ?,
          replacements = replacements + ?, reporting_incomplete = MAX(reporting_incomplete, ?) WHERE id = 1`)
          .run(processed, redacted, replacements, Number(incomplete));
        if (result.changes !== 1) throw new Error('redaction_stats_unavailable');
      });
    },
    async read(): Promise<RedactionStats> {
      return observation.withDatabase(db => {
        const row = db.query<Omit<RedactionStats, 'reportingIncomplete'> & { reportingIncomplete: number }, []>(
          `SELECT processed_requests AS processedRequests, redacted_requests AS redactedRequests,
            replacements, reporting_incomplete AS reportingIncomplete FROM request_body_redaction_stats WHERE id = 1`,
        ).get();
        if (!row) throw new Error('redaction_stats_unavailable');
        return { ...row, reportingIncomplete: row.reportingIncomplete === 1 };
      });
    },
  };
}

function createControl(host: ControlHostContext): PluginControl {
  return {
    rpc: [],
    start() { host.signal.throwIfAborted(); },
    dispose() {},
    api: [{ path: '/stats', methods: ['GET'], handler: 'getStats', async invoke(context) {
      try {
        host.signal.throwIfAborted();
        context.signal.throwIfAborted();
        context.requestSignal.throwIfAborted();
        if (!host.storage.invokeObservation) throw new Error('redaction_stats_unavailable');
        const stats = await host.storage.invokeObservation<RedactionStats>('read', []);
        host.signal.throwIfAborted();
        context.signal.throwIfAborted();
        context.requestSignal.throwIfAborted();
        return Response.json(stats);
      } catch {
        return Response.json({ error: 'redaction_stats_unavailable' }, { status: 503 });
      }
    } }],
  };
}

export default { supportsOnlinePreparation: true, createControl } satisfies ControlPlugin;
