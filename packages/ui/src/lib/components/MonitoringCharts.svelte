<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { _ } from '../i18n';
  import { getStatsHistoryV2 } from '../api/stats';
  import type { StatsHistoryV2, TimeRange } from '../types';
  import LineChart from '../components/LineChart.svelte';

  let history: StatsHistoryV2 | null = null;
  let loading = true;
  let error: string | null = null;
  let interval: number;
  let selectedRange: TimeRange = '1h';

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

  onMount(() => {
    loadHistory();
    // 每 30 秒刷新一次（适应新的长时间范围）
    interval = setInterval(loadHistory, 30000);
  });

  onDestroy(() => {
    if (interval) clearInterval(interval);
  });

  // 当时间范围改变时重新加载
  $: if (selectedRange) {
    loadHistory();
  }

  // 时间标签格式化
  $: timeLabels = history?.timestamps.map(ts => {
    const date = new Date(ts);
    switch (selectedRange) {
      case '1h':
        return date.toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit'
        });
      case '12h':
        return date.toLocaleString('zh-CN', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
      case '24h':
        return date.toLocaleString('zh-CN', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit'
        });
      default:
        return date.toLocaleTimeString('zh-CN');
    }
  }) || [];

  // 数据直接使用，无需差值计算
  $: requestsData = history?.requests || [];
  $: errorsData = history?.errors || [];
  $: responseTimeData = history?.responseTime || [];
  $: successRateData = history?.successRate || [];
</script>

<div class="space-y-6">
  <!-- 时间范围选择器 -->
  <div class="flex justify-between items-center">
    <h2 class="text-2xl font-bold">{$_('monitoring.title')}</h2>
    <div class="join">
      <input
        class="join-item btn btn-sm"
        type="radio"
        name="range"
        aria-label={$_('monitoring.range.oneHour')}
        value="1h"
        bind:group={selectedRange}
      />
      <input
        class="join-item btn btn-sm"
        type="radio"
        name="range"
        aria-label={$_('monitoring.range.twelveHours')}
        value="12h"
        bind:group={selectedRange}
      />
      <input
        class="join-item btn btn-sm"
        type="radio"
        name="range"
        aria-label={$_('monitoring.range.twentyFourHours')}
        value="24h"
        bind:group={selectedRange}
      />
    </div>
  </div>

  {#if loading && !history}
    <div class="flex justify-center items-center h-64">
      <span class="loading loading-spinner loading-lg"></span>
    </div>
  {:else if error}
    <div class="alert alert-error">
      <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span>{$_('common.error')}: {error}</span>
    </div>
  {:else if history && history.timestamps.length > 0}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- 请求数趋势图 -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body p-4">
          <div class="h-64">
            <LineChart
              title={$_('monitoring.charts.requestsTrend')}
              labels={timeLabels}
              datasets={[
                {
                  label: $_('monitoring.charts.periodRequests'),
                  data: requestsData,
                  borderColor: 'rgb(59, 130, 246)',
                  backgroundColor: 'rgba(59, 130, 246, 0.1)'
                }
              ]}
              yAxisLabel={$_('monitoring.charts.requests')}
            />
          </div>
        </div>
      </div>

      <!-- 响应时间趋势图 -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body p-4">
          <div class="h-64">
            <LineChart
              title={$_('monitoring.charts.responseTimeTrend')}
              labels={timeLabels}
              datasets={[
                {
                  label: $_('monitoring.charts.avgResponseTime'),
                  data: responseTimeData,
                  borderColor: 'rgb(34, 197, 94)',
                  backgroundColor: 'rgba(34, 197, 94, 0.1)'
                }
              ]}
              yAxisLabel={$_('monitoring.charts.milliseconds')}
            />
          </div>
        </div>
      </div>

      <!-- 成功率趋势图 -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body p-4">
          <div class="h-64">
            <LineChart
              title={$_('monitoring.charts.successRateTrend')}
              labels={timeLabels}
              datasets={[
                {
                  label: $_('monitoring.charts.successRate'),
                  data: successRateData,
                  borderColor: 'rgb(16, 185, 129)',
                  backgroundColor: 'rgba(16, 185, 129, 0.1)'
                }
              ]}
              yAxisLabel={$_('monitoring.charts.percentage')}
            />
          </div>
        </div>
      </div>

      <!-- 错误数趋势图 -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body p-4">
          <div class="h-64">
            <LineChart
              title={$_('monitoring.charts.errorsTrend')}
              labels={timeLabels}
              datasets={[
                {
                  label: $_('monitoring.charts.periodErrors'),
                  data: errorsData,
                  borderColor: 'rgb(239, 68, 68)',
                  backgroundColor: 'rgba(239, 68, 68, 0.1)'
                }
              ]}
              yAxisLabel={$_('monitoring.charts.errors')}
            />
          </div>
        </div>
      </div>
    </div>
  {:else}
    <div class="alert alert-info">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
      </svg>
      <span>{$_('monitoring.noData')}</span>
    </div>
  {/if}
</div>
