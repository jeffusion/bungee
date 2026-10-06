<script lang="ts">
  import { onMount } from 'svelte';
  import { requestPluginControl } from '@bungee/plugin-sdk';
  import { createClientModelSearch, type ClientModelSearchState } from './client-model-search';

  let { id, value, disabled = false, label, placeholder, loadingLabel, errorLabel, emptyLabel, previousLabel, nextLabel, onchange }: {
    id: string; value: string; disabled?: boolean; label: string; placeholder: string;
    loadingLabel: string; errorLabel: string; emptyLabel: string; previousLabel: string; nextLabel: string;
    onchange: (value: string) => void;
  } = $props();
  const listId = $props.id();
  let open = $state(false);
  let keyword = $state('');
  let restoringFocus = false;
  let highlighted = $state(-1);
  let container = $state<HTMLDivElement>();
  let input = $state<HTMLInputElement>();
  let results = $state<ClientModelSearchState>({ models: [], total: 0, page: 1, pageSize: 50, loading: false, error: false });
  const search = createClientModelSearch(
    (path, signal) => requestPluginControl('token-stats', path, 'GET', undefined, signal),
    state => { results = state; highlighted = -1; },
  );
  const pages = $derived(Math.max(1, Math.ceil(results.total / results.pageSize)));
  function changePage(page: number) {
    // Keep the combobox focus while loading replaces the candidate list.
    restoringFocus = true; input?.focus(); restoringFocus = false;
    search.search(keyword, page, false);
  }
  function select(model: string) { onchange(model); open = false; search.cancel(); restoringFocus = true; input?.focus(); restoringFocus = false; }
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); open = false; search.cancel(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { open = true; keyword = value; search.search(keyword); }
      highlighted = Math.max(-1, Math.min(results.models.length - 1, highlighted + (event.key === 'ArrowDown' ? 1 : -1)));
      if (highlighted >= 0) document.getElementById(`${listId}-${highlighted}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && open) {
      event.preventDefault(); select(highlighted >= 0 ? results.models[highlighted] : value);
    }
  }
  onMount(() => () => search.destroy());
</script>

<div class="relative min-w-0" bind:this={container} data-testid="client-model-picker"
  onfocusout={(event) => { if (!container?.contains(event.relatedTarget as Node | null)) { open = false; search.cancel(); } }}>
  <input {id} bind:this={input} type="text" {value} {disabled} {placeholder} maxlength={256}
    class="nx-input w-full" data-testid="client-model-input" aria-label={label} autocomplete="off"
    role="combobox" aria-expanded={open} aria-autocomplete="list" aria-controls={open ? listId : undefined}
    aria-activedescendant={open && highlighted >= 0 ? `${listId}-${highlighted}` : undefined}
    onfocus={() => { if (restoringFocus) return; keyword = value; open = true; search.search(keyword); }}
    oninput={(event) => { keyword = event.currentTarget.value; onchange(keyword); open = true; search.search(keyword); }}
    onkeydown={keydown} />
  {#if open && !disabled}
    <div class="absolute z-[200] left-0 right-0 mt-1 border border-carbon-600 bg-carbon-900 shadow-industrial">
      <div id={listId} role="listbox" aria-label={label} class="max-h-52 overflow-y-auto">
        {#each results.models as model, index (model)}
          <button type="button" role="option" id={`${listId}-${index}`} aria-selected={model === value}
            tabindex="-1" class="block w-full break-all px-3 py-2 text-left font-mono text-xs {highlighted === index ? 'bg-carbon-700 text-zinc-100' : 'text-zinc-200'}"
            onpointermove={() => highlighted = index} onmousedown={(event) => event.preventDefault()} onclick={() => select(model)}>{model}</button>
        {/each}
      </div>
      {#if results.loading}<p role="status" class="px-3 py-2 text-xs text-zinc-400">{loadingLabel}</p>
      {:else if results.error}<p role="alert" data-testid="client-model-search-error" class="px-3 py-2 text-xs text-red-400">{errorLabel}</p>
      {:else if !results.models.length}<p role="status" class="px-3 py-2 text-xs text-zinc-400">{emptyLabel}</p>{/if}
      {#if !results.loading && pages > 1}
        <div class="flex items-center justify-between border-t border-carbon-600 p-2">
          <button type="button" class="nx-pager-btn" aria-label={previousLabel} disabled={results.page <= 1}
            onmousedown={(event) => event.preventDefault()} onclick={() => changePage(results.page - 1)}>«</button>
          <span class="text-xs text-zinc-400">{results.page} / {pages}</span>
          <button type="button" class="nx-pager-btn" data-testid="client-model-next-page" aria-label={nextLabel} disabled={results.page >= pages}
            onmousedown={(event) => event.preventDefault()} onclick={() => changePage(results.page + 1)}>»</button>
        </div>
      {/if}
    </div>
  {/if}
</div>
