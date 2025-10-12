<script lang="ts">
  import type { ModificationRules } from '../api/routes';

  export let value: ModificationRules = {};
  export let label: string = 'Headers';
  export let showHelp: boolean = true;

  let addEntries: Array<{ key: string; value: string }> = [];
  let removeValue = '';
  let defaultEntries: Array<{ key: string; value: string }> = [];
  let initialized = false;

  // This reactive block now serves two purposes:
  // 1. One-time initialization of local state (addEntries, etc.) from the `value` prop.
  // 2. Continuously watching local state and updating the `value` prop.
  $: {
    // Initialize from prop only once
    if (!initialized && (value.add || value.remove || value.default)) {
      addEntries = Object.entries(value.add || {}).map(([key, val]) => ({
        key,
        value: String(val)
      }));
      removeValue = (value.remove || []).join(', ');
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

    const remove = removeValue
      .split(',')
      .map(s => s.trim())
      .filter(s => s);
    value.remove = remove.length > 0 ? remove : undefined;

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

  function addDefaultHeader() {
    defaultEntries = [...defaultEntries, { key: '', value: '' }];
    initialized = true; // Mark as initialized on user interaction
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
        Support dynamic expressions: <code class="text-xs">{'{{ expression }}'}</code>
      </span>
    {/if}
  </div>

  <div class="space-y-4">
    <!-- Add Headers -->
    <div class="collapse collapse-arrow bg-base-200">
      <input type="checkbox" checked />
      <div class="collapse-title text-sm font-medium">
        Add Headers ({addEntries.length})
      </div>
      <div class="collapse-content space-y-2">
        {#each addEntries as entry, index}
          <div class="flex gap-2">
            <input
              type="text"
              placeholder="Header name"
              class="input input-bordered input-sm flex-1"
              bind:value={entry.key}
            />
            <input
              type="text"
              placeholder="Value (or {'{{ expression }}'} )"
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
          on:click={addHeader}
        >
          + Add Header
        </button>
      </div>
    </div>

    <!-- Remove Headers -->
    <div class="collapse collapse-arrow bg-base-200">
      <input type="checkbox" />
      <div class="collapse-title text-sm font-medium">
        Remove Headers
      </div>
      <div class="collapse-content">
        <input
          type="text"
          placeholder="Comma-separated header names to remove"
          class="input input-bordered input-sm w-full"
          bind:value={removeValue}
        />
        <p class="text-xs text-gray-500 mt-1">
          Example: x-debug-info, x-internal-token
        </p>
      </div>
    </div>

    <!-- Default Headers -->
    <div class="collapse collapse-arrow bg-base-200">
      <input type="checkbox" />
      <div class="collapse-title text-sm font-medium">
        Default Headers ({defaultEntries.length})
      </div>
      <div class="collapse-content space-y-2">
        {#each defaultEntries as entry, index}
          <div class="flex gap-2">
            <input
              type="text"
              placeholder="Header name"
              class="input input-bordered input-sm flex-1"
              bind:value={entry.key}
            />
            <input
              type="text"
              placeholder="Default value"
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
          on:click={addDefaultHeader}
        >
          + Add Default Header
        </button>
      </div>
    </div>
  </div>
</div>
