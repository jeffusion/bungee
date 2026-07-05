<script lang="ts">
  import type { ModificationRules } from '$api/routes';
  import { _ } from '$i18n';
  import { Input } from '$components/ui/input';
  import { Button } from '$components/ui/button';

  export let value: ModificationRules = {};
  export let label: string = 'Body';
  export let showHelp: boolean = true;
  export let showLabel: boolean = true;

  let addEntries: Array<{ key: string; value: string }> = [];
  let removeEntries: string[] = [];
  let removeInputValue = '';
  let replaceEntries: Array<{ key: string; value: string }> = [];
  let defaultEntries: Array<{ key: string; value: string }> = [];

  // One-time initialization from prop
  import { onMount } from 'svelte';
  onMount(() => {
    if (value.add || value.remove || value.replace || value.default) {
      addEntries = Object.entries(value.add || {}).map(([key, val]) => ({
        key,
        value: typeof val === 'string' ? val : JSON.stringify(val)
      }));
      removeEntries = [...(value.remove || [])];
      replaceEntries = Object.entries(value.replace || {}).map(([key, val]) => ({
        key,
        value: typeof val === 'string' ? val : JSON.stringify(val)
      }));
      defaultEntries = Object.entries(value.default || {}).map(([key, val]) => ({
        key,
        value: typeof val === 'string' ? val : JSON.stringify(val)
      }));
    }
  });

  // Sync local state → prop (write-only)
  $: {
    const add: Record<string, any> = {};
    addEntries
      .filter(e => e.key.trim())
      .forEach(e => {
        try {
          add[e.key] = JSON.parse(e.value);
        } catch {
          add[e.key] = e.value;
        }
      });
    value.add = Object.keys(add).length > 0 ? add : undefined;

    value.remove = removeEntries.length > 0 ? removeEntries : undefined;

    const replace: Record<string, any> = {};
    replaceEntries
      .filter(e => e.key.trim())
      .forEach(e => {
        try {
          replace[e.key] = JSON.parse(e.value);
        } catch {
          replace[e.key] = e.value;
        }
      });
    value.replace = Object.keys(replace).length > 0 ? replace : undefined;

    const def: Record<string, any> = {};
    defaultEntries
      .filter(e => e.key.trim())
      .forEach(e => {
        try {
          def[e.key] = JSON.parse(e.value);
        } catch {
          def[e.key] = e.value;
        }
      });
    value.default = Object.keys(def).length > 0 ? def : undefined;
  }

  function addField() {
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

  function addReplaceField() {
    replaceEntries = [...replaceEntries, { key: '', value: '' }];
  }

  function removeReplaceEntry(index: number) {
    replaceEntries = replaceEntries.filter((_, i) => i !== index);
  }

  function addDefaultField() {
    defaultEntries = [...defaultEntries, { key: '', value: '' }];
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
        Support JSON values and dynamic expressions
      </span>
    {/if}
  </div>
  {/if}

  <div class="space-y-4">
    <!-- Add Fields -->
    <div class="border border-carbon-600 bg-carbon-950/60">
      <div class="px-3 py-2 font-mono text-[11px] uppercase tracking-command text-zinc-200 border-b border-carbon-600">
        {$_('body.add')} ({addEntries.length})
      </div>
      <div class="p-3 space-y-2">
        {#each addEntries as entry, index}
          <div class="flex gap-2">
            <Input
              type="text"
              placeholder={$_('headers.name')}
              class="flex-1"
              bind:value={entry.key}
            />
            <Input
              type="text"
              placeholder={$_('headers.value')}
              class="flex-[2]"
              bind:value={entry.value}
            />
            <Button
              variant="destructive"
              size="icon"
              onclick={() => removeAddEntry(index)}
            >
              ✕
            </Button>
          </div>
        {/each}
<Button variant="ghost" size="sm" onclick={addField}>
  {$_('body.add')}
</Button>
      </div>
    </div>

    <!-- Remove Fields -->
    <div class="border border-carbon-600 bg-carbon-950/60">
      <div class="px-3 py-2 font-mono text-[11px] uppercase tracking-command text-zinc-200 border-b border-carbon-600">
        {$_('body.remove')} ({removeEntries.length})
      </div>
      <div class="p-3 space-y-2">
        <div class="flex gap-2">
          <Input
            type="text"
            placeholder={$_('headers.name')}
            class="flex-1"
            bind:value={removeInputValue}
            onkeydown={handleRemoveKeydown}
          />
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
            {$_('body.empty')}
          </p>
        {/if}
      </div>
    </div>

    <!-- Replace Fields -->
    <div class="border border-carbon-600 bg-carbon-950/60">
      <div class="px-3 py-2 font-mono text-[11px] uppercase tracking-command text-zinc-200 border-b border-carbon-600">
        {$_('body.replace')} ({replaceEntries.length})
      </div>
      <div class="p-3 space-y-2">
        {#each replaceEntries as entry, index}
          <div class="flex gap-2">
            <Input
              type="text"
              placeholder={$_('headers.name')}
              class="flex-1"
              bind:value={entry.key}
            />
            <Input
              type="text"
              placeholder={$_('headers.value')}
              class="flex-[2]"
              bind:value={entry.value}
            />
            <Button
              variant="destructive"
              size="icon"
              onclick={() => removeReplaceEntry(index)}
            >
              ✕
            </Button>
          </div>
        {/each}
<Button variant="ghost" size="sm" onclick={addReplaceField}>
  {$_('body.add')}
</Button>
      </div>
    </div>

    <!-- Default Fields -->
    <div class="border border-carbon-600 bg-carbon-950/60">
      <div class="px-3 py-2 font-mono text-[11px] uppercase tracking-command text-zinc-200 border-b border-carbon-600">
        {$_('body.default')} ({defaultEntries.length})
      </div>
      <div class="p-3 space-y-2">
        {#each defaultEntries as entry, index}
          <div class="flex gap-2">
            <Input
              type="text"
              placeholder={$_('headers.name')}
              class="flex-1"
              bind:value={entry.key}
            />
            <Input
              type="text"
              placeholder={$_('headers.value')}
              class="flex-[2]"
              bind:value={entry.value}
            />
            <Button
              variant="destructive"
              size="icon"
              onclick={() => removeDefaultEntry(index)}
            >
              ✕
            </Button>
          </div>
        {/each}
<Button variant="ghost" size="sm" onclick={addDefaultField}>
  {$_('body.add')}
</Button>
      </div>
    </div>
  </div>
</div>
