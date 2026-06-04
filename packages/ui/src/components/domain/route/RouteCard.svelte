<script lang="ts">
  import { resolveRouteEndpoints, type Route, type Service } from '$api/routes';
  import { push } from 'svelte-spa-router';
  import { _ } from '$i18n';
  import UpstreamsModal from './UpstreamsModal.svelte';
  import { LoadingIndicator } from '$components/industrial';

  export let route: Route;
  export let services: Service[] = [];
  export let onDelete: () => void;
  export let onDuplicate: () => void;
  export let isDeleting = false;
  export let isDuplicating = false;

  const PREVIEW_COUNT = 5;
  let showUpstreamsModal = false;

  $: endpoints = resolveRouteEndpoints(route, services);
  $: previewUpstreams = endpoints.slice(0, PREVIEW_COUNT);
  $: hasMore = endpoints.length > PREVIEW_COUNT;

  function handleEdit() {
    push(`/routes/edit/${encodeURIComponent(route.path)}`);
  }

  function openUpstreamsModal() {
    showUpstreamsModal = true;
  }

  function getUpstreamStatus(upstream: any): 'healthy' | 'unhealthy' | 'half_open' {
    if (!upstream.status || upstream.status === 'HEALTHY') {
      return 'healthy';
    }
    return upstream.status === 'HALF_OPEN' ? 'half_open' : 'unhealthy';
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

<div class="nx-panel-raised nx-bracketed shadow-industrial transition-colors hover:border-nexus-500/40">
  <div class="flex flex-col p-4">
    <div class="flex justify-between items-start gap-4">
      <div class="min-w-0 flex-1">
        <h2 class="text-lg font-semibold">
          <code class="font-mono text-nexus-300">{route.path}</code>
        </h2>
        <div class="flex gap-2 mt-2 flex-wrap">
          <span class="nx-badge-muted">
            {$_('routeCard.upstreams', { values: { count: endpoints.length } })}
          </span>
          {#if route.service}
            <span class="nx-badge-info">service: {route.service}</span>
          {/if}
          {#if route.transformer}
            <span class="nx-badge-info">
              {$_('routeCard.hasTransformer')}
            </span>
          {/if}
          {#if route.auth?.enabled}
            <span class="nx-badge-standby">{$_('routeCard.routeAuth')}</span>
          {/if}
          {#if route.failover?.enabled}
            <span class="nx-badge-active">{$_('routeCard.failover')}</span>
          {/if}
        </div>
      </div>

      <div class="flex gap-2">
        <button class="nx-btn-primary nx-btn-sm gap-1" on:click={handleEdit}>
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          {$_('routeCard.edit')}
        </button>

        <div class="relative group">
          <button type="button" class="nx-btn-ghost nx-btn-sm h-8 w-8 px-0" title={$_('routeCard.moreActions')}>
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
            </svg>
          </button>
          <ul class="invisible absolute right-0 top-full z-20 mt-1 w-44 border border-carbon-500 bg-carbon-900 p-1 shadow-industrial-lg opacity-0 transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
            <li>
              <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-200 transition-colors hover:bg-carbon-700 hover:text-nexus-300 disabled:opacity-50" on:click={onDuplicate} disabled={isDuplicating}>
                {#if isDuplicating}
                  <LoadingIndicator label="" size="xs" centered={false} />
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
              <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200 disabled:opacity-50" on:click={onDelete} disabled={isDeleting}>
                {#if isDeleting}
                  <LoadingIndicator label="" size="xs" centered={false} />
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

    <div class="mt-4">
      <div class="overflow-x-auto border border-carbon-600">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-carbon-600 bg-carbon-950/80 text-left font-mono text-[10px] uppercase tracking-command text-zinc-500">
              <th class="w-12 px-3 py-2">{$_('routeCard.tableHeaders.status')}</th>
              <th class="px-3 py-2">{$_('routeCard.tableHeaders.target')}</th>
              <th class="w-16 px-3 py-2 text-right">{$_('routeCard.tableHeaders.weight')}</th>
              <th class="w-12 px-3 py-2 text-right">{$_('routeCard.tableHeaders.priority')}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-carbon-600">
            {#each previewUpstreams as upstream}
              <tr class="transition-colors hover:bg-carbon-700/40" class:opacity-50={upstream.is_disabled}>
                <td class="px-3 py-2">
                  <div
                    class="h-2.5 w-2.5 rounded-full"
                    class:bg-emerald-500={getUpstreamStatus(upstream) === 'healthy' && !upstream.is_disabled}
                    class:bg-red-500={getUpstreamStatus(upstream) === 'unhealthy' && !upstream.is_disabled}
                    class:bg-amber-500={getUpstreamStatus(upstream) === 'half_open' && !upstream.is_disabled}
                    class:bg-gray-400={upstream.is_disabled}
                    title={upstream.is_disabled
                      ? $_('upstream.disabled')
                      : upstream.last_failure_time
                        ? `最后失败: ${formatLastFailureTime(upstream.last_failure_time)}`
                        : getUpstreamStatus(upstream) === 'healthy'
                          ? '健康'
                        : getUpstreamStatus(upstream) === 'unhealthy'
                          ? '异常'
                            : '半开恢复中'}
                  ></div>
                </td>
                <td class="px-3 py-2">
                  <div class="flex flex-col">
                    <code class="text-xs truncate max-w-xs block" title={upstream.target}>
                      {upstream.target}
                    </code>
                    {#if upstream.description}
                      <span class="text-xs text-zinc-500 truncate max-w-xs" title={upstream.description}>
                        {upstream.description}
                      </span>
                    {/if}
                  </div>
                </td>
                <td class="px-3 py-2 text-right text-xs">{upstream.weight || 100}</td>
                <td class="px-3 py-2 text-right text-xs">{upstream.priority || 1}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      {#if hasMore}
        <div class="mt-2">
          <button class="nx-btn-outline nx-btn-sm w-full justify-center" on:click={openUpstreamsModal}>
            {$_('routeCard.viewAll', { values: { count: endpoints.length } })}
          </button>
        </div>
      {/if}
    </div>

    {#if route.path_rewrite}
      <div class="mt-3">
        <p class="text-sm font-semibold mb-1">Path Rewrite:</p>
        {#each Object.entries(route.path_rewrite) as [pattern, replacement]}
          <div class="text-sm text-zinc-400">
            {$_('routeCard.pathRewrite.original')} <code class="bg-carbon-950 px-1.5 py-0.5 rounded text-sm font-mono text-zinc-200">{pattern}</code> → {$_('routeCard.pathRewrite.rewriteTo')} <code class="bg-carbon-950 px-1.5 py-0.5 rounded text-sm font-mono text-zinc-200">{replacement}</code>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<UpstreamsModal bind:open={showUpstreamsModal} {route} {endpoints} readOnly={Boolean(route.service && (!route.endpoints || route.endpoints.length === 0))} />
