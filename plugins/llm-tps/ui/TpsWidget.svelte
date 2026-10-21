<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { isLoading } from 'svelte-i18n';
  import { _, type TimeRange } from '@bungee/plugin-sdk';
  import { getPluginText } from '$utils/plugin-i18n';
  import { configStore, routesStore } from '$stores/config';
  import { resolveRouteEndpoints } from '$api/routes';
  import { toEditorRoute, toEditorService } from '$api/config-adapters';
  import type { NativeWidgetHeaderChange } from '$components/native-widgets/widget-header';
  import type { TpsRange } from '../contract';
  import type { TpsResource, TpsState } from './stats-resource';
  import { getTpsResource } from './stats';
  import { endpointIdentity, formatTps, rankedEndpoints } from './presentation';

  let { pluginName, selectedRange, onHeaderChange, mode }:
    { pluginName: string; selectedRange: TimeRange; onHeaderChange?: NativeWidgetHeaderChange; mode: 'overview' | 'endpoints' } = $props();
  let state: TpsState = $state({ data: null, busy: true, error: false });
  let resource: TpsResource | undefined = $state();
  const range: TpsRange = $derived(selectedRange === '1h' || selectedRange === '12h' ? selectedRange : '24h');
  const t = (key: string, values?: Record<string, string | number>) => $isLoading ? '' : getPluginText(key, pluginName,
    (id, options) => $_(id, { ...options, values }));
  const rows = $derived(rankedEndpoints(state.data?.endpoints ?? []));
  const maximum = $derived(rows.reduce((max, row) => Math.max(max, row.tps ?? 0), 0));
  const services = $derived($configStore?.services ?? []);
  const labels = $derived.by(() => {
    const result = new Map<string, { route: string; endpoint: string }>();
    const editorServices = services.map(toEditorService);
    for (const route of $routesStore) {
      const endpoints = resolveRouteEndpoints(toEditorRoute(route, services), editorServices);
      for (const endpoint of endpoints) if (endpoint._uid) result.set(JSON.stringify([route.id, endpoint._uid]), {
        route: 'name' in route && typeof route.name === 'string' ? route.name.trim() || route.path || route.id : route.path || route.id,
        endpoint: endpoint.description?.trim() || endpointIdentity(endpoint._uid),
      });
    }
    return result;
  });
  $effect(() => {
    const next = getTpsResource(pluginName, range);
    resource = next;
    return next.subscribe(value => { state = value; });
  });
  $effect(() => {
    const report = onHeaderChange;
    const header = { summary: range, refresh: { label: t('ui.refresh'), busy: state.busy,
      disabled: !resource, run: () => { void resource?.refresh(); } } };
    untrack(() => report?.(header));
  });
  onMount(() => {
    const report = onHeaderChange;
    return () => report?.(null);
  });
</script>

<div class="tps-content min-w-0 w-full" data-testid={`tps-${mode}`} aria-busy={state.busy}>
  {#if $isLoading}
    <span class="nx-metric text-zinc-50">—</span>
  {:else}
    {#if mode === 'overview'}
      <div class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <span class="nx-metric tps-value text-zinc-50" data-testid="tps-total-value">{formatTps(state.data?.total.sampleCount ? state.data.total.tps : null)}</span>
        <span class="font-mono text-sm text-zinc-400">tokens/s</span>
      </div>
      <p class="mt-3 text-sm text-zinc-400">{t('ui.weightedHint')}</p>
    {/if}
    {#if state.error}
      <p role="alert" class="text-sm text-red-300" data-testid="tps-error">{t('ui.loadFailed')}</p>
    {:else if state.busy && !state.data}
      <p role="status" class="text-sm text-zinc-400">{t('ui.loading')}</p>
    {:else if state.data}
      {#if !state.data.total.sampleCount}
        <p class="text-sm text-zinc-400" data-testid="tps-empty">{t('ui.noData')}</p>
      {:else if mode === 'overview'}
        <p class="mt-3 font-mono text-sm text-zinc-300" data-testid="tps-total-samples">{t('ui.samples', {
          count: state.data.total.sampleCount, estimated: state.data.total.estimatedSampleCount })}</p>
      {:else}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (A scrolling region needs keyboard focus so every endpoint remains reachable.) -->
        <div class="endpoint-list" role="region" aria-label={t('ui.ranking')} data-testid="tps-endpoint-list" tabindex="0">
        <ol class="endpoint-items">
          {#each rows as row (JSON.stringify([row.routeId, row.endpointId]))}
            {@const label = labels.get(JSON.stringify([row.routeId, row.endpointId]))}
            <li class="endpoint-row" data-testid="tps-endpoint-row" data-route-id={row.routeId} data-endpoint-id={endpointIdentity(row.endpointId)}>
              <div class="endpoint-heading">
                <div class="min-w-0">
                  <p class="endpoint-label text-sm text-zinc-200">{label?.endpoint ?? endpointIdentity(row.endpointId)}</p>
                  <p class="endpoint-label mt-1 text-xs text-zinc-400">{label?.route ?? row.routeId}</p>
                </div>
                <p class="font-mono text-sm text-zinc-50">{formatTps(row.sampleCount ? row.tps : null)} <span class="text-xs text-zinc-400">tokens/s</span></p>
              </div>
              <div class="mt-2 h-1.5 bg-carbon-700" aria-hidden="true"><div class="h-full bg-nexus-500" style:width={`${maximum && row.tps !== null ? Math.max(0, row.tps / maximum * 100) : 0}%`}></div></div>
              <p class="mt-2 font-mono text-xs text-zinc-400">{t('ui.samples', { count: row.sampleCount, estimated: row.estimatedSampleCount })}</p>
            </li>
          {/each}
        </ol>
        </div>
      {/if}
      {#if state.data.reportingIncomplete}
        <p class="mt-3 text-sm text-amber-400" role="status" data-testid="tps-incomplete">{t('ui.incomplete')}</p>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .tps-content { display: flex; flex-direction: column; gap: 6px; }
  .tps-value { font-size: clamp(28px, 4cqw, 42px); overflow-wrap: anywhere; }
  .endpoint-list { max-height: 360px; overflow-y: auto; overscroll-behavior: contain; }
  .endpoint-items { list-style: none; margin: 0; padding: 0; }
  .endpoint-row { padding: 12px 0; border-bottom: 1px solid var(--nx-edge); }
  .endpoint-row:first-child { padding-top: 0; }
  .endpoint-row:last-child { border-bottom: 0; }
  .endpoint-heading { display: flex; flex-wrap: wrap; align-items: start; justify-content: space-between; gap: 6px 18px; }
  .endpoint-heading > div { flex: 1 1 180px; }
  .endpoint-heading > p { flex: 0 1 auto; overflow-wrap: anywhere; }
  .endpoint-label { overflow-wrap: anywhere; }
</style>
