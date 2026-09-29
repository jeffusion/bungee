import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';
import { fileURLToPath } from 'node:url';
import { loadPluginArtifactManifest } from '../../core/src/plugin-artifact-contract';
import {
  buildTimeSeries, cacheDetail, estimatedTokens, formatEstimatedUsd, modelColorIndex, modelTokenTotal,
  OTHER_MODEL, rankedModels, reportedTokens, usagePresentation, type ModelUsageRow,
} from '../../../plugins/token-stats/ui/labels';

const dashboard = await Bun.file(new URL('../src/routes/Dashboard.svelte', import.meta.url)).text();
const widget = await Bun.file(new URL('../../../plugins/token-stats/ui/TokenStatsChart.svelte', import.meta.url)).text();
const manifest = await Bun.file(new URL('../../../plugins/token-stats/manifest.json', import.meta.url)).json();
const nativePanels = dashboard.split('<!-- ===== Native plugin widgets')[1]?.split('<!-- ===== iframe plugin panels')[0];
const axisModule = widget.split('<script lang="ts" module>')[1]?.split('</script>')[0];
if (!axisModule) throw new Error('Token Stats axis formatter is missing');
const axisSource = new Bun.Transpiler({ loader: 'ts' })
  .transformSync(axisModule.replace('export function timeAxisLabels', 'function timeAxisLabels'));
const timeAxisLabels = new Function(`${axisSource}\nreturn timeAxisLabels;`)() as (
  starts: readonly [number, number, number], locale?: string, timeZone?: string,
) => [string, string, string];

function measured(id: string, input: number, output: number, estimatedCostUsd: number | null, bucketStartMs?: number): ModelUsageRow {
  return { dimension: id, bucketStartMs, officialInputTokens: input, officialOutputTokens: output,
    estimatedCostUsd, logicalRequests: 1, upstreamAttempts: 1,
    authorityBreakdown: { input: { official: 1 }, output: { official: 1 } } };
}

test('Token Stats alone fills the native-widget row without changing other cards or the mobile grid', async () => {
  const parsed = await loadPluginArtifactManifest(fileURLToPath(new URL('../../../plugins/token-stats', import.meta.url)));
  expect(parsed.contributes?.nativeWidgets).toContainEqual(expect.objectContaining({
    id: 'token-stats-chart', component: 'TokenStatsChart', size: 'large',
  }));
  expect(nativePanels).toContain("soleTokenStats = contentSized && nativeWidgetPanels.length === 1");
  expect(nativePanels).toContain("{panel.w === 4 || soleTokenStats ? 'lg:col-span-4' : panel.w === 2 ? 'lg:col-span-2' : ''}");
  expect(nativePanels).toContain('class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3"');
  expect(nativePanels).toContain('scrollable={!contentSized}');
  expect(nativePanels).toContain("{contentSized ? 'self-start' : 'h-64'}");
  expect(nativePanels).toContain("contentSized = panel.pluginName === 'token-stats' && panel.id === 'token-stats-chart'");
  expect(nativePanels).toContain("<div class=\"{contentSized ? 'p-4 sm:p-5' : 'p-2 h-full'}\">");
  expect(nativePanels?.match(/p-4 sm:p-5/g)).toHaveLength(1); // only this compact widget gets the extra inset
  expect(dashboard).toContain('class="h-64 {panel.w >= 2');
});

test('exactly two views, default model, shared range and no removed dimensions or audit UI', () => {
  expect(widget).toContain("let selectedView: View = $state('model')");
  expect(widget).toContain("['model', t('dimension.model')], ['time', t('dimension.time')]");
  expect(widget).toContain('aria-pressed={selectedView === view}');
  expect(widget).toContain('`/stats?range=${encodeURIComponent(selectedRange)}&groupBy=${selectedView}`');
  expect(widget).not.toMatch(/dimension\.(all|route|upstream|provider)|loadUpstreams|ConfigurationSnapshot|ChartJS|token-stats-details|token-stats-warning/);
  expect(widget).toContain('data-testid="token-stats-model-list"');
  expect(widget).toContain('data-testid="token-stats-time-chart"');
  for (const [locale, views] of [['en', ['Models', 'Time']], ['zh-CN', ['模型', '时间']]] as const) {
    const messages = manifest.translations[locale];
    expect([messages['dimension.model'], messages['dimension.time']]).toEqual(views);
    expect(messages['dimension.route']).toBeUndefined();
    expect(messages['ui.unknownModel']).toBeTruthy();
    expect(messages['ui.otherModels']).toBeTruthy();
    expect(messages['ui.timeChart']).toBeTruthy();
  }
});

