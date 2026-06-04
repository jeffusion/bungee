<script lang="ts">
import type { Route } from '$api/routes';
import { _ } from '$i18n';
import { IndustrialToggle } from '$components/industrial';

  export let route: Route;

  $: if (!route.retry) {
    route.retry = { enabled: false };
  }

  let newStatusCode = '';
  function addStatusCode() {
    if (!newStatusCode.trim()) return;
    route.retry = route.retry || { enabled: false };
    const code = parseInt(newStatusCode.trim());
    if (!isNaN(code)) {
      route.retry.retry_on = [...(route.retry.retry_on || []), code];
    }
    newStatusCode = '';
  }

  function removeStatusCode(index: number) {
    if (route.retry) {
      route.retry.retry_on = route.retry.retry_on?.filter((_, i) => i !== index);
    }
  }

  const commonStatusCodes = [502, 503, 504];
</script>

<div class="space-y-4">
  <p class="text-xs text-zinc-500">{$_('routeEditor.retryHelp')}</p>

  <label class="flex items-center gap-3 cursor-pointer">
    <IndustrialToggle bind:checked={route.retry.enabled} title={$_('routeEditor.enableRetry')} />
    <span class="font-mono text-[11px] uppercase tracking-command text-zinc-300">{$_('routeEditor.enableRetry')}</span>
  </label>

  {#if route.retry.enabled}
    <div class="border-l-2 border-l-nexus-500/40 pl-4 space-y-3">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label class="block space-y-1.5">
          <span class="nx-label">// {$_('routeEditor.maxRetries')}</span>
          <input type="number" min="1" max="5" class="nx-input" bind:value={route.retry.max_retries} placeholder="1" />
        </label>
        <label class="block space-y-1.5">
          <span class="nx-label">// {$_('routeEditor.perRetryTimeoutMs')}</span>
          <input type="number" class="nx-input" bind:value={route.retry.per_retry_timeout_ms} placeholder="e.g. 5000" />
        </label>
      </div>

      <div class="space-y-1.5">
        <span class="nx-label">// {$_('routeEditor.retryOn')}</span>

        {#if route.retry.retry_on && route.retry.retry_on.length > 0}
          <div class="flex flex-wrap gap-1.5">
            {#each route.retry.retry_on as code, i}
              <span class="inline-flex items-center gap-1.5 border border-carbon-500 bg-carbon-900 px-2 py-0.5 font-mono text-[11px] text-zinc-200">
                {code}
                <button
                  type="button"
                  class="text-zinc-500 hover:text-red-300 transition-colors"
                  on:click={() => removeStatusCode(i)}
                  aria-label="remove"
                >
                  <svg viewBox="0 0 24 24" class="h-2.5 w-2.5" fill="none" stroke="currentColor" stroke-width="2.4">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            {/each}
          </div>
        {/if}

        <div class="flex items-stretch gap-1">
          <input
            type="number"
            class="nx-input flex-1"
            placeholder={$_('routeEditor.statusCode')}
            bind:value={newStatusCode}
            on:keydown={(e) => e.key === 'Enter' && addStatusCode()}
          />
          <button type="button" class="nx-btn-ghost" on:click={addStatusCode}>{$_('common.add')}</button>
          {#each commonStatusCodes as code}
            <button
              type="button"
              class="nx-btn-ghost"
              on:click={() => { newStatusCode = code.toString(); addStatusCode(); }}
            >
              {code}
            </button>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>
