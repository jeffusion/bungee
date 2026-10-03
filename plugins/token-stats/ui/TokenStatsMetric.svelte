<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { isLoading } from 'svelte-i18n';
  import { _, formatCompactNumber, type TimeRange } from '@bungee/plugin-sdk';
  import { getPluginText } from '$utils/plugin-i18n';
  import { LoadingIndicator } from '$components/industrial';
  import KpiTrendValue from '$components/industrial/KpiTrendValue.svelte';
  import type { NativeWidgetHeaderChange } from '$components/native-widgets/widget-header';
  import { estimatedTokens, formatEstimatedUsd, formatTokenCount, usagePresentation } from './labels';
  import { getStatsResource } from './stats';
  import type { StatsState, StatsResource } from './stats-resource';
  import { overviewTrends } from './overview-trends';

  let { pluginName = 'token-stats', selectedRange = '24h', onHeaderChange }:
    { pluginName?: string; selectedRange?: TimeRange; onHeaderChange?: NativeWidgetHeaderChange } = $props();
  let state: StatsState = $state({ data: null, busy: false, error: '', refreshedAt: 0 });
  let resource: StatsResource | undefined = $state();
  const t = (key: string, values?: Record<string, string>) => $isLoading ? '' : getPluginText(key, pluginName,
    (id, options) => $_(id, { ...options, values }));
  const usage = $derived(state.data ? usagePresentation(state.data) : null);
  const trends = $derived(overviewTrends(state.error ? null : state.data));
  const interval = $derived(state.data?.bucketMs);
  const comparisonCaption = $derived(interval ? t('ui.previousInterval', { interval: interval < 3_600_000
    ? `${interval / 60_000}${t('ui.minutes')}` : `${interval / 3_600_000}${t('ui.hours')}` }) : '');
  $effect(() => {
    const nextResource = getStatsResource(pluginName, selectedRange, 'time');
    resource = nextResource;
    return nextResource.subscribe(next => { state = next; });
  });
  $effect(() => {
    const report = onHeaderChange;
    const header = { summary: selectedRange, refresh: { label: t('ui.refresh'), busy: state.busy,
      disabled: !resource, run: () => { void resource?.refresh(); } }, footer: trendFooter };
    untrack(() => report?.(header));
  });
  onMount(() => {
    const report = onHeaderChange;
    return () => report?.(null);
  });
</script>

{#snippet trendFooter()}
  <div class="overview-trends w-full" data-testid="token-stats-overview-trends">
    {#each trends as item}
      {@const value = item.isNew ? t('ui.newActivity') : item.percent == null ? '—' : `${item.percent >= 0 ? '+' : ''}${item.percent.toFixed(1)}%`}
      <div class="flex min-w-0 flex-wrap items-center gap-x-1.5" data-testid={`token-stats-trend-${item.metric}`}
        aria-label={`${t(item.metric === 'cost' ? 'ui.estimatedCostUsd' : `ui.${item.metric}`)} ${value} ${comparisonCaption}`}>
        <KpiTrendValue {value} change={item.change} direction={item.metric === 'cost' ? 'down' : 'up'} clamp />
        {#if comparisonCaption}<span class="nx-label-sm">{comparisonCaption}</span>{/if}
      </div>
    {/each}
  </div>
{/snippet}

<div class="kpi-metric-row w-full min-w-0" data-testid="token-stats-overview">
  {#if state.busy && !state.data}
    <LoadingIndicator size="sm" height="sm" label={t('ui.loading')} />
  {:else if state.error && !state.data}
    <p role="alert" class="text-xs text-red-300">{t('ui.loadFailed')}</p>
  {:else}
    <div class="kpi-metric-row overview-metrics">
      {#each ['input', 'output', 'cost'] as metric}
        {@const fullValue = metric === 'cost' ? formatEstimatedUsd(state.data?.estimatedCostUsd)
          : formatTokenCount(metric === 'input' ? usage?.input : usage?.output)}
        {@const value = metric === 'cost'
          ? (state.data?.estimatedCostUsd != null && Number.isFinite(state.data.estimatedCostUsd) && state.data.estimatedCostUsd >= 0
            ? `$${formatCompactNumber(state.data.estimatedCostUsd)}` : fullValue)
          : formatCompactNumber(metric === 'input' ? usage?.input : usage?.output)}
        <div class="min-w-0" data-testid={`token-stats-metric-${metric}`}>
          <div class="nx-label mb-2">{t(metric === 'cost' ? 'ui.estimatedCostUsd' : `ui.${metric}`)}</div>
          <div class="overview-value nx-metric text-zinc-50" title={fullValue} aria-label={fullValue}>{value}</div>
          {#if metric !== 'cost' && state.data && (estimatedTokens(state.data, metric as 'input' | 'output') ?? 0) > 0}
            <p class="mt-1 text-[10px] text-zinc-400">{t('ui.includesEstimate')}</p>
          {/if}
        </div>
      {/each}
    </div>
    {#if state.data?.reportingIncomplete}<p role="status" class="mt-2 text-xs text-amber-300">{t('ui.reportingIncomplete')}</p>{/if}
    {#if state.error}<p role="alert" class="mt-2 text-xs text-red-300">{t('ui.loadFailed')}</p>
    {:else if usage?.state === 'empty'}<p class="mt-2 text-[10px] text-zinc-400" data-testid="token-stats-empty">{t('ui.noData')}</p>{/if}
  {/if}
</div>

<style>
  .overview-metrics, .overview-trends { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
  .overview-trends > div + div { padding-left: 16px; }
  .overview-metrics > div + div { border-left: 1px solid var(--nx-edge); padding-left: 16px; }
  .overview-value { font-size: clamp(18px, 2vw, 28px); }
  @container (max-width: 380px) {
    .overview-metrics, .overview-trends { gap: 8px; }
    .overview-trends > div + div { padding-left: 8px; }
    .overview-metrics > div + div { padding-left: 8px; }
    .overview-value { font-size: 16px; }
  }
  @container (max-width: 220px) {
    .overview-metrics { grid-template-columns: 1fr; }
    .overview-metrics > div + div { border-left: 0; padding-left: 0; }
  }
</style>
