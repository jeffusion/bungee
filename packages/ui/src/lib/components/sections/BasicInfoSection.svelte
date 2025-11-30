<script lang="ts">
  import type { Route } from '../../api/routes';
  import type { ValidationError } from '../../validation';
  import PluginEditor from '../PluginEditor.svelte';
  import ConfirmDialog from '../ConfirmDialog.svelte';
  import { _ } from '../../i18n';

  export let route: Route;
  export let errors: ValidationError[] = [];
  export let isEditMode: boolean = false;

  // Path rewrite entries
  let pathRewriteEntries: Array<{ pattern: string; replacement: string }> = [];
  let confirmDeleteIndex: number | null = null;

  $: {
    if (!pathRewriteEntries.length && route.pathRewrite) {
      pathRewriteEntries = Object.entries(route.pathRewrite || {}).map(([pattern, replacement]) => ({
        pattern,
        replacement
      }));
    }
    const rewrite: Record<string, string> = {};
    pathRewriteEntries
      .filter(e => e.pattern.trim())
      .forEach(e => {
        rewrite[e.pattern] = e.replacement;
      });
    route.pathRewrite = Object.keys(rewrite).length > 0 ? rewrite : undefined;
  }

  // Plugin handling - convert between single value UI and array storage
  let routePlugin = route.plugins?.[0] || null;
  $: route.plugins = routePlugin ? [routePlugin] : undefined;

  function addPathRewrite() {
    pathRewriteEntries = [...pathRewriteEntries, { pattern: '', replacement: '' }];
  }

  function requestDeletePathRewrite(index: number) {
    confirmDeleteIndex = index;
  }

  function confirmDelete() {
    if (confirmDeleteIndex !== null) {
      pathRewriteEntries = pathRewriteEntries.filter((_, i) => i !== confirmDeleteIndex);
      confirmDeleteIndex = null;
    }
  }

  function cancelDelete() {
    confirmDeleteIndex = null;
  }
</script>

<div class="space-y-6">
  <!-- Path -->
  <div class="form-control">
    <label class="label" for="route-path">
      <span class="label-text font-semibold">
        {$_('routes.path')} <span class="text-error">*</span>
      </span>
    </label>
    <input
      id="route-path"
      type="text"
      placeholder={$_('routeEditor.pathPlaceholder')}
      class="input input-bordered"
      class:input-error={errors.some(e => e.field === 'path')}
      bind:value={route.path}
      required
    />
    <label class="label">
      {#if errors.some(e => e.field === 'path')}
        <span class="label-text-alt text-error">
          {errors.find(e => e.field === 'path')?.message}
        </span>
      {:else}
        <span class="label-text-alt text-gray-500">
          {$_('routeEditor.pathHelpLong')}
        </span>
      {/if}
    </label>
  </div>

  <!-- Path Rewrite -->
  <div class="form-control">
    <label class="label" for="path-rewrite-pattern-0">
      <span class="label-text font-semibold flex items-center gap-2">
        {$_('routeEditor.pathRewrite')} ({$_('routeEditor.optional')})
        <div
          class="tooltip tooltip-right"
          data-tip={$_('routeEditor.pathRewriteTooltip')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-gray-400 cursor-help" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
      </span>
    </label>
    <div class="space-y-2">
      {#each pathRewriteEntries as entry, index}
        <div class="flex gap-2 items-center">
          <input
            id={`path-rewrite-pattern-${index}`}
            type="text"
            placeholder={$_('routeEditor.patternPlaceholder')}
            class="input input-bordered input-sm flex-1"
            bind:value={entry.pattern}
          />
          <!-- Arrow Icon -->
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
          <input
            id={`path-rewrite-replacement-${index}`}
            type="text"
            placeholder={$_('routeEditor.replacementPlaceholder')}
            class="input input-bordered input-sm flex-1"
            bind:value={entry.replacement}
          />
          <button
            type="button"
            class="btn btn-sm btn-error btn-square flex-shrink-0"
            on:click={() => requestDeletePathRewrite(index)}
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      {/each}
      <button
        type="button"
        class="btn btn-sm btn-outline gap-2"
        on:click={addPathRewrite}
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
        {$_('routeEditor.addPathRewriteRule')}
      </button>
    </div>
  </div>

  <div class="divider"></div>

  <!-- Route-level Plugin/Transformer -->
  <div>
    <h3 class="text-lg font-semibold mb-2">{$_('routeEditor.transformer')}</h3>
    <p class="text-sm text-gray-500 mb-4">
      {$_('routeEditor.transformerHelp')}
    </p>
    <PluginEditor bind:plugin={routePlugin} label={$_('routeEditor.transformer')} />
  </div>
</div>

<!-- Confirm Delete Dialog -->
<ConfirmDialog
  open={confirmDeleteIndex !== null}
  title={$_('common.confirm')}
  message={$_('routeEditor.confirmDeleteRule')}
  confirmText={$_('common.delete')}
  cancelText={$_('common.cancel')}
  confirmClass="btn-error"
  on:confirm={confirmDelete}
  on:cancel={cancelDelete}
/>
