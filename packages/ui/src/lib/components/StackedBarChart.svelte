<script lang="ts">
  import { onMount } from 'svelte';
  import { Chart, BarElement, CategoryScale, LinearScale, Tooltip, Legend, BarController } from 'chart.js';

  Chart.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend, BarController);

  export let data: Array<{
    label: string;
    status2xx: number;
    status3xx: number;
    status4xx: number;
    status5xx: number;
  }> = [];
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
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            stacked: true,
            ticks: {
              font: { size: 10 },
              maxRotation: 45,
              minRotation: 45
            }
          },
          y: {
            stacked: true,
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
            mode: 'index',
            intersect: false
          }
        }
      }
    });
  }

  function updateChart() {
    if (!chart) return;

    chart.data.labels = data.map(d => d.label);
    chart.data.datasets[0].data = data.map(d => d.status2xx);
    chart.data.datasets[1].data = data.map(d => d.status3xx);
    chart.data.datasets[2].data = data.map(d => d.status4xx);
    chart.data.datasets[3].data = data.map(d => d.status5xx);
    chart.update();
  }
</script>

<div class="w-full h-full">
  <canvas bind:this={canvas}></canvas>
</div>
