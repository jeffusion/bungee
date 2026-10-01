<script lang="ts">
  let { value, change = null, direction = 'up', clamp = false }:
    { value: string; change?: 'up' | 'down' | 'flat' | null; direction?: 'up' | 'down'; clamp?: boolean } = $props();
  const tone = $derived(change == null ? 'text-zinc-500' : change === 'flat' ? 'text-zinc-400' :
    change === direction ? 'text-emerald-400' : 'text-red-400');
</script>

<span class="kpi-trend-value font-mono text-[10px] uppercase tracking-command {tone}" class:clamped={clamp}>{change === 'up' ? '↑' : change === 'down' ? '↓' : change === 'flat' ? '→' : ''} {value}</span>

<style>
  .clamped { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; line-height: 12px; }
</style>
