<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Bar } from 'svelte-chartjs';
  import {
    Chart as ChartJS,
    BarElement,
    CategoryScale,
    LinearScale,
    Tooltip,
    Legend,
    type ChartData,
    type ChartOptions
  } from 'chart.js';
  import { chartTheme } from '../stores/chartTheme';
  import { createTitleConfig, createLegendConfig, createScaleConfig, createTooltipConfig } from '../utils/chartConfig';

  ChartJS.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend);

  export let data: Array<{
    label: string;
    status2xx: number;
    status3xx: number;
    status4xx: number;
    status5xx: number;
  }> = [];
  export let title: string = '';

  onMount(() => {
    chartTheme.init();
  });

  onDestroy(() => {
    chartTheme.cleanup();
  });

  $: chartData = {
    labels: data.map(d => d.label),
    datasets: [
      {
        label: '2xx',
        data: data.map(d => d.status2xx),
        backgroundColor: 'rgba(16, 185, 129, 0.8)',
        borderColor: 'rgba(16, 185, 129, 1)',
        borderWidth: 1
      },
      {
        label: '3xx',
        data: data.map(d => d.status3xx),
        backgroundColor: 'rgba(59, 130, 246, 0.8)',
        borderColor: 'rgba(59, 130, 246, 1)',
        borderWidth: 1
      },
      {
        label: '4xx',
        data: data.map(d => d.status4xx),
        backgroundColor: 'rgba(245, 158, 11, 0.8)',
        borderColor: 'rgba(245, 158, 11, 1)',
        borderWidth: 1
      },
      {
        label: '5xx',
        data: data.map(d => d.status5xx),
        backgroundColor: 'rgba(239, 68, 68, 0.8)',
        borderColor: 'rgba(239, 68, 68, 1)',
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
      title: createTitleConfig(title, $chartTheme.textColor),
      legend: createLegendConfig($chartTheme.textColor, {
        position: 'top',
        padding: 15,
        fontSize: 11
      }),
      tooltip: createTooltipConfig('index', false)
    }
  } as ChartOptions<'bar'>;
</script>

<div class="w-full h-full">
  <Bar data={chartData} options={chartOptions} />
</div>
