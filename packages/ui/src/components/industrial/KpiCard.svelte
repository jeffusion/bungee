<!-- Existing KPI chassis, with optional dashboard controls and trend context. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import CornerBrackets from './CornerBrackets.svelte';
  let { label, value = null, unit = '', trend = null, trendLabel = '', trendCaption = 'TREND:',
    trendTitle = '', trendDirection = 'up', tone = 'auto', stripe = 'orange', href = null,
    corners = true, class: extraClass = '', leading, 'icon-head': iconHead, icon, foot,
    headerClass = '', bodyInert = false, 'data-testid': testId }:
    { label: string; value?: string | number | null; unit?: string; href?: string | null;
      tone?: 'auto' | 'ok' | 'warn' | 'danger' | 'accent'; stripe?: 'orange' | 'amber' | 'red' | 'emerald' | 'zinc';
      trend?: number | null; trendLabel?: string; trendCaption?: string; trendTitle?: string; trendDirection?: 'up' | 'down';
      corners?: boolean; class?: string; leading?: Snippet; 'icon-head'?: Snippet; icon?: Snippet;
      foot?: Snippet; headerClass?: string; bodyInert?: boolean; 'data-testid'?: string } = $props();
  const toneClass = { auto: 'text-zinc-50', ok: 'text-emerald-400', warn: 'text-amber-400', danger: 'text-red-400', accent: 'text-nexus-400' };
  const stripeClass = { orange: 'nx-stripe', amber: 'nx-stripe nx-stripe-amber', red: 'nx-stripe nx-stripe-red', emerald: 'nx-stripe nx-stripe-emerald', zinc: 'nx-stripe nx-stripe-zinc' };
  const trendText = $derived(trendLabel || (trend != null ? `${trend >= 0 ? '+' : ''}${trend.toFixed(1)}%` : ''));
  const trendToneClass = $derived(trend == null ? 'text-zinc-500' : trend === 0 ? 'text-zinc-400' :
    (trendDirection === 'down' ? trend < 0 : trend > 0) ? 'text-emerald-400' : 'text-red-400');
  const outerClass = $derived(`nx-panel-raised ${corners ? 'nx-bracketed' : ''} ${extraClass}`);
</script>

{#snippet contents()}
  {#if corners}<CornerBrackets />{/if}
  <header class="nx-panel-head shrink-0 {headerClass}">
    {#if leading}{@render leading()}{/if}
    <div class="nx-panel-head-title min-w-0 flex-1">
      <span class={stripeClass[stripe]} aria-hidden="true"></span>
      <span class="truncate" title={label}>{label}</span>
    </div>
    {#if iconHead}{@render iconHead()}{/if}
  </header>
  <div class="nx-panel-body space-y-2 min-h-0" class:editing={bodyInert} inert={bodyInert}>
    <div class="kpi-metric-row flex items-baseline justify-between gap-3">
      <div class="kpi-metric-group flex min-w-0 items-baseline gap-1.5">
        <span class="kpi-value nx-metric {toneClass[tone]}">{value ?? '—'}</span>
        {#if unit}<span class="kpi-unit nx-label">{unit}</span>{/if}
      </div>
      {#if icon}<div class="kpi-icon flex shrink-0 items-center">{@render icon()}</div>{/if}
    </div>
    {#if foot}
      <div class="pt-1 border-t border-carbon-600">{@render foot()}</div>
    {:else if trendText}
      <div class="kpi-trend pt-1 border-t border-carbon-600 flex flex-wrap items-center gap-x-1.5 gap-y-0.5" title={trendTitle} data-testid="kpi-trend">
        <span class="font-mono text-[10px] uppercase tracking-command {trendToneClass}">{trend != null ? trend > 0 ? '↑' : trend < 0 ? '↓' : '→' : ''} {trendText}</span>
        <span class="nx-label-sm">{trendCaption}</span>
      </div>
    {/if}
  </div>
{/snippet}
{#if href}<a {href} class="block no-underline {outerClass}" data-testid={testId}>{@render contents()}</a>
{:else}<article class={outerClass} data-testid={testId}>{@render contents()}</article>{/if}

<style>
  .kpi-value { white-space: nowrap; }
  @container (max-width: 260px) {
    .kpi-value { font-size: 24px; }
    .kpi-metric-group { flex-wrap: wrap; }
    .kpi-unit { letter-spacing: .06em; }
  }
  @container (max-width: 190px) {
    .nx-panel-body { padding: 8px 12px; }
    .nx-panel-body.editing { padding-block: 3px; }
    .kpi-metric-row { flex-wrap: wrap; gap: 4px; }
    .kpi-metric-group { flex-basis: 100%; flex-wrap: wrap; gap: 3px; }
    .kpi-value { font-size: 20px; }
    .kpi-unit { font-size: 9px; }
    .kpi-trend { margin-top: 4px !important; padding-top: 2px; }
    .kpi-trend span { line-height: 1.25; }
    .kpi-icon { width: 100%; height: 18px; justify-content: flex-end; }
    .kpi-icon :global(svg) { height: 18px; }
  }
</style>
