import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';
import { parsePluginManifestText } from '../../core/src/plugin-manifest-catalog/manifest-parser';
import { defaultLayout, templateLayout, parseLayout, GRID_COLUMNS, type CardDefinition } from '../src/components/dashboard/layout';
import { timeAxisLabels, tokenComposition, usagePresentation, buildTimeSeries, modelTokenTotal,
  formatEstimatedUsd, type ModelUsageRow } from '../../../plugins/token-stats/ui/labels';

const manifest = parsePluginManifestText(await Bun.file(new URL('../../../plugins/token-stats/manifest.json', import.meta.url)).text());
const definitions: CardDefinition[] = manifest.contributes!.nativeWidgets!.map(widget => ({
  id: `plugin:native:token-stats:${widget.id}`, title: widget.title, group: 'plugin', description: '', tag: 'TOKEN',
  presentation: widget.presentation, w: widget.size === 'full' ? GRID_COLUMNS : GRID_COLUMNS / 2, h: widget.size === 'full' ? 4 : 2,
}));

test('both token cards survive desktop and mobile layout persistence', () => {
  const layout = parseLayout(templateLayout('llm', definitions));
  expect(layout.cards.filter(card => card.id.startsWith('plugin:')).map(card => card.id)).toEqual(definitions.map(card => card.id));
  expect(layout.mobile.filter(card => card.id.startsWith('plugin:'))).toHaveLength(2);
  expect(layout.cards.filter(card => card.id.startsWith('plugin:')).map(({ x, y, w, h }) => ({ x, y, w, h }))).toEqual([
    { x: 18, y: 0, w: 12, h: 4 }, { x: 10, y: 4, w: 20, h: 8 },
  ]);
});

test('old combined widget migrates once, preserving other cards and mobile preferences', () => {
  const old = 'plugin:native:token-stats:token-stats-chart';
  const time = 'plugin:native:token-stats:token-stats-time';
  const overview = 'plugin:native:token-stats:token-stats-overview';
  for (const version of [2, 3, 4]) {
    const columns = version === 2 ? 12 : version === 3 ? 15 : 30;
    const layout = parseLayout({ version, cards: [
      { id: old, x: 0, y: 4, w: columns, h: 5 },
      { id: 'chart.requests', x: 0, y: 0, w: columns, h: 4 },
    ], mobile: [{ id: old, height: 'tall' }, { id: 'chart.requests', height: 'compact' }] });
    expect(layout.cards.map(card => card.id)).toEqual([time, 'chart.requests', overview]);
    expect(layout.cards[1]).toEqual({ id: 'chart.requests', x: 0, y: 0, w: 30, h: 8 });
    expect(layout.mobile).toEqual([{ id: overview, height: 'standard' }, { id: time, height: 'tall' }, { id: 'chart.requests', height: 'compact' }]);
    expect(parseLayout(layout)).toEqual(layout);
    layout.cards = layout.cards.filter(card => card.id !== overview);
    layout.mobile = layout.mobile.filter(card => card.id !== overview);
    expect(parseLayout(layout).cards.map(card => card.id)).not.toContain(overview);
  }
  expect(parseLayout(defaultLayout()).cards.some(card => card.id.startsWith('plugin:'))).toBe(false);
});

test('Token composition does not count cache twice and unknown usage remains unknown', () => {
  const row = { officialInputTokens: 100, officialOutputTokens: 20, cacheReadTokens: 70, cacheWriteTokens: 10 };
  expect(tokenComposition(row)).toEqual({ input: 20, output: 20, cacheRead: 70, cacheWrite: 10, total: 120 });
  expect(modelTokenTotal(row)).toBe(120);
  expect(tokenComposition({ ...row, cacheReadTokens: 200 })).toEqual({ input: 0, output: 20, cacheRead: 100, cacheWrite: 0, total: 120 });
  expect(usagePresentation({ logicalRequests: 1, upstreamAttempts: 1 }).state).toBe('unknown');
  expect(formatEstimatedUsd(null)).toBe('—');
  expect(formatEstimatedUsd(0)).toBe('$0');
  expect(formatEstimatedUsd(0.0000001)).toBe('<$0.000001');
});

test('time buckets preserve gaps, count totals once, and retain long-tail details', () => {
  const now = 3_900_000;
  const rows: ModelUsageRow[] = ['a', 'b', 'c', 'd', 'e', 'unknown'].map((dimension, index) => ({
    dimension, bucketStartMs: 3_600_000, officialInputTokens: 10 - index, officialOutputTokens: 0,
  }));
  const series = buildTimeSeries(rows, '1h', 300_000, now);
  expect(series.buckets.find(bucket => bucket.startMs === 3_600_000)?.total).toBe(45);
  expect(series.buckets.find(bucket => bucket.startMs === 3_600_000)?.details).toHaveLength(6);
  expect(series.models).toHaveLength(6);
  expect(series.buckets.some(bucket => bucket.total === 0)).toBe(true);
});

test('clock labels distinguish midnight and repeated DST hours', () => {
  expect(timeAxisLabels([Date.UTC(2026, 8, 28, 23), Date.UTC(2026, 8, 29, 0)], 'en-US', 'UTC'))
    .toEqual(['9/28 23:00', '9/29 00:00']);
  expect(timeAxisLabels([Date.parse('2026-11-01T05:30:00Z'), Date.parse('2026-11-01T06:30:00Z')], 'en-US', 'America/New_York'))
    .toEqual(['01:30 GMT-4', '01:30 GMT-5']);
});

test('page charts preserve server calendar boundaries, including a 25-hour day and empty days', () => {
  const starts = [Date.UTC(2026, 10, 1, 4), Date.UTC(2026, 10, 2, 5), Date.UTC(2026, 10, 3, 5)];
  const series = buildTimeSeries([
    { dimension: 'model-a', bucketStartMs: starts[0], officialInputTokens: 10, officialOutputTokens: 5 },
    { dimension: 'model-b', bucketStartMs: starts[2], officialInputTokens: 3, officialOutputTokens: 2 },
  ], 'month', 86_400_000, Date.UTC(2026, 10, 3, 18), starts);
  expect(series.buckets.map(bucket => bucket.startMs)).toEqual(starts);
  expect(series.buckets.map(bucket => bucket.total)).toEqual([15, 0, 5]);
  expect(series.models).toEqual(['model-a', 'model-b']);
});

test('new plugin components compile for browser and server without warnings', async () => {
  for (const name of ['TokenStatsChart', 'TokenStatsMetric', 'TokenStatsPage', 'UsageTimeChart']) {
    const source = await Bun.file(new URL(`../../../plugins/token-stats/ui/${name}.svelte`, import.meta.url)).text();
    for (const generate of ['client', 'server'] as const) expect(compile(source, { filename: `${name}.svelte`, generate }).warnings).toEqual([]);
  }
});
