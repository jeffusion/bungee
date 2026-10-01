import { writable } from 'svelte/store';
import type { ModelUsageRow, TokenStatsRange, UsageSnapshot } from './labels';

export type StatsResponse = UsageSnapshot & {
  groupBy: 'model' | 'time';
  asOfMs?: number;
  estimatedCostUsd: number | null;
  bucketMs?: number;
  bucketStarts?: number[];
  data: ModelUsageRow[];
};
export type StatsState = { data: StatsResponse | null; busy: boolean; error: string; refreshedAt: number };

/** One request and timer for all subscribers; the last unsubscribe aborts pending work. */
export function createStatsResource(
  load: (signal: AbortSignal) => Promise<StatsResponse>,
  onStop: () => void = () => {},
) {
  let current: StatsState = { data: null, busy: false, error: '', refreshedAt: 0 };
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  let generation = 0;
  let active = false;
  const state = writable<StatsState>(current, () => {
    active = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    return () => {
      active = false; generation++; controller?.abort(); pending = undefined;
      clearInterval(timer); onStop();
    };
  });
  function publish(next: StatsState) { current = next; state.set(next); }
  function refresh(): Promise<void> {
    if (!active) return Promise.resolve();
    if (pending) return pending;
    const request = new AbortController();
    controller = request;
    const version = ++generation;
    publish({ ...current, busy: true });
    pending = Promise.resolve().then(() => load(request.signal)).then(data => {
      if (version === generation) publish({ data, busy: false, error: '', refreshedAt: Date.now() });
    }).catch(error => {
      if (version === generation && !request.signal.aborted) {
        publish({ ...current, busy: false, error: error instanceof Error ? error.message : String(error) });
      }
    }).finally(() => { if (version === generation) pending = undefined; });
    return pending;
  }
  return { subscribe: state.subscribe, refresh };
}

export type StatsResource = ReturnType<typeof createStatsResource>;
export type StatsRange = TokenStatsRange;
