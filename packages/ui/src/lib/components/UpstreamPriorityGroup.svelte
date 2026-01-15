<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Upstream } from '../api/routes';
  import DraggableUpstreamItem from './DraggableUpstreamItem.svelte';
  import { _ } from '../i18n';

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
    event.preventDefault(); // Allow drop
    event.dataTransfer!.dropEffect = 'move';
    isDragOver = true;
  }

  function handleDragLeave(event: DragEvent) {
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
  class="bg-base-200/50 rounded-lg p-3 border-2 transition-colors relative"
  class:border-primary={isDragOver}
  class:bg-primary-content={isDragOver}
  class:border-transparent={!isDragOver}
  on:dragover={handleDragOver}
  on:dragleave={handleDragLeave}
  on:drop={handleDrop}
  role="group"
>
  <!-- Group Header -->
  <div class="flex items-center gap-2 mb-2 px-1">
    <div class="badge badge-primary font-bold">{$_('upstream.priorityGroup', { values: { priority } })}</div>
    <div class="text-xs text-gray-500 uppercase tracking-wide">{$_('upstream.loadBalancingGroup')}</div>
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
      <div class="text-center py-8 text-gray-400 border-2 border-dashed border-base-300 rounded-lg">
          {$_('upstream.dragToMerge')}
      </div>
  {/if}
</div>
