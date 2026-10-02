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
    Filler,
    type ScriptableContext,
    type ChartData,
    type ChartOptions
  } from 'chart.js';
  import { chartTheme } from '$stores/chartTheme';
  import { createTitleConfig, createScaleConfig, createTooltipConfig } from '$utils/chartConfig';
  import { createChartSyncPlugin } from '$utils/chartSyncPlugin';
  import ChartTooltip from './ChartTooltip.svelte';

  let tooltipContent: ReturnType<typeof ChartTooltip> | undefined;

  // 注册 Chart.js 组件
  ChartJS.register(
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend,
    Filler
  );

  let { title = '', labels, datasets, yAxisLabel = '', syncGroup, gradientFill = false }:
    { title?: string; labels: string[]; datasets: Array<{ label: string; data: number[];
      borderColor?: string; backgroundColor?: string; tension?: number }>;
      yAxisLabel?: string; syncGroup?: string; gradientFill?: boolean } = $props();

  function areaFill(color: string, context: ScriptableContext<'line'>) {
    const area = context.chart.chartArea;
    if (!area) return 'transparent';
    const gradient = context.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    // The dashboard supplies hex theme colors. Preserve a subtle fill for other callers.
    gradient.addColorStop(0, /^#[0-9a-f]{6}$/i.test(color) ? `${color}3d` : 'rgba(249,115,22,.15)');
    gradient.addColorStop(1, 'transparent');
    return gradient;
  }

  onMount(() => {
    chartTheme.init();
  });

  onDestroy(() => {
    chartTheme.cleanup();
  });

  const chartData = $derived({
    labels,
    datasets: datasets.map(dataset => ({
      ...dataset,
      borderColor: dataset.borderColor || 'rgb(75, 192, 192)',
      backgroundColor: gradientFill ? (context: ScriptableContext<'line'>) => areaFill(dataset.borderColor ?? '#f97316', context) : dataset.backgroundColor || 'rgba(75, 192, 192, 0.2)',
      fill: gradientFill,
      pointRadius: 3,
      pointHoverRadius: 4,
      pointBackgroundColor: dataset.borderColor || 'rgb(75, 192, 192)',
      tension: dataset.tension ?? 0.4,
    }))
  } as ChartData<'line', number[], unknown>);

  const chartOptions = $derived({
    responsive: true,
    maintainAspectRatio: false,
    // Keep data updates immediate; the shared HTML tooltip owns its animations.
    ...(gradientFill ? { datasets: { line: { animation: { duration: 0 } } } } : {}),
    plugins: {
      legend: {
        display: datasets.length > 1,
        position: 'top' as const,
        labels: {
          color: $chartTheme.textColor
        }
      },
      title: createTitleConfig(title, $chartTheme.textColor, true),
      tooltip: {
        ...createTooltipConfig('index', false),
        enabled: false,
        external: context => tooltipContent?.update(context),
      }
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
  } as ChartOptions<'line'>);

  // 创建插件数组（包含联动插件）
  const chartPlugins = $derived(syncGroup ? [createChartSyncPlugin(syncGroup)] : []);
</script>

<div class="w-full h-full">
  <Line data={chartData} options={chartOptions} plugins={chartPlugins} />
  <ChartTooltip bind:this={tooltipContent} unit={yAxisLabel} />
</div>
