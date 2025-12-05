<script lang="ts">
  import type { Route } from '../api/routes';
  import { push } from 'svelte-spa-router';
  import { _ } from '../i18n';
  import UpstreamsModal from './UpstreamsModal.svelte';

  export let route: Route;
  export let onDelete: () => void;
  export let onDuplicate: () => void;
  export let isDeleting = false;
  export let isDuplicating = false;

  const PREVIEW_COUNT = 5;
  let showUpstreamsModal = false;

  $: previewUpstreams = route.upstreams.slice(0, PREVIEW_COUNT);
  $: hasMore = route.upstreams.length > PREVIEW_COUNT;

  function handleEdit() {
    push(`/routes/edit/${encodeURIComponent(route.path)}`);
  }

  function openUpstreamsModal() {
    showUpstreamsModal = true;
  }

  function getUpstreamStatus(upstream: any): 'healthy' | 'unhealthy' | 'unknown' {
    // 从运行时状态获取健康状态
    if (!upstream.status) {
      return 'unknown';
    }
    return upstream.status === 'HEALTHY' ? 'healthy' : 'unhealthy';
  }

  function formatLastFailureTime(timestamp: number | undefined): string {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);

    if (diffSec < 60) return `${diffSec}秒前`;
    if (diffMin < 60) return `${diffMin}分钟前`;
    if (diffHour < 24) return `${diffHour}小时前`;
    return date.toLocaleString('zh-CN');
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
          {#if route.auth?.enabled}
            <span class="badge badge-sm badge-warning">{$_('routeCard.routeAuth')}</span>
          {/if}
          {#if route.failover?.enabled}
            <span class="badge badge-sm badge-success">{$_('routeCard.failover')}</span>
          {/if}
        </div>
      </div>

      <!-- Actions (Right Top Corner) -->
      <div class="flex gap-2">
        <!-- Edit Button - Purple Primary Button -->
        <button class="btn btn-sm btn-primary gap-1" on:click={handleEdit}>
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          {$_('routeCard.edit')}
        </button>

        <!-- More Actions Dropdown - Three-dot Button -->
        <div class="dropdown dropdown-end">
          <button type="button" class="btn btn-sm btn-ghost btn-square" title={$_('routeCard.moreActions')}>
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
            </svg>
          </button>
          <ul class="dropdown-content menu p-2 shadow-lg bg-base-100 rounded-box w-40 z-10">
            <li>
              <button on:click={onDuplicate} disabled={isDuplicating}>
                {#if isDuplicating}
                  <span class="loading loading-spinner loading-xs"></span>
                  <span>{$_('routeCard.duplicating')}</span>
                {:else}
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  <span>{$_('routeCard.duplicate')}</span>
                {/if}
              </button>
            </li>
            <li>
              <button class="text-error" on:click={onDelete} disabled={isDeleting}>
                {#if isDeleting}
                  <span class="loading loading-spinner loading-xs"></span>
                  <span>{$_('routeCard.deleting')}</span>
                {:else}
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  <span>{$_('routeCard.delete')}</span>
                {/if}
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <!-- Upstreams Summary -->
    <div class="mt-4">
      <div class="overflow-x-auto border border-base-300 rounded-lg">
        <table class="table table-xs w-full">
          <thead>
            <tr class="bg-base-200">
              <th class="w-12">{$_('routeCard.tableHeaders.status')}</th>
              <th>{$_('routeCard.tableHeaders.target')}</th>
              <th class="w-16 text-right">{$_('routeCard.tableHeaders.weight')}</th>
              <th class="w-12 text-right">{$_('routeCard.tableHeaders.priority')}</th>
            </tr>
          </thead>
          <tbody>
            {#each previewUpstreams as upstream}
              <tr class="hover" class:opacity-50={upstream.disabled}>
                <td>
                  <div
                    class="w-2.5 h-2.5 rounded-full tooltip tooltip-right"
                    class:bg-success={getUpstreamStatus(upstream) === 'healthy' && !upstream.disabled}
                    class:bg-error={getUpstreamStatus(upstream) === 'unhealthy' && !upstream.disabled}
                    class:bg-warning={getUpstreamStatus(upstream) === 'unknown' && !upstream.disabled}
                    class:bg-gray-400={upstream.disabled}
                    data-tip={upstream.disabled
                      ? $_('upstream.disabled')
                      : upstream.lastFailureTime
                        ? `最后失败: ${formatLastFailureTime(upstream.lastFailureTime)}`
                        : getUpstreamStatus(upstream) === 'healthy'
                          ? '健康'
                          : getUpstreamStatus(upstream) === 'unhealthy'
                            ? '异常'
                            : '未知'}
                  ></div>
                </td>
                <td>
                  <div class="flex flex-col">
                    <code class="text-xs truncate max-w-xs block" title={upstream.target}>
                      {upstream.target}
                    </code>
                    {#if upstream.description}
                      <span class="text-xs text-gray-500 truncate max-w-xs" title={upstream.description}>
                        {upstream.description}
                      </span>
                    {/if}
                  </div>
                </td>
                <td class="text-right text-xs">{upstream.weight || 100}</td>
                <td class="text-right text-xs">{upstream.priority || 1}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <!-- View All Button - Full width below table -->
      {#if hasMore}
        <div class="mt-2">
          <button class="btn btn-sm btn-outline w-full" on:click={openUpstreamsModal}>
            {$_('routeCard.viewAll', { values: { count: route.upstreams.length } })}
          </button>
        </div>
      {/if}
    </div>

    <!-- Path Rewrite -->
    {#if route.pathRewrite}
      <div class="mt-3">
        <p class="text-sm font-semibold mb-1">Path Rewrite:</p>
        {#each Object.entries(route.pathRewrite) as [pattern, replacement]}
          <div class="text-sm text-gray-600">
            {$_('routeCard.pathRewrite.original')} <code class="bg-base-200 px-1.5 py-0.5 rounded text-sm font-mono">{pattern}</code> → {$_('routeCard.pathRewrite.rewriteTo')} <code class="bg-base-200 px-1.5 py-0.5 rounded text-sm font-mono">{replacement}</code>
          </div>
        {/each}
      </div>
    {/if}

  </div>
</div>

<!-- Upstreams Modal -->
<UpstreamsModal bind:open={showUpstreamsModal} {route} />
