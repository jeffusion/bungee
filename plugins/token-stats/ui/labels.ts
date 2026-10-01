type Authority = 'official' | 'local' | 'heuristic' | 'partial' | 'none';
type Side = 'input' | 'output';
export type UsageSnapshot = {
  readonly officialInputTokens?: number;
  readonly officialOutputTokens?: number;
  readonly totalInputTokens?: number;
  readonly totalOutputTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedInputTokens?: number;
  readonly estimatedOutputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly logicalRequests?: number;
  readonly upstreamAttempts?: number;
  readonly authorityBreakdown?: {
    readonly input?: Partial<Record<Authority, number>>;
    readonly output?: Partial<Record<Authority, number>>;
  };
};

export const tokenAmount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** USD stays distinguishable from an unknown price and never rounds a positive estimate to $0. */
export function formatEstimatedUsd(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '$0';
  if (value < 0.000001) return '<$0.000001';
  return `$${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: value < 0.01 ? 0 : 2,
    maximumFractionDigits: value < 0.01 ? 8 : value < 1 ? 4 : 2,
  }).format(value)}`;
}

/** Aggregate zeroes are placeholders until an actual accounting event establishes a side's zero. */
export function reportedTokens(row: UsageSnapshot, side: Side): number | undefined {
  const value = tokenAmount(side === 'input'
    ? row.officialInputTokens ?? row.totalInputTokens ?? row.inputTokens
    : row.officialOutputTokens ?? row.totalOutputTokens ?? row.outputTokens);
  const noTraffic = tokenAmount(row.logicalRequests) === 0 && tokenAmount(row.upstreamAttempts) === 0;
  return value === 0 && !noTraffic && !tokenAmount(row.authorityBreakdown?.[side]?.official)
    ? undefined : value;
}

export function estimatedTokens(row: UsageSnapshot, side: Side): number | undefined {
  const value = tokenAmount(side === 'input' ? row.estimatedInputTokens : row.estimatedOutputTokens);
  const evidence = row.authorityBreakdown?.[side];
  const estimatedEvents = (tokenAmount(evidence?.local) ?? 0) + (tokenAmount(evidence?.heuristic) ?? 0)
    + (tokenAmount(evidence?.partial) ?? 0);
  const noTraffic = tokenAmount(row.logicalRequests) === 0 && tokenAmount(row.upstreamAttempts) === 0;
  return value === 0 && !noTraffic && estimatedEvents === 0 ? undefined : value;
}

export function usagePresentation(row: UsageSnapshot): {
  state: 'empty' | 'unknown' | 'usage'; input?: number; output?: number;
  positive: boolean;
} {
  const total = (side: Side) => {
    const reported = reportedTokens(row, side);
    const estimated = estimatedTokens(row, side);
    return reported === undefined && estimated === undefined ? undefined : (reported ?? 0) + (estimated ?? 0);
  };
  const input = total('input');
  const output = total('output');
  const positive = (input ?? 0) > 0 || (output ?? 0) > 0;
  const traffic = (tokenAmount(row.logicalRequests) ?? 0) > 0 || (tokenAmount(row.upstreamAttempts) ?? 0) > 0;
  return {
    state: positive || traffic && (input !== undefined || output !== undefined)
      ? 'usage' : traffic ? 'unknown' : 'empty',
    input, output, positive,
  };
}

export type ModelUsageRow = UsageSnapshot & {
  readonly dimension: string;
  readonly bucketStartMs?: number;
  readonly estimatedCostUsd?: number | null;
};
export type RankedModel = {
  id: string; tokens?: number; input?: number; output?: number;
  cacheRead?: number; cacheWrite?: number; estimatedCostUsd: number | null;
};
export type TimeBucket = { startMs: number; total: number; parts: { id: string; tokens: number }[]; details: { id: string; tokens: number }[] };
export type TimeSeries = { buckets: TimeBucket[]; models: string[]; maxTokens: number };
export type TokenRange = '1h' | '12h' | '24h';
export type TokenPageRange = '1d' | '7d' | '30d' | 'week' | 'month';
export type TokenStatsRange = TokenRange | TokenPageRange;
export const OTHER_MODEL = '\0other';
const RANGE_MS: Record<TokenRange, number> = { '1h': 3_600_000, '12h': 43_200_000, '24h': 86_400_000 };

export function modelTokenTotal(row: UsageSnapshot): number | undefined {
  const usage = usagePresentation(row);
  return usage.input === undefined && usage.output === undefined ? undefined : (usage.input ?? 0) + (usage.output ?? 0);
}

/** Cache is an input detail, never an extra amount to add to the token total. Aggregate zero lacks reporting evidence. */
export function cacheDetail(value: unknown): number | undefined {
  const amount = tokenAmount(value);
  return amount !== undefined && amount > 0 ? amount : undefined;
}

