<script lang="ts">
import type { Route } from '$api/routes';
import { _ } from '$i18n';
import { BSwitch } from '$components/industrial';

  export let route: Route;

  $: if (!route.cors) {
    route.cors = { enabled: false };
  }

  const httpMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];

  let newOrigin = '';
  function addOrigin() {
    if (!newOrigin.trim()) return;
    route.cors = route.cors || { enabled: false };
    route.cors.allowed_origins = [...(route.cors.allowed_origins || []), newOrigin.trim()];
    newOrigin = '';
  }
  function removeOrigin(index: number) {
    if (route.cors) route.cors.allowed_origins = route.cors.allowed_origins?.filter((_, i) => i !== index);
  }

  let newAllowedHeader = '';
  function addAllowedHeader() {
    if (!newAllowedHeader.trim()) return;
    route.cors = route.cors || { enabled: false };
    route.cors.allowed_headers = [...(route.cors.allowed_headers || []), newAllowedHeader.trim()];
    newAllowedHeader = '';
  }
  function removeAllowedHeader(index: number) {
    if (route.cors) route.cors.allowed_headers = route.cors.allowed_headers?.filter((_, i) => i !== index);
  }

  let newExposeHeader = '';
  function addExposeHeader() {
    if (!newExposeHeader.trim()) return;
    route.cors = route.cors || { enabled: false };
    route.cors.exposed_headers = [...(route.cors.exposed_headers || []), newExposeHeader.trim()];
    newExposeHeader = '';
  }
  function removeExposeHeader(index: number) {
    if (route.cors) route.cors.exposed_headers = route.cors.exposed_headers?.filter((_, i) => i !== index);
  }

  function toggleMethod(method: string) {
    if (!route.cors) return;
    const methods = route.cors.allowed_methods || [];
    route.cors.allowed_methods = methods.includes(method)
      ? methods.filter((m) => m !== method)
      : [...methods, method];
  }
</script>

<div class="space-y-4">
  <p class="text-xs text-zinc-500">{$_('routeEditor.corsHelp')}</p>

  <BSwitch bind:checked={route.cors.enabled} label={$_('routeEditor.enableCors')} />

  {#if route.cors.enabled}
    <div class="border-l-2 border-l-nexus-500/40 pl-4 space-y-4">
      <!-- Allowed origins -->
      <div class="space-y-1.5">
        <span class="nx-label">// {$_('routeEditor.allowedOrigins')}</span>
        {#if route.cors.allowed_origins && route.cors.allowed_origins.length > 0}
          <div class="flex flex-wrap gap-1.5">
            {#each route.cors.allowed_origins as origin, i}
              <span class="inline-flex items-center gap-1.5 border border-carbon-500 bg-carbon-900 px-2 py-0.5 font-mono text-[11px] text-zinc-200">
                {origin}
                <button type="button" class="text-zinc-500 hover:text-red-300 transition-colors" on:click={() => removeOrigin(i)}>
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
            type="text"
            class="nx-input flex-1"
            placeholder={$_('routeEditor.addOrigin')}
            bind:value={newOrigin}
            on:keydown={(e) => e.key === 'Enter' && addOrigin()}
          />
          <button type="button" class="nx-btn-ghost" on:click={addOrigin}>{$_('common.add')}</button>
          <button type="button" class="nx-btn-ghost" on:click={() => { newOrigin = '*'; addOrigin(); }}>*</button>
        </div>
      </div>

      <!-- Allowed methods -->
      <div class="space-y-1.5">
        <span class="nx-label">// {$_('routeEditor.allowedMethods')}</span>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-1.5">
            {#each httpMethods as method}
            <label class="flex items-center gap-2 border border-carbon-600 bg-carbon-900/60 px-2 py-1.5 cursor-pointer hover:border-nexus-500/60 transition-colors">
              <input
                type="checkbox"
                class="h-4 w-4 accent-orange-500"
                checked={(route.cors.allowed_methods || []).includes(method)}
                on:change={() => toggleMethod(method)}
              />
              <span class="font-mono text-[11px] uppercase tracking-command text-zinc-300">{method}</span>
            </label>
          {/each}
        </div>
      </div>

      <!-- Allowed headers -->
      <div class="space-y-1.5">
        <span class="nx-label">// {$_('routeEditor.allowedHeaders')}</span>
        {#if route.cors.allowed_headers && route.cors.allowed_headers.length > 0}
          <div class="flex flex-wrap gap-1.5">
            {#each route.cors.allowed_headers as header, i}
              <span class="inline-flex items-center gap-1.5 border border-carbon-500 bg-carbon-900 px-2 py-0.5 font-mono text-[11px] text-zinc-200">
                {header}
                <button type="button" class="text-zinc-500 hover:text-red-300 transition-colors" on:click={() => removeAllowedHeader(i)}>
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
            type="text"
            class="nx-input flex-1"
            placeholder={$_('routeEditor.addHeader')}
            bind:value={newAllowedHeader}
            on:keydown={(e) => e.key === 'Enter' && addAllowedHeader()}
          />
          <button type="button" class="nx-btn-ghost" on:click={addAllowedHeader}>{$_('common.add')}</button>
        </div>
      </div>

      <!-- Expose headers -->
      <div class="space-y-1.5">
        <span class="nx-label">// {$_('routeEditor.exposeHeaders')}</span>
        {#if route.cors.exposed_headers && route.cors.exposed_headers.length > 0}
          <div class="flex flex-wrap gap-1.5">
            {#each route.cors.exposed_headers as header, i}
              <span class="inline-flex items-center gap-1.5 border border-carbon-500 bg-carbon-900 px-2 py-0.5 font-mono text-[11px] text-zinc-200">
                {header}
                <button type="button" class="text-zinc-500 hover:text-red-300 transition-colors" on:click={() => removeExposeHeader(i)}>
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
            type="text"
            class="nx-input flex-1"
            placeholder={$_('routeEditor.addHeader')}
            bind:value={newExposeHeader}
            on:keydown={(e) => e.key === 'Enter' && addExposeHeader()}
          />
          <button type="button" class="nx-btn-ghost" on:click={addExposeHeader}>{$_('common.add')}</button>
        </div>
      </div>

      <!-- Credentials + max age -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label class="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" class="h-4 w-4 accent-orange-500" bind:checked={route.cors.allow_credentials} />
          <span class="font-mono text-[11px] uppercase tracking-command text-zinc-300">{$_('routeEditor.allowCredentials')}</span>
        </label>
        <label class="block space-y-1.5">
          <span class="nx-label">// {$_('routeEditor.maxAge')}</span>
          <input type="number" class="nx-input" bind:value={route.cors.max_age} placeholder="e.g. 3600" />
        </label>
      </div>
    </div>
  {/if}
</div>
