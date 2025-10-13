<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { _ } from '../lib/i18n';
  import { getStatsSnapshot } from '../lib/api/stats';
  import type { StatsSnapshot } from '../lib/types';
  import MonitoringCharts from '../lib/components/MonitoringCharts.svelte';

  let stats: StatsSnapshot | null = null;
  let error: string | null = null;
  let loading = true;
  let interval: number;

  async function loadStats() {
    try {
      stats = await getStatsSnapshot();
      error = null;
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    loadStats();
    interval = setInterval(loadStats, 3000);
  });

  onDestroy(() => {
    if (interval) clearInterval(interval);
  });
</script>

<div class="p-6">
  <h1 class="text-3xl font-bold mb-6">{$_('dashboard.title')}</h1>

  {#if loading}
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
  {:else if stats}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-sm">{$_('dashboard.totalRequests')}</h2>
          <p class="text-3xl font-bold">{stats.totalRequests}</p>
        </div>
      </div>

      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-sm">{$_('dashboard.requestsPerSecond')}</h2>
          <p class="text-3xl font-bold">{stats.requestsPerSecond.toFixed(2)}</p>
        </div>
      </div>

      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-sm">{$_('dashboard.successRate')}</h2>
          <p class="text-3xl font-bold">{stats.successRate.toFixed(1)}%</p>
        </div>
      </div>

      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-sm">{$_('dashboard.avgResponseTime')}</h2>
          <p class="text-3xl font-bold">{stats.averageResponseTime.toFixed(0)}ms</p>
        </div>
      </div>
    </div>

    <div class="mt-6 text-sm text-gray-500">
      {$_('dashboard.lastUpdated')}: {new Date(stats.timestamp).toLocaleString()}
    </div>

    <!-- 监控图表 -->
    <div class="mt-8">
      <MonitoringCharts />
    </div>
  {/if}
</div>
