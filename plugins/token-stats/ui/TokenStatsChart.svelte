<script lang="ts" module>
  /** Keep sparse chart ticks distinct across midnight and repeated clock hours at DST fall-back. */
  export function timeAxisLabels(
    starts: readonly [number, number, number], locale?: string, timeZone?: string,
  ): [string, string, string] {
    const zone = timeZone ? { timeZone } : {};
    const days = new Intl.DateTimeFormat(locale, { ...zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const dates = new Intl.DateTimeFormat(locale, { ...zone, month: 'numeric', day: 'numeric' });
    const clock = new Intl.DateTimeFormat(locale, { ...zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const offsets = new Intl.DateTimeFormat(locale, { ...zone, timeZoneName: 'shortOffset' });
    const dayLabels = starts.map(start => days.format(start));
    const zoneLabels = starts.map(start => offsets.formatToParts(start).find(part => part.type === 'timeZoneName')?.value ?? '');
    const crossesDay = new Set(dayLabels).size > 1;
    const changesOffset = new Set(zoneLabels).size > 1;
    return starts.map((start, index) => `${crossesDay ? `${dates.format(start)} ` : ''}${clock.format(start)}${changesOffset ? ` ${zoneLabels[index]}` : ''}`)
      as [string, string, string];
  }
</script>

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { isLoading, locale } from 'svelte-i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import { LoadingIndicator } from '$components/industrial';
  import * as Tooltip from '$components/ui/tooltip';
  import { requestPluginControl, _, type TimeRange } from '@bungee/plugin-sdk';
  import {
    buildTimeSeries, estimatedTokens, formatEstimatedUsd, modelColorIndex, OTHER_MODEL,
    rankedModels, tokenAmount, usagePresentation, type ModelUsageRow, type TimeBucket,
    type TimeSeries, type TokenRange, type UsageSnapshot,
  } from './labels';

  type View = 'model' | 'time';
  type StatsResponse = UsageSnapshot & {
    groupBy: View;
    estimatedCostUsd: number | null;
    bucketMs?: number;
    data: ModelUsageRow[];
  };

  let { pluginName = 'token-stats', selectedRange = '24h' }: { pluginName?: string; selectedRange?: TimeRange } = $props();
  let selectedView: View = $state('model');
  let stats: StatsResponse | null = $state(null);
  let loading = $state(true);
  let error = $state('');
  let refreshedAt = $state(Date.now());
  let selectedBucketStart: number | null = $state(null);
  const tooltipId = $props.id();
  let tooltipAnchor: HTMLElement | null = $state(null);
  let tooltipBucket: TimeBucket | undefined = $state();
  let tooltipMode: 'hover' | 'focus' | 'touch' = 'hover';
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let touchBucketWasOpen = false;
  let generation = 0;
  let requestKey = '';
  let controller: AbortController | undefined;

  const t = (key: string) => $isLoading ? '' : getPluginText(key, pluginName, (id, options) => $_(id, options));
  const display = (value: unknown) => {
    const number = tokenAmount(value);
    return number === undefined ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(number);
  };
  const rows = $derived(stats?.data ?? []);
  const usage = $derived(usagePresentation(stats ?? { logicalRequests: 0, upstreamAttempts: 0 }));
  const formattedCost = $derived(formatEstimatedUsd(stats?.estimatedCostUsd));
  const models = $derived(stats?.groupBy === 'model' ? rankedModels(rows) : []);
  const maxModelTokens = $derived(Math.max(0, ...models.map(model => model.tokens ?? 0)));
  const cacheLabels = $derived($locale?.startsWith('zh')
    ? { read: '缓存读取', write: '缓存写入' }
    : { read: 'Cache read', write: 'Cache write' });
  const trend: TimeSeries = $derived(stats?.groupBy === 'time' && stats.bucketMs
    ? buildTimeSeries(rows, selectedRange as TokenRange, stats.bucketMs, refreshedAt)
    : { buckets: [], models: [], maxTokens: 0 });
  const axisTicks = $derived(trend.buckets.length
    ? timeAxisLabels([
      trend.buckets[0].startMs,
      trend.buckets[Math.floor(trend.buckets.length / 2)].startMs,
      trend.buckets[trend.buckets.length - 1].startMs,
    ], $locale ?? undefined)
    : ['', '', '']);
  const selectedBucket = $derived(trend.buckets.find(bucket => bucket.startMs === selectedBucketStart));
  $effect(() => {
    // Retain the displayed data while the shared tooltip finishes fading out.
    if (selectedBucket) tooltipBucket = selectedBucket;
  });
  const denseAxis = $derived(axisTicks.join('').length > 42);
  const views = $derived($isLoading ? [] : ([
    ['model', t('dimension.model')], ['time', t('dimension.time')],
  ] as const));
  const tones = ['bg-nexus-500', 'bg-sky-400', 'bg-emerald-400', 'bg-amber-400', 'bg-red-400'] as const;

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
    return `${timeLabel(bucket.startMs, true)} · ${bucket.details.length
      ? `${display(bucket.total)} Token · ${bucket.details.map(part => `${modelLabel(part.id)} ${display(part.tokens)}`).join(' · ')}`
      : t('ui.noCountedTokens')}`;
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

  async function refresh() {
    const current = ++generation;
    controller?.abort();
    controller = new AbortController();
    const key = `${pluginName}:${selectedRange}:${selectedView}`;
    if (requestKey !== key) {
      stats = null;
      closeBucket();
      error = '';
      requestKey = key;
    }
    loading = stats === null;
    try {
      const result = await requestPluginControl<StatsResponse>(
        pluginName, `/stats?range=${encodeURIComponent(selectedRange)}&groupBy=${selectedView}`,
        'GET', undefined, controller.signal,
      );
      if (current !== generation) return;
      refreshedAt = Date.now();
      stats = result;
      error = '';
    } catch (cause) {
      if (current !== generation || controller.signal.aborted) return;
      error = cause instanceof Error ? cause.message : t('ui.loadFailed');
    } finally {
      if (current === generation) loading = false;
    }
  }

  $effect(() => {
    pluginName; selectedRange; selectedView;
    untrack(() => void refresh());
  });

  onMount(() => {
    const interval = setInterval(() => void refresh(), 60_000);
    return () => { ++generation; controller?.abort(); clearInterval(interval); cancelClose(); };
  });
</script>

<div class="flex h-full min-h-0 w-full flex-col gap-2 overflow-hidden text-zinc-200" data-testid="plugin-widget-token-stats">
  <div class="flex shrink-0 items-center gap-1" role="group" aria-label={t('ui.view')}>
    {#each views as [view, label]}
      <button type="button" aria-pressed={selectedView === view}
        class="nx-btn nx-btn-sm min-h-6 px-2 {selectedView === view ? 'nx-btn-primary' : 'nx-btn-ghost'}"
        onclick={() => selectedView = view}>{label}</button>
    {/each}
  </div>

  {#if loading && !stats}
    <LoadingIndicator size="sm" height="sm" label={t('ui.loading')} />
  {:else if error}
    <div role="alert" class="border-l-2 border-red-500 px-2 py-1 text-xs text-red-300">{t('ui.loadFailed')}: {error}</div>
  {:else if stats && usage}
    {#if usage.state === 'empty'}
      <div class="flex min-h-[180px] flex-1 items-center justify-center px-4 py-6 text-center text-sm text-zinc-400" data-testid="token-stats-empty">{t('ui.noData')}</div>
    {:else}
      <div class="grid shrink-0 grid-cols-2 gap-y-2 sm:grid-cols-3 {usage.positive ? 'border-b border-carbon-600 pb-2' : ''}" data-testid="token-stats-primary">
        <div class="min-w-0 pr-2 sm:pr-3">
          <div class="nx-label">{t('ui.input')}{#if estimatedTokens(stats, 'input') !== undefined}<span class="ml-1 text-zinc-400">· {t('ui.includesEstimate')}</span>{/if}</div>
          <div class="nx-display truncate text-2xl text-zinc-50" title={usage.input === undefined ? t('ui.unknownValue') : display(usage.input)}>{display(usage.input)}</div>
        </div>
        <div class="min-w-0 border-l border-carbon-600 pl-2 sm:pl-3 sm:pr-3">
          <div class="nx-label">{t('ui.output')}{#if estimatedTokens(stats, 'output') !== undefined}<span class="ml-1 text-zinc-400">· {t('ui.includesEstimate')}</span>{/if}</div>
          <div class="nx-display truncate text-2xl text-zinc-50" title={usage.output === undefined ? t('ui.unknownValue') : display(usage.output)}>{display(usage.output)}</div>
        </div>
        <div class="col-span-2 flex min-w-0 items-baseline justify-between gap-2 border-t border-carbon-600 pt-2 sm:col-span-1 sm:block sm:border-l sm:border-t-0 sm:pl-3 sm:pt-0" data-testid="token-stats-cost">
          <div class="nx-label shrink-0">{t('ui.estimatedCostUsd')}</div>
          <div class="min-w-0 truncate font-display text-lg font-bold leading-none text-zinc-50 sm:text-2xl" title={formattedCost === '—' ? t('ui.unknownValue') : formattedCost}>{formattedCost}</div>
        </div>
      </div>

      {#if selectedView === 'model' && models.length}
        <!-- Keyboard focus lets users scroll the model list without moving the fixed summary. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="min-h-0 flex-1 overflow-y-auto focus-visible:outline focus-visible:outline-1 focus-visible:outline-nexus-500" role="region" tabindex="0" aria-label={t('dimension.model')} data-testid="token-stats-model-scroll">
          <ol class="min-w-0" data-testid="token-stats-model-list">
            {#each models as model (model.id)}
              <li class="border-b border-carbon-600/60 py-2 last:border-0" data-testid="token-stats-model-row">
                <div class="flex items-start justify-between gap-2">
                  <span class="min-w-0 break-all font-mono text-xs leading-snug text-zinc-200">{modelLabel(model.id)}</span>
                  <span class="shrink-0 whitespace-nowrap text-right font-mono text-[10px] text-zinc-400" title={formatEstimatedUsd(model.estimatedCostUsd)}>USD <span class="text-zinc-200">{formatEstimatedUsd(model.estimatedCostUsd)}</span></span>
                </div>
                <div class="mt-1.5 grid grid-cols-2 gap-3 font-mono text-[11px]">
                  <div class="min-w-0">
                    <div class="flex items-baseline gap-1.5"><span class="nx-label">{t('ui.input')}</span><span class="font-display text-sm text-zinc-50">{display(model.input)}</span></div>
                    <div class="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-l border-carbon-500 pl-2">
                      <div class="inline-flex items-baseline gap-1.5 whitespace-nowrap"><span class="nx-label">{cacheLabels.read}</span><span class="font-display text-sm text-zinc-50">{display(model.cacheRead)}</span></div>
                      <div class="inline-flex items-baseline gap-1.5 whitespace-nowrap"><span class="nx-label">{cacheLabels.write}</span><span class="font-display text-sm text-zinc-50">{display(model.cacheWrite)}</span></div>
                    </div>
                  </div>
                  <div class="min-w-0 border-l border-carbon-600 pl-3">
                    <div class="flex items-baseline gap-1.5"><span class="nx-label">{t('ui.output')}</span><span class="font-display text-sm text-zinc-50">{display(model.output)}</span></div>
                  </div>
                </div>
                <div class="mt-1.5 h-1.5 bg-carbon-600/60" aria-hidden="true"><div class="h-full {modelTone(model.id)}" style:width={`${maxModelTokens > 0 ? (model.tokens ?? 0) / maxModelTokens * 100 : 0}%`}></div></div>
              </li>
            {/each}
          </ol>
        </div>
      {:else if selectedView === 'time' && trend.maxTokens > 0}
        <div class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="token-stats-time-chart">
          <div class="flex min-h-0 flex-1 items-end gap-1 border-b border-carbon-500" role="group" aria-label={t('ui.timeChart')}>
            {#each trend.buckets as bucket, index (bucket.startMs)}
              <button type="button" aria-pressed={selectedBucketStart === bucket.startMs}
                aria-label={bucketDescription(bucket)} aria-describedby={selectedBucketStart === bucket.startMs ? tooltipId : undefined} data-token-stats-bucket-trigger
                class="flex min-w-0 flex-1 self-stretch flex-col justify-end border-x border-transparent transition-colors hover:bg-carbon-700/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nexus-500 {selectedBucketStart === bucket.startMs ? 'bg-carbon-700/40' : ''}"
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
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    const next = event.currentTarget.parentElement?.children[index + (event.key === 'ArrowRight' ? 1 : -1)] as HTMLElement | undefined;
                    next?.focus();
                  }
                }}>
                {#if bucket.total > 0}
                  <span class="mx-auto flex w-full max-w-7 flex-col-reverse overflow-hidden sm:max-w-9" style:height={`${bucket.total / trend.maxTokens * 100}%`} aria-hidden="true">
                    {#each bucket.parts as part (part.id)}
                      <span class="block w-full {modelTone(part.id)}" style:height={`${part.tokens / bucket.total * 100}%`}></span>
                    {/each}
                  </span>
                {/if}
              </button>
            {/each}
          </div>
          <Tooltip.SharedContent anchor={tooltipAnchor} open={selectedBucket !== undefined} id={tooltipId}
            onclose={closeBucket} onpointerenter={cancelClose} onpointerleave={leaveBucket}
            class="w-72 font-mono text-[11px]"
            data-testid="token-stats-bucket-detail">
            {#if tooltipBucket}
              <div class="border-b border-carbon-600 pb-2 text-zinc-400">{timeLabel(tooltipBucket.startMs, true)}</div>
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
          <div class="mt-1 flex shrink-0 items-start justify-between gap-1 font-mono text-[10px] leading-tight text-zinc-400" aria-hidden="true">
            <span class="shrink-0 whitespace-nowrap">{axisTicks[0]}</span>
            <span class="min-w-0 whitespace-nowrap text-center {denseAxis ? 'hidden sm:inline' : ''}">{axisTicks[1]}</span>
            <span class="shrink-0 whitespace-nowrap text-right">{axisTicks[2]}</span>
          </div>
          <div class="mt-2 flex shrink-0 flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-zinc-300">
            {#each trend.models as id (id)}
              <span class="inline-flex min-w-0 items-center gap-1" title={modelLabel(id)}>
                <span class="h-2 w-2 shrink-0 {modelTone(id)}" aria-hidden="true"></span>
                <span class="max-w-28 truncate">{modelLabel(id)}</span>
              </span>
            {/each}
          </div>
        </div>
      {:else if usage.positive}
        <p class="text-xs text-zinc-400">{t('ui.noBreakdown')}</p>
      {/if}
    {/if}
  {/if}
</div>
