<script lang="ts">
  import { onMount } from 'svelte';
  import { Chart, BarElement, CategoryScale, LinearScale, Tooltip, Legend, BarController } from 'chart.js';

  Chart.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend, BarController);

  export let data: Array<{ label: string; success: number; failed: number; failureRate: number }> = [];
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
      type: 'bar',
      data: {
        labels: data.map(d => d.label),
        datasets: [
          {
            label: 'Success',
            data: data.map(d => d.success),
            backgroundColor: 'rgba(16, 185, 129, 0.8)',
            borderColor: 'rgba(16, 185, 129, 1)',
            borderWidth: 1
          },
          {
            label: 'Failed',
            data: data.map(d => d.failed),
            backgroundColor: 'rgba(239, 68, 68, 0.8)',
            borderColor: 'rgba(239, 68, 68, 1)',
            borderWidth: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            stacked: false,
            ticks: {
              font: { size: 10 },
              maxRotation: 45,
              minRotation: 45
            }
          },
          y: {
            stacked: false,
            beginAtZero: true,
            ticks: {
              font: { size: 11 }
            }
          }
        },
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
            position: 'top',
            labels: {
              padding: 15,
              font: { size: 11 }
            }
          },
          tooltip: {
            callbacks: {
              afterLabel: (context) => {
                const index = context.dataIndex;
                const failureRate = data[index]?.failureRate || 0;
                return `Failure Rate: ${failureRate}%`;
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
    chart.data.datasets[0].data = data.map(d => d.success);
    chart.data.datasets[1].data = data.map(d => d.failed);
    chart.update();
  }
</script>

<div class="w-full h-full">
  <canvas bind:this={canvas}></canvas>
</div>
