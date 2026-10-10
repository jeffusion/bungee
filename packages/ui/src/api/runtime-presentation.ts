import { findRuntimeUpstream, type RuntimeUpstreamsResponse } from './runtime';

export function formatLastUsed(
  runtime: RuntimeUpstreamsResponse | null,
  stateKey: string,
  upstreamId: string | undefined,
  translate: (key: string, options?: { values: { count: number } }) => string,
  now = Date.now(),
): string {
    const record = findRuntimeUpstream(runtime, stateKey, upstreamId);
    if (!record) return translate('runtime.unavailable');
    const t = record.last_used_time;
    if (t === null) return translate(record.last_used_complete ? 'services.noUsageRecord' : 'runtime.unavailable');
    const prefix = record.last_used_complete ? '' : `${translate('runtime.observedOnly')} · `;
    const diffSec = Math.floor((now - t) / 1000);
    if (diffSec < 60) return prefix + translate('services.justNow');
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return prefix + translate('services.minutesAgo', { values: { count: diffMin } });
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return prefix + translate('services.hoursAgo', { values: { count: diffHr } });
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return prefix + translate('services.daysAgo', { values: { count: diffDay } });
    const diffMon = Math.floor(diffDay / 30);
    return prefix + translate('services.monthsAgo', { values: { count: diffMon } });
  }