export function rankedModels(rows: readonly ModelUsageRow[]): RankedModel[] {
  return rows.map(row => {
    const usage = usagePresentation(row);
    return {
      id: row.dimension, tokens: modelTokenTotal(row), input: usage.input, output: usage.output,
      cacheRead: cacheDetail(row.cacheReadTokens), cacheWrite: cacheDetail(row.cacheWriteTokens),
      estimatedCostUsd: row.estimatedCostUsd ?? null,
    };
  }).sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1) || a.id.localeCompare(b.id));
}

/** Stable across tabs and ranges; the actual palette is declared in the widget for Tailwind's scanner. */
export function modelColorIndex(id: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16_777_619);
  return (hash >>> 0) % 5;
}

/** Only counted tokens make a bar; empty buckets have no visible segments. */
export function buildTimeSeries(rows: readonly ModelUsageRow[], range: TokenStatsRange, bucketMs: number, nowMs: number, bucketStarts?: readonly number[]): TimeSeries {
  if (!Number.isSafeInteger(bucketMs) || bucketMs <= 0) return { buckets: [], models: [], maxTokens: 0 };
  const starts = bucketStarts ? [...bucketStarts] : [];
  if (!bucketStarts && range in RANGE_MS) {
    const first = Math.floor((nowMs - RANGE_MS[range as TokenRange]) / bucketMs) * bucketMs;
    const last = Math.floor(nowMs / bucketMs) * bucketMs;
    for (let start = first; start <= last; start += bucketMs) starts.push(start);
  }
  if (!starts.length) return { buckets: [], models: [], maxTokens: 0 };
  const first = starts[0]!, last = starts[starts.length - 1]!;
  const byBucket = new Map<number, Map<string, number>>();
  const totals = new Map<string, number>();
  for (const row of rows) {
    const start = row.bucketStartMs;
    const tokens = modelTokenTotal(row);
    if (start === undefined || !Number.isSafeInteger(start) || start < first || start > last || tokens === undefined || tokens <= 0) continue;
    const bucket = byBucket.get(start) ?? new Map<string, number>();
    bucket.set(row.dimension, (bucket.get(row.dimension) ?? 0) + tokens);
    byBucket.set(start, bucket);
    totals.set(row.dimension, (totals.get(row.dimension) ?? 0) + tokens);
  }
  const named = [...totals].filter(([id]) => id !== 'unknown')
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const leading = named.slice(0, 4).map(([id]) => id);
  const models = [...leading, ...(totals.has('unknown') ? ['unknown'] : []), ...(named.length > 4 ? [OTHER_MODEL] : [])];
  const buckets: TimeBucket[] = [];
  for (const startMs of starts) {
    const amounts = byBucket.get(startMs) ?? new Map<string, number>();
    const details = [...amounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, tokens]) => ({ id, tokens }));
    const parts = models.map(id => ({ id, tokens: id === OTHER_MODEL
      ? [...amounts].reduce((sum, [model, value]) => sum + (leading.includes(model) || model === 'unknown' ? 0 : value), 0)
      : amounts.get(id) ?? 0 })).filter(part => part.tokens > 0);
    buckets.push({ startMs, parts, details, total: parts.reduce((sum, part) => sum + part.tokens, 0) });
  }
  return { buckets, models, maxTokens: Math.max(0, ...buckets.map(bucket => bucket.total)) };
}

export function formatTokenCount(value: unknown, locale?: string): string {
  const amount = tokenAmount(value);
  return amount === undefined ? '—' : new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(amount);
}

/** Cache tokens are subsets of input; clamping prevents double counting inconsistent partial reports. */
export function tokenComposition(row: UsageSnapshot): { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } {
  const usage = usagePresentation(row);
  const input = usage.input ?? 0;
  const cacheRead = Math.min(input, tokenAmount(row.cacheReadTokens) ?? 0);
  const cacheWrite = Math.min(input - cacheRead, tokenAmount(row.cacheWriteTokens) ?? 0);
  const output = usage.output ?? 0;
  return { input: input - cacheRead - cacheWrite, output, cacheRead, cacheWrite, total: input + output };
}

/** Dates and UTC offsets disambiguate midnight and repeated DST clock hours. */
export function timeAxisLabels(starts: readonly number[], locale?: string, timeZone?: string): string[] {
  const zone = timeZone ? { timeZone } : {};
  const days = new Intl.DateTimeFormat(locale, { ...zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dates = new Intl.DateTimeFormat(locale, { ...zone, month: 'numeric', day: 'numeric' });
  const clock = new Intl.DateTimeFormat(locale, { ...zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const offsets = new Intl.DateTimeFormat(locale, { ...zone, timeZoneName: 'shortOffset' });
  const crossesDay = new Set(starts.map(start => days.format(start))).size > 1;
  const zoneLabels = starts.map(start => offsets.formatToParts(start).find(part => part.type === 'timeZoneName')?.value ?? '');
  const changesOffset = new Set(zoneLabels).size > 1;
  return starts.map((start, index) => `${crossesDay ? `${dates.format(start)} ` : ''}${clock.format(start)}${changesOffset ? ` ${zoneLabels[index]}` : ''}`);
}