test('model rank lists every model, counts only evidenced tokens and keeps unknown distinct from measured zero', () => {
  const rows = [
    measured('small', 1, 1, 0.0000004),
    { ...measured('large', 16, 4, 0.004), cacheReadTokens: 5, cacheWriteTokens: 3 },
    { dimension: 'unknown', logicalRequests: 1, upstreamAttempts: 1, estimatedCostUsd: null,
      inputTokens: 0, outputTokens: 0, authorityBreakdown: { input: { none: 1 }, output: { none: 1 } } },
    { ...measured('zero', 0, 0, 0), cacheReadTokens: 0, cacheWriteTokens: 0 },
  ];
  const ranked = rankedModels(rows);
  expect(ranked.map(row => row.id)).toEqual(['large', 'small', 'zero', 'unknown']);
  expect(ranked.map(row => row.tokens)).toEqual([20, 2, 0, undefined]);
  expect(ranked.map(row => row.input)).toEqual([16, 1, 0, undefined]);
  expect(ranked.map(row => row.output)).toEqual([4, 1, 0, undefined]);
  expect(ranked.map(row => row.cacheRead)).toEqual([5, undefined, undefined, undefined]);
  expect(ranked.map(row => row.cacheWrite)).toEqual([3, undefined, undefined, undefined]);
  expect(ranked.map(row => formatEstimatedUsd(row.estimatedCostUsd))).toEqual(['$0.004', '<$0.000001', '$0', '—']);
  expect(rankedModels([{ ...measured('solo', 17, 7, 0.0000685), cacheReadTokens: 5, cacheWriteTokens: 2 }])[0])
    .toEqual(expect.objectContaining({ tokens: 24, input: 17, output: 7, cacheRead: 5, cacheWrite: 2, estimatedCostUsd: 0.0000685 }));
  expect(cacheDetail(0)).toBeUndefined(); // aggregate zero has no reported-zero provenance
  expect(cacheDetail(9)).toBe(9);
  expect(modelTokenTotal(rows[2])).toBeUndefined();
  expect(modelTokenTotal(rows[3])).toBe(0);
  expect(widget).toContain('min-w-0 break-all font-mono'); // long names wrap, rather than disappear on touch
  expect(widget).toContain('USD <span class="text-zinc-200">{formatEstimatedUsd(model.estimatedCostUsd)}</span>');
  const modelMarkup = widget.split("{#if selectedView === 'model' && models.length}")[1]?.split("{:else if selectedView === 'time'")[0] ?? '';
  expect(modelMarkup.match(/class="nx-label"/g)).toHaveLength(4);
  expect(modelMarkup.match(/class="font-display text-sm text-zinc-50"/g)).toHaveLength(4);
  expect(modelMarkup).toContain('class="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-l border-carbon-500 pl-2"');
  expect(modelMarkup.match(/class="inline-flex items-baseline gap-1\.5 whitespace-nowrap"/g)).toHaveLength(2);
  expect(modelMarkup).toContain('class="nx-label">{cacheLabels.read}</span><span class="font-display text-sm text-zinc-50">{display(model.cacheRead)}');
  expect(modelMarkup).toContain('class="nx-label">{cacheLabels.write}</span><span class="font-display text-sm text-zinc-50">{display(model.cacheWrite)}');
  expect(widget).toContain("? { read: '缓存读取', write: '缓存写入' }");
  expect(widget).toContain("{ read: 'Cache read', write: 'Cache write' }");
  expect(widget).toContain('maxModelTokens > 0 ? (model.tokens ?? 0) / maxModelTokens * 100 : 0');
  expect(widget).not.toContain('shareLabel');
  expect(widget).not.toContain('model.share');
  expect(modelMarkup).not.toContain('%</span>');
  expect(widget).not.toContain('slice(0, 4)'); // only the time trend folds the long tail
});

