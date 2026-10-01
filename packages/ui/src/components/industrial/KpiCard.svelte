<!-- Existing KPI chassis, with optional dashboard controls and trend context. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import CornerBrackets from './CornerBrackets.svelte';
  import KpiTrendValue from './KpiTrendValue.svelte';
  let { label, value = null, valueTitle = '', unit = '', trend = null, trendChange, trendLabel = '', trendCaption = 'TREND:',
    trendTitle = '', trendDirection = 'up', tone = 'auto', stripe = 'orange', href = null,
    corners = true, class: extraClass = '', leading, 'icon-head': iconHead, icon, foot,
    children, headerClass = '', bodyInert = false, fillHeight = false, reserveFooter = false, 'data-testid': testId }:
    { label: string; value?: string | number | null; valueTitle?: string; unit?: string; href?: string | null;
      tone?: 'auto' | 'ok' | 'warn' | 'danger' | 'accent'; stripe?: 'orange' | 'amber' | 'red' | 'emerald' | 'zinc';
      trend?: number | null; trendLabel?: string; trendCaption?: string; trendTitle?: string; trendDirection?: 'up' | 'down';
      trendChange?: 'up' | 'down' | 'flat';
      corners?: boolean; class?: string; leading?: Snippet; 'icon-head'?: Snippet; icon?: Snippet;
      foot?: Snippet; children?: Snippet; headerClass?: string; bodyInert?: boolean; fillHeight?: boolean; reserveFooter?: boolean; 'data-testid'?: string } = $props();
  const toneClass = { auto: 'text-zinc-50', ok: 'text-emerald-400', warn: 'text-amber-400', danger: 'text-red-400', accent: 'text-nexus-400' };
  const stripeClass = { orange: 'nx-stripe', amber: 'nx-stripe nx-stripe-amber', red: 'nx-stripe nx-stripe-red', emerald: 'nx-stripe nx-stripe-emerald', zinc: 'nx-stripe nx-stripe-zinc' };
  const trendText = $derived(trendLabel || (trend != null ? `${trend >= 0 ? '+' : ''}${trend.toFixed(1)}%` : ''));
  const change = $derived(trendChange ?? (trend == null ? null : trend > 0 ? 'up' : trend < 0 ? 'down' : 'flat'));
  const outerClass = $derived(`nx-panel-raised ${corners ? 'nx-bracketed' : ''} ${fillHeight ? 'kpi-fill' : ''} ${extraClass}`);
</script>

{#snippet contents()}
  {#if corners}<CornerBrackets />{/if}
  <header class="kpi-header nx-panel-head shrink-0 {headerClass}">
    {#if leading}{@render leading()}{/if}
    <div class="nx-panel-head-title min-w-0 flex-1">
      <span class={stripeClass[stripe]} aria-hidden="true"></span>
      <span class="truncate" title={label}>{label}</span>
    </div>
    {#if iconHead}{@render iconHead()}{/if}
  </header>
  <div class="kpi-body nx-panel-body min-h-0" class:has-footer={!!foot || !!trendText} class:has-reserved-footer={reserveFooter} class:editing={bodyInert} inert={bodyInert}>
    {#if children}{@render children()}{:else}
    <div class="kpi-metric-row flex items-baseline justify-between gap-3">
      <div class="kpi-metric-group flex min-w-0 items-baseline gap-1.5">
        <span class="kpi-value nx-metric {toneClass[tone]}" title={valueTitle || undefined}>{value ?? '—'}</span>
        {#if unit}<span class="kpi-unit nx-label">{unit}</span>{/if}
      </div>
      {#if icon}<div class="kpi-icon flex shrink-0 items-center">{@render icon()}</div>{/if}
    </div>
    {/if}
  </div>
  {#if foot}
    <footer class="kpi-footer border-t border-carbon-600" inert={bodyInert}>{@render foot()}</footer>
  {:else if trendText}
    <footer class="kpi-footer kpi-trend border-t border-carbon-600 flex flex-wrap items-center gap-x-1.5 gap-y-0.5" title={`${trendText} ${trendCaption} ${trendTitle}`} data-testid="kpi-trend" inert={bodyInert}>
      <KpiTrendValue value={trendText} {change} direction={trendDirection} clamp={fillHeight} />
      {#if trendCaption}<span class="nx-label-sm">{trendCaption}</span>{/if}
    </footer>
  {:else if reserveFooter}
    <footer class="kpi-footer" aria-hidden="true"></footer>
  {/if}
{/snippet}
{#if href}<a {href} class="block no-underline {outerClass}" data-testid={testId}>{@render contents()}</a>
{:else}<article class={outerClass} data-testid={testId}>{@render contents()}</article>{/if}

<style>
  .kpi-body.has-footer { padding-bottom: 8px; }
  .kpi-footer { margin: 0 16px 16px; padding-top: 4px; }
  .kpi-fill { display: flex; flex-direction: column; }
  .kpi-fill .kpi-header { height: 42px; padding-block: 0; }
  .kpi-fill .kpi-body { flex: 1; display: flex; align-items: center; padding-bottom: 16px; }
  .kpi-fill .kpi-body.has-reserved-footer { padding-block: 8px; }
  .kpi-fill .kpi-metric-row { width: 100%; }
  .kpi-fill .kpi-footer { flex: 0 0 32px; margin-bottom: 0; padding-top: 0; align-content: center; overflow: hidden; }
  .kpi-value { white-space: nowrap; }
  @container (max-width: 260px) {
    .kpi-value { font-size: 24px; }
    .kpi-metric-group { flex-wrap: wrap; }
    .kpi-unit { letter-spacing: .06em; }
  }
  @container (max-width: 190px) {
    .kpi-fill .nx-panel-body { padding: 8px 12px; }
    .kpi-fill .kpi-footer { margin-inline: 12px; }
    .kpi-metric-row { flex-wrap: wrap; gap: 4px; }
    .kpi-metric-group { flex-basis: 100%; flex-wrap: wrap; gap: 3px; }
    .kpi-value { font-size: 20px; }
    .kpi-unit { font-size: 9px; }
    .kpi-trend span { line-height: 1.25; }
    .kpi-icon { width: 100%; height: 18px; justify-content: flex-end; }
    .kpi-icon :global(svg) { height: 18px; }
  }
</style>
