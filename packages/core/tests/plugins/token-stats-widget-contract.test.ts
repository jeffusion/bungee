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
  const widget = readFileSync(join(pluginDir, 'ui/TokenStatsChart.svelte'), 'utf-8').replace(/\r\n/g, '\n');
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf-8'));
  const control = readFileSync(join(pluginDir, 'server/control.ts'), 'utf-8');

  test('requests only model or time with the selected range through the control API', () => {
    expect(widget).toContain("let selectedView: View = $state('model')");
    expect(widget).toContain("['model', t('dimension.model')], ['time', t('dimension.time')]");
    for (const dimension of ['all', 'route', 'upstream', 'provider']) expect(widget).not.toContain(`'${dimension}'`);
    expect(widget).toContain('requestPluginControl<StatsResponse>');
    expect(widget).toContain('`/stats?range=${encodeURIComponent(selectedRange)}&groupBy=${selectedView}`');
    expect(widget).toContain("'GET', undefined, controller.signal");
  });

  test('keeps compact input/output/USD KPIs with model rank and time-only token bars', () => {
    for (const side of ['input', 'output']) {
      expect(widget).toContain(`estimatedTokens(stats, '${side}') !== undefined`);
    }
    expect(widget).toContain("usage.state === 'empty'");
    expect(widget).toContain('data-testid="token-stats-primary"');
    expect(widget).toContain('data-testid="token-stats-cost"');
    expect(widget).toContain('data-testid="token-stats-model-list"');
    expect(widget).toContain('data-testid="token-stats-time-chart"');
    expect(widget).toContain('data-testid="token-stats-bucket-detail"');
    expect(widget).toContain('style:height={`${bucket.total / trend.maxTokens * 100}%`}');
    expect(widget).not.toContain('token-stats-warning');
    expect(widget).not.toContain('token-stats-details');
    expect(widget).not.toContain("t('ui.missingInput')");
    expect(widget).not.toContain("t('ui.logicalRequests')");
    expect(manifest.translations.en['ui.includesEstimate']).toBe('incl. estimate');
    expect(manifest.translations['zh-CN']['ui.includesEstimate']).toBe('含估算');
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

  test('renders request errors, a simple empty state and two unknown values', () => {
    expect(widget).toContain('{:else if error}');
    expect(widget).toContain('role="alert"');
    expect(widget).toContain("usage.state === 'empty'");
    expect(widget).toContain('data-testid="token-stats-empty"');
    expect(widget).toContain('title={usage.input === undefined ? t(\'ui.unknownValue\') : display(usage.input)}');
    expect(widget).toContain('title={usage.output === undefined ? t(\'ui.unknownValue\') : display(usage.output)}');
    expect(widget.match(/nx-display/g)).toHaveLength(2);
    expect(manifest.translations.en['ui.loadFailed']).toBeTruthy();
    expect(manifest.translations.en['ui.noData']).toBeTruthy();
  });

  test('aborts obsolete requests and cleans up the widget on unmount', () => {
    expect(widget).toContain('controller?.abort();');
    expect(widget).toContain('current !== generation');
    expect(widget).toContain('controller.signal.aborted');
    expect(widget).toContain('++generation;');
    expect(widget).toContain('clearInterval(interval);');
  });

  test('keeps the declared native widget and its read-only GET control endpoint aligned', () => {
    const widgets = manifest.contributes?.nativeWidgets ?? [];
    expect(widgets).toContainEqual(expect.objectContaining({ id: 'token-stats-chart', component: 'TokenStatsChart' }));

    const declaredApi = manifest.contributes?.api?.find((api: { path?: string }) => api.path === '/stats');
    expect(declaredApi).toMatchObject({ methods: ['GET'], handler: 'getStats', execution: 'control' });
    expect(control).toContain("path: '/stats'");
    expect(control).toContain("methods: ['GET']");
  });
});
