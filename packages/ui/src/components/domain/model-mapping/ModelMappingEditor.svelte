<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { _ } from '$i18n';
  import { Input } from '$components/ui/input';
  import { PluginsAPI } from '$api/plugins';
  import { getCachedPluginModelCatalog } from './catalog-cache';
  import {
    buildRowOptions,
    buildProviderOptions,
    canonicalizeProviderFilter,
    type ModelOption,
    type RowOptionSet,
    type RowProviderFilter
  } from './filtering';
  import { LoadingIndicator } from '$components/industrial';

  type ModelMapping = { source: string; target: string };

  export let value: ModelMapping[] = [];
  export let pluginName = 'model-mapping';
  export let catalogPlugin = 'model-mapping';
  export let sourceCatalogProvider = '';
  export let targetCatalogProvider = '';

  const dispatch = createEventDispatcher<{ change: ModelMapping[] }>();

  let allOptions: ModelOption[] = [];
  let providerOptions: string[] = [];
  let providerFilterOptions: ModelOption[] = [];
  let rowProviderFilters: RowProviderFilter[] = [];
  let rowOptions: RowOptionSet[] = [];
  let loading = false;
  let lastCatalogRequestKey = '';
  let catalogRequestToken = 0;

  $: rows = Array.isArray(value)
    ? value.map((item) => ({
      source: typeof item?.source === 'string' ? item.source : '',
      target: typeof item?.target === 'string' ? item.target : ''
    }))
    : [];

  $: i18nPrefix = `plugins.${(pluginName || 'model-mapping').trim()}.modelMapping`;

  $: providerOptions = buildProviderOptions(allOptions);
  $: normalizedCatalogPlugin = (catalogPlugin || 'model-mapping').trim();
  $: normalizedSourceCatalogProvider = sourceCatalogProvider.trim();
  $: normalizedTargetCatalogProvider = targetCatalogProvider.trim();
  $: showProviderFilters = true;
  $: catalogRequestKey = JSON.stringify([
    normalizedCatalogPlugin,
    normalizedSourceCatalogProvider,
    normalizedTargetCatalogProvider,
  ]);
  $: if (normalizedCatalogPlugin) {
    void loadCatalogOptions(catalogRequestKey);
  } else {
    allOptions = [];
    lastCatalogRequestKey = '';
  }

  $: providerFilterOptions = [
    {
      value: '',
      label: textOrFallback('allProviders', 'All providers')
    },
    ...providerOptions.map((provider) => ({
      value: provider,
      label: provider
    }))
  ];

  $: {
    if (rowProviderFilters.length !== rows.length) {
      rowProviderFilters = Array.from({ length: rows.length }, (_, index) => {
        const previous = rowProviderFilters[index];
        return {
          source: previous?.source ?? '',
          target: previous?.target ?? ''
        };
      });
    }
  }

  $: rowOptions = buildRowOptions(allOptions, rowProviderFilters, rows.length);

  function i18nKey(suffix: string): string {
    return `${i18nPrefix}.${suffix}`;
  }

  function textOrFallback(suffix: string, fallback: string): string {
    const key = i18nKey(suffix);
    const translated = $_(key);
    return translated === key ? fallback : translated;
  }

  function getRowProviderFilter(index: number, kind: 'source' | 'target'): string {
    return rowProviderFilters[index]?.[kind] ?? '';
  }

  function updateRowProviderFilter(index: number, kind: 'source' | 'target', provider: string): void {
    const nextFilters = [...rowProviderFilters];
    while (nextFilters.length <= index) {
      nextFilters.push({ source: '', target: '' });
    }

    const currentFilter = nextFilters[index] ?? { source: '', target: '' };
    const normalizedProvider = canonicalizeProviderFilter(provider, providerOptions);
    nextFilters[index] = {
      ...currentFilter,
      [kind]: normalizedProvider
    };

    rowProviderFilters = nextFilters;
  }

  async function loadCatalogOptions(requestKey: string): Promise<void> {
    if (!normalizedCatalogPlugin || requestKey === lastCatalogRequestKey) {
      return;
    }

    lastCatalogRequestKey = requestKey;
    const requestToken = ++catalogRequestToken;

    loading = true;

    try {
      const fixedProviders = Array.from(new Set([
        normalizedSourceCatalogProvider,
        normalizedTargetCatalogProvider,
      ].filter((provider) => provider.length > 0)));

      if (fixedProviders.length > 0) {
        const responses = await Promise.all(
          fixedProviders.map(async (provider) => {
            const response = await getCachedPluginModelCatalog(PluginsAPI.getPluginModels, normalizedCatalogPlugin, provider);
            const models = Array.isArray(response?.models) ? response.models : [];
            return models.map((model) => ({
              ...model,
              provider: typeof model.provider === 'string' && model.provider.length > 0 ? model.provider : provider,
            }));
          })
        );

        if (requestToken === catalogRequestToken) {
          allOptions = responses.flat();
        }
        return;
      }

      const response = await getCachedPluginModelCatalog(PluginsAPI.getPluginModels, normalizedCatalogPlugin);
      if (requestToken === catalogRequestToken) {
        allOptions = Array.isArray(response?.models) ? response.models : [];
      }
    } catch (_error) {
      if (requestToken === catalogRequestToken) {
        lastCatalogRequestKey = '';
      }
    } finally {
      if (requestToken === catalogRequestToken) {
        loading = false;
      }
    }
  }

  function emit(nextRows: ModelMapping[]): void {
    dispatch('change', nextRows);
  }

  function updateRow(index: number, key: 'source' | 'target', nextValue: string): void {
    const nextRows = rows.map((row, i) => (i === index ? { ...row, [key]: nextValue } : row));
    emit(nextRows);
  }

  function addRow(): void {
    rowProviderFilters = [...rowProviderFilters, { source: '', target: '' }];
    emit([...rows, { source: '', target: '' }]);
  }

  function removeRow(index: number): void {
    rowProviderFilters = rowProviderFilters.filter((_, i) => i !== index);
    emit(rows.filter((_, i) => i !== index));
  }

  function optionLabel(option: { value: string; label?: string }): string {
    return option.label ?? option.value;
  }
