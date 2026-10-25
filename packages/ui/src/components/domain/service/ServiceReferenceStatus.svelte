<script lang="ts">
  import type { ServiceReference } from '@jeffusion/bungee-types';
  import type { Service } from '$api/routes';
  import { _, isLoading } from '$i18n';
  import { runtimeStatus } from '$api/runtime';
  import { runtimeUpstreams } from '$stores/runtime';
  import { StatusBadge } from '$components/industrial';
  import { getServiceHealthAggregate } from '$utils/route-service-view-model';

  let { reference, services }: { reference: ServiceReference; services: Service[] } = $props();
  const serviceHealthStatus = {
    healthy: runtimeStatus.HEALTHY,
    degraded: { badge: 'standby', key: 'serviceReferences.degraded' },
    mixed: runtimeStatus.MIXED,
    unknown: runtimeStatus.UNKNOWN,
    unhealthy: runtimeStatus.UNHEALTHY,
    neutral: { badge: 'muted', key: 'runtime.notApplicable' },
    empty: { badge: 'muted', key: 'healthSummary.empty' },
  } as const;
</script>

{#if !$isLoading}
  {#if reference.is_disabled}
    <StatusBadge variant="muted" dot>{$_('upstream.disabled')}</StatusBadge>
  {:else}
    {@const service = services.find(item => item._uid === reference.service_id)}
    {#if service}
      {@const aggregate = getServiceHealthAggregate(service, $runtimeUpstreams, services)}
      {@const status = serviceHealthStatus[aggregate.state]}
      <span class="inline-flex" title={$_('services.referenceHealthTooltip') + '\n' + $_('services.referenceHealthCounts', { values: { ...aggregate } })}>
        <StatusBadge variant={status.badge} dot>{$_(status.key)}</StatusBadge>
      </span>
    {:else}
      <StatusBadge variant="fault" dot>{$_('services.missingReference')}</StatusBadge>
    {/if}
  {/if}
{/if}
