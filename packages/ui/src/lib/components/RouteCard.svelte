<script lang="ts">
  import type { Route } from '../api/routes';
  import { push } from 'svelte-spa-router';
  import { _ } from '../i18n';

  export let route: Route;
  export let onDelete: () => void;
  export let onDuplicate: () => void;
  export let isDeleting = false;
  export let isDuplicating = false;

  function handleEdit() {
    push(`/routes/edit/${encodeURIComponent(route.path)}`);
  }

  function getUpstreamStatus(upstream: any) {
    // 简单判断，后续可以接入实际健康检查状态
    return 'healthy';
  }
</script>

<div class="card bg-base-100 shadow-md hover:shadow-lg transition-shadow">
  <div class="card-body flex flex-col">
    <!-- Header -->
    <div class="flex justify-between items-start">
      <div class="flex-1">
        <h2 class="card-title text-lg">
          <code class="text-primary">{route.path}</code>
        </h2>
        <div class="flex gap-2 mt-2 flex-wrap">
          <span class="badge badge-sm">
            {$_('routeCard.upstreams', { values: { count: route.upstreams.length } })}
          </span>
          {#if route.transformer}
            <span class="badge badge-sm badge-info">
              {$_('routeCard.hasTransformer')}
            </span>
          {/if}
          {#if route.failover?.enabled}
            <span class="badge badge-sm badge-success">Failover</span>
          {/if}
          {#if route.healthCheck?.enabled}
            <span class="badge badge-sm badge-success">Health Check</span>
          {/if}
        </div>
      </div>
    </div>

    <!-- Upstreams Summary -->
    <div class="mt-4">
      <p class="text-sm font-semibold mb-2">{$_('routeEditor.upstreams')}:</p>
      <div class="space-y-2">
        {#each route.upstreams as upstream, index}
          <div class="flex items-center gap-2 text-sm">
            <div
              class="w-2 h-2 rounded-full"
              class:bg-success={getUpstreamStatus(upstream) === 'healthy'}
              class:bg-error={getUpstreamStatus(upstream) === 'unhealthy'}
              class:bg-warning={getUpstreamStatus(upstream) === 'unknown'}
              title={getUpstreamStatus(upstream)}
            ></div>
            <code class="text-xs flex-1 truncate">
              {upstream.target}
            </code>
            {#if upstream.weight}
              <span class="badge badge-xs">{$_('upstream.weight')}: {upstream.weight}</span>
            {/if}
            {#if upstream.priority !== undefined}
              <span class="badge badge-xs">P: {upstream.priority}</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>

    <!-- Path Rewrite -->
    {#if route.pathRewrite}
      <div class="mt-2">
        <p class="text-sm font-semibold">Path Rewrite:</p>
        <div class="text-xs text-gray-500">
          {#each Object.entries(route.pathRewrite) as [pattern, replacement]}
            <div><code>{pattern}</code> → <code>{replacement}</code></div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Actions -->
    <div class="card-actions justify-end mt-auto pt-4">
      <button class="btn btn-sm btn-primary btn-outline" on:click={handleEdit}>
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
        {$_('routeCard.edit')}
      </button>
      <button
        class="btn btn-sm btn-secondary btn-outline"
        on:click={onDuplicate}
        disabled={isDuplicating}
      >
        {#if isDuplicating}
          <span class="loading loading-spinner loading-xs"></span>
          {$_('routeCard.duplicating')}
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          {$_('routeCard.duplicate')}
        {/if}
      </button>
      <button
        class="btn btn-sm btn-error btn-outline"
        on:click={onDelete}
        disabled={isDeleting}
      >
        {#if isDeleting}
          <span class="loading loading-spinner loading-xs"></span>
          {$_('routeCard.deleting')}
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          {$_('routeCard.delete')}
        {/if}
      </button>
    </div>
  </div>
</div>
