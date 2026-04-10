<script lang="ts">
  /**
   * Token 统计图表组件
   * 插件: token-stats
   *
   * 支持多维度聚合：全部汇总、按路由、按 Upstream、按 Provider
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
  } from '../../../packages/ui/src/lib/plugin-sdk';

  ChartJS.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend);

  // Props
  export let pluginName: string = 'token-stats';
  export let selectedRange: TimeRange = '24h';

  // 维度类型
  type GroupByDimension = 'all' | 'route' | 'upstream' | 'provider';

  type AuthorityKey = 'official' | 'local' | 'heuristic' | 'partial' | 'none';

  type AuthorityBreakdown = {
    input: Record<AuthorityKey, number>;
    output: Record<AuthorityKey, number>;
  };

  interface DimensionTokenStats {
    dimension: string;
    inputTokens: number;
    outputTokens: number;
    officialInputTokens: number;
    officialOutputTokens: number;
    partialOutputs: number;
    logicalRequests: number;
    upstreamAttempts: number;
    authorityBreakdown: AuthorityBreakdown;
  }

  interface StatsResponse {
    groupBy: GroupByDimension;
    totalInputTokens: number;
    totalOutputTokens: number;
    logicalRequests: number;
    upstreamAttempts: number;
    authorityBreakdown: AuthorityBreakdown;
    data: DimensionTokenStats[];
  }

  let selectedDimension: GroupByDimension = 'route';
  let stats: StatsResponse | null = null;
  let loading = true;
  let error: string | null = null;
  let interval: ReturnType<typeof setInterval>;

  async function loadData() {
    try {
      loading = stats === null;
      const result = await api.get<StatsResponse>(
        `/plugins/${pluginName}/stats?range=${selectedRange}&groupBy=${selectedDimension}`
      );
      stats = result;
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

  // 时间范围或维度变化时重新加载
  $: if (selectedRange || selectedDimension) {
    loadData();
  }

  // 截断长标签
  function truncateLabel(label: string, maxLength: number = 20): string {
    if (label.length <= maxLength) return label;
    return label.slice(0, maxLength - 3) + '...';
  }

  // 格式化数字
  function formatNumber(num: number): string {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toLocaleString();
  }

  function getAuthorityEntries(breakdown?: Record<AuthorityKey, number>) {
    return Object.entries(breakdown ?? {}).sort(([, a], [, b]) => b - a);
  }

  function translateOrFallback(key: string, fallback: string): string {
    const translated = $_(key);
    return translated === key ? fallback : translated;
  }

  function getAuthoritySections(breakdown?: AuthorityBreakdown) {
    return [
      {
        label: $_('tokenStats.inputTokens'),
        entries: getAuthorityEntries(breakdown?.input)
      },
      {
        label: $_('tokenStats.outputTokens'),
        entries: getAuthorityEntries(breakdown?.output)
      }
    ].filter(section => section.entries.length > 0);
  }

  $: hasData = stats && stats.data && stats.data.length > 0;
  $: authoritySections = getAuthoritySections(stats?.authorityBreakdown);
  $: providerLabel = translateOrFallback('tokenStats.dimension.provider', 'Provider');
  $: logicalRequestsLabel = translateOrFallback('tokenStats.logicalRequests', 'Logical Requests');
  $: upstreamAttemptsLabel = translateOrFallback('tokenStats.upstreamAttempts', 'Upstream Attempts');

  $: chartData = {
    labels: stats?.data?.map(d => truncateLabel(d.dimension)) || [],
    datasets: [
      {
        label: $_('tokenStats.inputTokens'),
        data: stats?.data?.map(d => d.inputTokens) || [],
        backgroundColor: 'rgba(59, 130, 246, 0.8)',
        borderColor: 'rgba(59, 130, 246, 1)',
        borderWidth: 1
      },
      {
        label: $_('tokenStats.outputTokens'),
        data: stats?.data?.map(d => d.outputTokens) || [],
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
      legend: createLegendConfig($chartTheme.textColor, {
        position: 'top',
        padding: 8,
        fontSize: 10
      }),
      tooltip: createTooltipConfig('index', false)
    }
  } as ChartOptions<'bar'>;
</script>

<div class="w-full h-full flex flex-col p-2">
  <!-- 标题行：与监控图表样式一致 -->
  <div class="flex items-center justify-between mb-3">
    <h3 class="text-base font-semibold">{$_('tokenStats.chartTitle')}</h3>
    <!-- 维度选择器 -->
    <div class="flex gap-0.5">
      <button
        class="btn btn-xs h-6 min-h-6 px-2"
        class:btn-primary={selectedDimension === 'all'}
        class:btn-ghost={selectedDimension !== 'all'}
        on:click={() => selectedDimension = 'all'}
      >
        {$_('tokenStats.dimension.all')}
      </button>
      <button
        class="btn btn-xs h-6 min-h-6 px-2"
        class:btn-primary={selectedDimension === 'route'}
        class:btn-ghost={selectedDimension !== 'route'}
        on:click={() => selectedDimension = 'route'}
      >
        {$_('tokenStats.dimension.route')}
      </button>
      <button
        class="btn btn-xs h-6 min-h-6 px-2"
        class:btn-primary={selectedDimension === 'upstream'}
        class:btn-ghost={selectedDimension !== 'upstream'}
        on:click={() => selectedDimension = 'upstream'}
      >
        {$_('tokenStats.dimension.upstream')}
      </button>
      <button
        class="btn btn-xs h-6 min-h-6 px-2"
        class:btn-primary={selectedDimension === 'provider'}
        class:btn-ghost={selectedDimension !== 'provider'}
        on:click={() => selectedDimension = 'provider'}
      >
        {providerLabel}
      </button>
    </div>
  </div>

  {#if loading && !stats}
    <div class="flex-1 flex items-center justify-center">
      <span class="loading loading-spinner loading-md"></span>
    </div>
  {:else if error}
    <div class="alert alert-error text-xs py-1">
      <span>{error}</span>
    </div>
  {:else if stats}
    {#if selectedDimension === 'all'}
      <!-- 全部汇总视图：显示大数字卡片 -->
      <div class="flex-1 flex items-center justify-center">
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 text-center w-full">
          <div>
            <div class="text-3xl font-bold text-info">{formatNumber(stats.totalInputTokens)}</div>
            <div class="text-xs text-gray-500 mt-1">{$_('tokenStats.totalInput')}</div>
          </div>
          <div>
            <div class="text-3xl font-bold text-success">{formatNumber(stats.totalOutputTokens)}</div>
            <div class="text-xs text-gray-500 mt-1">{$_('tokenStats.totalOutput')}</div>
          </div>
          <div>
            <div class="text-3xl font-bold text-primary">{formatNumber(stats.logicalRequests)}</div>
            <div class="text-xs text-gray-500 mt-1">{logicalRequestsLabel}</div>
          </div>
          <div>
            <div class="text-3xl font-bold text-warning">{formatNumber(stats.upstreamAttempts)}</div>
            <div class="text-xs text-gray-500 mt-1">{upstreamAttemptsLabel}</div>
          </div>
        </div>
      </div>
      {#if authoritySections.length > 0}
        <div class="mt-3 flex flex-col gap-2 text-xs">
          {#each authoritySections as section}
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-medium">{section.label}</span>
              {#each section.entries as [authority, value]}
                <span class="badge badge-outline gap-1">
                  <span>{authority}</span>
                  <b>{formatNumber(value)}</b>
                </span>
              {/each}
            </div>
          {/each}
        </div>
      {/if}
    {:else}
      <!-- 统计摘要 -->
      <div class="flex flex-wrap gap-3 mb-2 text-xs">
        <span class="text-info">{$_('tokenStats.totalInput')}: <b>{formatNumber(stats.totalInputTokens)}</b></span>
        <span class="text-success">{$_('tokenStats.totalOutput')}: <b>{formatNumber(stats.totalOutputTokens)}</b></span>
        <span class="text-primary">{logicalRequestsLabel}: <b>{formatNumber(stats.logicalRequests)}</b></span>
        <span class="text-warning">{upstreamAttemptsLabel}: <b>{formatNumber(stats.upstreamAttempts)}</b></span>
      </div>
      {#if authoritySections.length > 0}
        <div class="flex flex-col gap-2 mb-2 text-xs">
          {#each authoritySections as section}
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-medium">{section.label}</span>
              {#each section.entries as [authority, value]}
                <span class="badge badge-ghost gap-1">
                  <span>{authority}</span>
                  <b>{formatNumber(value)}</b>
                </span>
              {/each}
            </div>
          {/each}
        </div>
      {/if}
      <!-- 图表或空状态 -->
      {#if hasData}
        <div class="flex-1 min-h-0">
          <Bar data={chartData} options={chartOptions} />
        </div>
      {:else}
        <div class="flex-1 flex items-center justify-center text-gray-400 text-sm">
          {$_('tokenStats.noData')}
        </div>
      {/if}
    {/if}
  {/if}
</div>
