<script lang="ts">
  import type { Upstream } from '../api/routes';
  import { _ } from '../i18n';

  export let open = false;
  export let routePath: string;
  export let upstreams: Upstream[] = [];

  function closeModal() {
    open = false;
  }

  function getUpstreamStatus(upstream: Upstream): 'healthy' | 'unhealthy' | 'unknown' {
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

  // Handle ESC key
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      closeModal();
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<dialog class="modal" class:modal-open={open}>
  <div class="modal-box max-w-3xl">
    <h3 class="font-bold text-lg mb-4">
      {$_('upstreamsModal.title')} - <code class="text-primary">{routePath}</code>
    </h3>

    <div class="overflow-x-auto max-h-[60vh]">
      <table class="table table-zebra w-full">
        <thead>
          <tr>
            <th class="w-20">{$_('routeCard.tableHeaders.status')}</th>
            <th>{$_('routeCard.tableHeaders.target')}</th>
            <th class="w-24 text-right">{$_('routeCard.tableHeaders.weight')}</th>
            <th class="w-20 text-right">{$_('routeCard.tableHeaders.priority')}</th>
          </tr>
        </thead>
        <tbody>
          {#each upstreams as upstream}
            <tr class="hover">
              <td>
                <div class="flex items-center gap-2">
                  <div
                    class="w-3 h-3 rounded-full tooltip tooltip-right"
                    class:bg-success={getUpstreamStatus(upstream) === 'healthy'}
                    class:bg-error={getUpstreamStatus(upstream) === 'unhealthy'}
                    class:bg-warning={getUpstreamStatus(upstream) === 'unknown'}
                    data-tip={upstream.lastFailureTime
                      ? `最后失败: ${formatLastFailureTime(upstream.lastFailureTime)}`
                      : getUpstreamStatus(upstream) === 'healthy'
                        ? $_('upstreamsModal.statusHealthy')
                        : getUpstreamStatus(upstream) === 'unhealthy'
                          ? $_('upstreamsModal.statusUnhealthy')
                          : $_('upstreamsModal.statusUnknown')}
                  ></div>
                  {#if getUpstreamStatus(upstream) === 'unhealthy'}
                    <span class="text-xs text-error font-semibold">RED</span>
                  {/if}
                </div>
              </td>
              <td>
                <code class="text-sm">{upstream.target}</code>
              </td>
              <td class="text-right">{upstream.weight || 100}</td>
              <td class="text-right">{upstream.priority || 1}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <div class="modal-action">
      <button class="btn" on:click={closeModal}>{$_('upstreamsModal.close')}</button>
    </div>
  </div>
  <form method="dialog" class="modal-backdrop">
    <button on:click={closeModal}>close</button>
  </form>
</dialog>
