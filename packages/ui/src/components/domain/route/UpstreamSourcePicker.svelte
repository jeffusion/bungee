<script lang="ts">
  import { onMount } from 'svelte';
  import type { EditorUpstream } from '$api/config-adapters';
  import { listUpstreamSources, listSourceAccounts, createSourceDraft, applySourceDraft, type UpstreamSource, type SourceAccount } from '$api/upstream-sources';
  import { Button } from '$components/ui/button';
  import * as RadioGroup from '$components/ui/radio-group';
  import * as Select from '$components/ui/select';
  import { isLoading } from 'svelte-i18n';
  import { _ } from '$i18n';
  import { getPluginText } from '$utils/plugin-i18n';

  let { upstream = $bindable(), onresolve = (_label: string | null) => {} }: {
    upstream: EditorUpstream; onresolve?: (label: string | null) => void;
  } = $props();
  let sources = $state<UpstreamSource[]>([]);
  let selected = $state('manual');
  let accountId = $state('');
  let accounts = $state<SourceAccount[]>([]);
  let loading = $state(true);
  let applying = $state(false);
  let error = $state('');
  const lifetime = new AbortController();
  let generation = 0;
  const key = (source: UpstreamSource) => `${source.plugin.name}/${source.contribution.id}`;
  let source = $derived(sources.find(item => key(item) === selected));
  let account = $derived(accounts.find(item => item.id === accountId));
  const id = $props.id();
  let selectedAccount = $derived(!$isLoading && accountId ? { value: accountId, label: account?.label ?? `${accountId} · ${$_('upstream.sourceMissingAccount')}` } : undefined);

  function boundAccountRef() {
    const binding = upstream.plugins?.find(item => typeof item !== 'string' && item._uid === upstream.managedBy?.bindingId);
    return typeof binding === 'object' && typeof binding.options?.accountRef === 'string' ? binding.options.accountRef : '';
  }
  async function loadAccounts(value: string) {
    const request = ++generation;
    selected = value; accounts = []; error = '';
    const chosen = sources.find(item => key(item) === value);
    accountId = chosen && upstream.managedBy?.plugin === chosen.plugin.name && upstream.managedBy.contributionId === chosen.contribution.id ? boundAccountRef() : '';
    if (!chosen) { loading = false; return; }
    loading = true;
    try {
      const result = await listSourceAccounts(chosen, lifetime.signal);
      if (request !== generation || lifetime.signal.aborted) return;
      accounts = result;
      if (upstream.managedBy?.plugin === chosen.plugin.name && upstream.managedBy.contributionId === chosen.contribution.id) {
        accountId = boundAccountRef();
        onresolve(result.find(item => item.id === accountId)?.label ?? null);
      }
    } catch {
      if (request === generation && !lifetime.signal.aborted) error = $_('upstream.sourceOperationFailed');
    } finally { if (request === generation) loading = false; }
  }
  async function discover() {
    loading = true; error = '';
    try {
      const result = await listUpstreamSources();
      if (lifetime.signal.aborted) return;
      sources = result;
      const marker = upstream.managedBy;
      if (marker) {
        selected = `${marker.plugin}/${marker.contributionId}`;
        if (!sources.some(item => key(item) === selected)) error = $_('upstream.sourceMissing');
        else await loadAccounts(selected);
      }
    } catch { error = $_('upstream.sourceLoadFailed'); }
    finally { loading = false; }
  }
  async function apply() {
    if (!source?.plugin.enabled || !account?.available || applying || loading) return;
    const chosen = source, chosenAccount = account;
    const before = JSON.stringify(upstream), request = generation;
    applying = true; error = '';
    try {
      const draft = await createSourceDraft(chosen, chosenAccount.id, lifetime.signal);
      if (lifetime.signal.aborted || request !== generation || JSON.stringify(upstream) !== before) return;
      upstream = applySourceDraft(upstream, chosen, draft);
      onresolve(chosenAccount.label);
    } catch { if (!lifetime.signal.aborted) error = $_('upstream.sourceOperationFailed'); }
    finally { applying = false; }
  }
  onMount(() => { void discover(); return () => { generation++; lifetime.abort(); }; });
