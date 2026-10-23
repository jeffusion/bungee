<script lang="ts">
  import type { ServiceReference } from '@jeffusion/bungee-types';
  import type { Service } from '$api/routes';
  import { _ } from '$i18n';
  import { BSwitch, IconButton } from '$components/industrial';
  import { NumberInput } from '$components/ui/number-input';
  import { Button } from '$components/ui/button';
  import HealthSummary from './HealthSummary.svelte';
  import RuntimeStatus from './RuntimeStatus.svelte';
  import { runtimeUpstreams } from '$stores/runtime';
  import { getServiceHealthAggregate } from '$utils/route-service-view-model';
  import RelationshipLink from './RelationshipLink.svelte';
  let { reference, services, onupdate, onremove }: {
    reference: ServiceReference; services: Service[]; onupdate: (reference: ServiceReference) => void; onremove: () => void;
  } = $props();
  const service = $derived(services.find(service => service._uid === reference.service_id));
  let expanded = $state(false);
</script>
<div class="border border-carbon-600 bg-carbon-900/60 transition-colors hover:border-nexus-500/40 hover:bg-carbon-700/40" data-testid="service-reference-row" class:opacity-50={reference.is_disabled}>
  <div class="flex items-center flex-wrap gap-2 sm:gap-3 px-3 py-2">
    <div class="text-zinc-500" role="img" aria-label="Drag handle"><svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" d="M4 8h16M4 16h16" /></svg></div>
    <BSwitch size="small" showChildren={false} checked={!reference.is_disabled} description={$_('serviceReferences.enabled')}
      onchange={enabled => onupdate({ ...reference, is_disabled: !enabled })} />
    <div class="flex-1 min-w-24">
      <div class="flex items-center gap-2 min-w-0">
        <span class="nx-label-sm shrink-0">SVC</span>
        {#if service}<RelationshipLink type="service" name={service.name} className="min-w-0" />
        {:else}<span role="alert" class="text-red-300 break-all text-sm" data-testid="broken-service-warning">{$_('services.brokenServiceWarning', { values: { name: reference.service_id } })}</span>{/if}
      </div>
    </div>
    {#if service}<HealthSummary aggregate={getServiceHealthAggregate(service, $runtimeUpstreams, services)} />{/if}
    <div class="flex items-center gap-2 ml-auto">
      <span class="nx-label-sm">W:</span>
      <div class="w-24"><NumberInput bind:value={() => reference.weight, weight => onupdate({ ...reference, weight: weight ?? 0 })}
        required emptyValue={0} min={1} max={Number.MAX_SAFE_INTEGER} aria-label={$_('upstream.weight')} class="h-7 text-[11px]"
        increaseLabel="+" decreaseLabel="−" invalidMessage={$_('serviceReferences.positiveInteger')} /></div>
    </div>
    <div class="flex items-center gap-1">
      <Button variant="ghost" size="icon" class="h-7 w-7" disabled={!service} aria-label={$_('serviceReferences.details')} aria-expanded={expanded} onclick={() => expanded = !expanded}>
        <svg viewBox="0 0 24 24" class="h-3.5 w-3.5 transition-transform {expanded ? 'rotate-180' : ''}" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6" /></svg>
      </Button>
      <IconButton size="sm" variant="danger" title={$_('routeEditor.removeServiceReference')} on:click={onremove}>
        <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </IconButton>
    </div>
  </div>
  {#if expanded && service}
    <div class="border-t border-carbon-600 px-3 py-2 space-y-2 text-xs text-zinc-400" data-testid="service-reference-details">
      {#each service.endpoints as endpoint}<div class="flex items-center gap-2"><RuntimeStatus stateKey={service._uid ?? ''} upstream={endpoint} /><span class="font-mono break-all">{endpoint.target}</span></div>{/each}
      {#each service.service_references ?? [] as child}<div class="flex items-center gap-2"><span class="nx-label-sm">SVC</span><span>{services.find(item => item._uid === child.service_id)?.name ?? child.service_id}</span></div>{/each}
    </div>
  {/if}
</div>
