<script lang="ts">
  import { _ } from '../lib/i18n';
  import type { StatsHistoryV2, TimeRange } from '../lib/types';
  import MonitoringCharts from '../lib/components/MonitoringCharts.svelte';

  // 时间范围状态（受控）
  let selectedRange: TimeRange = '1h';

  // 计算的统计数据
  let calculatedStats: {
    totalRequests: number;
    requestsPerSecond: number;
    successRate: number;
    avgResponseTime: number;
  } | null = null;

  // 处理数据加载回调
  function handleDataLoaded(data: StatsHistoryV2 | null) {
    calculatedStats = calculateStats(data);
  }

  // 基于历史数据计算统计指标
  function calculateStats(history: StatsHistoryV2 | null) {
    if (!history || history.requests.length === 0) {
      return null;
    }

    // 总请求数：时间范围内所有请求的总和
    const totalRequests = history.requests.reduce((sum, val) => sum + val, 0);

    // 每秒请求数：总请求数 ÷ 时间范围秒数
    const rangeInSeconds = getRangeInSeconds(selectedRange);
    const requestsPerSecond = totalRequests / rangeInSeconds;

    // 成功率：基于所有时间点的加权平均
    const totalErrors = history.errors.reduce((sum, val) => sum + val, 0);
    const successRate = totalRequests > 0
      ? ((totalRequests - totalErrors) / totalRequests) * 100
      : 100;

    // 平均响应时间：所有时间点响应时间的简单平均
    const avgResponseTime = history.responseTime.length > 0
      ? history.responseTime.reduce((sum, val) => sum + val, 0) / history.responseTime.length
      : 0;

    return {
      totalRequests,
      requestsPerSecond,
      successRate,
      avgResponseTime
    };
  }

  // 获取时间范围对应的秒数
  function getRangeInSeconds(range: TimeRange): number {
    switch (range) {
      case '1h': return 3600;
      case '12h': return 43200;
      case '24h': return 86400;
      default: return 3600;
    }
  }
</script>

<div class="p-6">
  <h1 class="text-3xl font-bold mb-6">{$_('dashboard.title')}</h1>

  <!-- 时间范围选择器 -->
  <div class="flex justify-between items-center mb-6">
    <p class="text-sm text-gray-500">
      {$_('dashboard.dataRange')}: {$_('monitoring.range.' + selectedRange)}
    </p>
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

  <!-- 统计卡片 -->
  {#if calculatedStats}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-sm">{$_('dashboard.totalRequests')}</h2>
          <p class="text-3xl font-bold">{calculatedStats.totalRequests}</p>
        </div>
      </div>

      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-sm">{$_('dashboard.requestsPerSecond')}</h2>
          <p class="text-3xl font-bold">{calculatedStats.requestsPerSecond.toFixed(2)}</p>
        </div>
      </div>

      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-sm">{$_('dashboard.successRate')}</h2>
          <p class="text-3xl font-bold">{calculatedStats.successRate.toFixed(1)}%</p>
        </div>
      </div>

      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-sm">{$_('dashboard.avgResponseTime')}</h2>
          <p class="text-3xl font-bold">{calculatedStats.avgResponseTime.toFixed(0)}ms</p>
        </div>
      </div>
    </div>
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-sm">{$_('dashboard.totalRequests')}</h2>
          <p class="text-3xl font-bold">-</p>
        </div>
      </div>

      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-sm">{$_('dashboard.requestsPerSecond')}</h2>
          <p class="text-3xl font-bold">-</p>
        </div>
      </div>

      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-sm">{$_('dashboard.successRate')}</h2>
          <p class="text-3xl font-bold">-</p>
        </div>
      </div>

      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-sm">{$_('dashboard.avgResponseTime')}</h2>
          <p class="text-3xl font-bold">-</p>
        </div>
      </div>
    </div>
  {/if}

  <!-- 监控图表 -->
  <MonitoringCharts
    selectedRange={selectedRange}
    onDataLoaded={handleDataLoaded}
  />
</div>
