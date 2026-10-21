import { describe, expect, test } from 'bun:test';
import type { TokenMeteringResult } from '@jeffusion/bungee-core/plugin';
import { aggregate, endpointIdentity, rangeDuration, sampleFromResult, validateSample } from '../../../server/metrics';

const result = {
  requestId: 'request', attemptId: 'attempt', routeId: 'route', upstreamId: 'endpoint', provider: 'openai',
  inputSource: 'none', outputSource: 'official', inputAuthority: 'none', outputAuthority: 'official',
  outputTokens: 100, complete: false, observationIncomplete: false, outcome: 'completed',
  generationOutput: { tokens: 100, source: 'official' },
  finishedAtMs: 10_000, generationDurationMs: 2000, settlementVersion: 1,
} satisfies TokenMeteringResult;

describe('TPS sample eligibility', () => {
  test('counts known output even when input usage is unknown', () => {
    expect(sampleFromResult(result, 'route')).toMatchObject({ outputTokens: 100, generationDurationMs: 2000 });
    expect(sampleFromResult({ ...result, generationOutput: { tokens: 100, source: 'estimated' } }, 'route')?.outputSource).toBe('estimated');
    expect(sampleFromResult({ ...result, generationOutput: { tokens: 0, source: 'official' } }, 'route')?.outputTokens).toBe(0);
  });
  test('accepts host-qualified successful timing independently of accounting outcome', () => {
    expect(sampleFromResult({ ...result, outcome: 'failed' }, 'route')?.outputTokens).toBe(100);
    expect(sampleFromResult({ ...result, outcome: 'failed', generationDurationMs: undefined }, 'route')).toBeNull();
  });
  test.each([
    { routeId: 'other' }, { outcome: 'failed', generationDurationMs: undefined }, { outcome: 'aborted', generationDurationMs: undefined },
    { generationOutput: undefined }, { generationOutput: { tokens: 1, source: 'partial' } }, { generationOutput: { tokens: 1, source: 'none' } },
    { generationOutput: { tokens: NaN, source: 'official' } }, { generationOutput: { tokens: -1, source: 'official' } },
    { generationOutput: { tokens: 1.5, source: 'official' } }, { generationOutput: { tokens: Number.MAX_SAFE_INTEGER + 1, source: 'official' } },
    { generationDurationMs: undefined }, { generationDurationMs: 0 }, { generationDurationMs: -1 },
    { generationDurationMs: Infinity }, { generationDurationMs: NaN },
  ])('excludes unusable observation %j', patch => {
    expect(sampleFromResult({ ...result, ...patch } as TokenMeteringResult, 'route')).toBeNull();
  });
  test('hashes URL identities and preserves configured IDs', () => {
    expect(endpointIdentity('https://user:secret@example.test/v1')).toBe('endpoint-5faca2ba8e7b52bc');
    expect(endpointIdentity('https://user:secret@example.test/v1')).not.toContain('secret');
    expect(endpointIdentity('provider:primary')).toBe('provider:primary');
  });
  test('uses independently complete generation output when accounting usage is incomplete', () => {
    expect(sampleFromResult({ ...result, outputTokens: undefined, outputSource: 'none', observationIncomplete: true,
      generationOutput: { tokens: 12, source: 'estimated' } }, 'route')).toMatchObject({ outputTokens: 12, outputSource: 'estimated' });
  });
  test('rejects unsafe storage inputs and rate overflow', () => {
    const sample = sampleFromResult(result, 'route')!;
    for (const patch of [{ attemptId: '' }, { endpointId: 'https://secret@test/' }, { outputTokens: -1 },
      { finishedAtMs: Infinity }, { generationDurationMs: Number.MIN_VALUE }, { outputSource: 'none' }]) {
      expect(() => validateSample({ ...sample, ...patch } as typeof sample)).toThrow();
    }
  });
});

describe('TPS aggregates', () => {
  test('calculates weighted rate and empty result', () => {
    expect(aggregate({ outputTokens: 300, generationDurationMs: 5000, sampleCount: 2, estimatedSampleCount: 1 }).tps).toBe(60);
    expect(aggregate({ outputTokens: 0, generationDurationMs: 0, sampleCount: 0, estimatedSampleCount: 0 }).tps).toBeNull();
    expect(aggregate({ outputTokens: 0, generationDurationMs: 10, sampleCount: 1, estimatedSampleCount: 0 }).tps).toBe(0);
  });
  test.each([
    { outputTokens: Number.MAX_SAFE_INTEGER + 1 }, { outputTokens: -1 }, { sampleCount: 1.5 },
    { estimatedSampleCount: 2 }, { generationDurationMs: Infinity }, { generationDurationMs: 0 },
    { generationDurationMs: Number.MIN_VALUE }, { outputTokens: '100' },
  ])('rejects malformed totals %j', patch => {
    expect(() => aggregate({ outputTokens: 100, generationDurationMs: 1000, sampleCount: 1, estimatedSampleCount: 0, ...patch })).toThrow();
  });
  test('accepts only specified ranges', () => {
    expect(rangeDuration('1h')).toBe(3600000);
    expect(rangeDuration('12h')).toBe(43200000);
    expect(rangeDuration('24h')).toBe(86400000);
    expect(() => rangeDuration('2h' as '1h')).toThrow();
  });
});
