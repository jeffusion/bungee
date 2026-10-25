<script lang="ts">
  import type { Service } from '$api/routes';
  import type { ServiceReference } from '@jeffusion/bungee-types';
  import type { TargetRow } from './sections/upstream-groups';
  import { _ } from '$i18n';
  import { BSwitch, IconButton } from '$components/industrial';
  import { NumberInput } from '$components/ui/number-input';
  import { Button } from '$components/ui/button';
  import RuntimeStatus from '$components/domain/service/RuntimeStatus.svelte';
  import ServiceReferenceStatus from '$components/domain/service/ServiceReferenceStatus.svelte';
  import RelationshipLink from '$components/domain/service/RelationshipLink.svelte';

  let { target, services, stateKey, onedit, onremove, onduplicate, ontogglestatus, onupdateweight, onreferenceupdate }: {
    target: TargetRow; services: Service[]; stateKey: string;
    onedit?: () => void; onremove: () => void; onduplicate?: () => void;
    ontogglestatus?: () => void; onupdateweight?: (weight: number | undefined) => void;
    onreferenceupdate: (reference: ServiceReference) => void;
  } = $props();
  const policy = $derived(target.kind === 'endpoint' ? target.endpoint : target.reference);
  const serviceId = $derived(target.kind === 'service' ? target.reference.service_id : undefined);
  const service = $derived(services.find(item => item._uid === serviceId));
  let expanded = $state(false);

  function toggle(enabled: boolean) {
    if (target.kind === 'endpoint') ontogglestatus?.();
    else onreferenceupdate({ ...target.reference, is_disabled: !enabled });
  }
  function updateWeight(weight: number | undefined) {
    if (target.kind === 'endpoint') onupdateweight?.(weight);
    else onreferenceupdate({ ...target.reference, weight: weight ?? 0 });
  }
</script>

<div class="border border-carbon-600 bg-carbon-900/60 transition-colors hover:border-nexus-500/40 hover:bg-carbon-700/40"
  data-testid={target.kind === 'service' ? 'service-reference-row' : 'upstream-endpoint-row'} class:opacity-50={policy.is_disabled}>
  <div class="flex flex-wrap items-center gap-2 sm:gap-3 px-3 py-2">
    <div class="text-zinc-500 shrink-0" aria-hidden="true"><svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" d="M4 8h16M4 16h16" /></svg></div>
    <BSwitch size="small" showChildren={false} checked={!policy.is_disabled}
      description={policy.is_disabled ? $_('upstream.enableTooltip') : $_('upstream.disableTooltip')} onchange={toggle} />
    <div class="w-28 shrink-0">
      {#if target.kind === 'endpoint'}<RuntimeStatus {stateKey} upstream={target.endpoint} />
      {:else}<ServiceReferenceStatus reference={target.reference} {services} />{/if}
    </div>
    <div class="flex-1 min-w-24">
      <div class="flex min-w-0 items-center gap-2">
        <span class="nx-label-sm shrink-0">{target.kind === 'endpoint' ? 'EP' : 'SVC'}</span>
        {#if target.kind === 'endpoint'}
          <span class="truncate font-mono text-[12px] text-zinc-100" title={target.endpoint.target}>{target.endpoint.target}</span>
        {:else if service}
          <RelationshipLink type="service" name={service.name} className="min-w-0 max-w-full [&>span]:max-w-none" />
        {:else}
          <span role="alert" class="break-all text-sm text-red-300" data-testid="broken-service-warning">{$_('services.brokenServiceWarning', { values: { name: target.reference.service_id } })}</span>
        {/if}
      </div>
      {#if target.kind === 'endpoint'}
        {#if target.endpoint.description}<div class="truncate font-mono text-[10px] text-zinc-400" title={target.endpoint.description}>{target.endpoint.description}</div>{/if}
        {#if target.endpoint.condition}<code class="block truncate font-mono text-[11px] text-nexus-300" title={target.endpoint.condition}>{target.endpoint.condition}</code>{/if}
      {/if}
    </div>
    <div class="ml-auto flex shrink-0 items-center gap-3">
      <div class="flex items-center gap-2">
        <span class="nx-label-sm">W:</span>
        <div class="w-24"><NumberInput bind:value={() => policy.weight, updateWeight}
          required emptyValue={0} min={1} max={Number.MAX_SAFE_INTEGER} aria-label={$_('upstream.weight')} class="h-7 text-[11px]"
          increaseLabel="+" decreaseLabel="−" invalidMessage={$_('serviceReferences.positiveInteger')} /></div>
      </div>
      <div class="flex w-24 justify-end items-center gap-1">
        {#if target.kind === 'endpoint'}
          <IconButton size="sm" title={$_('common.edit')} on:click={() => onedit?.()} data-testid="upstream-edit-button">
            <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
          </IconButton>
          <IconButton size="sm" title={$_('routeCard.duplicate')} on:click={() => onduplicate?.()}>
            <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
          </IconButton>
        {:else}
          <Button variant="ghost" size="icon" class="h-7 w-7" disabled={!service} aria-label={$_('serviceReferences.details')} aria-expanded={expanded} onclick={() => expanded = !expanded}>
            <svg viewBox="0 0 24 24" class="h-3.5 w-3.5 transition-transform {expanded ? 'rotate-180' : ''}" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6" /></svg>
          </Button>
        {/if}
        <IconButton size="sm" variant="danger" title={target.kind === 'endpoint' ? $_('common.delete') : $_('routeEditor.removeServiceReference')} on:click={onremove} data-testid="upstream-delete-button">
          <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </IconButton>
      </div>
    </div>
  </div>
  {#if expanded && service}
    <div class="border-t border-carbon-600 px-3 py-2 space-y-2 text-xs text-zinc-400" data-testid="service-reference-details">
      {#each service.endpoints as endpoint}<div class="flex items-center gap-2"><RuntimeStatus stateKey={service._uid ?? ''} upstream={endpoint} /><span class="nx-label-sm">EP</span><span class="font-mono break-all">{endpoint.target}</span></div>{/each}
      {#each service.service_references ?? [] as reference}<div class="flex items-center gap-2"><ServiceReferenceStatus {reference} {services} /><span class="nx-label-sm">SVC</span><span class="break-all">{services.find(item => item._uid === reference.service_id)?.name ?? reference.service_id}</span></div>{/each}
    </div>
  {/if}
</div>
