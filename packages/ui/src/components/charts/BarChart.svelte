<script lang="ts">
  import { Bar } from 'svelte-chartjs';
  import {
    Chart as ChartJS,
    BarElement,
    CategoryScale,
    LinearScale,
    Tooltip,
    Legend,
    type Chart,
    type ChartData,
    type ChartOptions,
    type Plugin,
  } from 'chart.js';
  import type { HTMLAttributes } from 'svelte/elements';
  import { barSeriesColor } from './bar-colors';

  ChartJS.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend);

  const MONO = '"DM Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace';
  const GRID = 'rgba(42, 47, 58, 0.6)';
  const EDGE = '#2a2f3a';
  const MUTED = '#71717a';
  const BODY = '#d4d4d8';
  const TITLE = '#f4f4f5';

  let {
    data,
    options = {},
    plugins = [],
    chart = $bindable(null),
    ...canvasProps
  }: {
    data: ChartData<'bar'>;
    options?: ChartOptions<'bar'>;
    plugins?: Plugin<'bar'>[];
    chart?: Chart<'bar'> | null;
  } & HTMLAttributes<HTMLCanvasElement> = $props();

  // Merge only the nodes the industrial defaults own. Callers replace a node
  // wholesale (ticks/grid/labels included) when they need a different look.
  function withIndustrialDefaults(input: ChartOptions<'bar'>): ChartOptions<'bar'> {
    const horizontal = input.indexAxis === 'y';
    const category = {
      offset: true,
      ticks: {
        color: MUTED,
        font: { family: MONO, size: 10 },
        maxRotation: 45,
        autoSkip: true,
        maxTicksLimit: 10,
      },
      grid: { display: false },
      border: { color: EDGE },
    };
    const value = {
      beginAtZero: true,
      ticks: { color: MUTED, font: { family: MONO, size: 10 } },
      grid: { color: GRID, drawTicks: false },
      border: { color: EDGE },
    };
    const legend = {
      display: data.datasets.length > 1,
      position: 'top' as const,
      labels: {
        color: BODY,
        font: { family: MONO, size: 11, weight: '600' as const },
        boxWidth: 10,
        boxHeight: 2,
        usePointStyle: false,
        padding: 14,
      },
    };
    const tooltip = {
      mode: 'index' as const,
      intersect: false,
      axis: horizontal ? 'y' as const : 'x' as const,
      backgroundColor: 'rgba(10, 11, 14, 0.95)',
      borderColor: '#373d4a',
      borderWidth: 1,
      titleColor: TITLE,
      titleFont: { family: MONO, size: 10, weight: '600' as const },
      bodyColor: BODY,
      bodyFont: { family: MONO, size: 11 },
      padding: 10,
      cornerRadius: 2,
      displayColors: true,
      boxWidth: 8,
      boxHeight: 8,
      boxPadding: 4,
    };
    const inputPlugins = input.plugins ?? {};
    const inputLegend = inputPlugins.legend;
    const inputTooltip = inputPlugins.tooltip;
    const inputScales = input.scales ?? {};
    const scales = horizontal ? { x: value, y: category } : { x: category, y: value };

    return {
      responsive: true,
      maintainAspectRatio: false,
      ...input,
      plugins: {
        ...inputPlugins,
        legend: inputLegend === false ? false : { ...legend, ...inputLegend },
        tooltip: inputTooltip === false ? false : { ...tooltip, ...inputTooltip },
      },
      scales: {
        ...scales,
        ...inputScales,
        x: { ...scales.x, ...inputScales.x },
        y: { ...scales.y, ...inputScales.y },
      },
    } as ChartOptions<'bar'>;
  }

  const chartData = $derived({
    ...data,
    datasets: data.datasets.map((dataset, index) => ({
      ...dataset,
      borderWidth: dataset.borderWidth ?? 0,
      borderRadius: dataset.borderRadius ?? 0,
      inflateAmount: dataset.inflateAmount ?? 0,
      backgroundColor: dataset.backgroundColor ?? barSeriesColor(index),
    })),
  } as ChartData<'bar'>);

  const chartOptions = $derived(withIndustrialDefaults(options));
</script>

<Bar data={chartData} options={chartOptions} {plugins} bind:chart {...canvasProps} />
