<script lang="ts">
  import type { ModificationRules } from '../api/routes';
  import { _ } from '../i18n';

  export let value: ModificationRules = {};
  export let label: string = 'Body';
  export let showHelp: boolean = true;
  export let showLabel: boolean = true;

  let addEntries: Array<{ key: string; value: string }> = [];
  let removeEntries: string[] = [];
  let removeInputValue = '';
  let replaceEntries: Array<{ key: string; value: string }> = [];
  let defaultEntries: Array<{ key: string; value: string }> = [];
  let initialized = false;

  $: {
    if (!initialized && (value.add || value.remove || value.replace || value.default)) {
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
      initialized = true;
    }

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

  function addReplaceField() {
    replaceEntries = [...replaceEntries, { key: '', value: '' }];
    initialized = true;
  }

  function removeReplaceEntry(index: number) {
    replaceEntries = replaceEntries.filter((_, i) => i !== index);
  }

  function addDefaultField() {
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
        Support JSON values and dynamic expressions
      </span>
    {/if}
  </div>
  {/if}

  <div class="space-y-4">
    <!-- Add Fields -->
    <div class="collapse collapse-arrow bg-base-200">
      <input type="checkbox" checked />
      <div class="collapse-title text-sm font-medium">
        {$_('body.add')} ({addEntries.length})
      </div>
      <div class="collapse-content space-y-2">
        {#each addEntries as entry, index}
          <div class="flex gap-2">
            <input
              type="text"
              placeholder={$_('headers.name')}
              class="input input-bordered input-sm flex-1"
              bind:value={entry.key}
            />
            <input
              type="text"
              placeholder={$_('headers.value')}
              class="input input-bordered input-sm flex-[2]"
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
          on:click={addField}
        >
          {$_('body.add')}
        </button>
      </div>
    </div>

    <!-- Remove Fields -->
    <div class="collapse collapse-arrow bg-base-200">
      <input type="checkbox" />
      <div class="collapse-title text-sm font-medium">
        {$_('body.remove')} ({removeEntries.length})
      </div>
      <div class="collapse-content space-y-2">
        <div class="flex gap-2">
          <input
            type="text"
            placeholder={$_('headers.name')}
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
            {$_('body.empty')}
          </p>
        {/if}
      </div>
    </div>

    <!-- Replace Fields -->
    <div class="collapse collapse-arrow bg-base-200">
      <input type="checkbox" />
      <div class="collapse-title text-sm font-medium">
        {$_('body.replace')} ({replaceEntries.length})
      </div>
      <div class="collapse-content space-y-2">
        {#each replaceEntries as entry, index}
          <div class="flex gap-2">
            <input
              type="text"
              placeholder={$_('headers.name')}
              class="input input-bordered input-sm flex-1"
              bind:value={entry.key}
            />
            <input
              type="text"
              placeholder={$_('headers.value')}
              class="input input-bordered input-sm flex-[2]"
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
          on:click={addReplaceField}
        >
          {$_('body.add')}
        </button>
      </div>
    </div>

    <!-- Default Fields -->
    <div class="collapse collapse-arrow bg-base-200">
      <input type="checkbox" />
      <div class="collapse-title text-sm font-medium">
        {$_('body.default')} ({defaultEntries.length})
      </div>
      <div class="collapse-content space-y-2">
        {#each defaultEntries as entry, index}
          <div class="flex gap-2">
            <input
              type="text"
              placeholder={$_('headers.name')}
              class="input input-bordered input-sm flex-1"
              bind:value={entry.key}
            />
            <input
              type="text"
              placeholder={$_('headers.value')}
              class="input input-bordered input-sm flex-[2]"
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
          on:click={addDefaultField}
        >
          {$_('body.add')}
        </button>
      </div>
    </div>
  </div>
</div>
