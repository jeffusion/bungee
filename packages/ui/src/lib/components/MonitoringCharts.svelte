<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getStatsHistory } from '../api/stats';
  import type { StatsHistory } from '../types';
  import LineChart from '../components/LineChart.svelte';

  let history: StatsHistory | null = null;
  let loading = true;
  let error: string | null = null;
  let interval: number;
  let selectedInterval: '10s' | '1m' | '5m' = '10s';

  async function loadHistory() {
    try {
      loading = true;
      history = await getStatsHistory(selectedInterval);
      error = null;
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    loadHistory();
    // 每 10 秒刷新一次
    interval = setInterval(loadHistory, 10000);
  });

  onDestroy(() => {
    if (interval) clearInterval(interval);
  });

  // 当时间间隔改变时重新加载
  $: if (selectedInterval) {
    loadHistory();
  }

  // 格式化时间标签
  $: timeLabels = history?.timestamps.map(ts => {
    const date = new Date(ts);
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }) || [];

  // 计算累积请求数的差值（得到每个时间点的实际请求数）
  $: requestsPerPeriod = history?.requests.map((req, i) => {
    if (i === 0) return 0; // 第一个数据点无法计算差值，设为0
    return req - (history?.requests[i - 1] || 0);
  }) || [];

  // 计算累积错误数的差值（得到每个时间点的实际错误数）
  $: errorsPerPeriod = history?.errors.map((err, i) => {
    if (i === 0) return 0; // 第一个数据点无法计算差值，设为0
    return err - (history?.errors[i - 1] || 0);
  }) || [];

  // 计算每个时段的错误率（时段错误数 / 时段请求数）
  $: errorRates = requestsPerPeriod.map((req, i) => {
    if (req === 0) return 0; // 避免除以0
    return (errorsPerPeriod[i] / req) * 100;
  });
</script>

<div class="space-y-6">
  <!-- 时间范围选择器 -->
  <div class="flex justify-between items-center">
    <h2 class="text-2xl font-bold">监控图表</h2>
    <div class="join">
      <input
        class="join-item btn btn-sm"
        type="radio"
        name="interval"
        aria-label="10秒"
        value="10s"
        bind:group={selectedInterval}
      />
      <input
        class="join-item btn btn-sm"
        type="radio"
        name="interval"
        aria-label="1分钟"
        value="1m"
        bind:group={selectedInterval}
      />
      <input
        class="join-item btn btn-sm"
        type="radio"
        name="interval"
        aria-label="5分钟"
        value="5m"
        bind:group={selectedInterval}
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
      <span>Error: {error}</span>
    </div>
  {:else if history && history.timestamps.length > 0}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- QPS 趋势图 -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body p-4">
          <div class="h-64">
            <LineChart
              title="请求数趋势"
              labels={timeLabels}
              datasets={[
                {
                  label: '每时段请求数',
                  data: requestsPerPeriod,
                  borderColor: 'rgb(59, 130, 246)',
                  backgroundColor: 'rgba(59, 130, 246, 0.1)'
                }
              ]}
              yAxisLabel="请求数"
            />
          </div>
        </div>
      </div>

      <!-- 响应时间趋势图 -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body p-4">
          <div class="h-64">
            <LineChart
              title="响应时间趋势"
              labels={timeLabels}
              datasets={[
                {
                  label: '平均响应时间 (ms)',
                  data: history.responseTime,
                  borderColor: 'rgb(34, 197, 94)',
                  backgroundColor: 'rgba(34, 197, 94, 0.1)'
                }
              ]}
              yAxisLabel="毫秒 (ms)"
            />
          </div>
        </div>
      </div>

      <!-- 错误率趋势图 -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body p-4">
          <div class="h-64">
            <LineChart
              title="错误率趋势"
              labels={timeLabels}
              datasets={[
                {
                  label: '错误率 (%)',
                  data: errorRates,
                  borderColor: 'rgb(239, 68, 68)',
                  backgroundColor: 'rgba(239, 68, 68, 0.1)'
                }
              ]}
              yAxisLabel="百分比 (%)"
            />
          </div>
        </div>
      </div>

      <!-- 错误数趋势图 -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body p-4">
          <div class="h-64">
            <LineChart
              title="错误数趋势"
              labels={timeLabels}
              datasets={[
                {
                  label: '每时段错误数',
                  data: errorsPerPeriod,
                  borderColor: 'rgb(249, 115, 22)',
                  backgroundColor: 'rgba(249, 115, 22, 0.1)'
                }
              ]}
              yAxisLabel="错误数"
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
      <span>暂无历史数据</span>
    </div>
  {/if}
</div>
