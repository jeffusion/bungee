<script lang="ts">
  import { onMount } from 'svelte';
  import { isLoading } from 'svelte-i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import { PanelCard, LoadingIndicator, BSelect } from '$components/industrial';
  import { Button } from '$components/ui/button';
  import { Label } from '$components/ui/label';
  import { requestPluginControl, _ } from '@bungee/plugin-sdk';
  import type { ModelsDevCatalogStatus, ModelsDevProviderSummary } from '../../models-dev/contract';
  import ClientModelPicker from './ClientModelPicker.svelte';
  import { MAX_PRICE_MODEL_MAPPINGS, parsePriceModelMappings, type PriceModelMapping } from '../server/model-mappings';
  import PriceModelPicker from './PriceModelPicker.svelte';

  let status: ModelsDevCatalogStatus | null = $state(null);
  let loading = $state(true);
  let error = $state('');
  let mappings = $state<PriceModelMapping[]>([]);
  let mappingsBusy = $state(false);
  let mappingsLoaded = $state(false);
  let mappingsSaved = $state(false);
  let mappingsError = $state('');
  let providersError = $state(false);
  let catalogVersion: number | null = $state(null);
  let providers = $state<ModelsDevProviderSummary[]>([]);
  let providersVersion: number | null | undefined;
  let providersPendingVersion: number | null | undefined;
  let providersGeneration = 0;
  let mappingIds = $state<number[]>([]);
  let nextMappingId = 0;
  const providerOptions = $derived(providers.map(provider => ({
    value: provider.provider, label: `${provider.name} · ${provider.provider}`,
  })));
  let alive = false;
  let polling = false;
  const controller = new AbortController();
  const t = (key: string) => $isLoading ? '' : getPluginText(`settings.${key}`, 'token-stats', (id, options) => $_(id, options));
  const date = (value: number | null) => value === null ? t('never') : new Date(value).toLocaleString();

  async function loadProviders(version: number | null) {
    if (providersPendingVersion === version) return;
    providersPendingVersion = version;
    const generation = ++providersGeneration;
    try {
      const providerResult = await requestPluginControl<{ providers: ModelsDevProviderSummary[] }>('models-dev', '/catalog/providers', 'GET', undefined, controller.signal);
      if (alive && generation === providersGeneration && catalogVersion === version) {
        providers = providerResult.providers;
        providersVersion = version;
        providersError = false;
      }
    } catch { if (alive && generation === providersGeneration) providersError = true; }
    finally { if (generation === providersGeneration) providersPendingVersion = undefined; }
  }

  async function loadMappings() {
    try {
      const result = await requestPluginControl<{ mappings: PriceModelMapping[] }>('token-stats', '/pricing/mappings', 'GET', undefined, controller.signal);
      if (alive) {
        mappings = result.mappings;
        mappingIds = mappings.map(() => nextMappingId++);
        mappingsLoaded = true;
        mappingsError = '';
      }
    } catch { if (alive) mappingsError = 'error'; }
  }

  function changeMapping(index: number, key: keyof PriceModelMapping, value: string) {
    mappings = mappings.map((mapping, i) => i === index ? { ...mapping, [key]: value, ...(key === 'provider' ? { model: '' } : {}) } : mapping);
    mappingsSaved = false;
    mappingsError = '';
  }

  function addMapping() {
    mappings = [...mappings, { source: '', provider: '', model: '' }];
    mappingIds = [...mappingIds, nextMappingId++];
    mappingsSaved = false;
  }

  function removeMapping(index: number) {
    mappings = mappings.filter((_, i) => i !== index);
    mappingIds = mappingIds.filter((_, i) => i !== index);
    mappingsSaved = false;
    mappingsError = '';
  }

  async function saveMappings() {
    if (!mappingsLoaded || mappingsBusy) return;
    mappingsSaved = false;
    let parsed: PriceModelMapping[];
    try {
      parsed = parsePriceModelMappings(mappings);
    } catch { mappingsError = 'mappingsInvalid'; return; }
    mappingsBusy = true;
    mappingsError = '';
    try {
      const result = await requestPluginControl<{ mappings: PriceModelMapping[] }>('token-stats', '/pricing/mappings', 'PUT', parsed, controller.signal);
      if (alive) { mappings = result.mappings; mappingsSaved = true; }
    } catch (error) { if (alive) mappingsError = error instanceof Error && error.message === 'invalid_input' ? 'mappingsInvalid' : 'error'; }
    finally { if (alive) mappingsBusy = false; }
  }

  async function load() {
    if (polling) return;
    polling = true;
    try {
      const result = await requestPluginControl<ModelsDevCatalogStatus>('token-stats', '/pricing', 'GET', undefined, controller.signal);
      if (!alive) return;
      status = result;
      catalogVersion = result.version;
      if (providersVersion !== result.version || providersError) void loadProviders(result.version);
      error = '';
    } catch {
      if (alive) error = 'error';
    } finally {
      if (alive) loading = false;
      polling = false;
    }
  }

  onMount(() => {
    alive = true;
    void load();
    void loadMappings();
    const timer = setInterval(() => { void load(); }, 3000);
    return () => { alive = false; controller.abort(); clearInterval(timer); };
  });
</script>

