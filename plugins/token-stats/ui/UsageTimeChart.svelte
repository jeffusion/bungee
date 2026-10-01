<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { isLoading, locale } from 'svelte-i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import * as Tooltip from '$components/ui/tooltip';
  import { Bar, ChartJS, BarElement, CategoryScale, LinearScale, _, type ChartData, type ChartOptions } from '@bungee/plugin-sdk';
  import type { Plugin } from 'chart.js';
  import { buildTimeSeries, formatTokenCount, modelColorIndex, OTHER_MODEL, timeAxisLabels, type TimeBucket, type TokenStatsRange } from './labels';
  import type { StatsResponse } from './stats-resource';

  ChartJS.register(BarElement, CategoryScale, LinearScale);
  let { stats, range, refreshedAt, pluginName = 'token-stats', presentation = 'dashboard' }:
    { stats: StatsResponse; range: TokenStatsRange; refreshedAt: number; pluginName?: string; presentation?: 'dashboard' | 'page' } = $props();
  const pageChart = $derived(presentation === 'page');
  const t = (key: string) => $isLoading ? '' : getPluginText(key, pluginName, (id, options) => $_(id, options));
  const display = (value: unknown) => formatTokenCount(value, $locale ?? undefined);
  const trend = $derived(buildTimeSeries(stats.data, range, stats.bucketMs ?? 0, stats.asOfMs ?? refreshedAt, stats.bucketStarts));
  const dayBuckets = $derived(['7d', '30d', 'week', 'month'].includes(range));
  const tickStarts = $derived(trend.buckets.length ? [
    trend.buckets[0].startMs, trend.buckets[Math.floor(trend.buckets.length / 2)].startMs,
    trend.buckets[trend.buckets.length - 1].startMs,
  ] : []);
  const axisTicks = $derived(!tickStarts.length ? ['', '', ''] : dayBuckets
    ? tickStarts.map(start => new Intl.DateTimeFormat($locale ?? undefined, { month: 'numeric', day: 'numeric' }).format(start))
    : timeAxisLabels(tickStarts, $locale ?? undefined));
  const denseAxis = $derived(axisTicks.join('').length > 42);
  let scroller: HTMLDivElement | undefined = $state();
  let plotWidth = $state(0);
  let positionedRange: TokenStatsRange | undefined;
  const pageTickLabels = $derived(dayBuckets
    ? trend.buckets.map(bucket => new Intl.DateTimeFormat($locale ?? undefined, { month: 'numeric', day: 'numeric' }).format(bucket.startMs))
    : timeAxisLabels(trend.buckets.map(bucket => bucket.startMs), $locale ?? undefined));
  const tickStep = $derived(trend.buckets.length <= 7 && plotWidth / trend.buckets.length >= 40 ? 1
    : Math.max(1, Math.ceil((trend.buckets.length - 1) / Math.max(1, Math.floor(plotWidth / (dayBuckets ? 56 : 110)) - 1))));
  const showTick = (index: number) => index === 0 || index === trend.buckets.length - 1
    || index % tickStep === 0 && index <= trend.buckets.length - 1 - tickStep;
  const tones = ['bg-nexus-500', 'bg-sky-400', 'bg-emerald-400', 'bg-amber-400', 'bg-red-400'] as const;
  // Match the original Tailwind palette, including carbon-500 and zinc-500.
  const palette = ['#f97316', '#38bdf8', '#34d399', '#fbbf24', '#f87171'];
  const data: ChartData<'bar'> = $derived({
    labels: trend.buckets.map(bucket => bucket.startMs),
    datasets: trend.models.map(id => ({
      label: modelLabel(id),
      data: trend.buckets.map(bucket => bucket.parts.find(part => part.id === id)?.tokens ?? 0),
      backgroundColor: id === OTHER_MODEL ? '#373d4a' : id === 'unknown' ? '#71717a' : palette[modelColorIndex(id)],
      borderWidth: 0, borderRadius: 0, inflateAmount: 0,
    })),
  });
  const options: ChartOptions<'bar'> = $derived({
    responsive: true, maintainAspectRatio: false, animation: false, events: [],
    layout: { padding: 0 },
    scales: {
      x: { stacked: true, display: false, offset: true },
      y: { stacked: true, display: false, min: 0, max: Math.max(1, trend.maxTokens) },
    },
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
  });
  const chartPlugins: Plugin<'bar'>[] = [{
    id: 'token-stats-bar-style',
    beforeUpdate(chart) {
      // Dashboard bars retain their fixed gutter; page bars stay centered and capped.
      const width = Math.max(0, chart.width / Math.max(1, chart.data.labels?.length ?? 0) - 12);
      for (const dataset of chart.data.datasets) dataset.barThickness = pageChart ? Math.min(40, width) : width;
    },
  }];
  let selectedBucketStart: number | null = $state(null);
  const tooltipId = $props.id();
  let tooltipAnchor: HTMLElement | null = $state(null);
  let tooltipBucket: TimeBucket | undefined = $state();
  let tooltipMode: 'hover' | 'focus' | 'touch' = 'hover';
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let touchBucketWasOpen = false;
  const selectedBucket = $derived(trend.buckets.find(bucket => bucket.startMs === selectedBucketStart));
  $effect(() => { if (selectedBucket) tooltipBucket = selectedBucket; });
  function modelLabel(id: string): string {
    return id === OTHER_MODEL ? t('ui.otherModels') : id === 'unknown' ? t('ui.unknownModel') : id;
  }
  function modelTone(id: string): string {
    return id === OTHER_MODEL ? 'bg-carbon-500' : id === 'unknown' ? 'bg-zinc-500' : tones[modelColorIndex(id)];
  }
  function timeLabel(startMs: number, full = false): string {
    return new Intl.DateTimeFormat($locale ?? undefined, {
      ...(full ? { month: '2-digit' as const, day: '2-digit' as const, timeZoneName: 'shortOffset' as const } : {}),
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(startMs);
  }
  function bucketDescription(bucket: TimeBucket): string {
    return `${bucketLabel(bucket.startMs)} · ${bucket.details.length
      ? `${display(bucket.total)} Token · ${bucket.details.map(part => `${modelLabel(part.id)} ${display(part.tokens)}`).join(' · ')}`
      : t('ui.noCountedTokens')}`;
  }
  function bucketLabel(startMs: number): string {
    if (!stats.bucketStarts) return timeLabel(startMs, true);
    const index = stats.bucketStarts.indexOf(startMs);
    const endMs = stats.bucketStarts[index + 1] ?? stats.asOfMs ?? refreshedAt;
    return `${timeLabel(startMs, true)} – ${timeLabel(endMs, true)}`;
  }

  function cancelClose() {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }
  function closeBucket() {
    cancelClose();
    selectedBucketStart = null;
    tooltipAnchor = null;
  }
  function showBucket(startMs: number, element: HTMLElement, mode: 'hover' | 'focus' | 'touch') {
    cancelClose();
    tooltipMode = mode;
    tooltipAnchor = element;
    selectedBucketStart = startMs;
  }
  function leaveBucket() {
    if (tooltipMode !== 'hover') return;
    cancelClose();
    // Allow the pointer to cross the small gap into the shared tooltip to read or scroll it.
    closeTimer = setTimeout(closeBucket, 100);
  }

  function positionLatest() {
    if (pageChart && scroller) {
      plotWidth = scroller.scrollWidth;
      scroller.scrollLeft = scroller.scrollWidth;
    }
  }
  $effect(() => {
    const nextRange = range;
    if (!pageChart || !scroller || !trend.buckets.length || positionedRange === nextRange) return;
    positionedRange = nextRange;
    void tick().then(() => { if (range === nextRange) positionLatest(); });
  });
  onMount(() => {
    let observedWidth = 0;
    const observer = pageChart && scroller ? new ResizeObserver(() => {
      const width = scroller?.clientWidth ?? 0;
      if (width !== observedWidth) { observedWidth = width; positionLatest(); }
    }) : undefined;
    if (observer && scroller) observer.observe(scroller);
    return () => { observer?.disconnect(); cancelClose(); };
  });
</script>

<div class="relative flex min-h-0 min-w-0 h-full flex-col overflow-hidden" data-testid="token-stats-time-chart" data-bucket-ms={stats.bucketMs} data-presentation={presentation}>
  <div class="min-h-0 flex-1 flex flex-col {pageChart ? 'overflow-x-auto' : ''}" bind:this={scroller} data-testid="token-stats-chart-scroll">
    <div class="flex min-h-0 flex-1 flex-col" style:min-width={pageChart ? `${trend.buckets.length * 32}px` : undefined}>
      <div class="relative min-h-0 flex-1 border-b border-carbon-500">
        <div class="pointer-events-none absolute inset-y-0 z-10 {pageChart ? 'inset-x-0' : '-left-[6px] -right-[6px]'}">
          <Bar {data} {options} plugins={chartPlugins} aria-hidden="true" />
        </div>
        <div class="h-full {pageChart ? 'grid' : 'flex items-end gap-[12px]'}" style:grid-template-columns={pageChart ? `repeat(${trend.buckets.length}, minmax(0, 1fr))` : undefined}
          role="group" aria-label={t('ui.timeChart')}>
          {#each trend.buckets as bucket, index (bucket.startMs)}
            <button type="button" aria-pressed={selectedBucketStart === bucket.startMs}
              aria-label={bucketDescription(bucket)} aria-describedby={selectedBucketStart === bucket.startMs ? tooltipId : undefined} data-token-stats-bucket-trigger
              class="flex min-w-0 flex-1 self-stretch flex-col justify-end transition-colors hover:bg-carbon-700/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nexus-500 {selectedBucketStart === bucket.startMs ? 'bg-carbon-700/40' : ''}"
              onpointerenter={(event) => {
                if (event.pointerType !== 'touch') showBucket(bucket.startMs, event.currentTarget, 'hover');
              }}
              onpointerleave={leaveBucket}
              onfocus={(event) => showBucket(bucket.startMs, event.currentTarget, 'focus')}
              onpointerdown={(event) => {
                touchBucketWasOpen = event.pointerType === 'touch' && selectedBucketStart === bucket.startMs;
              }}
              onclick={(event) => {
                if ('pointerType' in event && event.pointerType === 'touch') {
                  if (touchBucketWasOpen) closeBucket();
                  else showBucket(bucket.startMs, event.currentTarget, 'touch');
                } else showBucket(bucket.startMs, event.currentTarget, event.detail === 0 ? 'focus' : 'hover');
              }}
              onblur={(event) => {
                if (selectedBucketStart === bucket.startMs && !(event.relatedTarget instanceof HTMLElement && event.currentTarget.parentElement?.contains(event.relatedTarget))) closeBucket();
              }}
              onkeydown={(event) => {
                if (event.key === 'Escape') closeBucket();
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault();
                  const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? trend.buckets.length - 1
                    : index + (event.key === 'ArrowRight' ? 1 : -1);
                  const next = event.currentTarget.parentElement?.children[nextIndex] as HTMLElement | undefined;
                  next?.focus();
                }
              }}>
            </button>
          {/each}
        </div>
      </div>
      {#if pageChart}
        <div class="mt-2 grid shrink-0 font-mono text-xs leading-tight text-zinc-400" style:grid-template-columns={`repeat(${trend.buckets.length}, minmax(0, 1fr))`} aria-hidden="true" data-testid="token-stats-page-axis">
          {#each trend.buckets as bucket, index (bucket.startMs)}
            <span class="min-w-0 text-center whitespace-nowrap">{showTick(index) ? pageTickLabels[index] : ''}</span>
          {/each}
        </div>
      {:else}
        <div class="mt-1 flex shrink-0 items-start justify-between gap-1 font-mono text-[10px] leading-tight text-zinc-400" aria-hidden="true">
          <span class="shrink-0 whitespace-nowrap">{axisTicks[0]}</span>
          <span class="min-w-0 whitespace-nowrap text-center {denseAxis ? 'hidden sm:inline' : ''}">{axisTicks[1]}</span>
          <span class="shrink-0 whitespace-nowrap text-right">{axisTicks[2]}</span>
        </div>
      {/if}
    </div>
  </div>
  <Tooltip.SharedContent anchor={tooltipAnchor} open={selectedBucket !== undefined} id={tooltipId}
    onclose={closeBucket} onpointerenter={cancelClose} onpointerleave={leaveBucket}
    class="w-72 font-mono text-[11px]"
    data-testid="token-stats-bucket-detail">
    {#if tooltipBucket}
      <div class="border-b border-carbon-600 pb-2 text-zinc-400">{bucketLabel(tooltipBucket.startMs)}</div>
      <div class="mt-2 flex items-baseline justify-between gap-3">
        <span>Token</span><strong class="font-display text-sm text-zinc-50">{display(tooltipBucket.total)}</strong>
      </div>
      <div class="mt-2 space-y-1.5">
        {#each tooltipBucket.details as part (part.id)}
          <div class="flex items-start justify-between gap-3">
            <span class="flex min-w-0 items-start gap-1.5">
              <span class="mt-1 h-2 w-2 shrink-0 {modelTone(part.id)}" aria-hidden="true"></span>
              <span class="break-all">{modelLabel(part.id)}</span>
            </span>
            <strong class="shrink-0 font-normal text-zinc-50">{display(part.tokens)}</strong>
          </div>
        {:else}
          <span class="text-zinc-400">{t('ui.noCountedTokens')}</span>
        {/each}
      </div>
    {/if}
  </Tooltip.SharedContent>
  <div class="mt-2 flex shrink-0 flex-wrap gap-x-3 gap-y-1 font-mono {pageChart ? 'text-xs' : 'text-[10px]'} text-zinc-300" data-testid="token-stats-chart-legend">
    {#each trend.models as id (id)}
      <span class="inline-flex min-w-0 items-center gap-1" title={modelLabel(id)}>
        <span class="h-2 w-2 shrink-0 {modelTone(id)}" aria-hidden="true"></span>
        <span class={pageChart ? 'min-w-0 break-all' : 'max-w-28 truncate'}>{modelLabel(id)}</span>
      </span>
    {/each}
  </div>
</div>
