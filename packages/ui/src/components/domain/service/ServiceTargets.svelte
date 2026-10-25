<script lang="ts">
  import { _ } from '$i18n';
  import type { Service } from '$api/services';
  import { findRuntimeUpstream } from '$api/runtime';
  import { formatLastUsed } from '$api/runtime-presentation';
  import { runtimeUpstreams } from '$stores/runtime';
  import { groupTargets, type TargetRow, type TargetOwner } from '$components/domain/route/sections/upstream-groups';
  import RelationshipLink from './RelationshipLink.svelte';
  import RuntimeStatus from './RuntimeStatus.svelte';
  import ServiceReferenceStatus from './ServiceReferenceStatus.svelte';

  let { service, services, compact = false, inline = false, onshowall }: {
    service: TargetOwner & Pick<Service, '_uid'>;
    services: Service[];
    compact?: boolean;
    inline?: boolean;
    onshowall?: () => void;
  } = $props();

  const targets = $derived(groupTargets(service).flatMap(group => group.targets));
</script>

{#snippet identity(target: TargetRow)}
  <div class="flex min-w-0 gap-2 {inline ? 'items-center' : 'items-start'}">
    <span class="shrink-0 border border-carbon-600 px-1.5 py-0.5 font-mono text-xs text-zinc-400">
      {target.kind === 'endpoint' ? 'EP' : 'SVC'}
    </span>
    {#if target.kind === 'endpoint'}
      <div class="min-w-0">
        <code class="block font-mono text-sm text-zinc-200 {compact ? 'truncate' : 'break-all'}" title={target.endpoint.target}>{target.endpoint.target}</code>
        {#if !compact && target.endpoint.description}
          <p class="mt-1 text-sm text-zinc-400 break-words">{target.endpoint.description}</p>
        {/if}
      </div>
    {:else}
      {@const linkedService = services.find(item => item._uid === target.reference.service_id)}
      {#if linkedService}
        <RelationshipLink type="service" name={linkedService.name} className="min-w-0 max-w-full [&>span]:max-w-none" />
      {:else}
        <span role="alert" class="text-sm text-red-300 {inline ? 'min-w-0 truncate' : 'break-all'}" title={$_('services.brokenServiceWarning', { values: { name: target.reference.service_id } })}>{$_('services.brokenServiceWarning', { values: { name: target.reference.service_id } })}</span>
      {/if}
    {/if}
  </div>
{/snippet}

{#snippet status(target: TargetRow)}
  {#if target.kind === 'endpoint'}
    <RuntimeStatus stateKey={service._uid ?? ''} upstream={target.endpoint} />
  {:else}
    <ServiceReferenceStatus reference={target.reference} {services} />
  {/if}
{/snippet}

{#if targets.length === 0}
  <p class="text-sm text-zinc-400 {compact ? 'py-2' : 'px-5 py-6'}">{$_('serviceReferences.noTargets')}</p>
{:else if compact}
  <div class={inline ? 'min-w-0 space-y-0.5' : 'space-y-1'} data-testid="service-target-preview">
    {#each targets.slice(0, 3) as target (target.key)}
      {@const policy = target.kind === 'endpoint' ? target.endpoint : target.reference}
      <div class={inline ? 'grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 py-1' : 'space-y-1.5 border-b border-carbon-600/60 py-2 last:border-0'} class:opacity-50={policy.is_disabled}>
        {@render identity(target)}
        <div class={inline ? 'contents' : 'flex flex-wrap items-center justify-between gap-x-3 gap-y-1'}>
          <span class={inline ? 'inline-flex whitespace-nowrap' : 'inline-flex'}>{@render status(target)}</span>
          <span class="flex font-mono text-xs text-zinc-400 tabular-nums {inline ? 'gap-2 whitespace-nowrap' : 'gap-3'}">
            <span title={$_('upstream.weight')}>{inline ? 'W:' : $_('upstream.weight')} {policy.weight ?? 100}</span>
            <span title={$_('upstream.priority')}>{inline ? 'P:' : $_('upstream.priority')} {target.priority}</span>
          </span>
        </div>
      </div>
    {/each}
    {#if targets.length > 3}
      <button type="button" class={inline ? 'nx-btn-ghost nx-btn-sm whitespace-nowrap' : 'nx-btn-outline nx-btn-sm w-full justify-center'} onclick={onshowall}>
        {$_('services.targetsOverflow', { values: { count: targets.length - 3 } })} →
      </button>
    {/if}
  </div>
{:else}
  <table class="w-full" data-testid="endpoints-drawer-table">
    <thead class="sticky top-0 z-[1] border-b border-carbon-600 bg-carbon-900">
      <tr>
        <th scope="col" class="text-left nx-label py-2.5 px-4">{$_('routeCard.tableHeaders.status')}</th>
        <th scope="col" class="text-left nx-label py-2.5 px-4">{$_('routes.tableHeaders.target')}</th>
        <th scope="col" class="text-right nx-label py-2.5 px-4 whitespace-nowrap">{$_('routeCard.tableHeaders.weight')}</th>
        <th scope="col" class="text-right nx-label py-2.5 px-4 whitespace-nowrap">{$_('routeCard.tableHeaders.priority')}</th>
        <th scope="col" class="text-right nx-label py-2.5 px-4 whitespace-nowrap">{$_('runtime.activeRequests')}</th>
        <th scope="col" class="text-right nx-label py-2.5 px-4 whitespace-nowrap">{$_('routeCard.tableHeaders.lastUsed')}</th>
      </tr>
    </thead>
    <tbody>
      {#each targets as target (target.key)}
        {@const policy = target.kind === 'endpoint' ? target.endpoint : target.reference}
        <tr class="border-b border-carbon-600/60 hover:bg-carbon-700/40 transition-colors" class:opacity-50={policy.is_disabled}>
          <td class="py-2.5 px-4 min-w-40">{@render status(target)}</td>
          <td class="py-2.5 px-4 min-w-52">{@render identity(target)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-sm text-zinc-300 tabular-nums">{policy.weight ?? 100}</td>
          <td class="py-2.5 px-4 text-right font-mono text-sm text-zinc-300 tabular-nums">{target.priority}</td>
          <td class="py-2.5 px-4 text-right font-mono text-sm text-zinc-300 tabular-nums">
            {#if target.kind === 'endpoint'}
              {findRuntimeUpstream($runtimeUpstreams, service._uid ?? '', target.endpoint._uid)?.active_request_count ?? $_('runtime.unavailable')}
            {:else}—{/if}
          </td>
          <td class="py-2.5 px-4 text-right font-mono text-sm text-zinc-400 tabular-nums">
            {#if target.kind === 'endpoint'}
              {formatLastUsed($runtimeUpstreams, service._uid ?? '', target.endpoint._uid, $_)}
            {:else}—{/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
