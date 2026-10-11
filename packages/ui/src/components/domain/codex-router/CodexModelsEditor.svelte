<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { _, isLoading } from '$i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import CodexTargetPicker from './CodexTargetPicker.svelte';
  import { loadCodexGatewayTargets, type CodexGatewayTarget } from './gateway-targets';
  import { requestPluginControl } from '$api/client';
  import { BSelect, BCheckbox, LoadingIndicator, PanelCard, SegmentedControl } from '$components/industrial';
  import { Input } from '$components/ui/input';
  import { NumberInput } from '$components/ui/number-input';
  import { Label } from '$components/ui/label';
  import { Button } from '$components/ui/button';
  import PriceModelPicker from '@plugins/token-stats/ui/PriceModelPicker.svelte';
  import type { ModelsDevProviderSummary, ModelsDevCatalogStatus } from '@plugins/models-dev/contract';
  import { bindingSource, parseBindings, type ModelBinding as SavedModelBinding } from '@plugins/codex-router/server/config';

  // Drafts may omit the protocol until the user selects it; published bindings require it.
  type ModelBinding = Omit<SavedModelBinding, 'target'> & { target: Omit<SavedModelBinding['target'], 'protocol'> & { protocol?: SavedModelBinding['target']['protocol'] } };

  let { value = $bindable([]), onchange, onvalidate }: { value?: ModelBinding[]; onchange?: (value: ModelBinding[]) => void; onvalidate?: (error: string | null) => void } = $props();
  const componentId = `codex-bindings-${Math.random().toString(36).slice(2, 10)}`;
  let rowIds = $state<number[]>(untrack(() => value.map((_, index) => index))), nextRowId = untrack(() => value.length);
  let manualSources = $state<Record<number, boolean>>({});
  const catalogDrafts = new Map<number, string>();
  const manualDrafts = new Map<number, string>();
  const replacementDrafts = new Map<number, { source: string; sourceProvider?: string }>();
  let modes = $state<Record<number, 'add' | 'replace'>>({});
  let providers = $state<ModelsDevProviderSummary[]>([]);
  let catalogVersion = $state<number | null>(null);
  let modelCount = $state(0), loading = $state(true), catalogError = $state(false), targetsError = $state(false), targetsLoading = $state(true);
  let targets = $state<CodexGatewayTarget[]>([]);
  let alive = false;
  const controller = new AbortController();
  const t = (key: string) => $isLoading ? '' : getPluginText(`editor.${key}`, 'codex-router', (id, options) => $_(id, options));
  let providerOptions = $derived(providers.filter(provider => provider.provider !== 'openai').map(provider => ({ value: provider.provider, label: `${provider.name} · ${provider.provider}` })));
  const protocolOptions = [{ value: 'responses', label: 'Responses' }, { value: 'chat_completions', label: 'Chat Completions' }, { value: 'anthropic_messages', label: 'Anthropic Messages' }];
  const modeOptions = $derived([{ value: 'add', label: t('addModel') }, { value: 'replace', label: t('replaceModel') }]);
  $effect(() => {
    if ($isLoading) return;
    let error: string | null = null;
    try { parseBindings($state.snapshot(value)); }
    catch (cause) { error = t(cause instanceof Error && cause.message === 'codex_router_model_conflict' ? 'modelConflict' : 'bindingInvalid'); }
    untrack(() => onvalidate?.(error));
  });
  $effect(() => { if (rowIds.length !== value.length) rowIds = value.map((_, index) => rowIds[index] ?? nextRowId++); });

  function publish(next: ModelBinding[]) { value = next; onchange?.(value); }
  function mode(index: number): 'add' | 'replace' {
    return modes[rowIds[index]] ?? (bindingSource(value[index]) === value[index].model ? 'add' : 'replace');
  }
  function update(index: number, patch: Partial<ModelBinding>) {
    publish(value.map((binding, i) => {
      if (i !== index) return binding;
      const next = { ...binding, ...patch };
      if (mode(index) === 'add') next.source = next.model;
      return next;
    }));
  }
  function changeMode(index: number, nextMode: string) {
    if (nextMode === mode(index)) return;
    const binding = value[index], rowId = rowIds[index];
    if (nextMode === 'add') replacementDrafts.set(rowId, { source: binding.source ?? '', sourceProvider: binding.sourceProvider });
    modes = { ...modes, [rowId]: nextMode as 'add' | 'replace' };
    const { alias, ...rest } = binding;
    const draft = replacementDrafts.get(rowId);
    publish(value.map((entry, i) => i === index ? { ...rest,
      source: nextMode === 'add' ? binding.model : draft?.source ?? '',
      sourceProvider: nextMode === 'add' ? undefined : draft ? draft.sourceProvider : 'openai',
    } : entry));
  }
  function limit(index: number, key: keyof NonNullable<ModelBinding['capabilityOverrides']>, next: boolean | number | undefined) {
    const overrides = { ...value[index].capabilityOverrides };
    if (next === undefined) delete overrides[key]; else (overrides as Record<string, unknown>)[key] = next;
    update(index, { capabilityOverrides: overrides });
  }
  function add(nextMode: 'add' | 'replace') {
    const rowId = nextRowId++;
    rowIds = [...rowIds, rowId];
    modes = { ...modes, [rowId]: nextMode };
    publish([...value, { sourceProvider: nextMode === 'replace' ? 'openai' : undefined, source: '', sourceProtocol: 'responses', provider: '', model: '', target: { type: 'route', id: '' } }]);
  }
  function remove(index: number) {
    delete modes[rowIds[index]]; replacementDrafts.delete(rowIds[index]);
    delete manualSources[rowIds[index]]; catalogDrafts.delete(rowIds[index]); manualDrafts.delete(rowIds[index]);
    rowIds = rowIds.filter((_, i) => i !== index);
    publish(value.filter((_, i) => i !== index));
  }
  function manualSource(binding: ModelBinding, rowId: number) {
    return manualSources[rowId] ?? Boolean((binding.source ?? '') && !binding.sourceProvider);
  }
  function toggleSource(index: number, rowId: number, manual: boolean) {
    manualSources = { ...manualSources, [rowId]: manual };
    const binding = value[index];
    if (manual) {
      catalogDrafts.set(rowId, binding.source ?? '');
      update(index, { source: manualDrafts.get(rowId) ?? binding.source ?? '', sourceProvider: undefined });
    } else {
      manualDrafts.set(rowId, binding.source ?? '');
      const draft = catalogDrafts.get(rowId);
      update(index, { source: draft ?? '', sourceProvider: 'openai' });
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
      const next = await loadCodexGatewayTargets();
      if (!alive) return;
      targets = next;
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
  {#if loading}<LoadingIndicator label={t('loading')} />{/if}
  {#if catalogError}<p role="alert" class="text-sm text-red-400">{t('error')}</p><Button variant="outline" onclick={() => void loadCatalog()}>{t('retry')}</Button>
  {:else if !loading && !modelCount}<p role="status" class="text-sm text-amber-400">{t('noCatalog')}</p>{/if}
  {#if targetsError}<p role="alert" class="text-sm text-red-400">{t('targetsError')}</p><Button variant="outline" onclick={() => void loadTargets()}>{t('retry')}</Button>{/if}
  {#if !value.length}<p class="text-sm text-zinc-400">{t('noBindings')}</p>{/if}
  {#each value as binding, index (rowIds[index])}
    {@const id = `${componentId}-${rowIds[index]}`}
    <div class="min-w-0" data-testid="codex-model-binding">
      <PanelCard title={`${t('binding')} ${index + 1}`} variant="flat" corners={false} stripe="zinc">
        {#snippet actions()}
          <Button variant="ghost" class="h-[44px] shrink-0 px-2 text-xs sm:h-[40px]" onclick={() => remove(index)}>{t('remove')}</Button>
        {/snippet}
        <div class="min-w-0 space-y-6">
          <SegmentedControl options={modeOptions} value={mode(index)} ariaLabel={t('mode')}
            class="max-w-full [&>button]:h-[44px] [&>button]:px-3 [&>button]:py-0 sm:[&>button]:h-[32px]"
            onchange={nextMode => changeMode(index, nextMode)} />
          {#if mode(index) === 'replace'}
          <div class="min-w-0 space-y-3" data-testid="codex-binding-source">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="nx-label">{t('match')}</span>
              <Button variant="ghost" class="px-2 text-xs" onclick={() => toggleSource(index, rowIds[index], !manualSource(binding, rowIds[index]))}>{manualSource(binding, rowIds[index]) ? t('fromCatalog') : t('manual')}</Button>
            </div>
            {#if manualSource(binding, rowIds[index])}
              <div class="space-y-1.5">
                <Label class="block" for={`${id}-source`}>{t('source')}</Label>
                <Input id={`${id}-source`} aria-label={t('source')} value={binding.source ?? ''} maxlength={512} placeholder={t('sourcePlaceholder')} required oninput={event => update(index, { source: event.currentTarget.value })} />
              </div>
            {:else}
              <div class="min-w-0 space-y-1.5"><Label class="block" for={`${id}-source`}>{t('source')}</Label>
                <PriceModelPicker id={`${id}-source`} value={binding.source ?? ''} provider="openai" {catalogVersion} catalogPlugin="codex-router" catalogPath="/catalog" disabled={loading || !modelCount} label={t('source')} placeholder={t('source')} searchLabel={t('search')} emptyLabel={t('empty')} loadingLabel={t('loading')} errorLabel={t('error')} retryLabel={t('retry')} loadedLabel={t('loaded')} completeLabel={t('complete')} loadMoreLabel={t('loadMore')} onchange={source => update(index, { source, sourceProvider: 'openai' })} />
              </div>
            {/if}
            <div class="space-y-1.5">
              <Label class="block" for={`${id}-source-protocol`}>{t('sourceProtocol')}</Label>
              <BSelect id={`${id}-source-protocol`} searchable searchLabels={{ empty: t('noOptions') }} value={binding.sourceProtocol ?? 'responses'} options={protocolOptions.slice(0, 1)} ariaLabel={t('sourceProtocol')} onchange={() => update(index, { sourceProtocol: 'responses' })} />
            </div>
          </div>
          {/if}
          <div class="min-w-0 space-y-3" class:border-t={mode(index) === 'replace'} class:border-carbon-600={mode(index) === 'replace'} class:pt-6={mode(index) === 'replace'}>
            <span class="nx-label block">{t('forward')}</span>
            <div class="grid min-w-0 gap-3 sm:grid-cols-2" data-testid="codex-binding-destination">
              <div class="min-w-0 space-y-1.5"><Label class="block" for={`${id}-provider`}>{t('provider')}</Label>
                <BSelect id={`${id}-provider`} searchable searchLabels={{ empty: t('noOptions') }} value={binding.provider} options={providerOptions} ariaLabel={t('provider')} placeholder={t('provider')} disabled={loading || catalogError} onchange={provider => update(index, { provider: String(provider), model: '' })} />
              </div>
              <div class="min-w-0 space-y-1.5"><Label class="block" for={`${id}-model`}>{t('model')}</Label>
                <PriceModelPicker id={`${id}-model`} value={binding.model} provider={binding.provider} {catalogVersion} catalogPlugin="codex-router" catalogPath="/catalog" disabled={!binding.provider || !modelCount} label={t('model')} placeholder={t('model')} searchLabel={t('search')} emptyLabel={t('empty')} loadingLabel={t('loading')} errorLabel={t('error')} retryLabel={t('retry')} loadedLabel={t('loaded')} completeLabel={t('complete')} loadMoreLabel={t('loadMore')} onchange={model => update(index, { model })} />
              </div>
            </div>
            <div class="min-w-0" data-testid="codex-binding-target">
              <CodexTargetPicker id={`${id}-target`} label={t('target')} value={binding.target} {targets} loading={targetsLoading} error={targetsError}
                onchange={target => update(index, { target: { ...binding.target, ...target } })} />
            </div>
            <div class="space-y-1.5">
              <Label class="block" for={`${id}-target-protocol`}>{t('targetProtocol')}</Label>
              <BSelect id={`${id}-target-protocol`} searchable searchLabels={{ empty: t('noOptions') }} value={binding.target.protocol ?? ''} options={protocolOptions} ariaLabel={t('targetProtocol')} placeholder={t('targetProtocolPlaceholder')} onchange={protocol => update(index, { target: { ...binding.target, protocol: String(protocol) as ModelBinding['target']['protocol'] } })} />
            </div>
          </div>
          <details class="border-t border-carbon-600 pt-3">
            <summary class="cursor-pointer text-xs text-zinc-400 focus-visible:outline focus-visible:outline-nexus-500">{t('advanced')}</summary>
            <div class="mt-3 space-y-3">
              <div class="space-y-1.5"><Label class="block" for={`${id}-context`}>{t('context')}</Label>
                <NumberInput id={`${id}-context`} min={1} max={Number.MAX_SAFE_INTEGER}
                  bind:value={() => binding.capabilityOverrides?.contextWindow, next => limit(index, 'contextWindow', next)}
                  increaseLabel={t('increase')} decreaseLabel={t('decrease')} invalidMessage={t('contextInvalid')} />
                <p class="text-xs text-zinc-400">{t('contextHint')}</p>
              </div>
              <div class="grid gap-3 sm:grid-cols-2">
                <BCheckbox label={t('toolsOff')} bind:checked={() => binding.capabilityOverrides?.tools === false, checked => limit(index, 'tools', checked ? false : undefined)} />
                <BCheckbox label={t('imagesOff')} bind:checked={() => binding.capabilityOverrides?.images === false, checked => limit(index, 'images', checked ? false : undefined)} />
                <BCheckbox label={t('reasoningOff')} bind:checked={() => binding.capabilityOverrides?.reasoning === false, checked => limit(index, 'reasoning', checked ? false : undefined)} />
              </div>
            </div>
          </details>
        </div>
      </PanelCard>
    </div>
  {/each}
  <div class="flex flex-wrap gap-3">
    <Button variant="outline" disabled={value.length >= 100} onclick={() => add('add')}>{t('addModel')}</Button>
    <Button variant="outline" disabled={value.length >= 100} onclick={() => add('replace')}>{t('addReplacement')}</Button>
  </div>
</div>
