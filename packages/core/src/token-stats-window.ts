import type { TokenStatsRange } from './plugin.types';

const HOUR = 3_600_000;
export const TOKEN_STATS_RETENTION_MS = 31 * 24 * HOUR;
export const TOKEN_STATS_RANGES = ['1h', '12h', '24h', '1d', '7d', '30d', 'day', 'week', 'month'] as const;

/** Recent page ranges are consecutive elapsed hours; calendar ranges use local dates. */
export function tokenStatsWindow(range: TokenStatsRange, asOfMs: number, timeZone = 'UTC') {
  if (range === '1h' || range === '12h' || range === '24h') {
    const duration = { '1h': HOUR, '12h': 12 * HOUR, '24h': 24 * HOUR };
    const bucketMs = { '1h': 300_000, '12h': HOUR, '24h': 2 * HOUR }[range];
    return { startMs: asOfMs - duration[range], endMs: asOfMs, bucketMs };
  }
  if (range === '1d' || range === '7d' || range === '30d') {
    const days = { '1d': 1, '7d': 7, '30d': 30 }[range];
    const bucketMs = range === '1d' ? HOUR : 24 * HOUR;
    const startMs = asOfMs - days * 24 * HOUR;
    const bucketStarts = Array.from({ length: range === '1d' ? 24 : days }, (_, i) => startMs + i * bucketMs);
    return { startMs, endMs: asOfMs, bucketMs, bucketStarts };
  }
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  });
  const parts = (ms: number) => Object.fromEntries(format.formatToParts(ms)
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const today = parts(asOfMs);
  const day = Date.UTC(today.year!, today.month! - 1, today.day!);
  // Resolve each local midnight separately so DST days can contain 23 or 25 hours.
  const midnight = (date: number) => {
    let candidate = date;
    for (let i = 0; i < 4; i++) {
      const p = parts(candidate);
      const local = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
      const next = candidate + date - local;
      if (next === candidate) return candidate;
      candidate = next;
    }
    return candidate;
  };
  if (range === 'day') {
    const startMs = midnight(day);
    const bucketEndMs = midnight(day + 24 * HOUR);
    const bucketStarts = Array.from({ length: Math.ceil((bucketEndMs - startMs) / HOUR) }, (_, i) => startMs + i * HOUR);
    return { startMs, endMs: asOfMs, bucketMs: HOUR, bucketStarts, bucketEndMs };
  }
  const firstDay = range === 'month' ? Date.UTC(today.year!, today.month! - 1, 1)
    : day - ((new Date(day).getUTCDay() + 6) % 7) * 24 * HOUR;
  const nextPeriod = range === 'month' ? Date.UTC(today.year!, today.month!, 1) : firstDay + 7 * 24 * HOUR;
  const days = (nextPeriod - firstDay) / (24 * HOUR);
  const bucketStarts = Array.from({ length: days }, (_, i) => midnight(firstDay + i * 24 * HOUR));
  return { startMs: bucketStarts[0]!, endMs: asOfMs, bucketMs: 24 * HOUR, bucketStarts, bucketEndMs: midnight(nextPeriod) };
}
