<script lang="ts">
  import { isLoading, locale } from 'svelte-i18n';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import { _ } from '@bungee/plugin-sdk';
  import { getPluginText } from '$utils/plugin-i18n';
  import { KpiCard, PanelCard, MetricBar, BSegmentedControl, LoadingIndicator } from '$components/industrial';
  import { Button } from '$components/ui/button';
  import { Input } from '$components/ui/input';
  import UsageTimeChart from './UsageTimeChart.svelte';
  import { getStatsResource } from './stats';
  import { cacheDetail, formatEstimatedUsd, formatTokenCount, modelTokenTotal, tokenComposition, usagePresentation, type TokenRange } from './labels';
  import type { StatsState, StatsResource } from './stats-resource';

  let { pluginName = 'token-stats' }: { pluginName?: string } = $props();
  let range: TokenRange = $state('24h');
  let sort = $state('tokens');
  let search = $state('');
  let models: StatsState = $state({ data: null, busy: false, error: '', refreshedAt: 0 });
  let time: StatsState = $state({ data: null, busy: false, error: '', refreshedAt: 0 });
  let modelResource: StatsResource | undefined = $state();
  let timeResource: StatsResource | undefined = $state();
  const t = (key: string) => $isLoading ? '' : getPluginText(key, pluginName, (id, options) => $_(id, options));
  const display = (value: unknown) => formatTokenCount(value, $locale ?? undefined);
  const usage = $derived(models.data ? usagePresentation(models.data) : null);
  const composition = $derived(tokenComposition(models.data ?? {}));
  const modelLabel = (id: string) => id === 'unknown' ? t('ui.unknownModel') : id;
  const parts = (row: Parameters<typeof tokenComposition>[0]) => {
    const c = tokenComposition(row);
    return [
      { key: 'input', label: t('ui.input'), value: c.input, tone: 'accent' as const },
      { key: 'output', label: t('ui.output'), value: c.output, tone: 'ok' as const },
      { key: 'cacheRead', label: t('page.cacheRead'), value: c.cacheRead, tone: 'warn' as const },
      { key: 'cacheWrite', label: t('page.cacheWrite'), value: c.cacheWrite, tone: 'danger' as const },
    ];
  };
  const knownPart = (key: string) => key === 'input' ? usage?.input !== undefined
    : key === 'output' ? usage?.output !== undefined
    : cacheDetail(key === 'cacheRead' ? models.data?.cacheReadTokens : models.data?.cacheWriteTokens) !== undefined;
  const rankAmount = (row: NonNullable<typeof models.data>['data'][number]) => sort === 'cost'
    ? row.estimatedCostUsd ?? -1 : modelTokenTotal(row) ?? -1;
  const rows = $derived.by(() => [...models.data?.data ?? []]
    .filter(row => modelLabel(row.dimension).toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => rankAmount(b) - rankAmount(a) || a.dimension.localeCompare(b.dimension)));
  const maxRank = $derived(Math.max(0, ...rows.map(rankAmount)));
  const busy = $derived(models.busy || time.busy);
  const refreshedAt = $derived(Math.min(models.refreshedAt, time.refreshedAt));
  const ranges = $derived(['1h', '12h', '24h'].map(value => ({ value, label: t(`page.range.${value}`) })));
  const sorts = $derived(['tokens', 'cost'].map(value => ({ value, label: t(`page.sort.${value}`) })));
  $effect(() => {
    const nextModel = getStatsResource(pluginName, range, 'model');
    const nextTime = getStatsResource(pluginName, range, 'time');
    modelResource = nextModel; timeResource = nextTime;
    const stopModels = nextModel.subscribe(next => { models = next; });
    const stopTime = nextTime.subscribe(next => { time = next; });
    return () => { stopModels(); stopTime(); };
  });
  function refresh() { void modelResource?.refresh(); void timeResource?.refresh(); }
</script>

