<script lang="ts">
  import type { Service } from '$api/routes';
  import { groupTargets, moveTarget, type TargetOwner, type DropDestination } from './upstream-groups';
  import UpstreamPriorityGroup from '../UpstreamPriorityGroup.svelte';
  import UpstreamTargetRow from '../UpstreamTargetRow.svelte';
  import { _ } from '$i18n';
  let { owner = $bindable(), services = [], stateKey = '', searchTerm = '', onedit, onremove, onduplicate, ontogglestatus, onupdateweight }: {
    owner: TargetOwner; services?: Service[]; stateKey?: string; searchTerm?: string;
    onedit?: (index: number) => void; onremove?: (index: number) => void; onduplicate?: (index: number) => void;
    ontogglestatus?: (index: number) => void; onupdateweight?: (index: number, weight: number | undefined) => void;
  } = $props();
  const groups = $derived(groupTargets(owner, services, searchTerm));
  let spacer = $state<number | null>(null);
  function drop(event: DragEvent, destination: DropDestination) {
    event.preventDefault(); spacer = null;
    const data = event.dataTransfer?.getData('application/json');
    if (!data) return;
    let payload: unknown;
    try { payload = JSON.parse(data); } catch { return; }
    if (!payload || typeof payload !== 'object' || !('key' in payload) || typeof payload.key !== 'string') return;
    const next = moveTarget(owner, payload.key, destination);
    if (next === owner) return;
    if (owner.endpoints !== undefined) owner.endpoints = next.endpoints;
    if (owner.service_references !== undefined) owner.service_references = next.service_references;
  }
</script>
{#snippet boundary(index: number)}
  <div role="group" aria-label={$_('upstream.insertPriorityGroup')} data-testid="upstream-priority-boundary" data-insert-index={index}
    class="-my-2 transition-all duration-200 flex items-center justify-center border-2 border-dashed z-10 {spacer === index ? 'h-12 bg-nexus-500/10 border-nexus-500' : 'h-4 border-transparent'}"
    ondragover={event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; spacer = index; }}
    ondragleave={() => spacer = null} ondrop={event => drop(event, { insertIndex: index })}>
    {#if spacer === index}<span class="font-mono text-[11px] font-bold uppercase tracking-command text-nexus-300">{$_('upstream.insertNewPriority', { values: { priority: index + 1 } })}</span>{/if}
  </div>
{/snippet}
<div class="flex min-w-0 flex-col gap-4 min-h-[120px]" data-testid="service-mixed-targets">
  {#if groups.length > 0}{@render boundary(groups[0].groupIndex)}{/if}
  {#each groups as group (group.priority)}
    <UpstreamPriorityGroup {group} ondrop={drop}>
      {#snippet row(target)}
        <UpstreamTargetRow {target} {services} {stateKey}
          onedit={() => { if (target.kind === 'endpoint') onedit?.(target.originalIndex); }}
          onremove={() => { if (target.kind === 'endpoint') onremove?.(target.originalIndex); else owner.service_references = owner.service_references?.filter(reference => reference.id !== target.reference.id); }}
          onduplicate={() => { if (target.kind === 'endpoint') onduplicate?.(target.originalIndex); }}
          ontogglestatus={() => { if (target.kind === 'endpoint') ontogglestatus?.(target.originalIndex); }}
          onupdateweight={weight => { if (target.kind === 'endpoint') onupdateweight?.(target.originalIndex, weight); }}
          onreferenceupdate={next => owner.service_references = owner.service_references?.map(reference => reference.id === next.id ? next : reference)} />
      {/snippet}
    </UpstreamPriorityGroup>
    {@render boundary(group.groupIndex + 1)}
  {/each}
  {#if groups.length === 0}
    <div class="flex-1 flex items-center justify-center border border-dashed border-carbon-500 p-4">
      <span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_(searchTerm.trim() ? 'serviceReferences.noMatches' : 'serviceReferences.noTargets')}</span>
    </div>
  {/if}
</div>
