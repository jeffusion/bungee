<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Doughnut } from 'svelte-chartjs';
  import {
    Chart as ChartJS,
    ArcElement,
    Tooltip,
    Legend,
    type ChartData,
    type ChartOptions
  } from 'chart.js';
  import { chartTheme } from '../stores/chartTheme';
  import { createTitleConfig } from '../utils/chartConfig';

  ChartJS.register(ArcElement, Tooltip, Legend);

  export let data: Array<{ label: string; value: number; percentage: number }> = [];
  export let title: string = '';

  onMount(() => {
    chartTheme.init();
  });

  onDestroy(() => {
    chartTheme.cleanup();
  });

  $: chartData = {
    labels: data.map(d => d.label),
    datasets: [{
      data: data.map(d => d.value),
      backgroundColor: [
        'rgba(59, 130, 246, 0.8)',   // blue
        'rgba(16, 185, 129, 0.8)',   // green
        'rgba(245, 158, 11, 0.8)',   // amber
        'rgba(239, 68, 68, 0.8)',    // red
        'rgba(168, 85, 247, 0.8)',   // purple
        'rgba(236, 72, 153, 0.8)',   // pink
        'rgba(20, 184, 166, 0.8)',   // teal
        'rgba(251, 146, 60, 0.8)',   // orange
        'rgba(132, 204, 22, 0.8)',   // lime
        'rgba(148, 163, 184, 0.8)',  // slate
      ],
      borderColor: $chartTheme.gridColor,
      borderWidth: 1
    }]
  } as ChartData<'doughnut', number[], unknown>;

  $: chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      title: createTitleConfig(title, $chartTheme.textColor),
      legend: {
        position: 'right' as const,
        labels: {
          padding: 10,
          font: { size: 11 },
          color: $chartTheme.textColor,
          generateLabels: (chart) => {
            const datasets = chart.data.datasets;
            const bgColors = datasets[0].backgroundColor as string[];
            const meta = chart.getDatasetMeta(0);
            return chart.data.labels?.map((label, i) => {
              const arc = meta.data[i];
              const isHidden = arc && typeof arc.hidden !== 'undefined' ? arc.hidden : false;
              return {
                text: `${label} (${data[i]?.percentage || 0}%)`,
                fillStyle: bgColors[i],
                strokeStyle: bgColors[i],
                fontColor: $chartTheme.textColor,
                hidden: isHidden,
                index: i,
                datasetIndex: 0
              };
            }) || [];
          }
        },
        onClick: (e, legendItem, legend) => {
          const index = legendItem.index;
          const chart = legend.chart;
          const meta = chart.getDatasetMeta(0);

          // Toggle visibility
          meta.data[index].hidden = !meta.data[index].hidden;
          chart.update();
        }
      },
      tooltip: {
        callbacks: {
          label: (context) => {
            const label = context.label || '';
            const value = context.parsed || 0;
            const percentage = data[context.dataIndex]?.percentage || 0;
            return `${label}: ${value} (${percentage}%)`;
          }
        }
      }
    }
  } as ChartOptions<'doughnut'>;
</script>

<div class="w-full h-full">
  <Doughnut data={chartData} options={chartOptions} />
</div>
