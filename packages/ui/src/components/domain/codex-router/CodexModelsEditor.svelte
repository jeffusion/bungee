<script lang="ts">
  import { onMount, untrack } from 'svelte';
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
  import type { ModelsDevProviderSummary, ModelsDevCatalogStatus } from '@plugins/models-dev/contract';
  import type { ModelBinding as SavedModelBinding } from '@plugins/codex-router/server/config';

  // Drafts may omit the protocol until the user selects it; published bindings require it.
  type ModelBinding = Omit<SavedModelBinding, 'target'> & { target: Omit<SavedModelBinding['target'], 'protocol'> & { protocol?: SavedModelBinding['target']['protocol'] } };

  let { value = $bindable([]), onchange }: { value?: ModelBinding[]; onchange?: (value: ModelBinding[]) => void } = $props();
  const componentId = `codex-bindings-${Math.random().toString(36).slice(2, 10)}`;
  let rowIds = $state<number[]>(untrack(() => value.map((_, index) => index))), nextRowId = untrack(() => value.length);
  let manualSources = $state<Record<number, boolean>>({});
  const catalogDrafts = new Map<number, { source: string; provider?: string }>();
  const manualDrafts = new Map<number, string>();
  let providers = $state<ModelsDevProviderSummary[]>([]);
  let catalogVersion = $state<number | null>(null);
  let modelCount = $state(0), loading = $state(true), catalogError = $state(false), targetsError = $state(false), targetsLoading = $state(true);
  let targets = $state<{ type: 'route' | 'service'; id: string; label: string }[]>([]);
  let alive = false;
  const controller = new AbortController();
  const t = (key: string) => $isLoading ? '' : getPluginText(`editor.${key}`, 'codex-router', (id, options) => $_(id, options));
  let providerOptions = $derived(providers.map(provider => ({ value: provider.provider, label: `${provider.name} · ${provider.provider}` })));
  let targetOptions = $derived.by(() => {
    const options = targets.map(target => ({ value: JSON.stringify([target.type, target.id]), label: `${t(target.type)} · ${target.label}`, disabled: false }));
    for (const binding of value) {
      if (!binding.target.id) continue;
      const key = JSON.stringify([binding.target.type, binding.target.id]);
      if (!options.some(option => option.value === key)) options.push({ value: key, label: `${t(binding.target.type)} · ${binding.target.id}${targetsLoading ? '' : ` · ${t('targetUnavailable')}`}`, disabled: true });
    }
    return options;
  });
  const protocolOptions = [{ value: 'responses', label: 'Responses' }, { value: 'chat_completions', label: 'Chat Completions' }, { value: 'anthropic_messages', label: 'Anthropic Messages' }];
  $effect(() => { if (rowIds.length !== value.length) rowIds = value.map((_, index) => rowIds[index] ?? nextRowId++); });

  function publish(next: ModelBinding[]) { value = next; onchange?.(value); }
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
    publish([...value, { source: '', sourceProtocol: 'responses', provider: '', model: '', target: { type: 'route', id: '' } }]);
  }
  function remove(index: number) {
    delete manualSources[rowIds[index]]; catalogDrafts.delete(rowIds[index]); manualDrafts.delete(rowIds[index]);
    rowIds = rowIds.filter((_, i) => i !== index);
    publish(value.filter((_, i) => i !== index));
  }
  function manualSource(binding: ModelBinding, rowId: number) {
    return manualSources[rowId] ?? Boolean((binding.source ?? binding.alias ?? binding.model) && !binding.sourceProvider);
  }
  function toggleSource(index: number, rowId: number, manual: boolean) {
    manualSources = { ...manualSources, [rowId]: manual };
    const binding = value[index];
    if (manual) {
      catalogDrafts.set(rowId, { source: binding.source ?? binding.alias ?? binding.model, provider: binding.sourceProvider });
      update(index, { source: manualDrafts.get(rowId) ?? binding.source ?? binding.alias ?? binding.model, sourceProvider: undefined });
    } else {
      manualDrafts.set(rowId, binding.source ?? binding.alias ?? binding.model);
      const draft = catalogDrafts.get(rowId);
      update(index, { source: draft?.source ?? '', sourceProvider: draft?.provider });
    }
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
    targetsLoading = true; targetsError = false;
    try {
      const config = (await getConfigSnapshot()).config.logical_configuration;
      if (!alive) return;
      targets = [...config.routes.map(route => ({ type: 'route' as const, id: route.id, label: route.path })), ...config.services.map(service => ({ type: 'service' as const, id: service.id, label: service.name }))];
    } catch { if (alive) targetsError = true; }
    finally { if (alive) targetsLoading = false; }
  }
  onMount(() => {
    alive = true;
    void loadCatalog(); void loadTargets();
    return () => { alive = false; controller.abort(); };
  });
