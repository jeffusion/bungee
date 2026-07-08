<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { _ } from '$i18n';
  import { getStatsHistoryV2, getUnifiedUpstreamStats, getUpstreamStatusCodes } from '$api/stats';
  import type { StatsHistoryV2, TimeRange, UnifiedUpstreamStats, UpstreamStatusCodeStats } from '$types';
  import LineChart from './LineChart.svelte';
  import PieChart from './PieChart.svelte';
  import StackedBarChart from './StackedBarChart.svelte';
  import { LoadingIndicator, PanelCard, SectionDivider, StatusBadge } from '$components/industrial';

  export let selectedRange: TimeRange = '1h';
  export let onDataLoaded: (history: StatsHistoryV2 | null) => void = () => {};

  let history: StatsHistoryV2 | null = null;
  let loading = true;
  let error: string | null = null;
  let interval: number;

  let upstreamSuccess: UnifiedUpstreamStats[] = [];
  let upstreamFailures: UnifiedUpstreamStats[] = [];
  let upstreamStatusCodes: UpstreamStatusCodeStats[] = [];

  async function loadHistory() {
    try {
      loading = true;
      history = await getStatsHistoryV2(selectedRange);
      error = null;
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function loadUpstreamStats() {
    try {
      const [successResult, failResult, statusResult] = await Promise.all([
        getUnifiedUpstreamStats(selectedRange, 'success'),
        getUnifiedUpstreamStats(selectedRange, 'failure'),
        getUpstreamStatusCodes(selectedRange),
      ]);
      upstreamSuccess = successResult.data;
      upstreamFailures = failResult.data;
      upstreamStatusCodes = statusResult.data;
    } catch (error) {
      console.error('Failed to load upstream stats:', error);
    }
  }

  async function loadAllData() {
    await Promise.all([loadHistory(), loadUpstreamStats()]);
  }

  onMount(() => {
    loadAllData();
    interval = setInterval(loadAllData, 30000);
  });

  onDestroy(() => {
    if (interval) clearInterval(interval);
  });

  $: if (selectedRange) loadAllData();

  $: if (history !== null || error !== null) {
    onDataLoaded(error ? null : history);
  }

  $: timeLabels = history?.timestamps.map((ts) => {
    const date = new Date(ts);
    switch (selectedRange) {
      case '1h':
        return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      case '12h':
        return date.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      case '24h':
        return date.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit' });
      default:
        return date.toLocaleTimeString('zh-CN');
    }
  }) || [];

  $: requestsData = history?.requests || [];
  $: errorsData = history?.errors || [];
  $: responseTimeData = history?.responseTime || [];
  $: successRateData = history?.successRate || [];

  $: pieChartData = upstreamSuccess.map((d) => ({
    label: new URL(d.upstream).host,
    value: d.count,
    percentage: d.percentage,
  }));

  $: failurePieChartData = upstreamFailures
    .filter((d) => d.failedRequests > 0)
    .sort((a, b) => b.failedRequests - a.failedRequests)
    .map((d) => ({
      label: new URL(d.upstream).host,
      value: d.failedRequests,
      percentage: d.percentage,
    }));

  $: stackedBarChartData = upstreamStatusCodes.map((d) => ({
    label: new URL(d.upstream).host,
    status2xx: d.status2xx,
    status3xx: d.status3xx,
    status4xx: d.status4xx,
    status5xx: d.status5xx,
  }));

  // Industrial chart palette — orange-led.
  const COLOR_ORANGE = 'rgb(249, 115, 22)';
  const COLOR_ORANGE_FILL = 'rgba(249, 115, 22, 0.14)';
  const COLOR_SKY = 'rgb(56, 189, 248)';
  const COLOR_SKY_FILL = 'rgba(56, 189, 248, 0.12)';
  const COLOR_EMERALD = 'rgb(16, 185, 129)';
  const COLOR_EMERALD_FILL = 'rgba(16, 185, 129, 0.12)';
  const COLOR_RED = 'rgb(239, 68, 68)';
  const COLOR_RED_FILL = 'rgba(239, 68, 68, 0.14)';
</script>

<div class="space-y-3">
  <SectionDivider label={$_('monitoring.title')}>
    <svelte:fragment slot="actions">
      <StatusBadge variant="online" dot>LIVE</StatusBadge>
    </svelte:fragment>
  </SectionDivider>

  {#if loading && !history}
    <PanelCard title="TELEMETRY" tag="LOADING">
      <LoadingIndicator height="lg" />
    </PanelCard>
  {:else if error}
    <PanelCard title={$_('common.error')} tag="ERR" stripe="red">
      <p class="font-mono text-xs uppercase tracking-command text-red-300">{error}</p>
    </PanelCard>
  {:else if history && history.timestamps.length > 0}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <PanelCard title={$_('monitoring.charts.requestsTrend')} tag="CH-01">
        <div class="h-52">
          <LineChart
            labels={timeLabels}
            datasets={[
              {
                label: $_('monitoring.charts.periodRequests'),
                data: requestsData,
                borderColor: COLOR_ORANGE,
                backgroundColor: COLOR_ORANGE_FILL,
              },
            ]}
            yAxisLabel={$_('monitoring.charts.requests')}
            syncGroup="monitoring-trends"
          />
        </div>
      </PanelCard>

      <PanelCard title={$_('monitoring.charts.responseTimeTrend')} tag="CH-02">
        <div class="h-52">
          <LineChart
            labels={timeLabels}
            datasets={[
              {
                label: $_('monitoring.charts.avgResponseTime'),
                data: responseTimeData,
                borderColor: COLOR_SKY,
                backgroundColor: COLOR_SKY_FILL,
              },
            ]}
            yAxisLabel={$_('monitoring.charts.milliseconds')}
            syncGroup="monitoring-trends"
          />
        </div>
      </PanelCard>

      <PanelCard title={$_('monitoring.charts.successRateTrend')} tag="CH-03" stripe="emerald">
        <div class="h-52">
          <LineChart
            labels={timeLabels}
            datasets={[
              {
                label: $_('monitoring.charts.successRate'),
                data: successRateData,
                borderColor: COLOR_EMERALD,
                backgroundColor: COLOR_EMERALD_FILL,
              },
            ]}
            yAxisLabel={$_('monitoring.charts.percentage')}
            syncGroup="monitoring-trends"
          />
        </div>
      </PanelCard>

      <PanelCard title={$_('monitoring.charts.errorsTrend')} tag="CH-04" stripe="red">
        <div class="h-52">
          <LineChart
            labels={timeLabels}
            datasets={[
              {
                label: $_('monitoring.charts.periodErrors'),
                data: errorsData,
                borderColor: COLOR_RED,
                backgroundColor: COLOR_RED_FILL,
              },
            ]}
            yAxisLabel={$_('monitoring.charts.errors')}
            syncGroup="monitoring-trends"
          />
        </div>
      </PanelCard>

      <PanelCard title={$_('dashboard.upstreamDistribution')} tag="SECTOR-A" class="lg:col-start-1 lg:row-start-3">
        <div class="h-52">
          {#if pieChartData.length > 0}
            <PieChart data={pieChartData} />
          {:else}
            <div class="flex flex-col items-center justify-center h-full gap-3 text-zinc-600">
              <svg viewBox="0 0 24 24" class="h-10 w-10" fill="none" stroke="currentColor" stroke-width="1.4">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              <span class="nx-label">{$_('dashboard.noData')}</span>
            </div>
          {/if}
        </div>
      </PanelCard>

      <PanelCard title={$_('dashboard.upstreamFailures')} tag="SECTOR-B" stripe="red" class="lg:col-start-1 lg:row-start-4">
        <div class="h-52">
          {#if failurePieChartData.length > 0}
            <PieChart data={failurePieChartData} />
          {:else}
            <div class="flex flex-col items-center justify-center h-full gap-3 text-zinc-600">
              <svg viewBox="0 0 24 24" class="h-10 w-10" fill="none" stroke="currentColor" stroke-width="1.4">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              <span class="nx-label">{$_('dashboard.noData')}</span>
            </div>
          {/if}
        </div>
      </PanelCard>

      <PanelCard title={$_('dashboard.upstreamStatusCodes')} tag="MATRIX" class="lg:col-start-2 lg:row-start-3 lg:row-span-2" scrollable={true}>
        <div class="h-full">
          {#if stackedBarChartData.length > 0}
            <StackedBarChart data={stackedBarChartData} />
          {:else}
            <div class="flex flex-col items-center justify-center h-full gap-3 text-zinc-600">
              <svg viewBox="0 0 24 24" class="h-10 w-10" fill="none" stroke="currentColor" stroke-width="1.4">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              <span class="nx-label">{$_('dashboard.noData')}</span>
            </div>
          {/if}
        </div>
      </PanelCard>
    </div>
  {:else}
    <PanelCard title={$_('monitoring.noData')} tag="IDLE" stripe="zinc">
      <p class="font-mono text-xs uppercase tracking-command text-zinc-500">
        — no telemetry data for the selected range —
      </p>
    </PanelCard>
  {/if}
</div>
