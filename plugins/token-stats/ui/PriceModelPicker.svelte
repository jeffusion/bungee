<script lang="ts">
  import { onMount } from 'svelte';
  import { requestPluginControl } from '@bungee/plugin-sdk';
  import * as Popover from '$components/ui/popover';
  import * as Command from '$components/ui/command';
  import { Button } from '$components/ui/button';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import { createPricingModelSearch, type PricingModelSearchState } from './pricing-catalog';

  let { provider, catalogVersion, value, disabled = false, label, placeholder, searchLabel, emptyLabel,
    loadingLabel, errorLabel, retryLabel, previousLabel, nextLabel, onchange }: {
    provider: string;
    catalogVersion: number | null;
    value: string;
    disabled?: boolean;
    label: string;
    placeholder: string;
    searchLabel: string;
    emptyLabel: string;
    loadingLabel: string;
    errorLabel: string;
    retryLabel: string;
    previousLabel: string;
    nextLabel: string;
    onchange: (model: string) => void;
  } = $props();
  let open = $state(false);
  let width = $state(0);
  let search = $state('');
  let results = $state<PricingModelSearchState>({ models: [], total: 0, page: 1, pageSize: 50, loading: false, error: false });
  const modelSearch = createPricingModelSearch(
    (path, signal) => requestPluginControl('token-stats', path, 'GET', undefined, signal),
    state => { results = state; },
  );
  const pages = $derived(Math.max(1, Math.ceil(results.total / results.pageSize)));
  $effect(() => {
    // A new catalog version invalidates an open picker's current results too.
    void catalogVersion;
    if (!open || disabled || !provider) { modelSearch.cancel(); return; }
    modelSearch.search({ provider, search }, 1, search.length > 0);
  });
  function changePage(page: number) { modelSearch.search({ provider, search }, page, false); }
  onMount(() => () => modelSearch.destroy());
</script>

<div class="min-w-0 w-full" bind:clientWidth={width}>
  <Popover.Root bind:open>
    <Popover.Trigger asChild let:builder>
      <Button builders={[builder]} variant="outline" {disabled} aria-label={label} aria-haspopup="listbox"
        onclick={() => { search = ''; }}
        class="h-[34px] w-full min-w-0 justify-between border-carbon-500 bg-carbon-900 px-2 font-mono text-[11px] font-normal normal-case tracking-normal focus-visible:border-nexus-500">
        <span class="truncate text-zinc-200" title={value}>{value || placeholder}</span>
        <ChevronDown class="h-4 w-4 shrink-0 opacity-50" />
      </Button>
    </Popover.Trigger>
    <Popover.Content style={`width: ${width}px`} class="max-w-[calc(100vw-2rem)] border-carbon-600 p-0" align="start">
      <!-- cmdk-sv's imperative sorting moves Svelte-owned nodes; keep filtering declarative. -->
      <Command.Root shouldFilter={false}>
        <Command.Input bind:value={search} placeholder={searchLabel} aria-label={searchLabel} />
        <Command.List>
          {#if results.loading}<p role="status" class="px-3 py-2 text-xs text-zinc-400">{loadingLabel}</p>
          {:else if results.error}
            <p role="alert" class="px-3 py-2 text-xs text-red-400">{errorLabel}</p>
            <Button variant="ghost" onclick={() => changePage(results.page)}>{retryLabel}</Button>
          {:else}
          <Command.Empty>{emptyLabel}</Command.Empty>
          {#each results.models as option (option.model)}
            <Command.Item value={option.model} onSelect={() => { onchange(option.model); open = false; }}
              class="min-w-0 break-all text-zinc-200">
              {option.model}
            </Command.Item>
          {/each}
          {/if}
        </Command.List>
      </Command.Root>
      {#if !results.loading && !results.error && pages > 1}
        <div class="flex items-center justify-between border-t border-carbon-600 p-2">
          <button type="button" class="nx-pager-btn" aria-label={previousLabel} disabled={results.page <= 1}
            onmousedown={(event) => event.preventDefault()} onclick={() => changePage(results.page - 1)}>«</button>
          <span class="text-xs text-zinc-400">{results.page} / {pages}</span>
          <button type="button" class="nx-pager-btn" data-testid="price-model-next-page" aria-label={nextLabel} disabled={results.page >= pages}
            onmousedown={(event) => event.preventDefault()} onclick={() => changePage(results.page + 1)}>»</button>
        </div>
      {/if}
    </Popover.Content>
  </Popover.Root>
</div>
