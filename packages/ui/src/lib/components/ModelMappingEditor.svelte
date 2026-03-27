<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { _ } from '../i18n';
  import ComboInput from './smart-input/ComboInput.svelte';
  import { PluginsAPI } from '../api/plugins';
  import {
    buildRowOptions,
    buildProviderOptions,
    canonicalizeProviderFilter,
    type ModelOption,
    type RowOptionSet,
    type RowProviderFilter
  } from './model-mapping/filtering';

  type ModelMapping = { source: string; target: string };
  type CatalogCacheEntry = { models: ModelOption[]; expiresAt: number; source: 'fresh' | 'static' | '' };

  const OPTION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  export let value: ModelMapping[] = [];
  export let pluginName = 'model-mapping';
  export let catalogPlugin = 'model-mapping';

  const dispatch = createEventDispatcher<{ change: ModelMapping[] }>();

  const optionCache = new Map<string, CatalogCacheEntry>();

  let allOptions: ModelOption[] = [];
  let providerOptions: string[] = [];
  let providerFilterOptions: ModelOption[] = [];
  let rowProviderFilters: RowProviderFilter[] = [];
  let rowOptions: RowOptionSet[] = [];
  let loading = false;

  $: rows = Array.isArray(value)
    ? value.map((item) => ({
      source: typeof item?.source === 'string' ? item.source : '',
      target: typeof item?.target === 'string' ? item.target : ''
    }))
    : [];

  $: i18nPrefix = `plugins.${(pluginName || 'model-mapping').trim()}.modelMapping`;

  $: void loadCatalogOptions();

  $: providerOptions = buildProviderOptions(allOptions);

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

  function buildCacheKey(): string {
    const normalizedPlugin = (catalogPlugin || 'model-mapping').trim();
    return normalizedPlugin;
  }

  async function loadCatalogOptions(): Promise<void> {
    const normalizedPlugin = (catalogPlugin || 'model-mapping').trim();
    if (!normalizedPlugin) {
      allOptions = [];
      return;
    }

    const cacheKey = buildCacheKey();
    const cached = optionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      allOptions = cached.models;
      return;
    }

    loading = true;

    try {
      const response = await PluginsAPI.getPluginModels(normalizedPlugin);
      const models = Array.isArray(response?.models) ? response.models : [];

      optionCache.set(cacheKey, {
        models,
        expiresAt: Date.now() + OPTION_CACHE_TTL_MS,
        source: response?.source === 'fresh' || response?.source === 'static' ? response.source : ''
      });

      allOptions = models;
    } catch (_error) {
      optionCache.set(cacheKey, {
        models: [],
        expiresAt: Date.now() + OPTION_CACHE_TTL_MS,
        source: ''
      });
      allOptions = [];
    } finally {
      loading = false;
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
</script>

<div class="space-y-2">
  {#if rows.length === 0}
    <div class="text-sm text-gray-500">{$_(i18nKey('empty'))}</div>
  {/if}

  {#each rows as row, index}
    <div class="space-y-2 rounded-lg border border-base-300 p-2">
      {#if providerOptions.length > 0}
        <div class="grid grid-cols-[1fr_1fr_auto] gap-2 items-start">
          <div class="form-control w-full">
            <span class="label-text text-xs opacity-80 mb-1">{textOrFallback('sourceProviderFilter', 'Source provider filter')}</span>
            <ComboInput
              value={getRowProviderFilter(index, 'source')}
              options={providerFilterOptions}
              allowCustom={false}
              placeholder={textOrFallback('allProviders', 'All providers')}
              on:change={(event) => updateRowProviderFilter(index, 'source', String(event.detail ?? ''))}
              on:select={(event) => updateRowProviderFilter(index, 'source', String(event.detail?.value ?? ''))}
            />
          </div>

          <div class="form-control w-full">
            <span class="label-text text-xs opacity-80 mb-1">{textOrFallback('targetProviderFilter', 'Target provider filter')}</span>
            <ComboInput
              value={getRowProviderFilter(index, 'target')}
              options={providerFilterOptions}
              allowCustom={false}
              placeholder={textOrFallback('allProviders', 'All providers')}
              on:change={(event) => updateRowProviderFilter(index, 'target', String(event.detail ?? ''))}
              on:select={(event) => updateRowProviderFilter(index, 'target', String(event.detail?.value ?? ''))}
            />
          </div>

          <button class="btn btn-sm btn-ghost invisible pointer-events-none" type="button" aria-hidden="true">
            {$_('common.delete')}
          </button>
        </div>
      {/if}

      <div class="grid grid-cols-[1fr_1fr_auto] gap-2 items-start">
        <div class="min-w-0">
          <ComboInput
            value={row.source}
            options={rowOptions[index]?.source ?? []}
            allowCustom={true}
            placeholder={$_(i18nKey('sourceLabel'))}
            on:change={(event) => updateRow(index, 'source', String(event.detail ?? ''))}
          />
        </div>

        <div class="min-w-0">
          <ComboInput
            value={row.target}
            options={rowOptions[index]?.target ?? []}
            allowCustom={true}
            placeholder={$_(i18nKey('targetLabel'))}
            on:change={(event) => updateRow(index, 'target', String(event.detail ?? ''))}
          />
        </div>

        <button class="btn btn-sm btn-ghost text-error" type="button" on:click={() => removeRow(index)}>
          {$_('common.delete')}
        </button>
      </div>
    </div>
  {/each}

  <div class="flex items-center justify-between gap-2">
    <button class="btn btn-sm btn-outline" type="button" on:click={addRow}>
      {$_(i18nKey('addRow'))}
    </button>

    {#if loading}
      <span
        class="loading loading-spinner loading-xs text-base-content/50"
        aria-label="loading model catalog"
        title="loading"
      ></span>
    {/if}
  </div>
</div>