test('twelve-ish clock buckets aggregate the same model, retain gaps, and fold only the time long tail', () => {
  const step = 300_000;
  const now = 14 * 3_600_000 + 35 * 60_000;
  const firstActive = 14 * 3_600_000 + 15 * 60_000;
  const secondActive = firstActive + step;
  const rows = [measured('a', 10, 0, null, firstActive), measured('a', 5, 0, null, firstActive),
    measured('b', 7, 0, null, firstActive), measured('c', 6, 0, null, firstActive),
    measured('d', 5, 0, null, firstActive), measured('e', 4, 0, null, firstActive),
    measured('unknown', 3, 0, null, firstActive), measured('a', 2, 0, null, secondActive)];
  const series = buildTimeSeries(rows, '1h', step, now);
  expect(series.buckets).toHaveLength(13); // two partial end buckets, no fabricated consumption
  expect(series.models).toEqual(['a', 'b', 'c', 'd', 'unknown', OTHER_MODEL]);
  const active = series.buckets.find(bucket => bucket.startMs === firstActive)!;
  expect(active.total).toBe(40);
  expect(active.parts).toEqual([
    { id: 'a', tokens: 15 }, { id: 'b', tokens: 7 }, { id: 'c', tokens: 6 },
    { id: 'd', tokens: 5 }, { id: 'unknown', tokens: 3 }, { id: OTHER_MODEL, tokens: 4 },
  ]);
  expect(active.details).toEqual([
    { id: 'a', tokens: 15 }, { id: 'b', tokens: 7 }, { id: 'c', tokens: 6 },
    { id: 'd', tokens: 5 }, { id: 'e', tokens: 4 }, { id: 'unknown', tokens: 3 },
  ]);
  expect(series.buckets.find(bucket => bucket.startMs === secondActive)?.total).toBe(2);
  expect(series.buckets.filter(bucket => bucket.total === 0).every(bucket => bucket.parts.length === 0)).toBe(true);
  expect(buildTimeSeries(rows, '12h', 3_600_000, now).buckets.length).toBeLessThanOrEqual(13);
  expect(buildTimeSeries(rows, '24h', 7_200_000, now).buckets.length).toBeLessThanOrEqual(13);
  expect(buildTimeSeries([], '1h', step, now).maxTokens).toBe(0);
  expect(buildTimeSeries(rows, '1h', 0, now).buckets).toEqual([]);
  expect(modelColorIndex('a')).toBe(modelColorIndex('a')); // identity, not rank, chooses colour
  expect(widget).toContain('tones[modelColorIndex(id)]');
  expect(widget).toContain('style:height={`${bucket.total / trend.maxTokens * 100}%`}');
  expect(widget).not.toContain('row.estimatedCostUsd'); // USD is not a Token-axis series
});

test('mobile time bars support touch, keyboard focus, arrow navigation and readable values', () => {
  expect(widget).toContain('flex h-36 items-end gap-1 border-b border-carbon-500 sm:h-44');
  expect(widget).toContain('aria-label={bucketDescription(bucket)}');
  expect(widget).toContain('onpointerenter={() => selectedBucketStart = bucket.startMs}');
  expect(widget).toContain('onfocus={() => selectedBucketStart = bucket.startMs}');
  expect(widget).toContain('onclick={() => selectedBucketStart = bucket.startMs}');
  expect(widget).toContain("event.key === 'ArrowLeft' || event.key === 'ArrowRight'");
  expect(widget).toContain('data-testid="token-stats-bucket-detail"');
  expect(widget).toContain('{#each selected.details as part (part.id)}');
  expect(widget).toContain('aria-live="polite"');
  expect(widget).toContain('flex h-full min-w-0 flex-1');
  expect(widget).toContain('max-w-28 truncate');
});

test('visible clock ticks add compact dates across midnight but stay short on one calendar day', () => {
  const at = (day: number, hour: number) => Date.UTC(2026, 8, day, hour);
  const sameDay = [at(29, 1), at(29, 7), at(29, 13)] as const;
  expect(timeAxisLabels(sameDay, 'en-US', 'UTC')).toEqual(['01:00', '07:00', '13:00']);
  expect(timeAxisLabels(sameDay, 'zh-CN', 'UTC')).toEqual(['01:00', '07:00', '13:00']);

  const repeatedHourAcrossDays = [at(28, 18), at(29, 6), at(29, 18)] as const;
  for (const language of ['en-US', 'zh-CN']) {
    expect(timeAxisLabels(repeatedHourAcrossDays, language, 'UTC'))
      .toEqual(['9/28 18:00', '9/29 06:00', '9/29 18:00']);
    expect(timeAxisLabels([at(28, 23), at(29, 0), at(29, 1)], language, 'UTC'))
      .toEqual(['9/28 23:00', '9/29 00:00', '9/29 01:00']);
  }
  expect(widget).toContain('trend.buckets[0].startMs');
  expect(widget).toContain('trend.buckets[trend.buckets.length - 1].startMs');
  expect(widget).toContain('{axisTicks[0]}');
  expect(widget).toContain('{axisTicks[2]}');
});

