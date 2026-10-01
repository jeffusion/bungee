import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  buildTimeSeries, estimatedTokens, modelTokenTotal, OTHER_MODEL,
  rankedModels, reportedTokens, usagePresentation,
} from '../../../../plugins/token-stats/ui/labels';

describe('Token Stats widget consumer contract', () => {
  const repositoryRoot = resolve(import.meta.dir, '../../../..');
  const pluginDir = join(repositoryRoot, 'plugins/token-stats');
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf-8'));

  test('declares a combined KPI and a separate time widget, with a native model statistics page', () => {
    expect(manifest.contributes.nativeWidgets).toEqual([
      expect.objectContaining({ id: 'token-stats-overview', component: 'TokenStatsMetric', presentation: 'kpi' }),
      expect.objectContaining({ id: 'token-stats-time', component: 'TokenStatsChart' }),
    ]);
    expect(manifest.contributes.navigation).toContainEqual(expect.objectContaining({ path: '/statistics', component: 'TokenStatsPage' }));
    expect(manifest.contributes.settings).toBe('/pricing');
    expect(manifest.contributes.nativeSettingsComponent).toBe('TokenStatsSettings');
    expect(manifest.contributes.api).toContainEqual(expect.objectContaining({ path: '/stats', methods: ['GET'], execution: 'control' }));
  });

  test('retains unknown model and all model rows while collapsing only time long-tail', () => {
    const row = (dimension: string, tokens: number, bucketStartMs: number) => ({ dimension, bucketStartMs,
      officialInputTokens: tokens, officialOutputTokens: 0, logicalRequests: 1, upstreamAttempts: 1,
      authorityBreakdown: { input: { official: 1 }, output: { official: 1 } }, estimatedCostUsd: null });
    const rows = ['a', 'b', 'c', 'd', 'e', 'unknown'].map((id, index) => row(id, 10 - index, 3_600_000));
    expect(rankedModels(rows).map(item => item.id)).toHaveLength(6);
    expect(modelTokenTotal(rows[5])).toBe(5);
    const series = buildTimeSeries(rows, '1h', 300_000, 3_900_000);
    expect(series.models).toContain('unknown');
    expect(series.models).toContain(OTHER_MODEL);
    expect(series.buckets.find(bucket => bucket.startMs === 3_600_000)?.total).toBe(45);
  });

  test('distinguishes idle, unknown, measured zero, estimated usage, and partial data', () => {
    const idle = { logicalRequests: 0, upstreamAttempts: 0 };
    expect(usagePresentation(idle)).toEqual({
      state: 'empty', input: undefined, output: undefined, positive: false,
    });

    const requestWithoutUsage = { logicalRequests: 1, upstreamAttempts: 1 };
    expect(usagePresentation(requestWithoutUsage)).toEqual({
      state: 'unknown', input: undefined, output: undefined, positive: false,
    });

    const measuredZero = {
      ...requestWithoutUsage,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      authorityBreakdown: { input: { official: 1 }, output: { official: 1 } },
    };
    expect(reportedTokens(measuredZero, 'input')).toBe(0);
    expect(usagePresentation(measuredZero)).toEqual({
      state: 'usage', input: 0, output: 0, positive: false,
    });

    const placeholderZero = {
      ...requestWithoutUsage,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      authorityBreakdown: { input: { none: 1 }, output: { none: 1 } },
    };
    expect(reportedTokens(placeholderZero, 'input')).toBeUndefined();
    expect(usagePresentation(placeholderZero).state).toBe('unknown');

    const textAndUnmeasuredMedia = {
      ...requestWithoutUsage,
      estimatedInputTokens: 14,
      totalOutputTokens: 0,
      authorityBreakdown: { input: { partial: 1 }, output: { none: 1 } },
    };
    expect(usagePresentation(textAndUnmeasuredMedia)).toEqual({
      state: 'usage', input: 14, output: undefined, positive: true,
    });
    expect(estimatedTokens(textAndUnmeasuredMedia, 'input')).toBe(14);
    expect(reportedTokens(textAndUnmeasuredMedia, 'output')).toBeUndefined();

    const partialUsage = {
      ...requestWithoutUsage,
      officialInputTokens: 17,
      officialOutputTokens: 7,
      estimatedInputTokens: 3,
      cacheReadTokens: 5,
      authorityBreakdown: {
        input: { official: 1, heuristic: 1 },
        output: { official: 1, none: 1 },
      },
    };
    expect(reportedTokens(partialUsage, 'input')).toBe(17);
    expect(estimatedTokens(partialUsage, 'input')).toBe(3);
    expect(usagePresentation(partialUsage)).toEqual({
      state: 'usage', input: 20, output: 7, positive: true,
    }); // Event counts and cache details do not add token amounts to the total.
  });

});
