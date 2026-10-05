<script lang="ts">
  import { onMount } from 'svelte';
  import { isLoading } from 'svelte-i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import { PanelCard, IndustrialToggle, LoadingIndicator, BSelect } from '$components/industrial';
  import { Button } from '$components/ui/button';
  import { Input } from '$components/ui/input';
  import { Label } from '$components/ui/label';
  import { requestPluginControl, _ } from '@bungee/plugin-sdk';
  import type { PriceStatus } from '../server/price-catalog';
  import { MAX_PRICE_MODEL_MAPPINGS, parsePriceModelMappings, isUnchangedPriceModelMapping, type PriceModelMapping, type PriceModelOption } from '../server/model-mappings';
  import PriceModelPicker from './PriceModelPicker.svelte';

  let status: PriceStatus | null = $state(null);
  let autoRefresh = $state(true);
  let intervalMinutes = $state(60);
  let timeoutSeconds = $state(15);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let saved = $state(false);
  let models = $state<PriceModelOption[]>([]);
  let mappings = $state<PriceModelMapping[]>([]);
  let persistedMappings = $state<PriceModelMapping[]>([]);
  let mappingsBusy = $state(false);
  let mappingsLoaded = $state(false);
  let mappingsSaved = $state(false);
  let mappingsError = $state('');
  let modelsError = $state(false);
  let catalogTimestamp: number | null = null;
  let mappingIds = $state<number[]>([]);
  let nextMappingId = 0;
  const providerOptions = $derived(Array.from(new Map(models.map(model => [model.provider, {
    value: model.provider, label: `${model.providerName} · ${model.provider}`,
  }])).values()));
  let alive = false;
  let polling = false;
  const controller = new AbortController();
  const t = (key: string) => $isLoading ? '' : getPluginText(`settings.${key}`, 'token-stats', (id, options) => $_(id, options));
  const date = (value: number | null) => value === null ? t('never') : new Date(value).toLocaleString();

  async function loadModels() {
    try {
      const result = await requestPluginControl<{ models: PriceModelOption[] }>('token-stats', '/pricing/models', 'GET', undefined, controller.signal);
      if (alive) { models = result.models; modelsError = false; }
    } catch { if (alive) modelsError = true; }
  }

  async function loadMappings() {
    try {
      const result = await requestPluginControl<{ mappings: PriceModelMapping[] }>('token-stats', '/pricing/mappings', 'GET', undefined, controller.signal);
      if (alive) {
        mappings = result.mappings;
        persistedMappings = structuredClone(result.mappings);
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
      if (parsed.some(mapping => !models.some(model => model.provider === mapping.provider && model.model === mapping.model)
        && !isUnchangedPriceModelMapping(mapping, persistedMappings))) throw new Error('invalid_input');
    } catch { mappingsError = 'mappingsInvalid'; return; }
    mappingsBusy = true;
    mappingsError = '';
    try {
      const result = await requestPluginControl<{ mappings: PriceModelMapping[] }>('token-stats', '/pricing/mappings', 'PUT', parsed, controller.signal);
      if (alive) { mappings = result.mappings; persistedMappings = structuredClone(result.mappings); mappingsSaved = true; }
    } catch { if (alive) mappingsError = 'error'; }
    finally { if (alive) mappingsBusy = false; }
  }

  async function load(initial = false) {
    if (polling) return;
    polling = true;
    try {
      const result = await requestPluginControl<PriceStatus>('token-stats', '/pricing', 'GET', undefined, controller.signal);
      if (!alive) return;
      status = result;
      if (initial || result.lastSuccessAt !== catalogTimestamp || modelsError) {
        await loadModels();
        if (!alive) return;
        catalogTimestamp = result.lastSuccessAt;
      }
      if (initial) {
        autoRefresh = result.settings.autoRefresh;
        intervalMinutes = result.settings.intervalMinutes;
        timeoutSeconds = result.settings.timeoutSeconds;
      }
      error = '';
    } catch {
      if (alive) error = 'error';
    } finally {
      if (alive) loading = false;
      polling = false;
    }
  }

  async function save() {
    saved = false;
    const interval = Number(intervalMinutes);
    const timeout = Number(timeoutSeconds);
    if (!Number.isInteger(interval) || interval < 1 || interval > 1440
      || !Number.isInteger(timeout) || timeout < 5 || timeout > 60) {
      error = 'invalid'; return;
    }
    busy = true;
    error = '';
    try {
      const result = await requestPluginControl<PriceStatus>('token-stats', '/pricing/settings', 'PUT',
        { autoRefresh, intervalMinutes: interval, timeoutSeconds: timeout }, controller.signal);
      if (alive) { status = result; saved = true; }
    } catch { if (alive) error = 'error'; }
    finally { if (alive) busy = false; }
  }

  async function refresh() {
    busy = true;
    error = '';
    try {
      const result = await requestPluginControl<PriceStatus>('token-stats', '/pricing/refresh', 'POST', undefined, controller.signal);
      if (alive) status = result;
    } catch { if (alive) error = 'error'; }
    finally { if (alive) busy = false; }
  }

  onMount(() => {
    alive = true;
    void load(true);
    void loadMappings();
    const timer = setInterval(() => { if (!busy) void load(); }, 3000);
    return () => { alive = false; controller.abort(); clearInterval(timer); };
  });
</script>

<div class="space-y-6" data-testid="token-stats-settings">
  <p class="text-sm text-zinc-400">{t('description')}</p>
  {#if error}<p role="alert" class="border border-red-500/40 bg-carbon-900 p-3 text-sm text-red-400">{t(error)}</p>{/if}
  {#if loading}
    <LoadingIndicator />
  {:else if status}
    <PanelCard title={t('title')}>
      <form class="space-y-5" onsubmit={(event) => { event.preventDefault(); void save(); }}>
        <div class="flex items-center justify-between gap-4 border-b border-carbon-600 pb-4">
          <Label for="token-price-auto">{t('autoRefresh')}</Label>
          <IndustrialToggle id="token-price-auto" label={t('autoRefresh')} bind:checked={autoRefresh} disabled={busy} />
        </div>
        <div class="grid gap-5 sm:grid-cols-2">
          <div class="space-y-2">
            <Label for="token-price-interval">{t('interval')}</Label>
            <Input id="token-price-interval" type="number" min={1} max={1440} step={1} bind:value={intervalMinutes} disabled={busy} required />
          </div>
          <div class="space-y-2">
            <Label for="token-price-timeout">{t('timeout')}</Label>
            <Input id="token-price-timeout" type="number" min={5} max={60} step={1} bind:value={timeoutSeconds} disabled={busy} required />
          </div>
        </div>
        <div class="flex items-center gap-4">
          <Button type="submit" disabled={busy} aria-busy={busy}>{t(busy ? 'saving' : 'save')}</Button>
          {#if saved}<span role="status" class="text-sm text-emerald-400">{t('saved')}</span>{/if}
        </div>
      </form>
    </PanelCard>
    <PanelCard title={t('mappingsTitle')}>
      <div class="space-y-5">
        <p class="text-sm text-zinc-400">{t('mappingsDescription')}</p>
        {#if modelsError}<p role="alert" class="text-sm text-red-400">{t('modelsError')}</p>{/if}
        {#if mappingsError}<p role="alert" class="text-sm text-red-400">{t(mappingsError)}</p>{/if}
        {#if !mappingsLoaded}
          <Button variant="outline" onclick={() => void loadMappings()}>{t('mappingRetry')}</Button>
        {/if}
        {#if !models.length}<p class="text-sm text-amber-400">{t('mappingsNoCatalog')}</p>{/if}
        {#if !mappings.length}<p class="text-sm text-zinc-400">{t('mappingsEmpty')}</p>{/if}
        {#each mappings as mapping, index (mappingIds[index])}
          <div class="grid min-w-0 gap-3 border-b border-carbon-600 pb-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_auto] sm:items-end" data-testid="price-model-mapping">
            <div class="min-w-0 space-y-2">
              <Label for={`price-alias-${mappingIds[index]}`}>{t('mappingSource')}</Label>
              <Input id={`price-alias-${mappingIds[index]}`} value={mapping.source} maxlength={256} placeholder={t('mappingSourcePlaceholder')}
                disabled={mappingsBusy} oninput={(event) => changeMapping(index, 'source', event.currentTarget.value)} />
            </div>
            <div class="min-w-0 space-y-2">
              <span class="nx-field-label block">{t('mappingProvider')}</span>
              <BSelect value={mapping.provider} options={providerOptions} ariaLabel={t('mappingProvider')} placeholder={t('mappingProvider')}
                disabled={mappingsBusy || !models.length} onchange={(value) => changeMapping(index, 'provider', String(value))} />
            </div>
            <div class="min-w-0 space-y-2">
              <span class="nx-field-label block">{t('mappingTarget')}</span>
              <PriceModelPicker value={mapping.model} options={models.filter(model => model.provider === mapping.provider)}
                disabled={mappingsBusy || !mapping.provider || !models.length} label={t('mappingTarget')} placeholder={t('mappingTarget')}
                searchLabel={t('mappingSearch')} emptyLabel={t('mappingNoModels')} onchange={(value) => changeMapping(index, 'model', value)} />
            </div>
            <Button variant="ghost" disabled={mappingsBusy} onclick={() => removeMapping(index)}>{t('mappingRemove')}</Button>
            {#if mapping.model && !models.some(model => model.provider === mapping.provider && model.model === mapping.model)}
              <p role="status" class="text-sm text-amber-400 sm:col-span-4">{t('mappingUnavailable')}</p>
            {/if}
          </div>
        {/each}
        <div class="flex flex-wrap items-center gap-4">
          <Button variant="outline" disabled={!mappingsLoaded || mappingsBusy || mappings.length >= MAX_PRICE_MODEL_MAPPINGS} onclick={addMapping}>{t('mappingAdd')}</Button>
          <Button disabled={!mappingsLoaded || mappingsBusy} aria-busy={mappingsBusy} onclick={() => void saveMappings()}>{t(mappingsBusy ? 'saving' : 'mappingsSave')}</Button>
          {#if mappingsSaved}<span role="status" class="text-sm text-emerald-400">{t('mappingsSaved')}</span>{/if}
        </div>
      </div>
    </PanelCard>
    <PanelCard title={t('catalog')}>
      <div slot="actions">
        <Button variant="outline" disabled={busy || status.refreshing} aria-busy={status.refreshing} onclick={() => void refresh()}>
          {t(status.refreshing ? 'refreshing' : 'refresh')}
        </Button>
      </div>
      <dl class="grid gap-5 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div class="space-y-2"><dt class="text-zinc-400">{t('source')}</dt><dd class="break-all text-zinc-200"><a href={status.source} target="_blank" rel="noopener noreferrer" class="hover:text-nexus-400 underline underline-offset-4">models.dev</a></dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('modelCount')}</dt><dd class="font-display text-xl text-nexus-500">{status.modelCount}</dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('providerCount')}</dt><dd class="font-display text-xl text-zinc-100">{status.providerCount}</dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('lastAttempt')}</dt><dd class="font-mono text-zinc-200">{date(status.lastAttemptAt)}</dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('lastSuccess')}</dt><dd data-testid="price-last-success" class="font-mono text-zinc-200">{date(status.lastSuccessAt)}</dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('nextRefresh')}</dt><dd class="font-mono text-zinc-200">{status.nextRefreshAt === null ? t(status.settings.autoRefresh ? 'refreshing' : 'disabled') : date(status.nextRefreshAt)}</dd></div>
      </dl>
      {#if status.lastError}
        <p role="status" class="mt-5 border-l-2 border-amber-400 pl-3 text-sm text-amber-400">{t(`${status.lastError}Error`)} · {t('failure')}</p>
      {/if}
      <p class="mt-5 border-t border-carbon-600 pt-4 text-xs leading-relaxed text-zinc-400">{t('history')}</p>
    </PanelCard>
  {/if}
</div>
