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
    type ChartOptions,
    type Plugin
  } from 'chart.js';
  import { chartTheme } from '$stores/chartTheme';
  import { createTitleConfig, createLegendConfig, createTooltipConfig, createScaleConfig } from '$utils/chartConfig';

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

  // Status code family → industrial palette token (§2.1):
  // 2xx=healthy emerald · 3xx=info sky · 4xx=caution amber · 5xx=fault red.
  // Using solid hex (no 0.8 alpha) for the hard-edge industrial look — chart bars
  // are hardware indicators, not translucent WebGL overlays.
  const SERIES = [
    { key: 'status2xx', label: '2xx', color: '#10b981' },
    { key: 'status3xx', label: '3xx', color: '#38bdf8' },
    { key: 'status4xx', label: '4xx', color: '#f59e0b' },
    { key: 'status5xx', label: '5xx', color: '#ef4444' }
  ] as const;

  // Row caption — hostname drawn ABOVE each row in DM Mono uppercase with chiseled
  // tracking, matching the canonical nx-label spec from §4.2. Canvas does not see
  // CSS classes so we inline the equivalent type properties.
  // Binary-search truncation + ellipsis when text overflows chartArea width.
  const rowCaptionPlugin: Plugin<'bar'> = {
    id: 'rowCaptions',
    afterDatasetsDraw(chart) {
      const { ctx, data, chartArea } = chart;
      if (!data.labels || data.labels.length === 0) return;

      const meta = chart.getDatasetMeta(0);
      if (!meta?.data || meta.data.length === 0) return;

      ctx.save();

      const captionGap = 6;
      const maxLabelWidth = chartArea.right - chartArea.left;
      // nx-label spec: DM Mono · 10px · uppercase · tracking-chiseled · zinc-500
      ctx.font = '600 10px "DM Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace';
      // tracking-chiseled = 0.16em = 1.6px at 10px font size
      ctx.letterSpacing = '1.6px';

      meta.data.forEach((bar: any, index: number) => {
        const label = data.labels[index] as string;
        if (!label) return;

        const x = chartArea.left + 2;
        const y = bar.y - bar.height / 2 - captionGap;

        let displayLabel = label.toUpperCase();
        if (ctx.measureText(displayLabel).width > maxLabelWidth) {
          let lo = 0, hi = displayLabel.length;
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (ctx.measureText(displayLabel.slice(0, mid) + '…').width <= maxLabelWidth) lo = mid;
            else hi = mid - 1;
          }
          displayLabel = displayLabel.slice(0, lo) + '…';
        }

        // zinc-500 = #71717a per §2.1 table
        ctx.fillStyle = '#71717a';
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'left';
        ctx.fillText(displayLabel, x, y);
      });

      ctx.restore();
    }
  };

  // Per-row height budget: host count overflow → outer PanelCard body scrolls
  // instead of squeezing rows. ROW_HEIGHT_PX accounts for the caption above each
  // bar + the bar itself + inter-row gap.
  const ROW_HEIGHT_PX = 40;
  const CHROME_HEIGHT_PX = 80;
  $: minContentHeight = CHROME_HEIGHT_PX + Math.max(1, data.length) * ROW_HEIGHT_PX;

  $: chartData = {
    labels: data.map(d => d.label),
    datasets: SERIES.map(s => ({
      label: s.label,
      data: data.map(d => (d as any)[s.key]),
      backgroundColor: s.color,
      borderColor: s.color,
      // Hard-edge industrial bars (§2.3 / §6.2 never soft): zero border outline,
      // thin barPercentage gives the precision-instrument look.
      borderWidth: 0,
      barPercentage: 0.18,
      categoryPercentage: 0.85
    }))
  } as ChartData<'bar', number[], unknown>;

  $: chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: 'y' as const,
    scales: {
      x: {
        ...createScaleConfig($chartTheme.textColor, $chartTheme.gridColor, {
          stacked: true,
          beginAtZero: true,
          fontSize: 10
        }),
        ticks: {
          font: { family: '"DM Mono", ui-monospace, monospace', size: 10 },
          color: '#71717a'
        },
        grid: {
          color: 'rgba(42, 47, 58, 0.6)',
          drawTicks: false
        },
        // carbon-600 edge per §2.1 / §2.3 hard-edge
        border: { color: '#2a2f3a' }
      },
      y: {
        stacked: true,
        ticks: { display: false },
        grid: { display: false },
        border: { display: false }
      }
    },
    plugins: {
      title: { display: false },
      legend: {
        display: true,
        position: 'top',
        labels: {
          color: '#d4d4d8',
          font: {
            family: '"DM Mono", ui-monospace, monospace',
            size: 11,
            weight: '600' as const
          },
          // Hard-edge rectangle swatch (§6.2: no rounded legend dots).
          // 10×2 bar matches the panel-stripe geometry.
          boxWidth: 10,
          boxHeight: 2,
          usePointStyle: false,
          padding: 14
        }
      },
      tooltip: {
        ...createTooltipConfig('index', false),
        axis: 'y' as const,
        // Industrial tooltip — carbon-950 bg, carbon-500 border, DM Mono numerics
        backgroundColor: 'rgba(10, 11, 14, 0.95)',
        borderColor: '#373d4a',
        borderWidth: 1,
        titleColor: '#f4f4f5',
        titleFont: { family: '"DM Mono", monospace', size: 10, weight: '600' as const },
        bodyColor: '#d4d4d8',
        bodyFont: { family: '"DM Mono", monospace', size: 11 },
        padding: 10,
        cornerRadius: 2,
        displayColors: true,
        boxWidth: 8,
        boxHeight: 8,
        boxPadding: 4
      }
    }
  } as ChartOptions<'bar'>;
</script>

<div class="w-full" style="height: {minContentHeight}px; min-height: 100%;">
  <Bar data={chartData} options={chartOptions} plugins={[rowCaptionPlugin]} />
</div>
