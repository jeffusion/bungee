<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { on } from 'svelte/events';
  import ArrowRight from 'lucide-svelte/icons/arrow-right';
  import { _, isLoading } from '$i18n';
  import { requestPluginControl } from '$api/client';
  import { Button } from '$components/ui/button';
  import { Input } from '$components/ui/input';
  import { Label } from '$components/ui/label';
  import { BSelect, LoadingIndicator, PanelCard } from '$components/industrial';
  import { createModelSearch, type ModelSearchState } from '$components/industrial/paginated-search';
  import { canonicalizeProviderFilter, type ModelOption, type RowProviderFilter } from './filtering';

  type CatalogIdentity = { provider: string; model: string };
  type ModelMapping = { source: string; target: string; catalogModel?: CatalogIdentity };
  type CatalogPage = { models: ModelOption[]; providers: string[]; matchedCount: number; page: number; pageSize: number };
  type PickerKind = 'source' | 'catalog';
  type SearchQuery = { provider: string; search: string };

  let { value = $bindable([]), pluginName = 'model-mapping', catalogPlugin = 'model-mapping',
    sourceCatalogProvider = '', targetCatalogProvider = '', onchange }:
    { value?: ModelMapping[]; pluginName?: string; catalogPlugin?: string; sourceCatalogProvider?: string;
      targetCatalogProvider?: string; onchange?: (mappings: ModelMapping[]) => void } = $props();

  const componentId = `model-mapping-${Math.random().toString(36).slice(2, 10)}`;
  let rowIds = $state<number[]>(untrack(() => value.map((_, index) => index)));
  let nextRowId = untrack(() => value.length);
  let filters = $state<Record<number, RowProviderFilter>>({});
  let catalogPicker = $state<number | null>(null);
  let results = $state<Record<string, ModelSearchState<ModelOption>>>({});
  const searches = new Map<string, ReturnType<typeof createModelSearch<ModelOption, SearchQuery>>>();
  const emptyResults: ModelSearchState<ModelOption> = { models: [], total: 0, page: 1, pageSize: 50, loading: false, error: false };
  let providers = $state<string[]>([]);
  let loading = $state(false);
  let catalogError = $state(false);
  let catalogReload = $state(0);
  let rows = $derived(Array.isArray(value) ? value.map(item => ({
    ...item,
    source: typeof item?.source === 'string' ? item.source : '',
    target: typeof item?.target === 'string' ? item.target : '',
  })) : []);
  const normalizedCatalogPlugin = $derived((catalogPlugin || 'model-mapping').trim());
  const normalizedSourceProvider = $derived(sourceCatalogProvider.trim());
  const normalizedTargetProvider = $derived(targetCatalogProvider.trim());
  const i18nPrefix = $derived(`plugins.${(pluginName || 'model-mapping').trim()}.modelMapping`);
  const t = (suffix: string, fallback = '') => {
    if ($isLoading) return fallback;
    const key = `${i18nPrefix}.${suffix}`;
    const translated = $_(key);
    return translated === key ? fallback : translated;
  };
  const providerOptions = $derived([{ value: '', label: t('allProviders', 'All providers') },
    ...providers.map(provider => ({ value: provider, label: provider }))]);
  const searchLabels = $derived({ search: t('search', 'Search models'), loading: t('loading', 'Loading models'),
    error: t('error', 'Unable to load models'), empty: t('noOptions', 'No matching models'), retry: t('retry', 'Retry'),
    custom: t('custom', 'Use custom name:'), loaded: t('loaded', 'Loaded'), complete: t('complete', 'All loaded'),
    loadMore: t('loadMore', 'Load more'), clear: t('clearCatalog', 'Clear catalog association') });

  $effect(() => {
    if (rowIds.length !== rows.length) rowIds = rows.map((_, index) => rowIds[index] ?? nextRowId++);
  });
  $effect(() => {
    const plugin = normalizedCatalogPlugin;
    catalogReload;
    const controller = new AbortController();
    loading = true;
    catalogError = false;
    providers = [];
    void requestPluginControl<CatalogPage>(plugin, '/catalog', 'GET', undefined, controller.signal)
      .then(page => { if (!controller.signal.aborted) providers = page.providers; })
      .catch(() => { if (!controller.signal.aborted) catalogError = true; })
      .finally(() => { if (!controller.signal.aborted) loading = false; });
    return () => controller.abort();
  });
  onMount(() => () => { for (const search of searches.values()) search.destroy(); });

  function filterFor(id: number, kind: PickerKind, row: ModelMapping): string {
    return kind === 'source' ? normalizedSourceProvider || filters[id]?.source || ''
      : normalizedTargetProvider || (filters[id]?.target ?? row.catalogModel?.provider ?? '');
  }
  function changeFilter(id: number, kind: PickerKind, provider: string): void {
    const previous = filters[id] ?? { source: '', target: '' };
    filters = { ...filters, [id]: { ...previous, [kind === 'source' ? 'source' : 'target']: canonicalizeProviderFilter(provider, providers) } };
  }
  function searchKey(id: number, kind: PickerKind): string { return `${id}:${kind}`; }
  function searchResult(id: number, kind: PickerKind) { return results[searchKey(id, kind)] ?? emptyResults; }
  function searchModels(id: number, kind: PickerKind, provider: string, keyword: string, page: number, debounce: boolean): void {
    const key = searchKey(id, kind);
    let search = searches.get(key);
    if (!search) {
      search = createModelSearch<ModelOption, SearchQuery>(async (path, signal) => {
        const response = await requestPluginControl<CatalogPage>(normalizedCatalogPlugin, path, 'GET', undefined, signal);
        return { models: response.models, total: response.matchedCount, page: response.page, pageSize: response.pageSize };
      }, state => { results = { ...results, [key]: state }; }, (query, nextPage) => {
        const params = new URLSearchParams({ search: query.search, page: String(nextPage) });
        if (query.provider) params.set('provider', query.provider);
        return `/catalog?${params}`;
      });
      searches.set(key, search);
    }
    search.search({ provider, search: keyword }, page, debounce);
  }
  function cancelSearch(id: number, kind: PickerKind): void { searches.get(searchKey(id, kind))?.cancel(); }
  function closeCatalogPicker(id: number): void {
    catalogPicker = null;
    cancelSearch(id, 'catalog');
    void tick().then(() => document.getElementById(`${componentId}-${id}-catalog-action`)?.focus());
  }
  function pickerKeys(node: HTMLElement, id: number) {
    return { destroy: on(node, 'keydown', event => {
      if (event.key === 'Escape' && !event.isComposing && catalogPicker === id) {
        event.preventDefault(); event.stopPropagation(); closeCatalogPicker(id);
      }
    }) };
  }
  function identityValue(identity?: CatalogIdentity): string {
    return identity ? JSON.stringify([identity.provider, identity.model]) : '';
  }
  function catalogOptions(id: number, row: ModelMapping): Array<{ value: string; label: string; disabled?: boolean }> {
    const options: Array<{ value: string; label: string; disabled?: boolean }> = searchResult(id, 'catalog').models
      .filter(option => typeof option.provider === 'string' && option.provider.length > 0)
      .map(option => ({ value: identityValue({ provider: option.provider!, model: option.value }), label: `${option.value} · ${option.provider}` }));
    if (row.catalogModel) {
      const key = identityValue(row.catalogModel);
      if (!options.some(option => option.value === key)) options.push({ value: key, label: `${row.catalogModel.model} · ${row.catalogModel.provider}`, disabled: true });
    }
    return options;
  }
  function publish(nextRows: ModelMapping[]): void { value = nextRows; onchange?.(nextRows); }
  function updateRow(index: number, key: 'source' | 'target', nextValue: string): void {
    publish(rows.map((row, i) => i === index ? { ...row, [key]: nextValue } : row));
  }
  function updateIdentity(index: number, selection: string): void {
    if (!selection) { clearIdentity(index); return; }
    // Only catalog options can be confirmed. Decode the exact provider/value pair
    // carried by that option, including candidates retained from earlier pages.
    const identity: unknown = JSON.parse(selection);
    if (!Array.isArray(identity) || identity.length !== 2 || identity.some(part => typeof part !== 'string' || !part)) return;
    const [provider, model] = identity as [string, string];
    publish(rows.map((row, i) => i === index ? { ...row, catalogModel: { provider, model } } : row));
    closeCatalogPicker(rowIds[index]);
  }
  function clearIdentity(index: number): void {
    publish(rows.map((row, i) => {
      if (i !== index) return row;
      const { catalogModel, ...rest } = row;
      return rest;
    }));
    if (catalogPicker === rowIds[index]) closeCatalogPicker(rowIds[index]);
  }
  function addRow(): void { rowIds = [...rowIds, nextRowId++]; publish([...rows, { source: '', target: '' }]); }
  function removeRow(index: number): void {
    const id = rowIds[index];
    for (const kind of ['source', 'catalog'] as const) {
      const key = searchKey(id, kind);
      searches.get(key)?.destroy(); searches.delete(key);
      delete results[key];
    }
    delete filters[id];
    if (catalogPicker === id) catalogPicker = null;
    rowIds = rowIds.filter((_, i) => i !== index);
    publish(rows.filter((_, i) => i !== index));
  }
