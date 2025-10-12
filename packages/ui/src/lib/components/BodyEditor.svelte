<script lang="ts">
  import type { ModificationRules } from '../api/routes';

  export let value: ModificationRules = {};
  export let label: string = 'Body';
  export let showHelp: boolean = true;

  let addEntries: Array<{ key: string; value: string }> = [];
  let removeValue = '';
  let replaceEntries: Array<{ key: string; value: string }> = [];
  let defaultEntries: Array<{ key: string; value: string }> = [];
  let initialized = false;

  $: {
    if (!initialized && (value.add || value.remove || value.replace || value.default)) {
      addEntries = Object.entries(value.add || {}).map(([key, val]) => ({
        key,
        value: typeof val === 'string' ? val : JSON.stringify(val)
      }));
      removeValue = (value.remove || []).join(', ');
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

    const remove = removeValue
      .split(',')
      .map(s => s.trim())
      .filter(s => s);
    value.remove = remove.length > 0 ? remove : undefined;

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
  <div class="label">
    <span class="label-text font-semibold">{label}</span>
    {#if showHelp}
      <span class="label-text-alt text-xs">
        Support JSON values and dynamic expressions
      </span>
    {/if}
  </div>

  <div class="space-y-4">
    <!-- Add Fields -->
    <div class="collapse collapse-arrow bg-base-200">
      <input type="checkbox" checked />
      <div class="collapse-title text-sm font-medium">
        Add Fields ({addEntries.length})
      </div>
      <div class="collapse-content space-y-2">
        {#each addEntries as entry, index}
          <div class="flex gap-2">
            <input
              type="text"
              placeholder="Field name"
              class="input input-bordered input-sm flex-1"
              bind:value={entry.key}
            />
            <input
              type="text"
              placeholder="Value or expression"
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
          + Add Field
        </button>
      </div>
    </div>

    <!-- Remove Fields -->
    <div class="collapse collapse-arrow bg-base-200">
      <input type="checkbox" />
      <div class="collapse-title text-sm font-medium">
        Remove Fields
      </div>
      <div class="collapse-content">
        <input
          type="text"
          placeholder="Comma-separated field names to remove"
          class="input input-bordered input-sm w-full"
          bind:value={removeValue}
        />
        <p class="text-xs text-gray-500 mt-1">
          Example: debug_mode, internal_flag
        </p>
      </div>
    </div>

    <!-- Replace Fields -->
    <div class="collapse collapse-arrow bg-base-200">
      <input type="checkbox" />
      <div class="collapse-title text-sm font-medium">
        Replace Fields ({replaceEntries.length})
      </div>
      <div class="collapse-content space-y-2">
        {#each replaceEntries as entry, index}
          <div class="flex gap-2">
            <input
              type="text"
              placeholder="Field name"
              class="input input-bordered input-sm flex-1"
              bind:value={entry.key}
            />
            <input
              type="text"
              placeholder="Replacement value"
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
          + Add Replace Field
        </button>
      </div>
    </div>

    <!-- Default Fields -->
    <div class="collapse collapse-arrow bg-base-200">
      <input type="checkbox" />
      <div class="collapse-title text-sm font-medium">
        Default Fields ({defaultEntries.length})
      </div>
      <div class="collapse-content space-y-2">
        {#each defaultEntries as entry, index}
          <div class="flex gap-2">
            <input
              type="text"
              placeholder="Field name"
              class="input input-bordered input-sm flex-1"
              bind:value={entry.key}
            />
            <input
              type="text"
              placeholder="Default value"
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
          + Add Default Field
        </button>
      </div>
    </div>
  </div>
</div>
