<script lang="ts">
  let { values, tone = 'orange' }: { values: number[]; tone?: 'orange' | 'sky' | 'emerald' | 'red' } = $props();
  const points = $derived.by(() => {
    const lo = Math.min(...values), hi = Math.max(...values), spread = hi - lo || 1;
    return values.map((value, i) => `${i / Math.max(1, values.length - 1) * 100},${36 - (value - lo) / spread * 28}`).join(' ');
  });
</script>
{#if values.length > 1}
  <svg viewBox="0 0 100 44" preserveAspectRatio="none" class="dashboard-sparkline h-11 min-w-0 w-16 shrink-0" aria-hidden="true"
    class:text-nexus-500={tone === 'orange'} class:text-sky-400={tone === 'sky'} class:text-emerald-500={tone === 'emerald'} class:text-red-500={tone === 'red'}>
    <polygon points={`0,44 ${points} 100,44`} fill="currentColor" opacity=".08" /><polyline {points} fill="none" stroke="currentColor" stroke-width="1.4" vector-effect="non-scaling-stroke" />
  </svg>
{/if}
<style>@container (max-width: 250px) { .dashboard-sparkline { width: 36px; height: 32px; } }</style>
