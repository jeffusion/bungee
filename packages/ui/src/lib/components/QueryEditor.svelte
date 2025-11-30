<script lang="ts">
  import type { ModificationRules } from '../api/routes';
  import { _ } from '../i18n';

  export let value: ModificationRules = {};
  export let label: string = 'Query Parameters';
  export let showHelp: boolean = true;
  export let showLabel: boolean = true;

  let addEntries: Array<{ key: string; value: string }> = [];
  let removeEntries: string[] = [];
  let removeInputValue = '';
  let replaceEntries: Array<{ key: string; value: string }> = [];
  let defaultEntries: Array<{ key: string; value: string }> = [];
  let initialized = false;

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

  function addParam() {
    addEntries = [...addEntries, { key: '', value: '' }];
    initialized = true;
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

  function addReplaceParam() {
    replaceEntries = [...replaceEntries, { key: '', value: '' }];
    initialized = true;
  }

  function removeReplaceEntry(index: number) {
    replaceEntries = replaceEntries.filter((_, i) => i !== index);
  }

  function addDefaultParam() {
    defaultEntries = [...defaultEntries, { key: '', value: '' }];
    initialized = true;
  }

  function removeDefaultEntry(index: number) {
    defaultEntries = defaultEntries.filter((_, i) => i !== index);
  }
</script>

<div class="form-control w-full">
  {#if showLabel}
  <div class="label">
    <span class="label-text font-semibold">{label}</span>
    {#if showHelp}
      <span class="label-text-alt text-xs">
        Support dynamic expressions: <code class="text-xs">{'{{ expression }}'}</code>
      </span>
    {/if}
  </div>
  {/if}

  <div class="space-y-4">
    <!-- Add Parameters -->
    <div class="collapse collapse-arrow bg-base-200">
      <input type="checkbox" checked />
      <div class="collapse-title text-sm font-medium">
        {$_('query.add')} ({addEntries.length})
      </div>
      <div class="collapse-content space-y-2">
        {#each addEntries as entry, index}
          <div class="flex gap-2">
            <input
              type="text"
              placeholder={$_('query.namePlaceholder')}
              class="input input-bordered input-sm flex-1"
              bind:value={entry.key}
            />
            <input
              type="text"
              placeholder={$_('query.valuePlaceholder')}
              class="input input-bordered input-sm flex-1"
              bind:value={entry.value}
            />
            <button
              type="button"
              class="btn btn-sm btn-error btn-square"
              on:click={() => removeAddEntry(index)}
            >
              ✕
            </button>
          </div>
        {/each}
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          on:click={addParam}
        >
          {$_('query.add')}
        </button>
      </div>
    </div>

    <!-- Remove Parameters -->
    <div class="collapse collapse-arrow bg-base-200">
      <input type="checkbox" />
      <div class="collapse-title text-sm font-medium">
        {$_('query.remove')} ({removeEntries.length})
      </div>
      <div class="collapse-content space-y-2">
        <div class="flex gap-2">
          <input
            type="text"
            placeholder={$_('query.namePlaceholder')}
            class="input input-bordered input-sm flex-1"
            bind:value={removeInputValue}
            on:keydown={handleRemoveKeydown}
          />
          <button
            type="button"
            class="btn btn-sm btn-primary"
            on:click={addRemoveEntry}
            disabled={!removeInputValue.trim()}
          >
            {$_('common.add')}
          </button>
        </div>
        {#if removeEntries.length > 0}
          <div class="flex flex-wrap gap-2 mt-2">
            {#each removeEntries as entry, index}
              <div class="badge badge-lg gap-2">
                {entry}
                <button
                  type="button"
                  class="btn btn-ghost btn-xs btn-circle"
                  on:click={() => removeRemoveEntry(index)}
                >
                  ✕
                </button>
              </div>
            {/each}
          </div>
        {:else}
          <p class="text-xs text-gray-500">
            {$_('query.empty')}
          </p>
        {/if}
      </div>
    </div>

    <!-- Replace Parameters -->
    <div class="collapse collapse-arrow bg-base-200">
      <input type="checkbox" />
      <div class="collapse-title text-sm font-medium">
        {$_('query.replace')} ({replaceEntries.length})
      </div>
      <div class="collapse-content space-y-2">
        {#each replaceEntries as entry, index}
          <div class="flex gap-2">
            <input
              type="text"
              placeholder={$_('query.namePlaceholder')}
              class="input input-bordered input-sm flex-1"
              bind:value={entry.key}
            />
            <input
              type="text"
              placeholder={$_('query.valuePlaceholder')}
              class="input input-bordered input-sm flex-1"
              bind:value={entry.value}
            />
            <button
              type="button"
              class="btn btn-sm btn-error btn-square"
              on:click={() => removeReplaceEntry(index)}
            >
              ✕
            </button>
          </div>
        {/each}
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          on:click={addReplaceParam}
        >
          {$_('query.add')}
        </button>
      </div>
    </div>

    <!-- Default Parameters -->
    <div class="collapse collapse-arrow bg-base-200">
      <input type="checkbox" />
      <div class="collapse-title text-sm font-medium">
        {$_('query.default')} ({defaultEntries.length})
      </div>
      <div class="collapse-content space-y-2">
        {#each defaultEntries as entry, index}
          <div class="flex gap-2">
            <input
              type="text"
              placeholder={$_('query.namePlaceholder')}
              class="input input-bordered input-sm flex-1"
              bind:value={entry.key}
            />
            <input
              type="text"
              placeholder={$_('query.valuePlaceholder')}
              class="input input-bordered input-sm flex-1"
              bind:value={entry.value}
            />
            <button
              type="button"
              class="btn btn-sm btn-error btn-square"
              on:click={() => removeDefaultEntry(index)}
            >
              ✕
            </button>
          </div>
        {/each}
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          on:click={addDefaultParam}
        >
          {$_('query.add')}
        </button>
      </div>
    </div>
  </div>
</div>
