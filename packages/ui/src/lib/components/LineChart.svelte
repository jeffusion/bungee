<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Line } from 'svelte-chartjs';
  import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend,
    type ChartData,
    type ChartOptions,
    type Plugin
  } from 'chart.js';
  import { chartTheme } from '../stores/chartTheme';
  import { createTitleConfig, createScaleConfig, createTooltipConfig } from '../utils/chartConfig';
  import { createChartSyncPlugin } from '../utils/chartSyncPlugin';

  // 注册 Chart.js 组件
  ChartJS.register(
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend
  );

  export let title: string;
  export let labels: string[];
  export let datasets: Array<{
    label: string;
    data: number[];
    borderColor?: string;
    backgroundColor?: string;
    tension?: number;
  }>;
  export let yAxisLabel: string = '';
  export let syncGroup: string | undefined = undefined; // 联动组名称（可选）

  onMount(() => {
    chartTheme.init();
  });

  onDestroy(() => {
    chartTheme.cleanup();
  });

  $: chartData = {
    labels,
    datasets: datasets.map(dataset => ({
      ...dataset,
      borderColor: dataset.borderColor || 'rgb(75, 192, 192)',
      backgroundColor: dataset.backgroundColor || 'rgba(75, 192, 192, 0.2)',
      tension: dataset.tension ?? 0.4,
    }))
  } as ChartData<'line', number[], unknown>;

  $: chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: datasets.length > 1,
        position: 'top' as const,
        labels: {
          color: $chartTheme.textColor
        }
      },
      title: createTitleConfig(title, $chartTheme.textColor, true),
      tooltip: createTooltipConfig('index', false)
    },
    scales: {
      y: createScaleConfig($chartTheme.textColor, $chartTheme.gridColor, {
        beginAtZero: true,
        title: yAxisLabel ? {
          display: true,
          text: yAxisLabel
        } : undefined
      }),
      x: {
        ...createScaleConfig($chartTheme.textColor, $chartTheme.gridColor),
        ticks: {
          maxRotation: 45,
          minRotation: 0,
          autoSkip: true,
          maxTicksLimit: 10,
          color: $chartTheme.textColor
        }
      }
    },
    interaction: {
      mode: 'index' as const,
      axis: 'x' as const,
      intersect: false
    }
  } as ChartOptions<'line'>;

  // 创建插件数组（包含联动插件）
  $: chartPlugins = syncGroup ? [createChartSyncPlugin(syncGroup)] : [];
</script>

<div class="w-full h-full">
  <Line data={chartData} options={chartOptions} plugins={chartPlugins} />
</div>
