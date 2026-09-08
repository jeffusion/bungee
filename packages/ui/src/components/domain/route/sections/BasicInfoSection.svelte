<script lang="ts">
  import type { Route } from '$api/routes';
  import type { ValidationError } from '$validation';
  import PluginEditor from '$components/domain/plugin/PluginEditor.svelte';
  import ConfirmDialog from '$components/shell/ConfirmDialog.svelte';
  import { _ } from '$i18n';
  import { Input } from '$components/ui/input';

  export let route: Route;
  export let errors: ValidationError[] = [];
  export let showOnly: 'path' | 'rewrite' | 'timeouts' | 'plugins' | undefined = undefined;

  let pathRewriteEntries: Array<{ pattern: string; replacement: string }> = [];
  let rewriteInitialized = false;
  let confirmDeleteIndex: number | null = null;

  let requestMs: number | undefined;
  let timeoutsInitialized = false;

  function compactObject<T extends Record<string, any>>(value: T): T | undefined {
    const entries = Object.entries(value).filter(([, child]) => {
      if (child === undefined) return false;
      if (typeof child === 'object' && child !== null && !Array.isArray(child) && Object.keys(child).length === 0) return false;
      return true;
    });
    return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
  }

  function syncTimeouts(): void {
    route.timeouts = compactObject({ request_ms: requestMs });
  }

  // Guard prevents dual-instance race: only one BasicInfoSection (showOnly='rewrite')
  // owns path_rewrite state. rewriteInitialized is one-time to prevent delete-then-restore.
  $: if (showOnly === undefined || showOnly === 'rewrite') {
    if (!rewriteInitialized) {
      if (route.path_rewrite) {
        pathRewriteEntries = Object.entries(route.path_rewrite).map(([pattern, replacement]) => ({ pattern, replacement }));
      }
      rewriteInitialized = true;
    }
    const rewrite: Record<string, string> = {};
    pathRewriteEntries
      .filter((e) => e.pattern.trim())
      .forEach((e) => { rewrite[e.pattern] = e.replacement; });
    
    const nextRewrite = Object.keys(rewrite).length > 0 ? rewrite : undefined;
    if (JSON.stringify(route.path_rewrite) !== JSON.stringify(nextRewrite)) {
      route.path_rewrite = nextRewrite;
    }
  }

  $: if (!route.plugins) {
    route.plugins = [];
  }

  $: if (!timeoutsInitialized) {
    requestMs = route.timeouts?.request_ms;
    timeoutsInitialized = true;
  }

  function addPathRewrite() {
    pathRewriteEntries = [...pathRewriteEntries, { pattern: '', replacement: '' }];
  }
  function requestDeletePathRewrite(index: number) { confirmDeleteIndex = index; }
  function confirmDelete() {
    if (confirmDeleteIndex !== null) {
      pathRewriteEntries = pathRewriteEntries.filter((_, i) => i !== confirmDeleteIndex);
      confirmDeleteIndex = null;
    }
  }
  function cancelDelete() { confirmDeleteIndex = null; }

  function isInvalidRegex(value: string): boolean {
    if (!value) return false;
    try {
      new RegExp(value);
      return false;
    } catch (_error) {
      return true;
    }
  }

  $: pathError = errors.find((e) => e.field === 'path');
</script>

<div class="space-y-4">
  {#if showOnly === undefined || showOnly === 'path'}
    <div class="space-y-1.5">
      <label class="block space-y-1.5">
        <span class="nx-field-label">// {$_('routes.path')} *</span>
        <Input
          type="text"
          placeholder={$_('routeEditor.pathPlaceholder')}
          bind:value={route.path}
          required={true}
          data-testid="route-path-input"
        />
      </label>
      <span
        class="block text-sm"
        class:text-red-300={!!pathError}
        class:text-zinc-400={!pathError}
      >
        {pathError ? pathError.message : $_('routeEditor.pathHelpLong')}
      </span>
    </div>
  {/if}

  {#if showOnly === undefined || showOnly === 'rewrite'}
    <div class="border border-carbon-600 bg-carbon-950/60">
      <div class="flex items-center gap-2 px-3 py-2 border-b border-carbon-600">
        <span class="nx-stripe" aria-hidden="true"></span>
        <span class="font-mono text-[11px] uppercase tracking-command text-zinc-200">{$_('routeEditor.pathRewrite')}</span>
        <span class="font-mono text-[10px] uppercase tracking-command text-zinc-600">({$_('routeEditor.optional')})</span>
      </div>
      <div class="p-3 space-y-2">
        {#each pathRewriteEntries as entry, index}
          <div class="flex gap-2 items-center">
            <div class="flex-1">
              <Input
                type="text"
                placeholder={$_('routeEditor.patternPlaceholder')}
                bind:value={entry.pattern}
                aria-invalid={isInvalidRegex(entry.pattern)}
              />
            </div>
            <svg viewBox="0 0 24 24" class="h-4 w-4 text-zinc-500 shrink-0" fill="none" stroke="currentColor" stroke-width="1.8">
              <path stroke-linecap="round" stroke-linejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
            <div class="flex-1">
              <Input type="text" placeholder={$_('routeEditor.replacementPlaceholder')} bind:value={entry.replacement} />
            </div>
            <button
              type="button"
              class="inline-flex items-center justify-center h-9 w-9 border-2 border-red-500 bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors"
              on:click={() => requestDeletePathRewrite(index)}
              aria-label={$_('common.delete')}
            >
              <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        {/each}
        <button type="button" class="nx-btn-ghost" on:click={addPathRewrite}>
          <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          {$_('routeEditor.addPathRewriteRule')}
        </button>
      </div>
    </div>
  {/if}

  {#if showOnly === undefined || showOnly === 'timeouts'}
    <div class="space-y-3">
      <p class="text-sm text-zinc-400">{$_('routeEditor.requestTimeoutMsHelp')}</p>
      <label class="block space-y-1.5">
        <span class="nx-field-label">// {$_('routeEditor.requestTimeoutMs')}</span>
        <input type="number" placeholder="30000" class="nx-input" bind:value={requestMs} min="100" on:input={syncTimeouts} />
      </label>
    </div>
  {/if}

  {#if showOnly === undefined || showOnly === 'plugins'}
    <div class="space-y-3">
      <p class="text-sm text-zinc-400">{$_('routeEditor.routePluginsHelp')}</p>
      <PluginEditor bind:plugins={route.plugins} label="" />
    </div>
  {/if}
</div>

<ConfirmDialog
  open={confirmDeleteIndex !== null}
  title={$_('common.confirm')}
  message={$_('routeEditor.confirmDeleteRule')}
  confirmText={$_('common.delete')}
  cancelText={$_('common.cancel')}
  confirmClass="nx-btn-danger"
  on:confirm={confirmDelete}
  on:cancel={cancelDelete}
/>
