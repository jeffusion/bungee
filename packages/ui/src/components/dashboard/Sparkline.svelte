<script lang="ts">
  let { values, tone = 'orange' }: { values: number[]; tone?: 'orange' | 'sky' | 'emerald' | 'red' } = $props();
  const points = $derived.by(() => {
    const samples = values.filter(Number.isFinite);
    const lo = Math.min(...samples), hi = Math.max(...samples), spread = hi - lo || 1;
    return values.map((value, i) => Number.isFinite(value)
      ? `${i === 0 || !Number.isFinite(values[i - 1]) ? 'M' : 'L'}${i / Math.max(1, values.length - 1) * 100},${36 - (value - lo) / spread * 28}`
      : '').join(' ');
  });
</script>
{#if values.length > 1}
  <svg viewBox="0 0 100 44" preserveAspectRatio="none" class="dashboard-sparkline h-11 min-w-0 w-16 shrink-0" aria-hidden="true"
    class:text-nexus-500={tone === 'orange'} class:text-sky-400={tone === 'sky'} class:text-emerald-500={tone === 'emerald'} class:text-red-500={tone === 'red'}>
    {#if values.every(Number.isFinite)}<path d={`${points} L100,44 L0,44 Z`} fill="currentColor" opacity=".08" />{/if}<path d={points} fill="none" stroke="currentColor" stroke-width="1.4" vector-effect="non-scaling-stroke" />
  </svg>
{/if}
<style>@container (max-width: 250px) { .dashboard-sparkline { width: 36px; height: 32px; } }</style>