</script>

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
        <div class="min-w-0 space-y-3" data-testid="codex-binding-source">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs font-medium text-zinc-300">{t('match')}</span>
            <Button variant="ghost" class="h-7 px-2 text-xs" onclick={() => toggleSource(index, rowIds[index], !manualSource(binding, rowIds[index]))}>{manualSource(binding, rowIds[index]) ? t('fromCatalog') : t('manual')}</Button>
          </div>
          {#if manualSource(binding, rowIds[index])}
            <div class="space-y-2">
              <Label class="block" for={`${id}-source`}>{t('source')}</Label>
              <Input id={`${id}-source`} aria-label={t('source')} value={binding.source ?? binding.alias ?? binding.model} maxlength={512} placeholder={t('sourcePlaceholder')} required oninput={event => update(index, { source: event.currentTarget.value })} />
            </div>
          {:else}
            <div class="grid min-w-0 gap-4 sm:grid-cols-2">
              <div class="min-w-0 space-y-2"><Label class="block">{t('sourceProvider')}</Label>
                <BSelect searchable searchLabels={{ empty: t('noOptions') }} value={binding.sourceProvider ?? ''} options={providerOptions} ariaLabel={t('sourceProvider')} placeholder={t('sourceProvider')} disabled={loading || catalogError} onchange={provider => update(index, { sourceProvider: String(provider), source: '' })} />
              </div>
              <div class="min-w-0 space-y-2"><Label class="block">{t('source')}</Label>
                <PriceModelPicker value={binding.source ?? binding.alias ?? binding.model} provider={binding.sourceProvider ?? ''} {catalogVersion} catalogPlugin="codex-router" catalogPath="/catalog" disabled={!binding.sourceProvider || !modelCount} label={t('source')} placeholder={t('source')} searchLabel={t('search')} emptyLabel={t('empty')} loadingLabel={t('loading')} errorLabel={t('error')} retryLabel={t('retry')} loadedLabel={t('loaded')} completeLabel={t('complete')} loadMoreLabel={t('loadMore')} onchange={source => update(index, { source })} />
              </div>
            </div>
          {/if}
          <p class="text-xs leading-relaxed text-zinc-400">{t('sourceHint')}</p>
          <div class="space-y-2">
            <Label class="block">{t('sourceProtocol')}</Label>
            <BSelect searchable searchLabels={{ empty: t('noOptions') }} value={binding.sourceProtocol ?? 'responses'} options={protocolOptions.slice(0, 1)} ariaLabel={t('sourceProtocol')} onchange={() => update(index, { sourceProtocol: 'responses' })} />
          </div>
        </div>
        <div class="grid min-w-0 gap-4 border-t border-carbon-600 pt-4 sm:grid-cols-2" data-testid="codex-binding-destination">
          <div class="min-w-0 space-y-2"><Label class="block" id={`${id}-provider-label`}>{t('provider')}</Label>
            <BSelect searchable searchLabels={{ empty: t('noOptions') }} value={binding.provider} options={providerOptions} ariaLabel={t('provider')} placeholder={t('provider')} disabled={loading || catalogError} onchange={provider => update(index, { provider: String(provider), model: '' })} />
          </div>
          <div class="min-w-0 space-y-2"><Label class="block" id={`${id}-model-label`}>{t('model')}</Label>
            <PriceModelPicker value={binding.model} provider={binding.provider} {catalogVersion} catalogPlugin="codex-router" catalogPath="/catalog" disabled={!binding.provider || !modelCount} label={t('model')} placeholder={t('model')} searchLabel={t('search')} emptyLabel={t('empty')} loadingLabel={t('loading')} errorLabel={t('error')} retryLabel={t('retry')} loadedLabel={t('loaded')} completeLabel={t('complete')} loadMoreLabel={t('loadMore')} onchange={model => update(index, { model })} />
          </div>
        </div>
        <div class="min-w-0 space-y-2" data-testid="codex-binding-target">
          <Label class="block" id={`${id}-target-label`}>{t('target')}</Label>
            <BSelect searchable searchLabels={{ empty: t('noOptions') }} value={binding.target.id ? JSON.stringify([binding.target.type, binding.target.id]) : ''} options={targetOptions} ariaLabel={t('target')} placeholder={t('targetPlaceholder')} disabled={targetsLoading || targetsError} onchange={encoded => { const [type, id] = JSON.parse(String(encoded)); update(index, { target: { ...binding.target, type, id } }); }} />
        </div>
        <div class="space-y-2">
          <Label class="block">{t('targetProtocol')}</Label>
          <BSelect searchable searchLabels={{ empty: t('noOptions') }} value={binding.target.protocol ?? ''} options={protocolOptions} ariaLabel={t('targetProtocol')} placeholder={t('targetProtocolPlaceholder')} onchange={protocol => update(index, { target: { ...binding.target, protocol: String(protocol) as ModelBinding['target']['protocol'] } })} />
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
