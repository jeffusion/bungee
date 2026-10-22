<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { isLoading } from 'svelte-i18n';
  import { _, formatCompactNumber, type TimeRange } from '@bungee/plugin-sdk';
  import { getPluginText } from '$utils/plugin-i18n';
  import type { NativeWidgetHeaderChange } from '$components/native-widgets/widget-header';
  import type { TpsRange } from '../contract';
  import type { TpsResource, TpsState } from './stats-resource';
  import { getTpsResource } from './stats';
  import { formatTps, rankedEndpoints, rankedModels } from './presentation';
  import Sparkline from '$components/dashboard/Sparkline.svelte';
  import { BKpiMetric } from '$components/industrial';

  let { pluginName, selectedRange, onHeaderChange, mode }:
    { pluginName: string; selectedRange: TimeRange; onHeaderChange?: NativeWidgetHeaderChange; mode: 'overview' | 'endpoints' | 'models' } = $props();
  let state: TpsState = $state({ data: null, busy: true, error: false });
  let resource: TpsResource | undefined = $state();
  const range: TpsRange = $derived(selectedRange === '1h' || selectedRange === '12h' ? selectedRange : '24h');
  const t = (key: string, values?: Record<string, string | number>) => $isLoading ? '' : getPluginText(key, pluginName,
    (id, options) => $_(id, { ...options, values }));
  const sampleCount = $derived(state.data?.total.sampleCount ?? 0);
  const estimatedCount = $derived(state.data?.total.estimatedSampleCount ?? 0);
  const trendValues = $derived((state.data?.history ?? []).map(point => point.tps ?? 0));
  const rows = $derived(mode === 'models'
    ? rankedModels(state.data?.models ?? []).map(row => ({ ...row, key: row.model, label: row.model }))
    : rankedEndpoints(state.data?.endpoints ?? []).map(row => ({ ...row, key: row.upstreamHost, label: row.upstreamHost })));
  const maximum = $derived(rows.reduce((max, row) => Math.max(max, row.tps ?? 0), 0));
  $effect(() => {
    const next = getTpsResource(pluginName, range);
    resource = next;
    return next.subscribe(value => { state = value; });
  });
  $effect(() => {
    const report = onHeaderChange;
    const header = { summary: range, refresh: { label: t('ui.refresh'), busy: state.busy,
      disabled: !resource, run: () => { void resource?.refresh(); } },
      ...(mode !== 'overview' ? { actions: rankingUnit } : {}),
      ...(mode === 'overview' && state.data?.total.sampleCount ? { footer: sampleFooter } : {}) };
    untrack(() => report?.(header));
  });
  onMount(() => {
    const report = onHeaderChange;
    return () => report?.(null);
  });
</script>

