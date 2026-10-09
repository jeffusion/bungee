<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { _, isLoading } from '$i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import { getConfigSnapshot } from '$api/config';
  import { requestPluginControl } from '$api/client';
  import { BSelect, BCheckbox, LoadingIndicator } from '$components/industrial';
  import { Input } from '$components/ui/input';
  import { NumberInput } from '$components/ui/number-input';
  import { Label } from '$components/ui/label';
  import { Button } from '$components/ui/button';
  import PriceModelPicker from '@plugins/token-stats/ui/PriceModelPicker.svelte';
  import { createModelSearch, type ModelSearchState } from '@plugins/token-stats/ui/model-search';
  import type { ModelsDevModelOption, ModelsDevProviderSummary, ModelsDevCatalogStatus } from '@plugins/models-dev/contract';
  import type { ModelBinding } from '@plugins/codex-router/server/config';

  export let value: ModelBinding[] = [];
  export let catalogOnly = false;
  const dispatch = createEventDispatcher<{ change: ModelBinding[] }>();
  const componentId = `codex-bindings-${Math.random().toString(36).slice(2, 10)}`;
  let rowIds: number[] = [], nextRowId = 0;
  let providers: ModelsDevProviderSummary[] = [];
  let catalogVersion: number | null = null;
  let modelCount = 0, loading = true, catalogError = false, targetsError = false;
  let targets: { type: 'route' | 'service'; id: string; label: string; protocol?: string }[] = [];
  let search = '';
  let results: ModelSearchState<ModelsDevModelOption> = { models: [], total: 0, page: 1, pageSize: 50, loading: false, error: false };
  let alive = false;
  const controller = new AbortController();
  const modelSearch = createModelSearch<ModelsDevModelOption, string>(
    (path, signal) => requestPluginControl('codex-router', path, 'GET', undefined, signal),
    state => { results = state; },
    (query, page) => `/catalog?${new URLSearchParams({ search: query, page: String(page) })}`,
  );
  const t = (key: string) => $isLoading ? '' : getPluginText(`editor.${key}`, 'codex-router', (id, options) => $_(id, options));
  $: providerOptions = providers.map(provider => ({ value: provider.provider, label: `${provider.name} · ${provider.provider}` }));
  $: targetOptions = targets.map(target => ({ value: JSON.stringify([target.type, target.id]), label: `${target.label} · ${target.type} · ${target.protocol ?? t('protocolMissing')}` }));
  $: pages = Math.max(1, Math.ceil(results.total / results.pageSize));
  $: if (rowIds.length !== value.length) rowIds = value.map((_, index) => rowIds[index] ?? nextRowId++);

  function publish(next: ModelBinding[]) { value = next; dispatch('change', value); }
  function update(index: number, patch: Partial<ModelBinding>) {
    publish(value.map((binding, i) => {
      if (i !== index) return binding;
      const { alias, ...rest } = binding;
      return { ...rest, source: binding.source ?? alias ?? binding.model, ...patch };
    }));
  }
  function limit(index: number, key: keyof NonNullable<ModelBinding['capabilityOverrides']>, next: boolean | number | undefined) {
    const overrides = { ...value[index].capabilityOverrides };
    if (next === undefined) delete overrides[key]; else (overrides as Record<string, unknown>)[key] = next;
    update(index, { capabilityOverrides: overrides });
  }
  function add() {
    rowIds = [...rowIds, nextRowId++];
    publish([...value, { source: '', provider: '', model: '', target: { type: 'route', id: '' } }]);
  }
  function remove(index: number) {
    rowIds = rowIds.filter((_, i) => i !== index);
    publish(value.filter((_, i) => i !== index));
  }
  async function loadCatalog() {
    loading = true; catalogError = false;
    try {
      const data = await requestPluginControl<{ providers: ModelsDevProviderSummary[]; status: ModelsDevCatalogStatus }>('codex-router', '/catalog', 'GET', undefined, controller.signal);
      if (!alive) return;
      providers = data.providers; catalogVersion = data.status.version; modelCount = data.status.modelCount;
    } catch { if (alive) catalogError = true; }
    finally { if (alive) loading = false; }
  }
  async function loadTargets() {
    targetsError = false;
    try {
      const config = (await getConfigSnapshot()).config.logical_configuration;
      if (!alive) return;
      targets = [...config.routes.map(route => ({ type: 'route' as const, id: route.id, label: route.path, protocol: route.llm_protocol })), ...config.services.map(service => ({ type: 'service' as const, id: service.id, label: service.name, protocol: service.llm_protocol }))];
    } catch { if (alive) targetsError = true; }
  }
  onMount(() => {
    alive = true;
    if (catalogOnly) modelSearch.search('', 1, false);
    else { void loadCatalog(); void loadTargets(); }
    return () => { alive = false; controller.abort(); modelSearch.destroy(); };
  });
