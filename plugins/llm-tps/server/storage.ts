import type { PluginObservationStorage, PluginStorage } from '@jeffusion/bungee-core/plugin';
import { TPS_RETENTION_MS, type TpsRange, type TpsSample, type TpsStatsResponse } from '../contract';
import { aggregate, identifier, isUrlIdentity, rangeDuration, safeCount, validateSample } from './metrics';

export interface TpsObservationClient {
  recordSample(sample: TpsSample): Promise<void>;
  queryStats(input: { range: TpsRange; asOfMs: number }): Promise<TpsStatsResponse>;
}

/** Runtime and control use only the host's namespaced observation adapter. */
export function observationClient(storage: PluginStorage): TpsObservationClient {
  if (typeof storage.invokeObservation !== 'function') throw new Error('llm-tps observation storage is unavailable');
  const invoke = storage.invokeObservation.bind(storage);
  return {
    recordSample: sample => invoke<void>('recordSample', [sample]),
    queryStats: input => invoke<TpsStatsResponse>('queryStats', [input]),
  };
}

const metrics = `COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(generation_duration_ms), 0) AS generationDurationMs,
  COUNT(*) AS sampleCount, COALESCE(SUM(output_source = 'estimated'), 0) AS estimatedSampleCount,
  COALESCE(SUM(CASE WHEN typeof(output_tokens) != 'integer' OR output_tokens < 0 OR output_tokens > 9007199254740991
    OR typeof(generation_duration_ms) NOT IN ('integer', 'real') OR NOT(generation_duration_ms > 0)
    OR generation_duration_ms > 1.7976931348623157e308 OR output_source NOT IN ('official','estimated')
    OR typeof(finished_at_ms) != 'integer' OR finished_at_ms < 0 OR finished_at_ms > 9007199254740991
    THEN 1 ELSE 0 END), 0) AS invalidSamples`;

/** SQL is confined to the trusted access.db adapter callback. */
export function createObservationAdapter(observation: PluginObservationStorage): TpsObservationClient {
  return Object.freeze({
    async recordSample(sample: TpsSample): Promise<void> {
      validateSample(sample);
      observation.withDatabase(db => {
        db.transaction(() => {
          db.query(`INSERT OR IGNORE INTO llm_tps_samples
            (attempt_id, request_id, route_id, endpoint_id, finished_at_ms, output_tokens, generation_duration_ms, output_source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sample.attemptId, sample.requestId, sample.routeId, sample.endpointId,
            sample.finishedAtMs, sample.outputTokens, sample.generationDurationMs, sample.outputSource);
          db.query(`DELETE FROM llm_tps_samples WHERE attempt_id IN (
            SELECT attempt_id FROM llm_tps_samples INDEXED BY idx_llm_tps_samples_finished
            WHERE finished_at_ms < ? ORDER BY finished_at_ms LIMIT 500
          )`).run(Date.now() - TPS_RETENTION_MS);
        }).immediate();
      });
    },
    async queryStats(input: { range: TpsRange; asOfMs: number }): Promise<TpsStatsResponse> {
      safeCount(input.asOfMs, 'asOfMs');
      const start = input.asOfMs - rangeDuration(input.range);
      return observation.withDatabase(db => db.transaction(() => {
        const where = 'WHERE finished_at_ms >= ? AND finished_at_ms <= ?';
        const totalRow = db.query<Record<string, unknown>, [number, number]>(`SELECT ${metrics} FROM llm_tps_samples ${where}`).get(start, input.asOfMs)!;
        const rows = db.query<Record<string, unknown>, [number, number]>(`SELECT route_id AS routeId, endpoint_id AS endpointId, ${metrics}
          FROM llm_tps_samples ${where} GROUP BY route_id, endpoint_id`).all(start, input.asOfMs);
        const checked = (row: Record<string, unknown>) => {
          if (safeCount(row.invalidSamples, 'invalid sample count') !== 0) throw new RangeError('invalid persisted llm-tps sample');
          return aggregate(row);
        };
        const total = checked(totalRow);
        const endpoints = rows.map(row => {
          identifier(row.routeId, 'routeId'); identifier(row.endpointId, 'endpointId');
          if (isUrlIdentity(row.endpointId)) throw new TypeError('invalid persisted llm-tps endpoint');
          return { routeId: row.routeId, endpointId: row.endpointId, ...checked(row) };
        }).sort((a, b) => (b.tps! - a.tps!) || compare(a.routeId, b.routeId) || compare(a.endpointId, b.endpointId));
        return { range: input.range, asOfMs: input.asOfMs, total, endpoints, reportingIncomplete: false };
      })());
    },
  });
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
