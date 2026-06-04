<script lang="ts">
  import type { Upstream } from '$api/routes';
  import { _ } from '$i18n';
  import { createEventDispatcher } from 'svelte';
  import { IconButton } from '$components/industrial';

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
    event.dataTransfer.setData('application/json', JSON.stringify({
      originalIndex: upstream.originalIndex,
      uid: upstream._uid,
    }));
    event.dataTransfer.effectAllowed = 'move';
    if (event.target instanceof HTMLElement) event.target.style.opacity = '0.5';
  }

  function handleDragEnd(event: DragEvent) {
    if (event.target instanceof HTMLElement) event.target.style.opacity = '1';
  }
</script>

<div
  class="flex items-center gap-3 border border-carbon-600 bg-carbon-900/60 px-3 py-2 mb-2 cursor-move transition-colors hover:border-nexus-500/40 hover:bg-carbon-700/40"
  class:opacity-50={upstream.is_disabled}
  draggable="true"
  on:dragstart={handleDragStart}
  on:dragend={handleDragEnd}
  role="listitem"
>
  <!-- Drag handle -->
  <div class="text-zinc-500 hover:text-zinc-300" role="img" aria-label="Drag handle">
    <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M4 8h16M4 16h16" />
    </svg>
  </div>

  <label class="nx-toggle" title={upstream.is_disabled ? $_('upstream.enableTooltip') : $_('upstream.disableTooltip')} aria-label={upstream.is_disabled ? $_('upstream.enableTooltip') : $_('upstream.disableTooltip')}>
    <input
      type="checkbox"
      checked={!upstream.is_disabled}
      on:change={() => dispatch('toggleStatus')}
    />
    <span class="nx-toggle-track">
      <span class="nx-toggle-knob"></span>
    </span>
  </label>

  <!-- Info -->
  <div class="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-12 gap-3 items-center">
    <div class="col-span-1 md:col-span-5 flex flex-col">
      <div class="font-mono text-[12px] text-zinc-100 truncate" title={upstream.target}>{upstream.target}</div>
      {#if upstream.description}
        <div class="font-mono text-[10px] uppercase tracking-command text-zinc-500 truncate" title={upstream.description}>
          {upstream.description}
        </div>
      {/if}
    </div>

    <div class="col-span-1 md:col-span-4 hidden md:flex items-center">
      {#if upstream.condition}
        <code class="font-mono text-[11px] text-nexus-300 border border-carbon-500 bg-carbon-950 px-2 py-1 truncate max-w-full" title={upstream.condition}>
          {upstream.condition}
        </code>
      {/if}
    </div>

    <div class="col-span-1 md:col-span-3 flex items-center gap-2">
      <span class="nx-label-sm whitespace-nowrap">W:</span>
      <input
        type="number"
        class="nx-input h-7 w-16 px-2 text-[11px]"
        value={upstream.weight}
        on:input={(e) => dispatch('updateWeight', parseInt(e.currentTarget.value) || 0)}
        on:click|stopPropagation
      />
    </div>
  </div>

  <!-- Actions -->
  <div class="flex items-center gap-1">
    <IconButton size="sm" title={$_('common.edit')} on:click={() => dispatch('edit')} data-testid="upstream-edit-button">
      <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
      </svg>
    </IconButton>
    <IconButton size="sm" title={$_('routeCard.duplicate')} on:click={() => dispatch('duplicate')}>
      <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>
    </IconButton>
    <IconButton size="sm" variant="danger" title={$_('common.delete')} on:click={() => dispatch('remove')} data-testid="upstream-delete-button">
      <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </IconButton>
  </div>
</div>