</script>

{#if catalogOnly}
  <div class="space-y-4" data-testid="codex-model-catalog">
    <div class="space-y-2"><Label for={`${componentId}-search`}>{t('search')}</Label>
      <Input id={`${componentId}-search`} aria-label={t('search')} value={search} on:input={(event) => { search = event.currentTarget.value; modelSearch.search(search); }} />
    </div>
    {#if results.loading}<LoadingIndicator label={t('loading')} />
    {:else if results.error}<p role="alert" class="text-sm text-red-400">{t('error')}</p><Button variant="outline" onclick={() => modelSearch.search(search, results.page, false)}>{t('retry')}</Button>
    {:else if !results.models.length}<p role="status" class="text-sm text-zinc-400">{t('empty')}</p>
    {:else}<div class="divide-y divide-carbon-600">
      {#each results.models as model (`${model.provider}:${model.model}`)}<div class="grid min-w-0 gap-1 py-3 text-sm sm:grid-cols-2"><span class="break-words text-zinc-200">{model.name}</span><span class="break-all font-mono text-xs text-zinc-400">{model.provider} / {model.model}</span></div>{/each}
    </div>{/if}
    <div class="flex flex-wrap items-center gap-3 border-t border-carbon-600 pt-4">
      <Button variant="outline" disabled={results.loading || results.page <= 1} onclick={() => modelSearch.search(search, results.page - 1, false)}>{t('previous')}</Button>
      <span class="text-xs text-zinc-400">{results.page} / {pages}</span>
      <Button variant="outline" disabled={results.loading || results.page >= pages} onclick={() => modelSearch.search(search, results.page + 1, false)}>{t('next')}</Button>
    </div>
  </div>
{:else}
  <div class="space-y-5" data-testid="codex-model-bindings">
    <p class="text-sm text-zinc-400">{t('description')}</p>
    {#if loading}<LoadingIndicator label={t('loading')} />{/if}
    {#if catalogError}<p role="alert" class="text-sm text-red-400">{t('error')}</p><Button variant="outline" onclick={() => void loadCatalog()}>{t('retry')}</Button>
    {:else if !loading && !modelCount}<p role="status" class="text-sm text-amber-400">{t('noCatalog')}</p>{/if}
    {#if targetsError}<p role="alert" class="text-sm text-red-400">{t('targetsError')}</p><Button variant="outline" onclick={() => void loadTargets()}>{t('retry')}</Button>{/if}
    {#if !value.length}<p class="text-sm text-zinc-400">{t('noBindings')}</p>{/if}
    {#each value as binding, index (rowIds[index])}
      {@const id = `${componentId}-${rowIds[index]}`}
      <div class="min-w-0 space-y-4 border border-carbon-600 p-4" data-testid="codex-model-binding">
        <div class="flex items-center justify-between gap-3 border-b border-carbon-600 pb-3">
          <span class="text-xs font-medium text-zinc-300">{t('binding')} {index + 1}</span>
          <Button variant="ghost" class="h-7 shrink-0 px-2 text-xs" onclick={() => remove(index)}>{t('remove')}</Button>
        </div>
        <div class="min-w-0 space-y-2" data-testid="codex-binding-source">
          <Label class="block" for={`${id}-source`}>{t('source')}</Label>
            <Input id={`${id}-source`} aria-label={t('source')} value={binding.source ?? binding.alias ?? binding.model} maxlength={512} placeholder={t('sourcePlaceholder')} required on:input={event => update(index, { source: event.currentTarget.value })} />
            <p class="text-xs leading-relaxed text-zinc-400">{t('sourceHint')}</p>
        </div>
        <div class="grid min-w-0 gap-4 border-t border-carbon-600 pt-4 sm:grid-cols-2" data-testid="codex-binding-destination">
          <div class="min-w-0 space-y-2"><Label class="block" id={`${id}-provider-label`}>{t('provider')}</Label>
            <BSelect value={binding.provider} options={providerOptions} ariaLabel={t('provider')} placeholder={t('provider')} disabled={loading || catalogError} onchange={provider => update(index, { provider: String(provider), model: '' })} />
          </div>
          <div class="min-w-0 space-y-2"><Label class="block" id={`${id}-model-label`}>{t('model')}</Label>
            <PriceModelPicker value={binding.model} provider={binding.provider} {catalogVersion} catalogPlugin="codex-router" catalogPath="/catalog" disabled={!binding.provider || !modelCount} label={t('model')} placeholder={t('model')} searchLabel={t('search')} emptyLabel={t('empty')} loadingLabel={t('loading')} errorLabel={t('error')} retryLabel={t('retry')} previousLabel={t('previous')} nextLabel={t('next')} onchange={model => update(index, { model })} />
          </div>
        </div>
        <div class="min-w-0 space-y-2" data-testid="codex-binding-target">
          <Label class="block" id={`${id}-target-label`}>{t('target')}</Label>
            <BSelect value={JSON.stringify([binding.target.type, binding.target.id])} options={targetOptions} ariaLabel={t('target')} placeholder={t('targetPlaceholder')} disabled={targetsError} onchange={encoded => { const [type, id] = JSON.parse(String(encoded)); update(index, { target: { type, id } }); }} />
        </div>
        <details class="border-t border-carbon-600 pt-3">
          <summary class="cursor-pointer text-xs text-zinc-400 focus-visible:outline focus-visible:outline-nexus-500">{t('advanced')}</summary>
          <div class="mt-4 space-y-4">
            <div class="space-y-2"><Label class="block" for={`${id}-context`}>{t('context')}</Label>
              <NumberInput id={`${id}-context`} min={1} max={Number.MAX_SAFE_INTEGER}
                bind:value={() => binding.capabilityOverrides?.contextWindow, next => limit(index, 'contextWindow', next)}
                increaseLabel={t('increase')} decreaseLabel={t('decrease')} invalidMessage={t('contextInvalid')} />
              <p class="text-xs text-zinc-400">{t('contextHint')}</p>
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <BCheckbox label={t('toolsOff')} bind:checked={() => binding.capabilityOverrides?.tools === false, checked => limit(index, 'tools', checked ? false : undefined)} />
              <BCheckbox label={t('imagesOff')} bind:checked={() => binding.capabilityOverrides?.images === false, checked => limit(index, 'images', checked ? false : undefined)} />
              <BCheckbox label={t('reasoningOff')} bind:checked={() => binding.capabilityOverrides?.reasoning === false, checked => limit(index, 'reasoning', checked ? false : undefined)} />
              <BCheckbox label={t('reasoningEffort')} bind:checked={() => binding.capabilityOverrides?.reasoningEffort === true, checked => limit(index, 'reasoningEffort', checked ? true : undefined)} />
            </div>
          </div>
        </details>
      </div>
    {/each}
    <Button variant="outline" disabled={value.length >= 100} onclick={add}>{t('add')}</Button>
  </div>
{/if}
