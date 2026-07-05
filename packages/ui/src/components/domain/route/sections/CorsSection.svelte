<script lang="ts">
import type { Route } from '$api/routes';
import { _ } from '$i18n';
import { Input } from '$components/ui/input';
import { Button } from '$components/ui/button';
import { BSwitch, BCheckbox } from '$components/industrial';

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

  function handleCredentialsChange(checked: boolean) {
    route.cors.allow_credentials = checked;
  }
</script>

<div class="space-y-4">
  <p class="text-xs text-zinc-500">{$_('routeEditor.corsHelp')}</p>

  <BSwitch bind:checked={route.cors.enabled} label={$_('routeEditor.enableCors')} />

  {#if route.cors.enabled}
    <div class="space-y-4">
      <!-- Allowed origins -->
      <div class="space-y-1.5">
        <label class="font-mono text-[11px] uppercase tracking-command text-zinc-400">// {$_('routeEditor.allowedOrigins')}</label>
        {#if route.cors.allowed_origins && route.cors.allowed_origins.length > 0}
          <div class="flex flex-wrap gap-1.5">
            {#each route.cors.allowed_origins as origin, i}
              <span class="inline-flex items-center gap-1.5 border border-carbon-500 bg-carbon-900 px-2 py-0.5 font-mono text-[11px] text-zinc-200">
                {origin}
                <button type="button" class="text-zinc-500 hover:text-red-300 transition-colors" onclick={() => removeOrigin(i)}>
                  <svg viewBox="0 0 24 24" class="h-2.5 w-2.5" fill="none" stroke="currentColor" stroke-width="2.4">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            {/each}
          </div>
        {/if}
        <div class="flex items-center gap-1">
          <Input
            type="text"
            class="flex-1"
            placeholder={$_('routeEditor.addOrigin')}
            bind:value={newOrigin}
            onkeydown={(e) => e.key === 'Enter' && addOrigin()}
          />
          <Button variant="ghost" size="default" onclick={addOrigin}>{$_('common.add')}</Button>
          <Button variant="ghost" size="default" onclick={() => { newOrigin = '*'; addOrigin(); }}>*</Button>
        </div>
      </div>

      <!-- Allowed methods -->
      <div class="space-y-1.5">
        <label class="font-mono text-[11px] uppercase tracking-command text-zinc-400">// {$_('routeEditor.allowedMethods')}</label>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-1.5">
          {#each httpMethods as method}
            <BCheckbox
              label={method}
              checked={(route.cors.allowed_methods || []).includes(method)}
              onchange={() => toggleMethod(method)}
              class="w-full border border-carbon-600 bg-carbon-900/60 px-2 py-1.5"
            />
          {/each}
        </div>
      </div>

      <!-- Allowed headers -->
      <div class="space-y-1.5">
        <label class="font-mono text-[11px] uppercase tracking-command text-zinc-400">// {$_('routeEditor.allowedHeaders')}</label>
        {#if route.cors.allowed_headers && route.cors.allowed_headers.length > 0}
          <div class="flex flex-wrap gap-1.5">
            {#each route.cors.allowed_headers as header, i}
              <span class="inline-flex items-center gap-1.5 border border-carbon-500 bg-carbon-900 px-2 py-0.5 font-mono text-[11px] text-zinc-200">
                {header}
                <button type="button" class="text-zinc-500 hover:text-red-300 transition-colors" onclick={() => removeAllowedHeader(i)}>
                  <svg viewBox="0 0 24 24" class="h-2.5 w-2.5" fill="none" stroke="currentColor" stroke-width="2.4">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            {/each}
          </div>
        {/if}
        <div class="flex items-center gap-1">
          <Input
            type="text"
            class="flex-1"
            placeholder={$_('routeEditor.addHeader')}
            bind:value={newAllowedHeader}
            onkeydown={(e) => e.key === 'Enter' && addAllowedHeader()}
          />
          <Button variant="ghost" size="default" onclick={addAllowedHeader}>{$_('common.add')}</Button>
        </div>
      </div>

      <!-- Expose headers -->
      <div class="space-y-1.5">
        <label class="font-mono text-[11px] uppercase tracking-command text-zinc-400">// {$_('routeEditor.exposeHeaders')}</label>
        {#if route.cors.exposed_headers && route.cors.exposed_headers.length > 0}
          <div class="flex flex-wrap gap-1.5">
            {#each route.cors.exposed_headers as header, i}
              <span class="inline-flex items-center gap-1.5 border border-carbon-500 bg-carbon-900 px-2 py-0.5 font-mono text-[11px] text-zinc-200">
                {header}
                <button type="button" class="text-zinc-500 hover:text-red-300 transition-colors" onclick={() => removeExposeHeader(i)}>
                  <svg viewBox="0 0 24 24" class="h-2.5 w-2.5" fill="none" stroke="currentColor" stroke-width="2.4">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            {/each}
          </div>
        {/if}
        <div class="flex items-center gap-1">
          <Input
            type="text"
            class="flex-1"
            placeholder={$_('routeEditor.addHeader')}
            bind:value={newExposeHeader}
            onkeydown={(e) => e.key === 'Enter' && addExposeHeader()}
          />
          <Button variant="ghost" size="default" onclick={addExposeHeader}>{$_('common.add')}</Button>
        </div>
      </div>

      <!-- Credentials + max age -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <BCheckbox
          label={$_('routeEditor.allowCredentials')}
          checked={route.cors.allow_credentials}
          onchange={handleCredentialsChange}
        />
        <label class="block space-y-1.5">
          <span class="font-mono text-[11px] uppercase tracking-command text-zinc-400">// {$_('routeEditor.maxAge')}</span>
          <Input type="number" bind:value={route.cors.max_age} placeholder="e.g. 3600" />
        </label>
      </div>
    </div>
  {/if}
</div>
