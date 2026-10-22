import { createHash } from 'node:crypto';
import type { TokenMeteringResult } from '@jeffusion/bungee-core/plugin';
import { isUpstreamHost, type TpsAggregate, type TpsRange, type TpsSample } from '../contract';

export function isUrlIdentity(value: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(value);
}

export function endpointIdentity(upstreamId: string): string {
  return isUrlIdentity(upstreamId)
    ? `endpoint-${createHash('sha256').update(upstreamId).digest('hex').slice(0, 16)}`
    : upstreamId;
}

export function safeCount(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new RangeError(`invalid llm-tps ${name}`);
  return value;
}

export function identifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`invalid llm-tps ${name}`);
}

/** Accept only a canonical URL.host, never URL credentials, path, query or fragment. */
export function validateUpstreamHost(value: unknown): asserts value is string {
  if (!isUpstreamHost(value)) throw new TypeError('invalid llm-tps upstream host');
}

export function validateSample(sample: TpsSample): void {
  for (const key of ['attemptId', 'requestId', 'routeId', 'endpointId'] as const) identifier(sample[key], key);
  if (sample.model !== null) identifier(sample.model, 'model');
  if (isUrlIdentity(sample.endpointId)) throw new TypeError('llm-tps endpoint must be opaque');
  if (sample.upstreamHost !== null) validateUpstreamHost(sample.upstreamHost);
  safeCount(sample.finishedAtMs, 'finishedAtMs');
  safeCount(sample.outputTokens, 'outputTokens');
  if (!Number.isFinite(sample.generationDurationMs) || sample.generationDurationMs <= 0) throw new RangeError('invalid llm-tps duration');
  if (sample.outputSource !== 'official' && sample.outputSource !== 'estimated') throw new TypeError('invalid llm-tps output source');
  if (!Number.isFinite(sample.outputTokens / sample.generationDurationMs * 1000)) throw new RangeError('invalid llm-tps rate');
}

/** Unknown input usage does not invalidate observable output usage. */
export function sampleFromResult(result: TokenMeteringResult, routeId: string): TpsSample | null {
  const output = result.generationOutput;
  if (result.routeId !== routeId || !output
    || (output.source !== 'official' && output.source !== 'estimated')
    || !Number.isSafeInteger(output.tokens) || output.tokens < 0
    || !Number.isFinite(result.generationDurationMs) || result.generationDurationMs! <= 0) return null;
  const sample: TpsSample = {
    attemptId: result.attemptId, requestId: result.requestId, routeId: result.routeId,
    endpointId: endpointIdentity(result.upstreamId), finishedAtMs: result.finishedAtMs,
    upstreamHost: result.upstreamHost ?? null,
    model: typeof result.model === 'string' && result.model.trim() ? result.model : null,
    outputTokens: output.tokens, generationDurationMs: result.generationDurationMs!, outputSource: output.source,
  };
  validateSample(sample);
  return sample;
}

export function rangeDuration(range: TpsRange): number {
  if (range === '1h') return 3_600_000;
  if (range === '12h') return 43_200_000;
  if (range === '24h') return 86_400_000;
  throw new RangeError('invalid llm-tps range');
}

export function aggregate(row: Record<string, unknown>): TpsAggregate {
  const outputTokens = safeCount(row.outputTokens, 'aggregate tokens');
  const sampleCount = safeCount(row.sampleCount, 'sample count');
  const estimatedSampleCount = safeCount(row.estimatedSampleCount, 'estimated sample count');
  const duration = row.generationDurationMs;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0
    || (sampleCount > 0 && duration <= 0) || estimatedSampleCount > sampleCount
    || (sampleCount === 0 && (outputTokens !== 0 || duration !== 0 || estimatedSampleCount !== 0))) throw new RangeError('invalid llm-tps aggregate');
  const tps = sampleCount === 0 ? null : outputTokens / duration * 1000;
  if (tps !== null && (!Number.isFinite(tps) || tps < 0)) throw new RangeError('invalid llm-tps aggregate rate');
  return { tps, outputTokens, generationDurationMs: duration, sampleCount, estimatedSampleCount };
}