test('DST clock repeats distinguish offsets, with compact mobile fallback for dense ticks', () => {
  const fallBack = [
    Date.parse('2026-11-01T05:30:00Z'),
    Date.parse('2026-11-01T06:00:00Z'),
    Date.parse('2026-11-01T06:30:00Z'),
  ] as const;
  for (const language of ['en-US', 'zh-CN']) {
    expect(timeAxisLabels(fallBack, language, 'America/New_York'))
      .toEqual(['01:30 GMT-4', '01:00 GMT-5', '01:30 GMT-5']);
  }
  expect(timeAxisLabels([
    Date.parse('2026-03-08T06:30:00Z'), Date.parse('2026-03-08T07:00:00Z'),
    Date.parse('2026-03-08T07:30:00Z'),
  ], 'en-US', 'America/New_York')).toEqual(['01:30 GMT-5', '03:00 GMT-4', '03:30 GMT-4']);
  const overnightDst = [
    Date.parse('2026-10-31T23:30:00-04:00'),
    Date.parse('2026-11-01T01:30:00-04:00'),
    Date.parse('2026-11-01T02:30:00-05:00'),
  ] as const;
  const labels = timeAxisLabels(overnightDst, 'en-US', 'America/New_York');
  expect(labels).toEqual(['10/31 23:30 GMT-4', '11/1 01:30 GMT-4', '11/1 02:30 GMT-5']);
  expect(labels.join('').length).toBeGreaterThan(42);
  expect(widget).toContain("denseAxis ? 'hidden sm:inline' : ''");
  expect(widget).toContain("timeZoneName: 'shortOffset' as const"); // full-date hover, touch and keyboard detail
});

test('USD format never turns absent price or small positive USD into a false zero', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, '$1']) expect(formatEstimatedUsd(value)).toBe('—');
  expect(formatEstimatedUsd(0)).toBe('$0');
  expect(formatEstimatedUsd(Number.MIN_VALUE)).toBe('<$0.000001');
  expect(formatEstimatedUsd(0.000001)).toBe('$0.000001');
  expect(formatEstimatedUsd(0.00001234567)).toBe('$0.00001235');
  expect(formatEstimatedUsd(0.123456)).toBe('$0.1235');
  expect(formatEstimatedUsd(1234.5)).toBe('$1,234.50');
  expect(widget).toContain('grid-cols-2 gap-y-2 sm:grid-cols-3');
  expect(widget).toContain('col-span-2 flex min-w-0 items-baseline justify-between gap-2 border-t');
  expect(widget).toContain('min-w-0 truncate font-display text-lg');
  for (const [locale, label] of [['en', 'Est. cost · USD'], ['zh-CN', '费用估算 · USD']] as const) {
    expect(manifest.translations[locale]['ui.estimatedCostUsd']).toBe(label);
  }
});

test('loading, empty, unknown, official zero and partial usage remain distinct across range changes', () => {
  expect(usagePresentation({ logicalRequests: 0, upstreamAttempts: 0 }).state).toBe('empty');
  const unknown = { logicalRequests: 1, upstreamAttempts: 1, totalInputTokens: 0, totalOutputTokens: 0,
    authorityBreakdown: { input: { none: 1 }, output: { none: 1 } } };
  expect(usagePresentation(unknown).input).toBeUndefined();
  const zero = { ...unknown, authorityBreakdown: { input: { official: 1 }, output: { official: 1 } } };
  expect(reportedTokens(zero, 'input')).toBe(0);
  expect(usagePresentation(zero).input).toBe(0);
  const partial = { ...unknown, estimatedInputTokens: 14, authorityBreakdown: {
    input: { partial: 1 }, output: { none: 1 },
  } };
  expect(estimatedTokens(partial, 'input')).toBe(14);
  expect(usagePresentation(partial)).toMatchObject({ state: 'usage', input: 14, output: undefined });
  expect(widget).toContain('const usage = $derived(usagePresentation(stats ?? { logicalRequests: 0, upstreamAttempts: 0 }));');
  expect(widget).toContain('{#if loading && !stats}');
  expect(widget).toContain('data-testid="token-stats-empty"');
  expect(widget.match(/nx-display/g)).toHaveLength(2);
  for (const generate of ['client', 'server'] as const) {
    expect(compile(widget, { filename: 'TokenStatsChart.svelte', generate }).warnings).toEqual([]);
  }
});
