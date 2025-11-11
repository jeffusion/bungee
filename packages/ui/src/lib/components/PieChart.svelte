<script lang="ts">
  import { onMount } from 'svelte';
  import { Chart, ArcElement, Tooltip, Legend, DoughnutController } from 'chart.js';

  Chart.register(ArcElement, Tooltip, Legend, DoughnutController);

  export let data: Array<{ label: string; value: number; percentage: number }> = [];
  export let title: string = '';

  let canvas: HTMLCanvasElement;
  let chart: Chart | null = null;

  $: if (chart && data) {
    updateChart();
  }

  onMount(() => {
    createChart();
    return () => {
      if (chart) {
        chart.destroy();
      }
    };
  });

  function createChart() {
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    chart = new Chart(ctx, {
      type: 'doughnut',
      data: {
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
          borderColor: 'rgba(0, 0, 0, 0.1)',
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: !!title,
            text: title,
            font: {
              size: 16,
              weight: 'bold'
            }
          },
          legend: {
            position: 'right',
            labels: {
              padding: 10,
              font: { size: 11 },
              generateLabels: (chart) => {
                const datasets = chart.data.datasets;
                return chart.data.labels?.map((label, i) => ({
                  text: `${label} (${data[i]?.percentage || 0}%)`,
                  fillStyle: datasets[0].backgroundColor?.[i] as string,
                  hidden: false,
                  index: i
                })) || [];
              }
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
      }
    });
  }

  function updateChart() {
    if (!chart) return;

    chart.data.labels = data.map(d => d.label);
    chart.data.datasets[0].data = data.map(d => d.value);
    chart.update();
  }
</script>

<div class="w-full h-full">
  <canvas bind:this={canvas}></canvas>
</div>