</script>

<div class="space-y-2">
  {#if rows.length === 0}
    <div class="text-sm text-zinc-500">{$_(i18nKey('empty'))}</div>
  {/if}

  {#each rows as row, index}
    <div class="space-y-2 border border-carbon-600 bg-carbon-950/40 p-2">
      {#if showProviderFilters}
        <div class="grid grid-cols-[1fr_1fr_auto] gap-2 items-start">
          <div class="w-full space-y-1">
            <span class="nx-label-sm block">{textOrFallback('sourceProviderFilter', 'Source provider filter')}</span>
            {#if normalizedSourceCatalogProvider}
              <div class="nx-input flex items-center bg-carbon-950/60 text-zinc-300">{normalizedSourceCatalogProvider}</div>
            {:else}
              <Input
                type="text"
                value={getRowProviderFilter(index, 'source')}
                list={`model-mapping-source-provider-${index}`}
                placeholder={textOrFallback('allProviders', 'All providers')}
                oninput={(event) => updateRowProviderFilter(index, 'source', event.currentTarget.value)}
              />
              <datalist id={`model-mapping-source-provider-${index}`}>
                {#each providerFilterOptions as option}
                  <option value={option.value}>{optionLabel(option)}</option>
                {/each}
              </datalist>
            {/if}
          </div>

          <div class="w-full space-y-1">
            <span class="nx-label-sm block">{textOrFallback('targetProviderFilter', 'Target provider filter')}</span>
            {#if normalizedTargetCatalogProvider}
              <div class="nx-input flex items-center bg-carbon-950/60 text-zinc-300">{normalizedTargetCatalogProvider}</div>
            {:else}
              <Input
                type="text"
                value={getRowProviderFilter(index, 'target')}
                list={`model-mapping-target-provider-${index}`}
                placeholder={textOrFallback('allProviders', 'All providers')}
                oninput={(event) => updateRowProviderFilter(index, 'target', event.currentTarget.value)}
              />
              <datalist id={`model-mapping-target-provider-${index}`}>
                {#each providerFilterOptions as option}
                  <option value={option.value}>{optionLabel(option)}</option>
                {/each}
              </datalist>
            {/if}
          </div>

          <button class="nx-btn-ghost nx-btn-sm invisible pointer-events-none" type="button" aria-hidden="true">
            {$_('common.delete')}
          </button>
        </div>
      {/if}

      <div class="grid grid-cols-[1fr_1fr_auto] gap-2 items-start">
        <div class="min-w-0">
          <Input
            type="text"
            value={row.source}
            list={`model-mapping-source-model-${index}`}
            placeholder={$_(i18nKey('sourceLabel'))}
            oninput={(event) => updateRow(index, 'source', event.currentTarget.value)}
          />
          <datalist id={`model-mapping-source-model-${index}`}>
            {#each rowOptions[index]?.source ?? [] as option}
              <option value={option.value}>{optionLabel(option)}</option>
            {/each}
          </datalist>
        </div>

        <div class="min-w-0">
          <Input
            type="text"
            value={row.target}
            list={`model-mapping-target-model-${index}`}
            placeholder={$_(i18nKey('targetLabel'))}
            oninput={(event) => updateRow(index, 'target', event.currentTarget.value)}
          />
          <datalist id={`model-mapping-target-model-${index}`}>
            {#each rowOptions[index]?.target ?? [] as option}
              <option value={option.value}>{optionLabel(option)}</option>
            {/each}
          </datalist>
        </div>

        <button class="nx-btn-danger nx-btn-sm" type="button" on:click={() => removeRow(index)}>
          {$_('common.delete')}
        </button>
      </div>
    </div>
  {/each}

  <div class="flex items-center justify-between gap-2">
    <button class="nx-btn-outline nx-btn-sm" type="button" on:click={addRow} data-testid="model-mapping-add-button">
      {$_(i18nKey('addRow'))}
    </button>

    {#if loading}
      <LoadingIndicator label="" size="xs" centered={false} />
    {/if}
  </div>
</div>
