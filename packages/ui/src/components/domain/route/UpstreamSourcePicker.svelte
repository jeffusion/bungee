<script lang="ts">
  import { onMount } from 'svelte';
  import type { EditorUpstream } from '$api/config-adapters';
  import { listUpstreamSources, listSourceAccounts, createSourceDraft, applySourceDraft, type UpstreamSource, type SourceAccount } from '$api/upstream-sources';
  import { Button } from '$components/ui/button';
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

  function boundAccountRef() {
    const binding = upstream.plugins?.find(item => typeof item !== 'string' && item._uid === upstream.managedBy?.bindingId);
    return typeof binding === 'object' && typeof binding.options?.accountRef === 'string' ? binding.options.accountRef : '';
  }
  async function loadAccounts(value: string) {
    const request = ++generation;
    selected = value; accounts = []; accountId = ''; error = '';
    const chosen = sources.find(item => key(item) === value);
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
    if (!source || !account?.available || applying) return;
    const chosen = source, chosenAccount = account;
    applying = true; error = '';
    try {
      const draft = await createSourceDraft(chosen, chosenAccount.id, lifetime.signal);
      if (lifetime.signal.aborted) return;
      upstream = applySourceDraft(upstream, chosen, draft);
      onresolve(chosenAccount.label);
    } catch { if (!lifetime.signal.aborted) error = $_('upstream.sourceOperationFailed'); }
    finally { applying = false; }
  }
  onMount(() => { void discover(); return () => { generation++; lifetime.abort(); }; });
</script>

<div class="space-y-3 border-b border-carbon-600 pb-4" data-testid="upstream-source-picker">
  <label class="block space-y-1.5">
    <span class="nx-label">{$_('upstream.source')}</span>
    <select class="nx-input w-full" value={selected} onchange={event => loadAccounts(event.currentTarget.value)} disabled={applying || loading} data-testid="upstream-source-select">
      <option value="manual" disabled={!!upstream.managedBy}>{$_('upstream.sourceManual')}</option>
      {#if upstream.managedBy && !sources.some(item => key(item) === selected)}
        <option value={selected}>{upstream.managedBy.plugin} / {upstream.managedBy.contributionId}</option>
      {/if}
      {#each sources as item (key(item))}
        <option value={key(item)} disabled={!item.plugin.enabled}>{getPluginText(item.contribution.label, item.plugin.name, $_)}{item.plugin.enabled ? '' : ` · ${$_('plugins.disabled')}`}</option>
      {/each}
    </select>
  </label>
  {#if selected !== 'manual'}
    <div class="flex flex-col sm:flex-row gap-2 sm:items-end">
      <label class="block space-y-1.5 flex-1 min-w-0">
        <span class="nx-label">{$_('upstream.sourceAccount')}</span>
        <select class="nx-input w-full" bind:value={accountId} disabled={loading || applying || !source?.plugin.enabled} data-testid="upstream-account-select">
          <option value="">{$_('upstream.sourceChooseAccount')}</option>
          {#if accountId && !accounts.some(item => item.id === accountId)}<option value={accountId}>{accountId} · {$_('upstream.sourceMissingAccount')}</option>{/if}
          {#each accounts as item (item.id)}<option value={item.id} disabled={!item.available}>{item.label}{item.available ? '' : ` · ${$_('upstream.sourceUnavailable')}`}</option>{/each}
        </select>
      </label>
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
