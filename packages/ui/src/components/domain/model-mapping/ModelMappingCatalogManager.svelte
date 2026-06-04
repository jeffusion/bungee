<script lang="ts">
  import { onMount } from 'svelte';
  import { PluginsAPI, type ModelMappingCatalogStatus } from '$api/plugins';
  import { _ } from '$i18n';
  import { toast } from '$stores/toast';
  import { KpiCard, LoadingIndicator, StatusBadge } from '$components/industrial';

  let loading = true;
  let refreshing = false;
  let status: ModelMappingCatalogStatus | null = null;

  let searchQuery = '';
  let selectedProvider = '';
  let providerFilter = '';
  let showProviderDropdown = false;
  let providerDropdownRef: HTMLElement | null = null;
  
  let currentPage = 1;
  const itemsPerPage = 50;

  async function loadStatus(): Promise<void> {
    loading = true;
    try {
      status = await PluginsAPI.getModelMappingCatalogStatus();
    } catch (error: any) {
      toast.show(`${$_('common.error')}: ${error.message}`, 'error');
    } finally {
      loading = false;
    }
  }

  async function refreshCatalog(): Promise<void> {
    refreshing = true;
    try {
      status = await PluginsAPI.refreshModelMappingCatalog();
      toast.show($_('plugins.modelMappingCatalog.refreshSuccess'), 'success');
      currentPage = 1;
    } catch (error: any) {
      toast.show(`${$_('plugins.modelMappingCatalog.refreshFailed')}: ${error.message}`, 'error');
    } finally {
      refreshing = false;
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

  $: filteredModels = (status?.models || []).filter((model: any) => {
    const matchesSearch = !searchQuery || 
      model.label.toLowerCase().includes(searchQuery.toLowerCase()) || 
      model.value.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesProvider = !selectedProvider || model.provider === selectedProvider;
    return matchesSearch && matchesProvider;
  });

  $: filteredProviders = (status?.providers || []).filter((p: string) =>
    !providerFilter || p.toLowerCase().includes(providerFilter.toLowerCase())
  );

  $: totalPages = Math.ceil(filteredModels.length / itemsPerPage) || 1;
  $: paginatedModels = filteredModels.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  $: {
    if (searchQuery !== undefined || selectedProvider !== undefined) {
      currentPage = 1;
    }
  }

  function selectProvider(provider: string): void {
    selectedProvider = provider;
    providerFilter = '';
    showProviderDropdown = false;
  }

  function clearProvider(): void {
    selectedProvider = '';
    providerFilter = '';
    showProviderDropdown = false;
  }

  function handleProviderKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      showProviderDropdown = false;
      providerFilter = '';
    } else if (event.key === 'Enter' && filteredProviders.length > 0) {
      selectProvider(filteredProviders[0]);
    }
  }

  function handleGlobalClick(event: MouseEvent): void {
    if (providerDropdownRef && !providerDropdownRef.contains(event.target as Node)) {
      showProviderDropdown = false;
    }
  }

  onMount(() => {
    loadStatus();
    document.addEventListener('click', handleGlobalClick);
    return () => document.removeEventListener('click', handleGlobalClick);
  });
</script>

<div class="p-6 space-y-6">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h2 class="text-2xl font-semibold">{$_('plugins.modelMappingCatalog.title')}</h2>
      <p class="text-sm text-zinc-400 mt-1">{$_('plugins.modelMappingCatalog.description')}</p>
    </div>

    <button class="nx-btn-primary nx-btn-sm" on:click={refreshCatalog} disabled={refreshing || loading}>
      {#if refreshing}
        <LoadingIndicator label="" size="xs" centered={false} />
      {/if}
      {$_('plugins.modelMappingCatalog.refreshAction')}
    </button>
  </div>

  {#if loading}
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
        <div class="relative w-full sm:w-64" bind:this={providerDropdownRef}>
          <div class="flex items-center gap-1">
            <input
              type="text"
              class="nx-input w-full"
              placeholder={selectedProvider || $_('plugins.modelMappingCatalog.allProviders')}
              bind:value={providerFilter}
              on:focusin={() => showProviderDropdown = true}
              on:keydown={handleProviderKeydown}
            />
            {#if selectedProvider}
              <button class="inline-flex items-center justify-center h-5 w-5 text-zinc-500 hover:text-red-300 transition-colors" on:click={clearProvider} title="Clear">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            {/if}
          </div>
          {#if showProviderDropdown && filteredProviders.length > 0}
            <ul class="absolute z-50 left-0 right-0 mt-1 border border-carbon-600 bg-carbon-900 shadow-industrial max-h-60 overflow-y-auto">
              <li>
                <button
                  class="w-full text-left px-4 py-2 hover:bg-carbon-950/60 text-sm {!selectedProvider ? 'font-semibold bg-carbon-950/60/50' : ''}"
                  on:click={() => selectProvider('')}
                >
                  {$_('plugins.modelMappingCatalog.allProviders')}
                </button>
              </li>
              {#each filteredProviders as provider}
                <li>
                  <button
                    class="w-full text-left px-4 py-2 hover:bg-carbon-950/60 text-sm {selectedProvider === provider ? 'font-semibold bg-carbon-950/60/50' : ''}"
                    on:click={() => selectProvider(provider)}
                  >
                    {provider}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
        
        <div class="relative w-full">
          <input 
            type="text" 
            placeholder={$_('plugins.modelMappingCatalog.searchModels')} 
            class="nx-input w-full pl-10"
            bind:value={searchQuery}
          />
          <svg class="w-5 h-5 absolute left-3 top-3 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
        </div>
      </div>
      <div class="text-sm text-zinc-400 whitespace-nowrap">
        {$_('plugins.modelMappingCatalog.showingModels').replace('{count}', String(filteredModels.length)).replace('{total}', String(status.models.length))}
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
            {#if paginatedModels.length === 0}
              <tr>
                <td colspan="3" class="text-center py-12 text-zinc-500">
                  {$_('plugins.modelMappingCatalog.noModelsFound')}
                </td>
              </tr>
            {:else}
              {#each paginatedModels as model}
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
      {#if totalPages > 1}
        <div class="border-t border-carbon-600 p-4 flex flex-row justify-between items-center bg-carbon-950/60">
          <div class="text-sm text-zinc-500">
            Page {currentPage} of {totalPages}
          </div>
          <div class="flex items-center gap-1">
            <button 
              class="nx-pager-btn" 
              disabled={currentPage === 1}
              on:click={() => currentPage--}
            >
              «
            </button>
            <button class="nx-pager-btn is-active">
              {currentPage}
            </button>
            <button 
              class="nx-pager-btn" 
              disabled={currentPage === totalPages}
              on:click={() => currentPage++}
            >
              »
            </button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
