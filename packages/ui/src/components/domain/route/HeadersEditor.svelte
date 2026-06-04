<script lang="ts">
  import type { ModificationRules } from '$api/routes';
  import { _ } from '$i18n';
  import { Input } from '$components/ui/input';
  import { commonHttpHeaders } from '$components/industrial/data/http-headers';

  export let value: ModificationRules = {};
  export let label: string = 'Headers';
  export let showHelp: boolean = true;
  export let showLabel: boolean = true;

  let addEntries: Array<{ key: string; value: string }> = [];
  let removeEntries: string[] = [];
  let removeInputValue = '';
  let replaceEntries: Array<{ key: string; value: string }> = [];
  let defaultEntries: Array<{ key: string; value: string }> = [];
  let initialized = false;

  // This reactive block now serves two purposes:
  // 1. One-time initialization of local state (addEntries, etc.) from the `value` prop.
  // 2. Continuously watching local state and updating the `value` prop.
  $: {
    // Initialize from prop only once
    if (!initialized && (value.add || value.remove || value.replace || value.default)) {
      addEntries = Object.entries(value.add || {}).map(([key, val]) => ({
        key,
        value: String(val)
      }));
      removeEntries = [...(value.remove || [])];
      replaceEntries = Object.entries(value.replace || {}).map(([key, val]) => ({
        key,
        value: String(val)
      }));
      defaultEntries = Object.entries(value.default || {}).map(([key, val]) => ({
        key,
        value: String(val)
      }));
      // Prevent re-initialization which would overwrite user input
      initialized = true;
    }

    // Update prop from local state reactively
    const add: Record<string, string> = {};
    addEntries
      .filter(e => e.key.trim())
      .forEach(e => {
        add[e.key] = e.value;
      });
    value.add = Object.keys(add).length > 0 ? add : undefined;

    value.remove = removeEntries.length > 0 ? removeEntries : undefined;

    const replace: Record<string, string> = {};
    replaceEntries
      .filter(e => e.key.trim())
      .forEach(e => {
        replace[e.key] = e.value;
      });
    value.replace = Object.keys(replace).length > 0 ? replace : undefined;

    const def: Record<string, string> = {};
    defaultEntries
      .filter(e => e.key.trim())
      .forEach(e => {
        def[e.key] = e.value;
      });
    value.default = Object.keys(def).length > 0 ? def : undefined;
  }

  function addHeader() {
    addEntries = [...addEntries, { key: '', value: '' }];
    initialized = true; // Mark as initialized on user interaction
  }

  function removeAddEntry(index: number) {
    addEntries = addEntries.filter((_, i) => i !== index);
  }

  function addRemoveEntry() {
    const trimmed = removeInputValue.trim();
    if (trimmed && !removeEntries.includes(trimmed)) {
      removeEntries = [...removeEntries, trimmed];
      removeInputValue = '';
      initialized = true;
    }
  }

  function removeRemoveEntry(index: number) {
    removeEntries = removeEntries.filter((_, i) => i !== index);
  }

  function handleRemoveKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      addRemoveEntry();
    }
  }

  function addReplaceHeader() {
    replaceEntries = [...replaceEntries, { key: '', value: '' }];
    initialized = true;
  }

  function removeReplaceEntry(index: number) {
    replaceEntries = replaceEntries.filter((_, i) => i !== index);
  }

  function addDefaultHeader() {
    defaultEntries = [...defaultEntries, { key: '', value: '' }];
    initialized = true; // Mark as initialized on user interaction
  }

  function removeDefaultEntry(index: number) {
    defaultEntries = defaultEntries.filter((_, i) => i !== index);
  }
</script>

