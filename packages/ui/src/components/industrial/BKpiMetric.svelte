<!-- Shared metric row for KpiCard and native plugin KPI bodies. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  let { value = null, valueTitle = '', unit = '', tone = 'auto', icon, valueTestId }:
    { value?: string | number | null; valueTitle?: string; unit?: string;
      tone?: 'auto' | 'ok' | 'warn' | 'danger' | 'accent'; icon?: Snippet; valueTestId?: string } = $props();
  const toneClass = { auto: 'text-zinc-50', ok: 'text-emerald-400', warn: 'text-amber-400', danger: 'text-red-400', accent: 'text-nexus-400' };
</script>

<div class="kpi-metric-row flex w-full min-w-0 items-baseline justify-between gap-3">
  <div class="kpi-metric-group flex min-w-0 items-baseline gap-1.5">
    <span class="kpi-value nx-metric {toneClass[tone]}" title={valueTitle || undefined} data-testid={valueTestId}>{value ?? '—'}</span>
    {#if unit}<span class="kpi-unit nx-label">{unit}</span>{/if}
  </div>
  {#if icon}<div class="kpi-icon flex shrink-0 self-center items-center">{@render icon()}</div>{/if}
</div>

<style>
  .kpi-value { white-space: nowrap; }
  @container (max-width: 260px) {
    .kpi-value { font-size: 24px; }
    .kpi-metric-group { flex-wrap: wrap; }
    .kpi-unit { letter-spacing: .06em; }
  }
  @container (max-width: 190px) {
    .kpi-metric-row { flex-wrap: wrap; gap: 4px; }
    .kpi-metric-group { flex-basis: 100%; flex-wrap: wrap; gap: 3px; }
    .kpi-value { font-size: 20px; }
    .kpi-unit { font-size: 9px; }
    .kpi-icon { width: 100%; height: 18px; justify-content: flex-end; }
    .kpi-icon :global(svg) { height: 18px; }
  }
</style>
