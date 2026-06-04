<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Upstream } from '$api/routes';
  import DraggableUpstreamItem from './DraggableUpstreamItem.svelte';
  import { _ } from '$i18n';

  export let priority: number;
  export let upstreams: (Upstream & { originalIndex: number })[];

  const dispatch = createEventDispatcher<{
    merge: { originalIndex: number };
    edit: { originalIndex: number };
    remove: { originalIndex: number };
    duplicate: { originalIndex: number };
    toggleStatus: { originalIndex: number };
    updateWeight: { originalIndex: number, weight: number };
  }>();

  let isDragOver = false;

  function handleDragOver(event: DragEvent) {
    event.preventDefault();
    event.dataTransfer!.dropEffect = 'move';
    isDragOver = true;
  }
  function handleDragLeave() {
    isDragOver = false;
  }
  function handleDrop(event: DragEvent) {
    event.preventDefault();
    isDragOver = false;
    const data = event.dataTransfer?.getData('application/json');
    if (data) {
      const { originalIndex } = JSON.parse(data);
      dispatch('merge', { originalIndex });
    }
  }
</script>

<div
  class="border-2 transition-colors relative p-3 {isDragOver ? 'border-nexus-500 bg-nexus-500/5' : 'border-carbon-600 bg-carbon-950/60'}"
  on:dragover={handleDragOver}
  on:dragleave={handleDragLeave}
  on:drop={handleDrop}
  role="group"
>
  <!-- Group header -->
  <div class="flex items-center gap-2.5 mb-3">
    <span class="nx-pill-accent">P{priority}</span>
    <span class="font-mono text-[11px] uppercase tracking-command text-zinc-200">
      {$_('upstream.priorityGroup', { values: { priority } })}
    </span>
    <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">·</span>
    <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
      {$_('upstream.loadBalancingGroup')}
    </span>
  </div>

  <!-- Items -->
  <div class="flex flex-col gap-0">
    {#each upstreams as upstream (upstream._uid || upstream.originalIndex)}
      <DraggableUpstreamItem
        {upstream}
        on:edit={() => dispatch('edit', { originalIndex: upstream.originalIndex })}
        on:remove={() => dispatch('remove', { originalIndex: upstream.originalIndex })}
        on:duplicate={() => dispatch('duplicate', { originalIndex: upstream.originalIndex })}
        on:toggleStatus={() => dispatch('toggleStatus', { originalIndex: upstream.originalIndex })}
        on:updateWeight={(e) => dispatch('updateWeight', { originalIndex: upstream.originalIndex, weight: e.detail })}
      />
    {/each}
  </div>

  {#if upstreams.length === 0}
    <div class="text-center py-8 border border-dashed border-carbon-500">
      <span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">
        {$_('upstream.dragToMerge')}
      </span>
    </div>
  {/if}
</div>
