<!--
  HealthSummary — Single-line health indicator (status dot + uppercase label).
  Used in ServicesIndex / ServiceEditor / dashboard rows. Localized labels
  distinguish unavailable observations and mixed worker states from health.

  API preserved:
    aggregate: ServiceHealthAggregate (required)
    showLabel: boolean (default true)
    className: extra classes appended
-->
<script lang="ts">
  import { _ } from '$i18n';
  import type { ServiceHealthAggregate } from '$utils/route-service-view-model';
  import StatusDot from '$components/industrial/StatusDot.svelte';

  let { aggregate, showLabel = true, className = '' }: { aggregate: ServiceHealthAggregate; showLabel?: boolean; className?: string } = $props();

  const statusByState: Record<ServiceHealthAggregate['state'], 'ok' | 'warn' | 'danger' | 'idle' | 'accent'> = {
    healthy: 'ok',
    degraded: 'warn',
    mixed: 'warn',
    unknown: 'idle',
    unhealthy: 'danger',
    neutral: 'idle',
    empty: 'idle',
  };

  const textClassByState: Record<ServiceHealthAggregate['state'], string> = {
    healthy: 'text-emerald-300',
    degraded: 'text-amber-300',
    mixed: 'text-amber-300',
    unknown: 'text-zinc-400',
    unhealthy: 'text-red-300',
    neutral: 'text-zinc-500',
    empty: 'text-zinc-500',
  };

  /** Short, localized labels; never expose the wire enum as display copy. */
  function getStateLabel(state: ServiceHealthAggregate['state']): string {
    switch (state) {
      case 'healthy':   return $_('upstreamsModal.statusHealthy');
      case 'degraded':  return $_('upstreamsModal.statusHalfOpen');
      case 'mixed':     return $_('runtime.mixed');
      case 'unknown':   return $_('upstreamsModal.statusUnknown');
      case 'unhealthy': return $_('upstreamsModal.statusUnhealthy');
      case 'neutral':   return $_('runtime.notApplicable');
      case 'empty':     return $_('healthSummary.empty');
    }
  }

  /** Tooltip keeps localized verbose breakdown (still useful for ops). */
  function getTooltipContent(agg: ServiceHealthAggregate): string {
    if (agg.state === 'empty') return $_('healthSummary.empty');
    const parts: string[] = [];
    if (agg.healthy > 0) parts.push(`${$_('upstreamsModal.statusHealthy')}: ${agg.healthy}`);
    if (agg.halfOpen > 0) parts.push(`${$_('upstreamsModal.statusHalfOpen')}: ${agg.halfOpen}`);
    if (agg.mixed > 0) parts.push(`${$_('runtime.mixed')}: ${agg.mixed}`);
    if (agg.unknown > 0) parts.push(`${$_('upstreamsModal.statusUnknown')}: ${agg.unknown}`);
    if (agg.unhealthy > 0) parts.push(`${$_('upstreamsModal.statusUnhealthy')}: ${agg.unhealthy}`);
    if (agg.disabled > 0) parts.push(`${$_('upstream.disabled')}: ${agg.disabled}`);
    return parts.join(', ') || $_('upstreamsModal.statusUnknown');
  }
</script>

<div
  class="inline-flex items-center gap-2 {className}"
  title={getTooltipContent(aggregate)}
  data-testid="health-summary"
>
  <StatusDot status={statusByState[aggregate.state]} />
  {#if showLabel}
    <span
      class="font-mono text-[11px] uppercase tracking-command {textClassByState[aggregate.state]}"
      data-testid="health-label"
    >
      {getStateLabel(aggregate.state)}
    </span>
    {#if aggregate.total > 0 && aggregate.state !== 'empty'}
      <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
        · {aggregate.healthy}/{aggregate.total}
      </span>
    {/if}
  {/if}
</div>