{#snippet rankingUnit()}
  <span class="ranking-unit">TOKENS/S</span>
{/snippet}

{#snippet sampleFooter()}
  {#if sampleCount}
    <div class="tps-samples" data-testid="tps-total-samples">
      <span>{t('ui.sampleCount')} <b class="nx-display">{sampleCount.toLocaleString()}</b></span>
      {#if estimatedCount > 0}<span>{t('ui.estimatedCount')} <b class="nx-display">{estimatedCount.toLocaleString()}</b></span>{/if}
    </div>
  {/if}
{/snippet}

<div class="tps-content min-w-0 w-full" class:tps-overview={mode === 'overview'} data-testid={`tps-${mode}`} aria-busy={state.busy}>
  {#if $isLoading}
    <span class="nx-metric text-zinc-50">—</span>
  {:else}
    {#if mode === 'overview'}
      <BKpiMetric value={formatCompactNumber(state.data?.total.sampleCount ? state.data.total.tps : null)}
        valueTitle={`${formatTps(state.data?.total.sampleCount ? state.data.total.tps : null)} TOKENS/S`} unit="TOKENS/S" valueTestId="tps-total-value">
        {#snippet icon()}<Sparkline values={trendValues} tone="orange" wide />{/snippet}
      </BKpiMetric>
    {/if}
    {#if state.error}
      <p role="alert" class="text-sm text-red-300" data-testid="tps-error">{t('ui.loadFailed')}</p>
    {:else if state.busy && !state.data}
      <p role="status" class="text-sm text-zinc-400">{t('ui.loading')}</p>
    {:else if state.data}
      {#if mode === 'overview' ? !state.data.total.sampleCount : !rows.length}
        <p class="text-sm text-zinc-400" data-testid="tps-empty">{t('ui.noData')}</p>
      {:else if mode !== 'overview'}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (A scrolling region needs keyboard focus so every endpoint remains reachable.) -->
        <div class="ranking-list" role="region" aria-label={t(mode === 'models' ? 'ui.modelRanking' : 'ui.ranking')} data-testid={mode === 'models' ? 'tps-model-list' : 'tps-endpoint-list'} tabindex="0">
        <ol class="ranking-items">
          {#each rows as row, index (JSON.stringify([row.routeId, row.key]))}
            <li class="ranking-row" data-testid={mode === 'models' ? 'tps-model-row' : 'tps-endpoint-row'} data-route-id={row.routeId}
              data-upstream-host={mode === 'endpoints' ? row.key : undefined} data-model={mode === 'models' ? row.key : undefined}>
              <span class="ranking-position nx-display" aria-hidden="true">{index + 1}</span>
              <div class="ranking-identity">
                <p class="ranking-name">{row.label}</p>
                <p class="ranking-route">{row.routeId}</p>
              </div>
              <span class="ranking-value nx-display" title={`${formatTps(row.sampleCount ? row.tps : null)} TOKENS/S · ${t('ui.samples', { count: row.sampleCount, estimated: row.estimatedSampleCount })}`}>{formatCompactNumber(row.sampleCount ? row.tps : null)}</span>
              <div class="ranking-track" aria-hidden="true"><span class="ranking-bar" style:width={`${maximum > 0 ? (row.tps ?? 0) / maximum * 100 : 0}%`}></span></div>
            </li>
          {/each}
        </ol>
        </div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .tps-content { display: flex; flex-direction: column; gap: 6px; }
  .tps-content:not(.tps-overview) { height: 100%; min-height: 0; }
  .tps-overview { justify-content: center; }
  .tps-samples { display: flex; flex-wrap: wrap; gap: 6px 18px; font-family: var(--font-mono, 'DM Mono', monospace); font-size: 10px; letter-spacing: .08em; color: var(--nx-text-mute); }
  .tps-samples b { margin-left: 4px; font-weight: 400; font-variant-numeric: tabular-nums; color: var(--nx-text); }
  .ranking-unit { white-space: nowrap; font: 10px var(--font-mono, 'DM Mono', monospace); letter-spacing: .08em; color: var(--nx-text-dim); }
  .ranking-list { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: none; }
  .ranking-list::-webkit-scrollbar { display: none; }
  .ranking-items { display: grid; grid-template-columns: 20px minmax(0, 1fr) max-content; column-gap: 8px; list-style: none; margin: 0; padding: 0; }
  .ranking-row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: center; gap: 4px 8px; padding: 6px 0; border-bottom: 1px solid var(--nx-edge); }
  .ranking-row:first-child { padding-top: 0; }
  .ranking-row:last-child { border-bottom: 0; }
  .ranking-position { grid-column: 1; grid-row: 1 / 3; color: var(--nx-text-dim); font-size: 12px; font-variant-numeric: tabular-nums; }
  .ranking-identity { min-width: 0; }
  .ranking-name { margin: 0; font-size: 14px; font-weight: 500; line-height: 1.4; color: var(--nx-text); overflow-wrap: anywhere; }
  .ranking-route { margin: 3px 0 0; font: 12px/1.4 var(--font-mono, 'DM Mono', monospace); color: var(--nx-text-dim); overflow-wrap: anywhere; }
  .ranking-value { grid-column: 3; grid-row: 1 / 3; text-align: right; font-size: 14px; font-variant-numeric: tabular-nums; color: var(--nx-text); }
  .ranking-track { grid-column: 2; height: 6px; }
  .ranking-bar { display: block; height: 100%; background: var(--nx-accent); }
</style>
