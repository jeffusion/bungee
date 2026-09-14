import { afterEach, expect, test } from 'bun:test';
import { findRuntimeUpstream, getRuntimeUpstreams, runtimeAvailabilityKey, runtimeStatus } from './runtime';
import { runtimeRecord, runtimeResponse, unavailableRuntime } from '../../tests/fixtures/runtime';
import { getRouteHealthAggregate, getServiceHealthAggregate } from '../utils/route-service-view-model';
import { getStatsHistoryV2, getUnifiedUpstreamStats, getUpstreamDistribution, getUpstreamFailures, getUpstreamStatusCodes } from './stats';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const service = { name: 'service', endpoints: [{ _uid: 'endpoint-id', target: 'https://example.com' }] };

test('Master runtime endpoint preserves complete, mixed, unknown, no admission and nullable counts', async () => {
  for (const response of [runtimeResponse(), runtimeResponse([runtimeRecord('MIXED')]),
    { ...runtimeResponse([runtimeRecord('UNKNOWN', { active_request_count: null, last_used_complete: false })]), availability: 'partial' as const },
    unavailableRuntime('runtime_unavailable'), unavailableRuntime()]) {
    globalThis.fetch = (async (input: string) => {
      expect(input).toBe('/__ui/api/runtime/upstreams');
      return Response.json(response);
    }) as typeof fetch;
    expect(await getRuntimeUpstreams()).toEqual(response);
  }
});

test('runtime identity never falls back to endpoint position, target or another service', () => {
  const record = runtimeRecord();
  const response = runtimeResponse([record]);
  expect(findRuntimeUpstream(response, 'service', 'endpoint-id')).toBe(record);
  expect(findRuntimeUpstream(response, 'other', 'endpoint-id')).toBeUndefined();
  expect(findRuntimeUpstream(response, 'service', '0')).toBeUndefined();
  expect(findRuntimeUpstream(response, 'service')).toBeUndefined();
  expect(findRuntimeUpstream(unavailableRuntime(), 'service', 'endpoint-id')).toBeUndefined();
});

test('health requires runtime evidence, including per-upstream unknown in a complete envelope', () => {
  for (const [state, expected] of [['HEALTHY', 'healthy'], ['UNHEALTHY', 'unhealthy'], ['HALF_OPEN', 'degraded'], ['MIXED', 'mixed'], ['UNKNOWN', 'unknown']] as const) {
    const runtime = runtimeResponse([runtimeRecord(state)]);
    expect(getServiceHealthAggregate(service, runtime).state).toBe(expected);
    expect(getRouteHealthAggregate({ path: '/route', service: 'service' }, [service], runtime).state).toBe(expected);
    expect(getRouteHealthAggregate({ path: 'service', endpoints: service.endpoints }, [], runtime).state).toBe(expected);
    expect(runtimeStatus[state].dot).toBe(state === 'HEALTHY' ? 'ok' : state === 'UNHEALTHY' ? 'danger' : state === 'UNKNOWN' ? 'idle' : 'warn');
  }
  for (const runtime of [null, unavailableRuntime(), runtimeResponse([])]) {
    expect(getServiceHealthAggregate(service, runtime).state).toBe('unknown');
    expect(getServiceHealthAggregate(service, runtime).healthy).toBe(0);
  }
  expect(getServiceHealthAggregate({ ...service, endpoints: [{ ...service.endpoints[0], is_disabled: true }] }).state).toBe('neutral');
  expect(getServiceHealthAggregate({ name: 'empty', endpoints: [] }).state).toBe('empty');
});

test('null counts and partial maximum timestamps remain distinct from zero and no usage', () => {
  const record = runtimeRecord('UNKNOWN', { active_request_count: null, last_used_time: 500,
    last_used_complete: false, last_failure_time: 300, last_failure_complete: false });
  const result = findRuntimeUpstream(runtimeResponse([record]), 'service', 'endpoint-id')!;
  expect(result.active_request_count).toBeNull();
  expect(result.last_used_time).toBe(500);
  expect(result.last_used_complete).toBe(false);
  expect(result.last_failure_time).toBe(300);
  expect(result.last_failure_complete).toBe(false);
  expect(runtimeRecord().active_request_count).toBe(0);
  expect(runtimeAvailabilityKey(unavailableRuntime())).toBe('runtime.noAdmission');
  expect(runtimeAvailabilityKey(unavailableRuntime('session_unavailable'))).toBe('runtime.unknown');
});

test('stats use Master paths with one strict range and type, never arbitrary query injection', async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string) => { urls.push(input); return Response.json({}); }) as typeof fetch;
  await getStatsHistoryV2('12h');
  await getUpstreamDistribution('24h');
  await getUpstreamFailures('1h');
  await getUpstreamStatusCodes('1h');
  await getUnifiedUpstreamStats('24h', 'failure');
  expect(urls).toEqual(['/__ui/api/stats/history/v2?range=12h', '/__ui/api/stats/upstream-distribution?range=24h',
    '/__ui/api/stats/upstream-failures?range=1h', '/__ui/api/stats/upstream-status-codes?range=1h', '/__ui/api/stats/upstream-stats?range=24h&type=failure']);
  for (const get of [getStatsHistoryV2, getUpstreamDistribution, getUpstreamFailures, getUpstreamStatusCodes, getUnifiedUpstreamStats]) {
    await expect(get('1h&range=24h' as '1h')).rejects.toThrow('Invalid stats range');
  }
  await expect(getUnifiedUpstreamStats('1h', 'all&type=failure' as 'all')).rejects.toThrow('Invalid stats type');
  expect(urls).toHaveLength(5);
});
