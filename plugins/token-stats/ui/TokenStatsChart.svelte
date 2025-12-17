<script lang="ts">
  /**
   * Token 统计图表组件
   * 插件: token-stats
   */
  import { onMount, onDestroy } from 'svelte';
  import {
    Bar,
    ChartJS,
    BarElement,
    CategoryScale,
    LinearScale,
    Tooltip,
    Legend,
    chartTheme,
    createTitleConfig,
    createLegendConfig,
    createScaleConfig,
    createTooltipConfig,
    api,
    _,
    type ChartData,
    type ChartOptions,
    type TimeRange
  } from '@bungee/plugin-sdk';

  ChartJS.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend);

  // Props
  export let pluginName: string = 'token-stats';
  export let selectedRange: TimeRange = '24h';

  interface RouteTokenStats {
    routeId: string;
    input_tokens: number;
    output_tokens: number;
    requests: number;
  }

  let data: RouteTokenStats[] = [];
  let loading = true;
  let error: string | null = null;
  let interval: ReturnType<typeof setInterval>;

  async function loadData() {
    try {
      loading = data.length === 0;
      const result = await api.get<RouteTokenStats[]>(
        `/plugins/${pluginName}/by-route?range=${selectedRange}`
      );
      data = result;
      error = null;
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    chartTheme.init();
    loadData();
    interval = setInterval(loadData, 60000); // 每分钟刷新
  });

  onDestroy(() => {
    chartTheme.cleanup();
    if (interval) clearInterval(interval);
  });

  // 时间范围变化时重新加载
  $: if (selectedRange) {
    loadData();
  }

  // 截断长路由名称
  function truncateLabel(label: string, maxLength: number = 20): string {
    if (label.length <= maxLength) return label;
    return label.slice(0, maxLength - 3) + '...';
  }

  $: chartData = {
    labels: data.map(d => truncateLabel(d.routeId)),
    datasets: [
      {
        label: $_('tokenStats.inputTokens'),
        data: data.map(d => d.input_tokens),
        backgroundColor: 'rgba(59, 130, 246, 0.8)',
        borderColor: 'rgba(59, 130, 246, 1)',
        borderWidth: 1
      },
      {
        label: $_('tokenStats.outputTokens'),
        data: data.map(d => d.output_tokens),
        backgroundColor: 'rgba(34, 197, 94, 0.8)',
        borderColor: 'rgba(34, 197, 94, 1)',
        borderWidth: 1
      }
    ]
  } as ChartData<'bar', number[], unknown>;

  $: chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: createScaleConfig($chartTheme.textColor, $chartTheme.gridColor, {
        stacked: true,
        fontSize: 10,
        maxRotation: 45,
        minRotation: 45
      }),
      y: createScaleConfig($chartTheme.textColor, $chartTheme.gridColor, {
        stacked: true,
        beginAtZero: true,
        fontSize: 11
      })
    },
    plugins: {
      title: createTitleConfig($_('tokenStats.chartTitle'), $chartTheme.textColor),
      legend: createLegendConfig($chartTheme.textColor, {
        position: 'top',
        padding: 10,
        fontSize: 11
      }),
      tooltip: createTooltipConfig('index', false)
    }
  } as ChartOptions<'bar'>;

  // 计算汇总数据
  $: totalInput = data.reduce((sum, d) => sum + d.input_tokens, 0);
  $: totalOutput = data.reduce((sum, d) => sum + d.output_tokens, 0);
</script>

<div class="w-full h-full flex flex-col">
  {#if loading && data.length === 0}
    <div class="flex items-center justify-center h-full">
      <span class="loading loading-spinner loading-lg"></span>
    </div>
  {:else if error}
    <div class="alert alert-error text-sm">
      <span>{error}</span>
    </div>
  {:else if data.length === 0}
    <div class="flex items-center justify-center h-full text-gray-500">
      {$_('dashboard.noData')}
    </div>
  {:else}
    <!-- 汇总统计 -->
    <div class="flex gap-4 mb-2 text-xs">
      <div class="badge badge-info badge-outline">
        {$_('tokenStats.totalInput')}: {totalInput.toLocaleString()}
      </div>
      <div class="badge badge-success badge-outline">
        {$_('tokenStats.totalOutput')}: {totalOutput.toLocaleString()}
      </div>
    </div>
    <!-- 图表 -->
    <div class="flex-1 min-h-0">
      <Bar data={chartData} options={chartOptions} />
    </div>
  {/if}
</div>
