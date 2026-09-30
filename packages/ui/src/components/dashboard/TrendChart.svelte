<script lang="ts">
  import LineChart from '$components/charts/LineChart.svelte';
  let { labels, values, label, tone = 'orange', unit = '' }:
    { labels: string[]; values: number[]; label: string; tone?: 'orange' | 'sky' | 'emerald' | 'red'; unit?: string } = $props();
  const palette = { orange: '#f97316', sky: '#38bdf8', emerald: '#10b981', red: '#ef4444' };
  const datasets = $derived([{ label, data: values, borderColor: palette[tone], tension: 0 }]);
</script>
<div class="min-h-0 h-full w-full" role="img" aria-label={label}>
  <LineChart {labels} {datasets} yAxisLabel={unit} syncGroup="dashboard-trends" gradientFill />
</div>
