<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { _ } from '$i18n';
  import { Button } from '$components/ui/button';
  import BSelect from '$components/industrial/BSelect.svelte';
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

  function toSelectOptions(opts: { value: string; label?: string }[]): { value: string; label: string }[] {
    return opts.map((opt) => ({ value: opt.value, label: opt.label ?? opt.value }));
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
            <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500 block">{textOrFallback('sourceProviderFilter', 'Source provider filter')}</span>
            {#if normalizedSourceCatalogProvider}
              <BSelect
                value={normalizedSourceCatalogProvider}
                options={[{ value: normalizedSourceCatalogProvider, label: normalizedSourceCatalogProvider }]}
                disabled
              />
            {:else}
              <BSelect
                creatable
                value={getRowProviderFilter(index, 'source')}
                options={toSelectOptions(providerFilterOptions)}
                placeholder={textOrFallback('allProviders', 'All providers')}
                onchange={(v) => updateRowProviderFilter(index, 'source', typeof v === 'string' ? v : '')}
              />
            {/if}
          </div>

          <div class="w-full space-y-1">
            <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500 block">{textOrFallback('targetProviderFilter', 'Target provider filter')}</span>
            {#if normalizedTargetCatalogProvider}
              <BSelect
                value={normalizedTargetCatalogProvider}
                options={[{ value: normalizedTargetCatalogProvider, label: normalizedTargetCatalogProvider }]}
                disabled
              />
            {:else}
              <BSelect
                creatable
                value={getRowProviderFilter(index, 'target')}
                options={toSelectOptions(providerFilterOptions)}
                placeholder={textOrFallback('allProviders', 'All providers')}
                onchange={(v) => updateRowProviderFilter(index, 'target', typeof v === 'string' ? v : '')}
              />
            {/if}
          </div>

          <Button variant="ghost" size="sm" class="invisible pointer-events-none" disabled aria-hidden="true">
            {$_('common.delete')}
          </Button>
        </div>
      {/if}

      <div class="grid grid-cols-[1fr_1fr_auto] gap-2 items-start">
        <div class="min-w-0">
          <BSelect
            creatable
            value={row.source}
            options={toSelectOptions(rowOptions[index]?.source ?? [])}
            placeholder={$_(i18nKey('sourceLabel'))}
            onchange={(v) => updateRow(index, 'source', typeof v === 'string' ? v : '')}
          />
        </div>

        <div class="min-w-0">
          <BSelect
            creatable
            value={row.target}
            options={toSelectOptions(rowOptions[index]?.target ?? [])}
            placeholder={$_(i18nKey('targetLabel'))}
            onchange={(v) => updateRow(index, 'target', typeof v === 'string' ? v : '')}
          />
        </div>

        <Button variant="destructive" size="sm" onclick={() => removeRow(index)}>
          {$_('common.delete')}
        </Button>
      </div>
    </div>
  {/each}

  <div class="flex items-center justify-between gap-2">
    <Button variant="outline" size="sm" onclick={addRow} data-testid="model-mapping-add-button">
      {$_(i18nKey('addRow'))}
    </Button>

    {#if loading}
      <LoadingIndicator label="" size="xs" centered={false} />
    {/if}
  </div>
</div>