</script>

<div class="space-y-3" data-testid="model-mapping-editor">
  {#if !rows.length}<p class="text-sm text-zinc-400">{t('empty', 'No model mappings configured')}</p>{/if}
  {#each rows as row, index (rowIds[index])}
    {@const rowId = rowIds[index]}
    {@const id = `${componentId}-${rowId}`}
    {@const sourceProvider = filterFor(rowId, 'source', row)}
    {@const catalogProvider = filterFor(rowId, 'catalog', row)}
    <div class="min-w-0" data-testid="model-mapping-row">
      <PanelCard headless variant="flat" corners={false}>
        <div class="min-w-0 space-y-3" use:pickerKeys={rowId}>
          <div class="flex items-center justify-between gap-3">
            <span class="font-mono text-xs text-zinc-400">{t('rule', 'Rule')} {String(index + 1).padStart(2, '0')}</span>
            <Button variant="ghost" size="sm" onclick={() => removeRow(index)}>{$_('common.delete')}</Button>
          </div>
          <div class="mapping-flow">
            <div class="min-w-0 space-y-1.5">
              <Label class="block" for={`${id}-source`}>{t('sourceLabel', 'Model name in request')}</Label>
              <BSelect id={`${id}-source`} creatable value={row.source} options={searchResult(rowId, 'source').models.map(option => ({ value: option.value, label: option.value }))}
                ariaLabel={t('sourceLabel', 'Model name in request')} placeholder={t('sourceLabel', 'Model name in request')} {searchLabels}
                remoteSearch={{ result: searchResult(rowId, 'source'), resetKey: JSON.stringify([normalizedCatalogPlugin, sourceProvider]),
                  search: (keyword, page, debounce) => searchModels(rowId, 'source', sourceProvider, keyword, page, debounce),
                  cancel: () => cancelSearch(rowId, 'source') }}
                onchange={next => updateRow(index, 'source', String(next))}>
                {#snippet searchHeader()}
                  <Label class="mb-1.5 block" for={`${id}-source-provider`}>{t('sourceProviderFilter', 'Source provider filter')}</Label>
                  <BSelect id={`${id}-source-provider`} searchable value={sourceProvider} options={providerOptions}
                    disabled={!!normalizedSourceProvider} ariaLabel={t('sourceProviderFilter', 'Source provider filter')}
                    {searchLabels} onchange={next => changeFilter(rowId, 'source', String(next))} />
                {/snippet}
              </BSelect>
              <p class="text-sm text-zinc-400">{t('sourceHint', 'Enter a name or find it in the catalog.')}</p>
            </div>
            <div class="mapping-arrow text-zinc-400" aria-hidden="true"><ArrowRight class="h-4 w-4" /></div>
            <div class="min-w-0 space-y-1.5">
              <Label class="block" for={`${id}-target`}>{t('targetLabel', 'Model name sent upstream')}</Label>
              <Input id={`${id}-target`} aria-label={t('targetLabel', 'Model name sent upstream')} value={row.target} maxlength={512}
                placeholder={t('targetLabel', 'Model name sent upstream')} oninput={event => updateRow(index, 'target', event.currentTarget.value)} />
              <p class="text-sm text-zinc-400">{t('targetHint', 'Letter case is preserved.')}</p>
            </div>
          </div>
          <div class="space-y-2 border-t border-carbon-600 pt-3">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="min-w-0 flex-1 space-y-1.5">
                <p class="text-sm text-zinc-400">{t('catalogAssociation', 'Capability catalog (optional)')}</p>
                {#if row.catalogModel}
                  <span class="block break-all font-mono text-sm text-zinc-200" data-testid="model-mapping-catalog-identity">{row.catalogModel.provider}/{row.catalogModel.model}</span>
                {:else}
                  <span class="text-sm text-zinc-300">{t('unassociated', 'Not associated')}</span>
                {/if}
              </div>
              <div class="flex flex-wrap items-center gap-1.5">
                <Button id={`${id}-catalog-action`} variant="outline" size="sm" aria-expanded={catalogPicker === rowId}
                  aria-controls={catalogPicker === rowId ? `${id}-catalog-picker` : undefined}
                  onclick={() => { if (catalogPicker === rowId) closeCatalogPicker(rowId); else catalogPicker = rowId; }}>
                  {row.catalogModel ? t('changeCatalog', 'Change') : t('associateCatalog', 'Associate catalog model')}
                </Button>
                {#if row.catalogModel}<Button variant="ghost" size="sm" onclick={() => clearIdentity(index)}>{t('clearCatalog', 'Clear association')}</Button>{/if}
              </div>
            </div>
            <p class="text-sm text-zinc-400">{t('catalogHint', 'Checks reasoning and protocol capabilities without changing the upstream name.')}</p>
            {#if catalogPicker === rowId}
              <div id={`${id}-catalog-picker`} class="space-y-3 border border-carbon-600 bg-carbon-800 p-3" data-testid="model-mapping-catalog-picker">
                <div class="flex items-center justify-between gap-3">
                  <span class="text-sm font-semibold text-zinc-300">{t('selectCatalog', 'Select capability catalog')}</span>
                  <Button variant="ghost" size="sm" onclick={() => closeCatalogPicker(rowId)}>{$_('common.cancel')}</Button>
                </div>
                <div class="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                  <div class="min-w-0 space-y-1.5">
                    <Label class="block" for={`${id}-catalog-provider`}>{t('catalogProviderFilter', 'Catalog provider filter')}</Label>
                    <BSelect id={`${id}-catalog-provider`} searchable value={catalogProvider} options={providerOptions}
                      disabled={!!normalizedTargetProvider} ariaLabel={t('catalogProviderFilter', 'Catalog provider filter')}
                      {searchLabels} onchange={next => changeFilter(rowId, 'catalog', String(next))} />
                  </div>
                  <div class="min-w-0 space-y-1.5">
                    <Label class="block" for={`${id}-catalog`}>{t('catalogLabel', 'Catalog model')}</Label>
                    <BSelect id={`${id}-catalog`} value={identityValue(row.catalogModel)} options={catalogOptions(rowId, row)}
                      ariaLabel={t('catalogLabel', 'Catalog model')} placeholder={t('catalogPlaceholder', 'Select a catalog model')} {searchLabels}
                      remoteSearch={{ result: searchResult(rowId, 'catalog'), resetKey: JSON.stringify([normalizedCatalogPlugin, catalogProvider]),
                        search: (keyword, page, debounce) => searchModels(rowId, 'catalog', catalogProvider, keyword, page, debounce),
                        cancel: () => cancelSearch(rowId, 'catalog') }}
                      onchange={next => updateIdentity(index, String(next))} />
                  </div>
                </div>
              </div>
            {/if}
          </div>
        </div>
      </PanelCard>
    </div>
  {/each}
  <div class="flex flex-wrap items-center justify-between gap-2">
    <Button variant="outline" size="sm" onclick={addRow} data-testid="model-mapping-add-button">{t('addRow', 'Add mapping')}</Button>
    {#if loading}<LoadingIndicator label="" size="xs" centered={false} />{/if}
    {#if catalogError}<span role="alert" class="text-xs text-red-400">{t('error', 'Unable to load models')}</span><Button variant="ghost" size="sm" onclick={() => catalogReload++}>{t('retry', 'Retry')}</Button>{/if}
  </div>
</div>

<style>
  .mapping-flow { display: grid; min-width: 0; gap: 6px; }
  .mapping-arrow { width: 18px; transform: rotate(90deg); }
  @media (min-width: 640px) {
    .mapping-flow { grid-template-columns: minmax(0, 1fr) 18px minmax(0, 1fr); gap: 12px; }
    .mapping-arrow { padding-top: 32px; transform: none; }
  }
</style>
