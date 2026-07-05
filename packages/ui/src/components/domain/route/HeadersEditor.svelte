<script lang="ts">
  import type { ModificationRules } from '$api/routes';
  import { _ } from '$i18n';
  import { Input } from '$components/ui/input';
  import { Button } from '$components/ui/button';
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

  // Combobox open state per section + entry index
  let openCombobox: Record<string, boolean> = {};
  let comboboxSearch: Record<string, string> = {};

  function filteredHeaders(search: string): string[] {
    const q = search.toLowerCase();
    return commonHttpHeaders.filter(h => h.toLowerCase().includes(q));
  }

  function openComboboxFor(id: string, currentValue: string) {
    // Close all other comboboxes first — reassign to trigger reactivity
    const updated: Record<string, boolean> = {};
    updated[id] = true;
    openCombobox = updated;
    comboboxSearch[id] = currentValue;
  }

  function closeCombobox(id: string) {
    openCombobox[id] = false;
  }

  function selectAddHeader(index: number, header: string, id: string) {
    addEntries[index].key = header;
    addEntries = [...addEntries];
    openCombobox[id] = false;
  }

  function selectReplaceHeader(index: number, header: string, id: string) {
    replaceEntries[index].key = header;
    replaceEntries = [...replaceEntries];
    openCombobox[id] = false;
  }

  function selectDefaultHeader(index: number, header: string, id: string) {
    defaultEntries[index].key = header;
    defaultEntries = [...defaultEntries];
    openCombobox[id] = false;
  }

  function selectRemoveHeader(header: string, id: string) {
    removeInputValue = header;
    openCombobox[id] = false;
  }

  // One-time initialization from prop — runs once on mount
  import { onMount } from 'svelte';
  onMount(() => {
    if (value.add || value.remove || value.replace || value.default) {
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
    }
  });

  // Sync local state → prop (write-only, no read of value.* here)
  $: {
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
  }

  function removeAddEntry(index: number) {
    addEntries = addEntries.filter((_, i) => i !== index);
  }

  function addRemoveEntry() {
    const trimmed = removeInputValue.trim();
    if (trimmed && !removeEntries.includes(trimmed)) {
      removeEntries = [...removeEntries, trimmed];
      removeInputValue = '';
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
  }

  function removeReplaceEntry(index: number) {
    replaceEntries = replaceEntries.filter((_, i) => i !== index);
  }

  function addDefaultHeader() {
    defaultEntries = [...defaultEntries, { key: '', value: '' }];
  }

  function removeDefaultEntry(index: number) {
    defaultEntries = defaultEntries.filter((_, i) => i !== index);
  }
</script>

<svelte:window on:click={(e) => {
  // Close all open comboboxes when clicking outside
  for (const id of Object.keys(openCombobox)) {
    if (openCombobox[id]) {
      const container = document.getElementById(`combobox-${id}`);
      if (container && !container.contains(e.target)) {
        openCombobox[id] = false;
      }
    }
  }
}} />

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
          {@const id = `add-${index}`}
          <div class="flex gap-2">
            <div class="flex-1 relative" id="combobox-{id}">
              <Input
                type="text"
                placeholder={$_('headers.namePlaceholder')}
                bind:value={entry.key}
                on:focus={() => openComboboxFor(id, entry.key)}
                on:input={() => { comboboxSearch[id] = entry.key; }}
              />
              {#if openCombobox[id]}
                <div class="absolute z-50 left-0 top-full mt-1 w-full min-w-[200px] max-h-[200px] overflow-y-auto border border-carbon-600 bg-carbon-900 shadow-lg">
                  {#each filteredHeaders(comboboxSearch[id] || entry.key) as header}
                    <button
                      type="button"
                      class="w-full px-3 py-1.5 text-left text-sm hover:bg-nexus-500/10 hover:text-nexus-300 transition-colors"
                      on:click|stopPropagation={() => selectAddHeader(index, header, id)}
                    >
                      {header}
                    </button>
                  {/each}
                  {#if filteredHeaders(comboboxSearch[id] || entry.key).length === 0}
                    <div class="px-3 py-2 text-sm text-zinc-500">{$_('headers.noMatch') || 'No header found'}</div>
                  {/if}
                </div>
              {/if}
            </div>
            <div class="flex-1">
              <Input
                type="text"
                placeholder={$_('headers.valuePlaceholder')}
                bind:value={entry.value}
              />
            </div>
            <Button
              variant="destructive"
              size="icon"
              onclick={() => removeAddEntry(index)}
            >
              ✕
            </Button>
          </div>
        {/each}
        <Button variant="ghost" size="sm" onclick={addHeader}>
          {$_('headers.add')}
        </Button>
      </div>
    </div>

    <!-- Remove Headers -->
    <div class="border border-carbon-600 bg-carbon-950/60">
      <div class="px-3 py-2 font-mono text-[11px] uppercase tracking-command text-zinc-200 border-b border-carbon-600">
        {$_('headers.remove')} ({removeEntries.length})
      </div>
      <div class="p-3 space-y-2">
        <div class="flex gap-2">
          <div class="flex-1 relative" id="combobox-remove-input">
            <Input
              type="text"
              placeholder={$_('headers.namePlaceholder')}
              bind:value={removeInputValue}
              on:focus={() => openComboboxFor('remove-input', removeInputValue)}
              on:input={() => { comboboxSearch['remove-input'] = removeInputValue; }}
              onkeydown={handleRemoveKeydown}
            />
            {#if openCombobox['remove-input']}
              <div class="absolute z-50 left-0 top-full mt-1 w-full min-w-[200px] max-h-[200px] overflow-y-auto border border-carbon-600 bg-carbon-900 shadow-lg">
                {#each filteredHeaders(comboboxSearch['remove-input'] || removeInputValue) as header}
                  <button
                    type="button"
                    class="w-full px-3 py-1.5 text-left text-sm hover:bg-nexus-500/10 hover:text-nexus-300 transition-colors"
                    on:click|stopPropagation={() => selectRemoveHeader(header, 'remove-input')}
                  >
                    {header}
                  </button>
                {/each}
                {#if filteredHeaders(comboboxSearch['remove-input'] || removeInputValue).length === 0}
                  <div class="px-3 py-2 text-sm text-zinc-500">{$_('headers.noMatch') || 'No header found'}</div>
                {/if}
              </div>
            {/if}
          </div>
          <Button variant="default" size="default" onclick={addRemoveEntry} disabled={!removeInputValue.trim()}>
            {$_('common.add')}
          </Button>
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
          {@const id = `replace-${index}`}
          <div class="flex gap-2">
            <div class="flex-1 relative" id="combobox-{id}">
              <Input
                type="text"
                placeholder={$_('headers.namePlaceholder')}
                bind:value={entry.key}
                on:focus={() => openComboboxFor(id, entry.key)}
                on:input={() => { comboboxSearch[id] = entry.key; }}
              />
              {#if openCombobox[id]}
                <div class="absolute z-50 left-0 top-full mt-1 w-full min-w-[200px] max-h-[200px] overflow-y-auto border border-carbon-600 bg-carbon-900 shadow-lg">
                  {#each filteredHeaders(comboboxSearch[id] || entry.key) as header}
                    <button
                      type="button"
                      class="w-full px-3 py-1.5 text-left text-sm hover:bg-nexus-500/10 hover:text-nexus-300 transition-colors"
                      on:click|stopPropagation={() => selectReplaceHeader(index, header, id)}
                    >
                      {header}
                    </button>
                  {/each}
                  {#if filteredHeaders(comboboxSearch[id] || entry.key).length === 0}
                    <div class="px-3 py-2 text-sm text-zinc-500">{$_('headers.noMatch') || 'No header found'}</div>
                  {/if}
                </div>
              {/if}
            </div>
            <div class="flex-1">
              <Input
                type="text"
                placeholder={$_('headers.valuePlaceholder')}
                bind:value={entry.value}
              />
            </div>
            <Button
              variant="destructive"
              size="icon"
              onclick={() => removeReplaceEntry(index)}
            >
              ✕
            </Button>
          </div>
        {/each}
        <Button variant="ghost" size="sm" onclick={addReplaceHeader}>
          {$_('headers.add')}
        </Button>
      </div>
    </div>

    <!-- Default Headers -->
    <div class="border border-carbon-600 bg-carbon-950/60">
      <div class="px-3 py-2 font-mono text-[11px] uppercase tracking-command text-zinc-200 border-b border-carbon-600">
        {$_('headers.default')} ({defaultEntries.length})
      </div>
      <div class="p-3 space-y-2">
        {#each defaultEntries as entry, index}
          {@const id = `default-${index}`}
          <div class="flex gap-2">
            <div class="flex-1 relative" id="combobox-{id}">
              <Input
                type="text"
                placeholder={$_('headers.namePlaceholder')}
                bind:value={entry.key}
                on:focus={() => openComboboxFor(id, entry.key)}
                on:input={() => { comboboxSearch[id] = entry.key; }}
              />
              {#if openCombobox[id]}
                <div class="absolute z-50 left-0 top-full mt-1 w-full min-w-[200px] max-h-[200px] overflow-y-auto border border-carbon-600 bg-carbon-900 shadow-lg">
                  {#each filteredHeaders(comboboxSearch[id] || entry.key) as header}
                    <button
                      type="button"
                      class="w-full px-3 py-1.5 text-left text-sm hover:bg-nexus-500/10 hover:text-nexus-300 transition-colors"
                      on:click|stopPropagation={() => selectDefaultHeader(index, header, id)}
                    >
                      {header}
                    </button>
                  {/each}
                  {#if filteredHeaders(comboboxSearch[id] || entry.key).length === 0}
                    <div class="px-3 py-2 text-sm text-zinc-500">{$_('headers.noMatch') || 'No header found'}</div>
                  {/if}
                </div>
              {/if}
            </div>
            <div class="flex-1">
              <Input
                type="text"
                placeholder={$_('headers.valuePlaceholder')}
                bind:value={entry.value}
              />
            </div>
            <Button
              variant="destructive"
              size="icon"
              onclick={() => removeDefaultEntry(index)}
            >
              ✕
            </Button>
          </div>
        {/each}
        <Button variant="ghost" size="sm" onclick={addDefaultHeader}>
          {$_('headers.add')}
        </Button>
      </div>
    </div>
  </div>
</div>
