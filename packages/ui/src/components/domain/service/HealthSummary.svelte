<!--
  HealthSummary — Single-line health indicator (status dot + uppercase label).
  Used in ServicesIndex / ServiceEditor / dashboard rows. The label maps to
  the canonical industrial vocabulary (HEALTHY / DEGRADED / FAULT / N/A /
  EMPTY) rather than the localized "健康" text — operators learn this
  vocabulary once and read it instantly on dashboards.

  API preserved:
    aggregate: ServiceHealthAggregate (required)
    showLabel: boolean (default true)
    className: extra classes appended
-->
<script lang="ts">
  import { _ } from '$i18n';
  import type { ServiceHealthAggregate } from '$utils/route-service-view-model';
  import StatusDot from '$components/industrial/StatusDot.svelte';

  export let aggregate: ServiceHealthAggregate;
  export let showLabel = true;
  export let className = '';

  const statusByState: Record<ServiceHealthAggregate['state'], 'ok' | 'warn' | 'danger' | 'idle' | 'accent'> = {
    healthy: 'ok',
    degraded: 'warn',
    unhealthy: 'danger',
    neutral: 'idle',
    empty: 'idle',
  };

  const textClassByState: Record<ServiceHealthAggregate['state'], string> = {
    healthy: 'text-emerald-300',
    degraded: 'text-amber-300',
    unhealthy: 'text-red-300',
    neutral: 'text-zinc-500',
    empty: 'text-zinc-500',
  };

  /** Canonical industrial labels — keep short, uppercase, English. */
  function getStateLabel(state: ServiceHealthAggregate['state']): string {
    switch (state) {
      case 'healthy':   return 'HEALTHY';
      case 'degraded':  return 'DEGRADED';
      case 'unhealthy': return 'FAULT';
      case 'neutral':   return 'N/A';
      case 'empty':     return 'EMPTY';
      default:          return 'UNKNOWN';
    }
  }

  /** Tooltip keeps localized verbose breakdown (still useful for ops). */
  function getTooltipContent(agg: ServiceHealthAggregate): string {
    if (agg.state === 'empty') return $_('healthSummary.empty');
    const parts: string[] = [];
    if (agg.healthy > 0) parts.push(`${$_('upstreamsModal.statusHealthy')}: ${agg.healthy}`);
    if (agg.halfOpen > 0) parts.push(`${$_('upstreamsModal.statusHalfOpen')}: ${agg.halfOpen}`);
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
