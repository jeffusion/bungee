<script lang="ts">
  import { onMount } from 'svelte';
  import { PluginsAPI, type ModelMappingCatalogStatus } from '$api/plugins';
  import { _ } from '$i18n';
  import { toast } from '$stores/toast';
  import { KpiCard, LoadingIndicator, StatusBadge } from '$components/industrial';

  let loading = $state(true);
  let refreshing = $state(false);
  let loadError = $state(false);
  let status = $state<ModelMappingCatalogStatus | null>(null);
  let searchQuery = $state('');
  let selectedProvider = $state('');
  let providerFilter = $state('');
  let providerOpen = $state(false);
  let highlightedProvider = $state(0);
  let providerPicker = $state<HTMLElement>();
  let providerInput = $state<HTMLInputElement>();
  let currentPage = $state(1);
  let requestId = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let activeRequest: AbortController | undefined;
  let destroyed = false;

  let filteredProviders = $derived(
    ['', ...(status?.providers ?? [])].filter((provider) =>
      (provider || $_('plugins.modelMappingCatalog.allProviders')).toLocaleLowerCase().includes(providerFilter.toLocaleLowerCase()))
  );
  let totalPages = $derived(Math.max(1, Math.ceil((status?.matchedCount ?? 0) / (status?.pageSize ?? 50))));
  let rangeStart = $derived(status && status.models.length ? (status.page - 1) * status.pageSize + 1 : 0);
  let rangeEnd = $derived(status ? rangeStart + status.models.length - (rangeStart ? 1 : 0) : 0);

  function invalidate(): number {
    clearTimeout(searchTimer);
    activeRequest?.abort();
    return ++requestId;
  }

  async function loadStatus(): Promise<void> {
    const id = invalidate();
    const controller = new AbortController();
    activeRequest = controller;
    loading = true;
    loadError = false;
    try {
      const result = await PluginsAPI.getModelMappingCatalogStatus({
        provider: selectedProvider, search: searchQuery.trim(), page: currentPage,
      }, controller.signal);
      if (id === requestId) {
        status = result;
        currentPage = result.page;
      }
    } catch (error: any) {
      if (id === requestId) {
        loadError = true;
        toast.show(`${$_('common.error')}: ${error.message}`, 'error');
      }
    } finally {
      if (id === requestId) {
        loading = false;
        activeRequest = undefined;
      }
    }
  }

  function changeProvider(provider: string): void {
    selectedProvider = provider;
    providerFilter = '';
    providerOpen = false;
    highlightedProvider = 0;
    currentPage = 1;
    void loadStatus();
  }

  function handleProviderKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (providerOpen) {
        event.preventDefault();
        providerOpen = false;
        providerFilter = '';
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!providerOpen) {
        providerOpen = true;
        providerFilter = '';
        highlightedProvider = event.key === 'ArrowDown' ? 0 : filteredProviders.length - 1;
      } else if (filteredProviders.length) {
        highlightedProvider = (highlightedProvider + (event.key === 'ArrowDown' ? 1 : -1) + filteredProviders.length) % filteredProviders.length;
      }
      document.getElementById(`catalog-provider-${highlightedProvider}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && providerOpen) {
      event.preventDefault();
      if (filteredProviders[highlightedProvider] !== undefined) changeProvider(filteredProviders[highlightedProvider]);
    }
  }

  $effect(() => {
    if (!providerOpen) return;
    function closeOnOutsidePointer(event: PointerEvent): void {
      if (providerPicker && !providerPicker.contains(event.target as Node)) {
        providerOpen = false;
        providerFilter = '';
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  });

  function changeSearch(event: Event): void {
    searchQuery = (event.currentTarget as HTMLInputElement).value;
    currentPage = 1;
    invalidate();
    loading = true;
    searchTimer = setTimeout(() => void loadStatus(), 250);
  }

  function changePage(page: number): void {
    currentPage = page;
    void loadStatus();
  }

  async function refreshCatalog(): Promise<void> {
    invalidate();
    refreshing = true;
    loading = true;
    try {
      await PluginsAPI.refreshModelMappingCatalog();
      if (destroyed) return;
      toast.show($_('plugins.modelMappingCatalog.refreshSuccess'), 'success');
      currentPage = 1;
      await loadStatus();
    } catch (error: any) {
      if (destroyed) return;
      toast.show(`${$_('plugins.modelMappingCatalog.refreshFailed')}: ${error.message}`, 'error');
      await loadStatus();
    } finally {
      if (!destroyed) {
        refreshing = false;
        if (!activeRequest) loading = false;
      }
    }
  }

  function formatTime(timestamp: number | null): string {
    if (!timestamp) {
      return $_('plugins.modelMappingCatalog.neverRefreshed');
    }

    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(timestamp);
  }

  onMount(() => {
    void loadStatus();
    return () => {
      destroyed = true;
      invalidate();
    };
  });
</script>

<div class="p-6 space-y-6">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h2 class="text-2xl font-semibold">{$_('plugins.modelMappingCatalog.title')}</h2>
      <p class="text-sm text-zinc-400 mt-1">{$_('plugins.modelMappingCatalog.description')}</p>
    </div>

    <button class="nx-btn-primary nx-btn-sm" onclick={refreshCatalog} disabled={refreshing}>
      {#if refreshing}
        <LoadingIndicator label="" size="xs" centered={false} />
      {/if}
      {$_('plugins.modelMappingCatalog.refreshAction')}
    </button>
  </div>

  {#if loading && !status}
    <LoadingIndicator label={$_('common.loading')} height="md" />
  {:else if status}
    <!-- Summary Stats -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
      <KpiCard label={$_('plugins.modelMappingCatalog.catalogSource')} value={status.source.toUpperCase()} unit="SRC" tone={status.source === 'stored' ? 'ok' : 'warn'} stripe={status.source === 'stored' ? 'emerald' : 'amber'}>
        <span slot="foot" class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
          {status.source === 'stored' ? $_('plugins.modelMappingCatalog.sourceStored') : $_('plugins.modelMappingCatalog.sourceStatic')}
        </span>
      </KpiCard>
      <KpiCard label={$_('plugins.modelMappingCatalog.modelCount')} value={status.modelCount} unit="MODELS" />
      <KpiCard label={$_('plugins.modelMappingCatalog.providerCount')} value={status.providerCount} unit="PROVIDERS" />
      <KpiCard label={$_('plugins.modelMappingCatalog.lastRefresh')} value={formatTime(status.fetchedAt)} unit="SYNC" />
    </div>

    {#if status.source === 'static'}
      <div class="border-l-2 border-l-amber-500 bg-amber-500/5 px-3 py-2 font-mono text-[11px] uppercase tracking-command text-amber-200">
        <span>{$_('plugins.modelMappingCatalog.staticHint')}</span>
      </div>
    {:else}
      <div class="border-l-2 border-l-emerald-500 bg-emerald-500/5 px-3 py-2 font-mono text-[11px] uppercase tracking-command text-emerald-200">
        <span>{$_('plugins.modelMappingCatalog.storedHint')}</span>
      </div>
    {/if}

    <!-- Filter Bar -->
    <div class="flex flex-col sm:flex-row gap-4 items-center justify-between border border-carbon-600 bg-carbon-950/50 p-4">
      <div class="flex gap-4 w-full sm:w-auto flex-1">
        <div
          class="relative w-full sm:w-64"
          bind:this={providerPicker}
          onfocusout={(event) => {
            if (!providerPicker?.contains(event.relatedTarget as Node | null)) {
              providerOpen = false;
              providerFilter = '';
            }
          }}
        >
          <div class="relative">
            <input
              bind:this={providerInput}
              type="text"
              class="nx-input w-full {selectedProvider ? 'pr-9' : ''}"
              value={providerOpen ? providerFilter : selectedProvider || $_('plugins.modelMappingCatalog.allProviders')}
              aria-label={$_('plugins.modelMappingCatalog.provider')}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={providerOpen}
              aria-controls="catalog-provider-list"
              aria-activedescendant={providerOpen && filteredProviders.length ? `catalog-provider-${highlightedProvider}` : undefined}
              onfocus={() => { providerFilter = ''; highlightedProvider = 0; providerOpen = true; }}
              oninput={(event) => { providerFilter = event.currentTarget.value; highlightedProvider = 0; providerOpen = true; }}
              onkeydown={handleProviderKeydown}
            />
            {#if selectedProvider}
              <button
                type="button"
                class="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-nexus-400"
                aria-label={$_('plugins.modelMappingCatalog.allProviders')}
                title={$_('plugins.modelMappingCatalog.allProviders')}
                onclick={() => { changeProvider(''); providerInput?.focus(); }}
              >×</button>
            {/if}
          </div>
          {#if providerOpen}
            <ul id="catalog-provider-list" role="listbox" aria-label={$_('plugins.modelMappingCatalog.provider')} class="absolute z-50 left-0 right-0 mt-1 max-h-60 overflow-y-auto border border-carbon-600 bg-carbon-900 shadow-industrial">
              {#each filteredProviders as provider, index (provider)}
                <li role="presentation">
                  <button
                    type="button"
                    id={`catalog-provider-${index}`}
                    role="option"
                    aria-selected={selectedProvider === provider}
                    tabindex="-1"
                    class="block w-full cursor-pointer px-3 py-2 text-left font-mono text-xs {index === highlightedProvider ? 'bg-carbon-700 text-zinc-100' : 'text-zinc-200'}"
                    onpointermove={() => highlightedProvider = index}
                    onclick={() => changeProvider(provider)}
                  >{provider || $_('plugins.modelMappingCatalog.allProviders')}</button>
                </li>
              {:else}
                <li class="px-3 py-2 font-mono text-xs text-zinc-400">0 / {status?.providerCount ?? 0}</li>
              {/each}
            </ul>
          {/if}
        </div>
        
        <div class="relative w-full">
          <input 
            type="text" 
            placeholder={$_('plugins.modelMappingCatalog.searchModels')} 
            class="nx-input w-full pl-10"
            value={searchQuery}
            oninput={changeSearch}
            aria-label={$_('plugins.modelMappingCatalog.searchModels')}
          />
          <svg class="w-5 h-5 absolute left-3 top-3 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
        </div>
      </div>
      <div class="text-sm text-zinc-400 whitespace-nowrap" aria-live="polite">
        {#if loading}{$_('common.loading')}{:else if loadError}{$_('common.error')}{:else}{$_('plugins.modelMappingCatalog.showingModels').replace('{start}', String(rangeStart)).replace('{end}', String(rangeEnd)).replace('{matched}', String(status.matchedCount)).replace('{total}', String(status.modelCount))}{/if}
      </div>
    </div>

    <!-- Models Table -->
    <div class="border border-carbon-600 bg-carbon-950/40 overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="bg-carbon-950/60/50">
              <th class="w-1/4">{$_('plugins.modelMappingCatalog.provider')}</th>
              <th class="w-1/3">{$_('plugins.modelMappingCatalog.modelId')}</th>
              <th class="w-auto">{$_('plugins.modelMappingCatalog.modelName')}</th>
            </tr>
          </thead>
          <tbody>
            {#if loading}
              <tr><td colspan="3" class="text-center py-12 text-zinc-400">{$_('common.loading')}</td></tr>
            {:else if loadError}
              <tr><td colspan="3" class="text-center py-12 text-red-400">{$_('common.error')}</td></tr>
            {:else if status.models.length === 0}
              <tr>
                <td colspan="3" class="text-center py-12 text-zinc-500">
                  {$_('plugins.modelMappingCatalog.noModelsFound')}
                </td>
              </tr>
            {:else}
              {#each status.models as model}
                <tr class="border-t border-carbon-600 hover:bg-carbon-800/40">
                  <td>
                    {#if model.provider}
                      <StatusBadge variant="info">{model.provider}</StatusBadge>
                    {:else}
                      <span class="text-zinc-600">-</span>
                    {/if}
                  </td>
                  <td>
                    <code class="text-xs border border-carbon-600 bg-carbon-950 px-1.5 py-0.5 break-all">{model.value}</code>
                  </td>
                  <td>
                    <div class="font-medium">{model.label}</div>
                    {#if model.description}
                      <div class="text-xs text-zinc-500 mt-1">{model.description}</div>
                    {/if}
                  </td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      {#if !loading && !loadError && totalPages > 1}
        <div class="border-t border-carbon-600 p-4 flex flex-row justify-between items-center bg-carbon-950/60">
          <div class="text-sm text-zinc-500">
            {$_('plugins.modelMappingCatalog.pageOf').replace('{page}', String(status.page)).replace('{total}', String(totalPages))}
          </div>
          <div class="inline-flex items-center border border-carbon-500 bg-carbon-900">
            <button 
              class="nx-pager-btn" 
              disabled={currentPage === 1}
              aria-label={$_('plugins.modelMappingCatalog.previousPage')}
              onclick={() => changePage(currentPage - 1)}
            >
              «
            </button>
            <span class="nx-pager-btn pointer-events-none bg-carbon-700 font-semibold text-zinc-100" aria-current="page">
              {currentPage}
            </span>
            <button 
              class="nx-pager-btn" 
              disabled={currentPage === totalPages}
              aria-label={$_('plugins.modelMappingCatalog.nextPage')}
              onclick={() => changePage(currentPage + 1)}
            >
              »
            </button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
