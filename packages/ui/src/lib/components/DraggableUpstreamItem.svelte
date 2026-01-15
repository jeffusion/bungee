<script lang="ts">
  import type { Upstream } from '../api/routes';
  import { _ } from '../i18n';
  import { createEventDispatcher } from 'svelte';

  export let upstream: Upstream & { originalIndex: number };

  const dispatch = createEventDispatcher<{
    edit: void;
    remove: void;
    duplicate: void;
    toggleStatus: void;
    updateWeight: number;
  }>();

  function handleDragStart(event: DragEvent) {
    if (!event.dataTransfer) return;
    
    // Set data to identify this item
    event.dataTransfer.setData('application/json', JSON.stringify({
      originalIndex: upstream.originalIndex,
      uid: upstream._uid
    }));
    event.dataTransfer.effectAllowed = 'move';
    
    // Add dragging visual feedback
    if (event.target instanceof HTMLElement) {
       event.target.style.opacity = '0.5';
    }
  }
  
  function handleDragEnd(event: DragEvent) {
     if (event.target instanceof HTMLElement) {
       event.target.style.opacity = '1';
    }
  }
</script>

<div
  class="card bg-base-100 border border-base-300 shadow-sm hover:shadow-md transition-all p-3 mb-2 cursor-move"
  class:opacity-50={upstream.disabled}
  draggable="true"
  on:dragstart={handleDragStart}
  on:dragend={handleDragEnd}
  role="listitem"
>
  <div class="flex items-center gap-4">
    <!-- Drag Handle -->
    <div class="text-base-content/30 hover:text-base-content/60">
      <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8h16M4 16h16" />
      </svg>
    </div>

    <!-- Status Toggle -->
    <input
      type="checkbox"
      class="toggle toggle-sm toggle-success"
      checked={!upstream.disabled}
      on:change={() => dispatch('toggleStatus')}
      title={upstream.disabled ? $_('upstream.enableTooltip') : $_('upstream.disableTooltip')}
    />

    <!-- Info -->
    <div class="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
        <!-- Target (5 cols) -->
        <div class="col-span-1 md:col-span-5 flex flex-col">
           <div class="font-bold truncate text-sm" title={upstream.target}>{upstream.target}</div>
           <div class="text-xs text-gray-500 truncate" title={upstream.description || ''}>
             {upstream.description || ''}
           </div>
        </div>
        
        <!-- Condition (4 cols) -->
        <div class="col-span-1 md:col-span-4 hidden md:flex items-center">
           {#if upstream.condition}
             <div class="text-xs font-mono bg-base-200 px-2 py-1 rounded truncate max-w-full" title={upstream.condition}>
               {upstream.condition}
             </div>
           {/if}
        </div>

        <!-- Weight (3 cols) -->
        <div class="col-span-1 md:col-span-3 flex items-center gap-2">
            <span class="text-xs text-gray-500 whitespace-nowrap">{$_('upstream.weight')}:</span>
            <input
                type="number"
                class="input input-xs input-bordered w-16"
                value={upstream.weight}
                on:input={(e) => dispatch('updateWeight', parseInt(e.currentTarget.value) || 0)}
                on:click|stopPropagation
            />
        </div>
    </div>

    <!-- Actions -->
    <div class="flex gap-1">
      <button type="button" class="btn btn-square btn-ghost btn-sm" title={$_('common.edit')} on:click={() => dispatch('edit')}>
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
      </button>
      <button type="button" class="btn btn-square btn-ghost btn-sm" title={$_('routeCard.duplicate')} on:click={() => dispatch('duplicate')}>
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
      </button>
      <button type="button" class="btn btn-square btn-ghost btn-sm text-error" title={$_('common.delete')} on:click={() => dispatch('remove')}>
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
      </button>
    </div>
  </div>
</div>