<div class="w-full space-y-1">
  {#if showLabel}
  <div class="block">
    <span class="nx-label-sm font-semibold">{label}</span>
    {#if showHelp}
      <span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">
        Support dynamic expressions: <code class="text-xs">{'{{ expression }}'}</code>
      </span>
    {/if}
  </div>
  {/if}

  <div class="space-y-4">
    <!-- Add Headers -->
    <div class="border border-carbon-600 bg-carbon-950/60">
      <div class="px-3 py-2 font-mono text-[11px] uppercase tracking-command text-zinc-200 border-b border-carbon-600">
        {$_('headers.add')} ({addEntries.length})
      </div>
      <div class="p-3 space-y-2">
        {#each addEntries as entry, index}
          <div class="flex gap-2">
            <div class="flex-1">
              <Input
                type="text"
                placeholder={$_('headers.namePlaceholder')}
                bind:value={entry.key}
                list="headers-editor-common-headers"
              />
            </div>
            <div class="flex-1">
              <Input
                type="text"
                placeholder={$_('headers.valuePlaceholder')}
                bind:value={entry.value}
              />
            </div>
            <button
              type="button"
              class="inline-flex items-center justify-center h-9 w-9 border-2 border-red-500 bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors"
              on:click={() => removeAddEntry(index)}
            >
              ✕
            </button>
          </div>
        {/each}
        <button
          type="button"
          class="nx-btn-ghost nx-btn-sm"
          on:click={addHeader}
        >
          {$_('headers.add')}
        </button>
      </div>
    </div>

    <!-- Remove Headers -->
    <div class="border border-carbon-600 bg-carbon-950/60">
      <div class="px-3 py-2 font-mono text-[11px] uppercase tracking-command text-zinc-200 border-b border-carbon-600">
        {$_('headers.remove')} ({removeEntries.length})
      </div>
      <div class="p-3 space-y-2">
        <div class="flex gap-2">
          <div class="flex-1">
            <Input
              type="text"
              placeholder={$_('headers.namePlaceholder')}
              bind:value={removeInputValue}
              list="headers-editor-common-headers"
              onkeydown={handleRemoveKeydown}
            />
          </div>
          <button
            type="button"
            class="nx-btn-primary nx-btn-sm"
            on:click={addRemoveEntry}
            disabled={!removeInputValue.trim()}
          >
            {$_('common.add')}
          </button>
        </div>
        {#if removeEntries.length > 0}
          <div class="flex flex-wrap gap-2 mt-2">
            {#each removeEntries as entry, index}
              <div class="inline-flex items-center gap-1.5 border border-carbon-500 bg-carbon-900 px-2 py-0.5 font-mono text-[11px] text-zinc-200">
                {entry}
                <button
                  type="button"
                  class="inline-flex items-center justify-center h-5 w-5 text-zinc-500 hover:text-red-300 transition-colors"
                  on:click={() => removeRemoveEntry(index)}
                >
                  ✕
                </button>
              </div>
            {/each}
          </div>
        {:else}
          <p class="text-xs text-zinc-500">
            {$_('headers.empty')}
          </p>
        {/if}
      </div>
    </div>

    <!-- Replace Headers -->
    <div class="border border-carbon-600 bg-carbon-950/60">
      <div class="px-3 py-2 font-mono text-[11px] uppercase tracking-command text-zinc-200 border-b border-carbon-600">
        {$_('headers.replace')} ({replaceEntries.length})
      </div>
      <div class="p-3 space-y-2">
        {#each replaceEntries as entry, index}
          <div class="flex gap-2">
            <div class="flex-1">
              <Input
                type="text"
                placeholder={$_('headers.namePlaceholder')}
                bind:value={entry.key}
                list="headers-editor-common-headers"
              />
            </div>
            <div class="flex-1">
              <Input
                type="text"
                placeholder={$_('headers.valuePlaceholder')}
                bind:value={entry.value}
              />
            </div>
            <button
              type="button"
              class="inline-flex items-center justify-center h-9 w-9 border-2 border-red-500 bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors"
              on:click={() => removeReplaceEntry(index)}
            >
              ✕
            </button>
          </div>
        {/each}
        <button
          type="button"
          class="nx-btn-ghost nx-btn-sm"
          on:click={addReplaceHeader}
        >
          {$_('headers.add')}
        </button>
      </div>
    </div>

    <!-- Default Headers -->
    <div class="border border-carbon-600 bg-carbon-950/60">
      <div class="px-3 py-2 font-mono text-[11px] uppercase tracking-command text-zinc-200 border-b border-carbon-600">
        {$_('headers.default')} ({defaultEntries.length})
      </div>
      <div class="p-3 space-y-2">
        {#each defaultEntries as entry, index}
          <div class="flex gap-2">
            <div class="flex-1">
              <Input
                type="text"
                placeholder={$_('headers.namePlaceholder')}
                bind:value={entry.key}
                list="headers-editor-common-headers"
              />
            </div>
            <div class="flex-1">
              <Input
                type="text"
                placeholder={$_('headers.valuePlaceholder')}
                bind:value={entry.value}
              />
            </div>
            <button
              type="button"
              class="inline-flex items-center justify-center h-9 w-9 border-2 border-red-500 bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors"
              on:click={() => removeDefaultEntry(index)}
            >
              ✕
            </button>
          </div>
        {/each}
        <button
          type="button"
          class="nx-btn-ghost nx-btn-sm"
          on:click={addDefaultHeader}
        >
          {$_('headers.add')}
        </button>
      </div>
    </div>
  </div>
  <datalist id="headers-editor-common-headers">
    {#each commonHttpHeaders as header}
      <option value={header}>{header}</option>
    {/each}
  </datalist>
</div>
