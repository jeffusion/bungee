import { writable } from 'svelte/store';
import { isUpstreamHost, type TpsAggregate, type TpsRange, type TpsStatsResponse } from '../contract';

export type TpsState = { data: TpsStatsResponse | null; busy: boolean; error: boolean };
type Load = (plugin: string, range: TpsRange, signal: AbortSignal) => Promise<TpsStatsResponse>;
type Poll = (refresh: () => void) => () => void;

function validAggregate(value: TpsAggregate): boolean {
  return !!value && (value.tps === null || typeof value.tps === 'number' && Number.isFinite(value.tps) && value.tps >= 0)
    && [value.outputTokens, value.generationDurationMs].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)
    && [value.sampleCount, value.estimatedSampleCount].every(n => Number.isSafeInteger(n) && n >= 0)
    && value.estimatedSampleCount <= value.sampleCount;
}

export function validateStats(data: TpsStatsResponse, range: TpsRange): TpsStatsResponse {
  if (!data || data.range !== range || !Number.isFinite(data.asOfMs) || !validAggregate(data.total)
    || typeof data.reportingIncomplete !== 'boolean' || !Array.isArray(data.endpoints) || !Array.isArray(data.models) || !Array.isArray(data.history)
    || !data.history.every((row, index) => validAggregate(row) && Number.isSafeInteger(row.bucketStartMs) && row.bucketStartMs >= 0
      && (index === 0 || row.bucketStartMs > data.history[index - 1]!.bucketStartMs))
    || !data.endpoints.every(row => validAggregate(row) && typeof row.routeId === 'string' && !!row.routeId.trim() && isUpstreamHost(row.upstreamHost))
    || !data.models.every(row => validAggregate(row) && typeof row.routeId === 'string' && !!row.routeId.trim()
      && typeof row.model === 'string' && !!row.model.trim())) {
    throw new Error('invalid_tps_stats');
  }
  return data;
}

/** One active request and polling timer per plugin/range; no snapshots survive the last subscriber. */
export function createTpsResources(load: Load, poll: Poll = refresh => {
  const timer = setInterval(refresh, 60_000);
  return () => clearInterval(timer);
}) {
  const resources = new Map<string, TpsResource>();
  function get(plugin: string, range: TpsRange): TpsResource {
    const key = JSON.stringify([plugin, range]);
    const cached = resources.get(key);
    if (cached) return cached;
    let active = false;
    let generation = 0;
    let controller: AbortController | undefined;
    let pending: Promise<void> | undefined;
    const state = writable<TpsState>({ data: null, busy: false, error: false }, () => {
      active = true;
      state.set({ data: null, busy: true, error: false });
      void refresh();
      const stopPoll = poll(() => { void refresh(); });
      return () => {
        active = false;
        generation++;
        controller?.abort();
        pending = undefined;
        stopPoll();
        if (resources.get(key) === resource) resources.delete(key);
      };
    });
    function refresh(): Promise<void> {
      if (!active) return Promise.resolve();
      if (pending) return pending;
      const version = ++generation;
      const request = new AbortController();
      controller = request;
      state.update(current => ({ ...current, busy: true }));
      pending = Promise.resolve().then(() => load(plugin, range, request.signal)).then(data => {
        const valid = validateStats(data, range);
        if (active && version === generation) state.set({ data: valid, busy: false, error: false });
      }).catch(() => {
        if (active && version === generation && !request.signal.aborted) state.set({ data: null, busy: false, error: true });
      }).finally(() => { if (version === generation) pending = undefined; });
      return pending;
    }
    const resource: TpsResource = { subscribe: state.subscribe, refresh };
    resources.set(key, resource);
    return resource;
  }
  return { get };
}

export type TpsResource = {
  subscribe: ReturnType<typeof writable<TpsState>>['subscribe'];
  refresh: () => Promise<void>;
};
