<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { isLoading } from 'svelte-i18n';
  import { _, type TimeRange } from '@bungee/plugin-sdk';
  import { getPluginText } from '$utils/plugin-i18n';
  import { LoadingIndicator } from '$components/industrial';
  import type { NativeWidgetHeaderChange } from '$components/native-widgets/widget-header';
  import UsageTimeChart from './UsageTimeChart.svelte';
  import { getStatsResource } from './stats';
  import { usagePresentation } from './labels';
  import type { StatsState, StatsResource } from './stats-resource';

  let { pluginName = 'token-stats', selectedRange = '24h', onHeaderChange }:
    { pluginName?: string; selectedRange?: TimeRange; onHeaderChange?: NativeWidgetHeaderChange } = $props();
  let state: StatsState = $state({ data: null, busy: false, error: '', refreshedAt: 0 });
  let resource: StatsResource | undefined = $state();
  const t = (key: string) => $isLoading ? '' : getPluginText(key, pluginName, (id, options) => $_(id, options));
  $effect(() => {
    const nextResource = getStatsResource(pluginName, selectedRange, 'time');
    resource = nextResource;
    return nextResource.subscribe(next => { state = next; });
  });
  $effect(() => {
    const report = onHeaderChange;
    const header = { summary: selectedRange, refresh: { label: t('ui.refresh'), busy: state.busy,
      disabled: !resource, run: () => { void resource?.refresh(); } }, actions: headerActions };
    untrack(() => report?.(header));
  });
  onMount(() => {
    const report = onHeaderChange;
    return () => report?.(null);
  });
</script>

{#snippet headerActions()}
  <a href={`/#/extensions/${pluginName}/statistics`} class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-zinc-400 hover:text-nexus-300 hover:underline">{t('page.viewModels')} <span>→</span></a>
{/snippet}

<div class="flex h-full min-h-0 flex-col gap-2" data-testid="plugin-widget-token-stats">
  {#if state.error}<p role="alert" class="shrink-0 text-xs text-red-300">{t('ui.loadFailed')}</p>{/if}
  {#if state.busy && !state.data}
    <LoadingIndicator size="sm" height="sm" label={t('ui.loading')} />
  {:else if state.data}
    {#if usagePresentation(state.data).state === 'empty'}
      <p class="flex flex-1 items-center justify-center text-sm text-zinc-400" data-testid="token-stats-empty">{t('ui.noData')}</p>
    {:else if !usagePresentation(state.data).positive}
      <p class="flex flex-1 items-center justify-center text-sm text-zinc-400">{t('ui.noBreakdown')}</p>
    {:else}
      <div class="min-h-0 flex-1"><UsageTimeChart stats={state.data} range={selectedRange} refreshedAt={state.refreshedAt} {pluginName} /></div>
    {/if}
  {/if}
</div>