<div class="space-y-6" data-testid="token-stats-settings">
  <p class="text-sm text-zinc-400">{t('description')}</p>
  {#if error}<p role="alert" class="border border-red-500/40 bg-carbon-900 p-3 text-sm text-red-400">{t(error)}</p>{/if}
  {#if loading}
    <LoadingIndicator />
  {:else if status}
    <PanelCard title={t('mappingsTitle')}>
      <div class="space-y-5">
        <p class="text-sm text-zinc-400">{t('mappingsDescription')}</p>
        {#if providersError}<p role="alert" class="text-sm text-red-400">{t('modelsError')}</p>{/if}
        {#if mappingsError}<p role="alert" class="text-sm text-red-400">{t(mappingsError)}</p>{/if}
        {#if !mappingsLoaded}
          <Button variant="outline" onclick={() => void loadMappings()}>{t('mappingRetry')}</Button>
        {/if}
        {#if !status.modelCount}<p class="text-sm text-amber-400">{t('mappingsNoCatalog')}</p>{/if}
        {#each mappings as mapping, index (mappingIds[index])}
          <div class="grid min-w-0 gap-3 border-b border-carbon-600 pb-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_auto] sm:items-end" data-testid="price-model-mapping">
            <div class="min-w-0 space-y-2">
              <Label for={`price-alias-${mappingIds[index]}`}>{t('mappingSource')}</Label>
              <ClientModelPicker id={`price-alias-${mappingIds[index]}`} value={mapping.source} label={t('mappingSource')}
                placeholder={t('mappingSourcePlaceholder')} loadingLabel={t('clientModelsLoading')} errorLabel={t('clientModelsError')}
                emptyLabel={t('clientModelsEmpty')} loadedLabel={t('modelsLoaded')} completeLabel={t('modelsComplete')} loadMoreLabel={t('modelsLoadMore')}
                searchLabel={t('mappingSearch')} retryLabel={t('modelSearchRetry')} customLabel={t('mappingUseCustom')}
                disabled={mappingsBusy} onchange={(value) => changeMapping(index, 'source', value)} />
            </div>
            <div class="min-w-0 space-y-2">
              <span class="nx-field-label block">{t('mappingProvider')}</span>
              <BSelect value={mapping.provider} options={providerOptions} ariaLabel={t('mappingProvider')} placeholder={t('mappingProvider')}
                disabled={mappingsBusy || !providers.length} onchange={(value) => changeMapping(index, 'provider', String(value))} />
            </div>
            <div class="min-w-0 space-y-2">
              <span class="nx-field-label block">{t('mappingTarget')}</span>
              <PriceModelPicker value={mapping.model} provider={mapping.provider} {catalogVersion}
                disabled={mappingsBusy || !mapping.provider || !status.modelCount} label={t('mappingTarget')} placeholder={t('mappingTarget')}
                searchLabel={t('mappingSearch')} emptyLabel={t('mappingNoModels')} loadingLabel={t('clientModelsLoading')}
                errorLabel={t('modelsError')} retryLabel={t('modelSearchRetry')} loadedLabel={t('modelsLoaded')} completeLabel={t('modelsComplete')} loadMoreLabel={t('modelsLoadMore')}
                onchange={(value) => changeMapping(index, 'model', value)} />
            </div>
            <Button variant="ghost" disabled={mappingsBusy} onclick={() => removeMapping(index)}>{t('mappingRemove')}</Button>
          </div>
        {/each}
        <div class="flex flex-wrap items-center gap-4">
          <Button variant="outline" disabled={!mappingsLoaded || mappingsBusy || mappings.length >= MAX_PRICE_MODEL_MAPPINGS} onclick={addMapping}>{t('mappingAdd')}</Button>
          <Button data-testid="price-mappings-save" disabled={!mappingsLoaded || mappingsBusy} aria-busy={mappingsBusy} onclick={() => void saveMappings()}>{t(mappingsBusy ? 'saving' : 'mappingsSave')}</Button>
          {#if mappingsSaved}<span role="status" class="text-sm text-emerald-400">{t('mappingsSaved')}</span>{/if}
        </div>
      </div>
    </PanelCard>
    <PanelCard title={t('catalog')}>
      <dl class="grid gap-5 text-sm sm:grid-cols-2 lg:grid-cols-3" data-testid="pricing-catalog-status">
        <div class="space-y-2"><dt class="text-zinc-400">{t('catalogState')}</dt><dd data-testid="pricing-catalog-state">{t(status.state)}</dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('catalogVersion')}</dt><dd data-testid="pricing-catalog-version">{status.version ?? t('never')}</dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('lastSuccess')}</dt><dd data-testid="price-last-success" class="font-mono text-zinc-200">{date(status.fetchedAt)}</dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('modelCount')}</dt><dd>{status.modelCount}</dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('providerCount')}</dt><dd>{status.providerCount}</dd></div>
      </dl>
      {#if status.error}<p role="status" data-testid="pricing-catalog-error" class="mt-5 border-l-2 border-amber-400 pl-3 text-sm text-amber-400">{t('catalogFailure')}</p>{/if}
      <p class="mt-5 border-t border-carbon-600 pt-4 text-xs leading-relaxed text-zinc-400">{t('history')}</p>
    </PanelCard>
  {/if}
</div>