<div class="min-w-0 space-y-4" data-testid="token-stats-page">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <BSegmentedControl options={ranges} value={range} onchange={value => range = value as TokenRange} ariaLabel={t('page.range')} />
    <div class="flex min-w-0 flex-wrap items-center gap-3">
      <span class="font-mono text-[10px] text-zinc-400" aria-live="polite">{refreshedAt ? `${t('page.updatedAt')} ${new Date(refreshedAt).toLocaleTimeString($locale ?? undefined)}` : ''}</span>
      <Button variant="ghost" size="sm" disabled={busy} onclick={refresh} aria-label={t('ui.refresh')} aria-busy={busy}>
        <RefreshCw class={`mr-1.5 h-3.5 w-3.5 ${busy ? 'motion-safe:animate-spin' : ''}`} />{t('ui.refresh')}
      </Button>
      <a href={`/#/plugins/${pluginName}/pricing`} class="nx-btn nx-btn-ghost nx-btn-sm">{t('settings.title')}</a>
    </div>
  </div>
  {#if models.error || time.error}
    <div role="alert" class="flex flex-wrap items-center justify-between gap-2 border-l-2 border-red-500 bg-carbon-900 px-3 py-2 text-xs text-red-300">
      <span>{t('ui.loadFailed')}</span><Button variant="ghost" size="sm" onclick={refresh} disabled={busy}>{t('page.retry')}</Button>
    </div>
  {/if}
  {#if models.busy && !models.data}
    <LoadingIndicator label={t('ui.loading')} height="sm" />
  {:else if models.data}
    <div class="grid grid-cols-2 gap-3 xl:grid-cols-4" data-testid="token-stats-page-summary">
      <KpiCard class="min-w-0 [container-type:inline-size]" label={t('ui.input')} value={display(usage?.input)} />
      <KpiCard class="min-w-0 [container-type:inline-size]" label={t('ui.output')} value={display(usage?.output)} />
      <KpiCard class="min-w-0 [container-type:inline-size]" label={t('page.tokens')} value={display(modelTokenTotal(models.data))} />
      <KpiCard class="min-w-0 [container-type:inline-size]" label={t('ui.estimatedCostUsd')} value={formatEstimatedUsd(models.data.estimatedCostUsd)} />
    </div>
    {#if usage?.state === 'empty'}<p class="py-8 text-center text-sm text-zinc-400" data-testid="token-stats-page-empty">{t('ui.noData')}</p>{/if}
  {/if}

  <PanelCard title={t('page.activity')} tag="TOKEN / TIME">
    <div class="h-[240px] min-w-0 sm:h-[300px]">
      {#if time.busy && !time.data}<LoadingIndicator label={t('ui.loading')} />
      {:else if time.data && usagePresentation(time.data).positive}
        <UsageTimeChart stats={time.data} {range} refreshedAt={time.refreshedAt} {pluginName} />
      {:else}<p class="flex h-full items-center justify-center text-sm text-zinc-400">{t(time.data && usagePresentation(time.data).state === 'empty' ? 'ui.noData' : 'ui.noBreakdown')}</p>{/if}
    </div>
  </PanelCard>

  {#if models.data}
    <PanelCard title={t('page.composition')} tag="TOKEN">
      <MetricBar label={t('page.tokens')} value={composition.total} max={composition.total} valueLabel={display(modelTokenTotal(models.data))}
        segments={parts(models.data)} tone="neutral" />
      <dl class="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4" data-testid="token-stats-composition">
        {#each parts(models.data) as part}
          <div><dt class="nx-label">{part.label}</dt><dd class="mt-1 font-mono text-xs text-zinc-200">{knownPart(part.key) ? display(part.value) : '—'}
            <span class="ml-2 text-zinc-400">{knownPart(part.key) && composition.total > 0 ? `${(part.value / composition.total * 100).toFixed(1)}%` : '—'}</span></dd></div>
        {/each}
      </dl>
    </PanelCard>

    <PanelCard title={t('dimension.model')} tag={`${rows.length} / ${models.data.data.length}`}>
      <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
        <Input bind:value={search} aria-label={t('page.searchModels')} placeholder={t('page.searchModels')} class="w-full sm:w-64" />
        <BSegmentedControl options={sorts} bind:value={sort} ariaLabel={t('page.sort')} />
      </div>
      <ol class="space-y-4" data-testid="token-stats-model-list">
        {#each rows as row (row.dimension)}
          {@const total = modelTokenTotal(row)}
          <li class="min-w-0 border-b border-carbon-600 pb-4 last:border-0 last:pb-0" data-testid="token-stats-model-row">
            <div class="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
              <strong class="min-w-0 break-all font-mono text-xs font-normal text-zinc-200">{modelLabel(row.dimension)}</strong>
              <span class="font-mono text-[11px] text-zinc-400">{display(total)} Token · {formatEstimatedUsd(row.estimatedCostUsd)}</span>
            </div>
            <MetricBar label={`${modelLabel(row.dimension)} · ${t(`page.sort.${sort}`)}`} value={Math.max(0, rankAmount(row))} max={maxRank}
              valueLabel={sort === 'cost' ? formatEstimatedUsd(row.estimatedCostUsd) : display(total)}
              tone={sort === 'tokens' ? 'neutral' : 'accent'} segments={sort === 'tokens' ? parts(row) : []} headless />
            <dl class="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10px] text-zinc-400">
              <div>{t('ui.input')} <span class="text-zinc-200">{display(usagePresentation(row).input)}</span></div>
              <div>{t('ui.output')} <span class="text-zinc-200">{display(usagePresentation(row).output)}</span></div>
              <div>{t('page.cacheRead')} <span class="text-zinc-200">{display(row.cacheReadTokens)}</span></div>
              <div>{t('page.cacheWrite')} <span class="text-zinc-200">{display(row.cacheWriteTokens)}</span></div>
            </dl>
          </li>
        {:else}<li class="py-6 text-center text-xs text-zinc-400">{t(search ? 'page.noModels' : 'ui.noData')}</li>{/each}
      </ol>
    </PanelCard>
  {/if}
</div>
