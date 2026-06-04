<!--
  KpiCard — A compact panel for a single headline metric.
  Reference layout: orange short bar + UPPERCASE LABEL on the top, big
  Orbitron-styled display number with unit subscript, optional trend row
  with delta + icon. Used in the dashboard KPI strip.

  Slots:
    icon → small icon shown on the right of the metric row
    foot → custom footer (overrides the auto trend row)
-->
<script lang="ts">
  import CornerBrackets from './CornerBrackets.svelte';

  /** Label shown at the top of the card (auto-uppercased visually). */
  export let label: string;

  /**
   * The main metric value. Pass formatted string (e.g. "99.9", "8,902",
   * "4.2"). For values that should look "blank", pass null/undefined and
   * the card will render a dash.
   */
  export let value: string | number | null | undefined = null;

  /** Optional unit suffix shown next to the value (e.g. "%", "MS", "REQ/S"). */
  export let unit: string = '';

  /**
   * Optional delta percentage shown in the trend row. Positive numbers
   * render with a "+" prefix and emerald tint; negative numbers render
   * red. Pass null to omit the trend row.
   */
  export let trend: number | null = null;

  /** Optional explicit trend label (overrides the auto-formatted percent). */
  export let trendLabel: string = '';

  /** Color tone of the value text. `auto` is zinc; pass an override for status. */
  export let tone: 'auto' | 'ok' | 'warn' | 'danger' | 'accent' = 'auto';

  /** Stripe color, defaults to primary. Use to mark fault/warning KPIs. */
  export let stripe: 'orange' | 'amber' | 'red' | 'emerald' | 'zinc' = 'orange';

  /** Optional href — when set, the card becomes a link. */
  export let href: string | null = null;

  /** Render corner brackets (defaults to true). */
  export let corners: boolean = true;

  let extraClass = '';
  export { extraClass as class };

  const toneClass = {
    auto: 'text-zinc-50',
    ok: 'text-emerald-400',
    warn: 'text-amber-400',
    danger: 'text-red-400',
    accent: 'text-nexus-400',
  } as const;

  const stripeClass = {
    orange: 'nx-stripe',
    amber: 'nx-stripe nx-stripe-amber',
    red: 'nx-stripe nx-stripe-red',
    emerald: 'nx-stripe nx-stripe-emerald',
    zinc: 'nx-stripe nx-stripe-zinc',
  } as const;

  $: trendText = trendLabel || (trend !== null && trend !== undefined
    ? `${trend >= 0 ? '+' : ''}${trend.toFixed(1)}%`
    : '');

  $: trendToneClass =
    trend === null || trend === undefined
      ? 'text-zinc-500'
      : trend > 0
        ? 'text-emerald-400'
        : trend < 0
          ? 'text-red-400'
          : 'text-zinc-400';

  $: outerClass = `nx-panel-raised ${corners ? 'nx-bracketed' : ''} ${extraClass}`;
</script>

{#if href}
  <a
    {href}
    class="block no-underline {outerClass}"
  >
    {#if corners}<CornerBrackets />{/if}
    <header class="nx-panel-head">
      <div class="nx-panel-head-title">
        <span class={stripeClass[stripe]} aria-hidden="true"></span>
        <span>{label}</span>
      </div>
      <slot name="icon-head" />
    </header>
    <div class="nx-panel-body space-y-2">
      <div class="flex items-baseline justify-between gap-3">
        <div class="flex items-baseline gap-1.5">
          <span class="nx-metric {toneClass[tone]}">{value ?? '—'}</span>
          {#if unit}<span class="nx-label">{unit}</span>{/if}
        </div>
        <slot name="icon" />
      </div>

      {#if $$slots.foot}
        <div class="pt-1 border-t border-carbon-600">
          <slot name="foot" />
        </div>
      {:else if trendText}
        <div class="pt-1 border-t border-carbon-600 flex items-center gap-1.5">
          <span class="nx-label-sm">TREND:</span>
          <span class="font-mono text-[10px] uppercase tracking-command {trendToneClass}">{trendText}</span>
        </div>
      {/if}
    </div>
  </a>
{:else}
  <article class={outerClass}>
    {#if corners}<CornerBrackets />{/if}
    <header class="nx-panel-head">
      <div class="nx-panel-head-title">
        <span class={stripeClass[stripe]} aria-hidden="true"></span>
        <span>{label}</span>
      </div>
      <slot name="icon-head" />
    </header>
    <div class="nx-panel-body space-y-2">
      <div class="flex items-baseline justify-between gap-3">
        <div class="flex items-baseline gap-1.5">
          <span class="nx-metric {toneClass[tone]}">{value ?? '—'}</span>
          {#if unit}<span class="nx-label">{unit}</span>{/if}
        </div>
        <slot name="icon" />
      </div>

      {#if $$slots.foot}
        <div class="pt-1 border-t border-carbon-600">
          <slot name="foot" />
        </div>
      {:else if trendText}
        <div class="pt-1 border-t border-carbon-600 flex items-center gap-1.5">
          <span class="nx-label-sm">TREND:</span>
          <span class="font-mono text-[10px] uppercase tracking-command {trendToneClass}">{trendText}</span>
        </div>
      {/if}
    </div>
  </article>
{/if}
