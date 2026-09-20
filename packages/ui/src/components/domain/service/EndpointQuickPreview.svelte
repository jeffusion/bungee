<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { _ } from '$i18n';
  import type { Upstream } from '$api/routes';
  import { getEndpointPreview } from '$utils/route-service-view-model';
  import RuntimeStatus from './RuntimeStatus.svelte';

  const dispatch = createEventDispatcher<{
    overflowClick: void;
  }>();

  interface Props {
    endpoints?: Upstream[];
    limit?: number;
    className?: string;
    stateKey?: string;
  }

  let {
    endpoints = [],
    limit = 3,
    className = '',
    stateKey = ''
  }: Props = $props();

  let preview = $derived(getEndpointPreview(endpoints, limit));

  function handleOverflowClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    dispatch('overflowClick');
  }
</script>

<div class={`flex flex-col gap-1.5 ${className}`} data-testid="endpoint-quick-preview">
  {#each preview.items as upstream}
    <div 
      class="flex items-center justify-between gap-2 text-xs py-0.5 px-1 rounded hover:bg-carbon-700/50 transition-colors"
      class:opacity-50={upstream.is_disabled}
      data-testid="endpoint-preview-item"
    >
      <div class="flex items-center gap-2 min-w-0 flex-1">
        <RuntimeStatus {stateKey} {upstream} />
        <code class="truncate font-mono text-zinc-300" title={upstream.target}>
          {upstream.target}
        </code>
      </div>
      
      <div class="flex items-center gap-2 flex-shrink-0 text-zinc-500">
        {#if upstream.weight !== undefined}
          <span title={$_('upstream.weight')}>w:{upstream.weight}</span>
        {/if}
        {#if upstream.priority !== undefined}
          <span title={$_('upstream.priority')}>p:{upstream.priority}</span>
        {/if}
      </div>
    </div>
  {/each}

  {#if preview.overflowCount > 0}
    <button
      type="button"
      class="nx-btn-outline nx-btn-sm w-full justify-center mt-1 text-xs border-carbon-500 hover:border-nexus-500 hover:bg-nexus-500/10 hover:text-nexus-300"
      onclick={handleOverflowClick}
      data-testid="endpoint-overflow"
    >
      {$_('endpointPreview.overflow', { values: { count: preview.overflowCount } })}
    </button>
  {/if}
</div>