</script>

<div class="space-y-3 border-b border-carbon-600 pb-4" data-testid="upstream-source-picker">
  <fieldset class="space-y-2">
    <legend class="nx-field-label mb-2">{$_('upstream.source')}</legend>
    <RadioGroup.Root value={selected} onValueChange={loadAccounts} aria-label={$_('upstream.source')} class="flex flex-wrap gap-x-5 gap-y-3" disabled={applying || loading}>
      <div class="flex items-center gap-2"><RadioGroup.Item id={`${id}-manual`} value="manual" disabled={!!upstream.managedBy || applying || loading} /><label for={`${id}-manual`} class="text-sm text-zinc-200">{$_('upstream.sourceManual')}</label></div>
      {#if upstream.managedBy && !sources.some(item => key(item) === selected)}
        <div class="flex items-center gap-2"><RadioGroup.Item id={`${id}-missing`} value={selected} disabled /><label for={`${id}-missing`} class="text-sm text-zinc-400">{upstream.managedBy.plugin} / {upstream.managedBy.contributionId} · {$_('upstream.sourceMissing')}</label></div>
      {/if}
      {#each sources as item (key(item))}
        <div class="flex items-center gap-2"><RadioGroup.Item id={`${id}-${key(item)}`} value={key(item)} disabled={!item.plugin.enabled || applying || loading} /><label for={`${id}-${key(item)}`} class="text-sm text-zinc-200">{getPluginText(item.contribution.label, item.plugin.name, $_)}{item.plugin.enabled ? '' : ` · ${$_('plugins.disabled')}`}</label></div>
      {/each}
    </RadioGroup.Root>
  </fieldset>
  {#if selected !== 'manual'}
    <div class="flex flex-col sm:flex-row gap-2 sm:items-end">
      <div class="space-y-1.5 flex-1 min-w-0">
        <span class="nx-field-label">{$_('upstream.sourceAccount')}</span>
        <Select.Root selected={selectedAccount} onSelectedChange={(next) => accountId = next?.value ?? ''}>
          <Select.Trigger class="w-full" aria-label={$_('upstream.sourceAccount')} disabled={loading || applying || !source?.plugin.enabled}><Select.Value placeholder={$_('upstream.sourceChooseAccount')} /></Select.Trigger>
          <Select.Content class="z-[200]">
            {#if accountId && !accounts.some(item => item.id === accountId)}<Select.Item value={accountId} label={selectedAccount?.label} disabled>{selectedAccount?.label}</Select.Item>{/if}
            {#each accounts as item (item.id)}<Select.Item value={item.id} label={item.label} disabled={!item.available}>{item.label}{item.available ? '' : ` · ${$_('upstream.sourceUnavailable')}`}</Select.Item>{/each}
          </Select.Content>
        </Select.Root>
      </div>
      <Button variant="outline" disabled={!account?.available || applying || loading} onclick={apply} data-testid="upstream-account-apply">{applying ? $_('common.loading') : $_('upstream.sourceApply')}</Button>
    </div>
    <p class="text-xs text-zinc-400">{$_('upstream.sourceDraftHelp')}</p>
    {#if source?.plugin.metadata?.contributes?.settings?.startsWith('/')}
      <a class="text-xs text-nexus-300 underline underline-offset-2" href={`#/plugins/${encodeURIComponent(source.plugin.name)}${source.plugin.metadata.contributes.settings}`}>{$_('upstream.sourceManageAccounts')}</a>
    {/if}
  {/if}
  {#if loading}<p role="status" class="text-xs text-zinc-400">{$_('common.loading')}</p>{/if}
  {#if error}
    <div role="alert" class="border-l-2 border-amber-500 bg-amber-500/5 px-3 py-2 text-sm text-amber-300">
      <p>{error}</p><Button variant="ghost" size="sm" onclick={() => source ? loadAccounts(selected) : discover()} disabled={loading || applying}>{$_('common.refresh')}</Button>
    </div>
  {/if}
</div>
