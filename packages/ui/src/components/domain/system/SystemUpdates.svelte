<script lang="ts">
  import { onMount } from 'svelte';
  import type { SystemUpdateStatus } from '@jeffusion/bungee-types';
  import { api, ApiError } from '$api/client';
  import { _, isLoading } from '$i18n';
  import { confirmAction } from '$stores/confirmation';
  import { getAuthStateRevision, isAuthenticationStateCurrent } from '$stores/auth';
  import { IndustrialDialog } from '$components/industrial';
  import { Button } from '$components/ui/button';
  import Download from 'lucide-svelte/icons/download';

  let { returnFocus }: { returnFocus?: HTMLElement | null } = $props();
  const pendingKey = 'bungee.system-update.pending';
  const reloadKey = 'bungee.system-update.reload';
  let status = $state<SystemUpdateStatus | null>(null);
  let open = $state(false);
  let trigger = $state<HTMLButtonElement | null>(null);
  let loading = $state(false);
  let checkingRelease = $state(false);
  let submitting = $state(false);
  let confirming = $state(false);
  let pendingId = $state<string | null>(null);
  let reloadIntent = $state<{ id: string; at: number } | null>(null);
  let seconds = $state(10);
  let error = $state<string | null>(null);
  let destroyed = false;
  let generation = 0;
  const active = $derived(!!status?.operation && !['succeeded', 'failed', 'cancelled'].includes(status.operation.phase));
  const blocked = $derived(submitting || confirming || !!pendingId || !!reloadIntent || active);
  const ready = $derived(status?.operation?.phase === 'awaiting_confirmation');
  const available = $derived(!!status?.latest && status.latest.version.localeCompare(status.running_version, undefined, { numeric: true }) > 0);
  const needsAttention = $derived(available || active || !!pendingId || !!reloadIntent || !!error || !!status?.check_error
    || status?.operation?.phase === 'failed' || status?.operation?.phase === 'cancelled');
  $effect.pre(() => {
    if (!needsAttention && !open && trigger && document.activeElement === trigger) returnFocus?.focus({ preventScroll: true });
  });
  const releaseUrl = $derived.by(() => {
    try { const url = new URL(status?.latest?.url ?? ''); return url.protocol === 'https:' ? url.href : null; }
    catch { return null; }
  });
  const reasonKeys: Record<string, string> = {
    source_runtime: 'source', windows_runtime: 'platform',
    install_unavailable: 'installation', not_writable: 'writable', unsupported_platform: 'platform', unsupported_architecture: 'platform',
    update_busy: 'busy', asset_not_ready: 'asset', version_conflict: 'stale',
    unauthorized: 'unauthorized', forbidden: 'forbidden',
    download_failed: 'download', digest_mismatch: 'digest', shutdown_failed: 'shutdown', startup_failed: 'startup',
    update_cancelled: 'cancelled', result_unknown: 'unknown', storage_unavailable: 'storage',
  };
  function reason(code: string) { return $_(`updates.errors.${reasonKeys[code] ?? 'generic'}`); }
  function apply(value: SystemUpdateStatus) {
    status = value;
    if (pendingId && value.operation?.id === pendingId) {
      pendingId = null;
      sessionStorage.removeItem(pendingKey);
    }
  }
  async function read(check = false) {
    if (loading || submitting || destroyed) return;
    const requestGeneration = ++generation;
    loading = true;
    checkingRelease = check;
    try {
      const value = check
        ? await api.post<SystemUpdateStatus>('/system/updates/check', {}, { signal: AbortSignal.timeout(15_000) })
        : await api.get<SystemUpdateStatus>('/system/updates', { signal: AbortSignal.timeout(15_000) });
      if (!destroyed && generation === requestGeneration) { apply(value); error = null; }
    } catch (cause) {
      if (!destroyed && generation === requestGeneration) error = cause instanceof ApiError ? cause.message : 'status_unavailable';
    } finally {
      if (!destroyed && generation === requestGeneration) { loading = false; checkingRelease = false; }
    }
  }
  async function upgrade(opener: HTMLElement) {
    if (blocked || loading || !status?.can_upgrade || !status.latest) return;
    const current = status.running_version, target = status.latest.version;
    const revision = getAuthStateRevision();
    confirming = true;
    const accepted = await confirmAction({ opener, title: $_('updates.confirmTitle'),
      message: $_('updates.confirmMessage', { values: { current, target } }),
      confirmText: $_('updates.download'), cancelText: $_('confirmDialog.cancel') });
    confirming = false;
    if (!accepted || destroyed || !isAuthenticationStateCurrent(revision) || blocked || !status?.can_upgrade
      || status.running_version !== current || status.latest?.version !== target) return;
    const id = crypto.randomUUID();
    try { sessionStorage.setItem(pendingKey, id); }
    catch { error = 'storage_unavailable'; return; }
    pendingId = id;
    await submit('/system/updates', { operation_id: id, current_version: current, target_version: target });
  }
  async function install(opener: HTMLElement) {
    if (!ready || confirming || submitting || pendingId || reloadIntent || !status?.operation) return;
    const operation = status.operation, revision = getAuthStateRevision();
    confirming = true;
    const accepted = await confirmAction({ opener, title: $_('updates.installTitle'),
      message: $_('updates.installMessage', { values: { target: operation.target_version } }),
      confirmText: $_('updates.install'), cancelText: $_('confirmDialog.cancel') });
    confirming = false;
    if (!accepted || destroyed || !isAuthenticationStateCurrent(revision) || submitting || pendingId || reloadIntent
      || status?.operation?.id !== operation.id || status.operation.phase !== 'awaiting_confirmation') return;
    const intent = { id: operation.id, at: Date.now() + 10_000 };
    try { sessionStorage.setItem(reloadKey, JSON.stringify(intent)); }
    catch { error = 'storage_unavailable'; return; }
    reloadIntent = intent; seconds = 10;
    await submit('/system/updates/confirm', { operation_id: operation.id,
      current_version: operation.source_version, target_version: operation.target_version });
  }
  async function submit(path: string, input: { operation_id: string; current_version: string; target_version: string }) {
    submitting = true;
    loading = false;
    checkingRelease = false;
    ++generation;
    try {
      const value = await api.post<SystemUpdateStatus>(path, input, { signal: AbortSignal.timeout(15_000) });
      if (!destroyed) { apply(value); error = null; }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) {
        pendingId = null; sessionStorage.removeItem(pendingKey);
        if (path.endsWith('/confirm')) { reloadIntent = null; sessionStorage.removeItem(reloadKey); }
      }
      if (!destroyed) error = cause instanceof ApiError ? cause.message : 'result_unknown';
    } finally { if (!destroyed) { submitting = false; void read(); } }
  }
  onMount(() => {
    try {
      pendingId = sessionStorage.getItem(pendingKey);
      const stored = sessionStorage.getItem(reloadKey);
      if (stored) {
        const intent = JSON.parse(stored);
        if (typeof intent?.id !== 'string' || !Number.isSafeInteger(intent.at) || intent.at <= 0) throw new Error('Invalid reload intent');
        reloadIntent = intent;
      }
    }
    catch { error = 'storage_unavailable'; }
    void read();
    const timer = setInterval(() => { if (open || active || pendingId || status?.checking) void read(); }, 2_000);
    const reminder = setInterval(() => { if (document.visibilityState !== 'hidden') void read(); }, 60_000);
    const countdown = setInterval(() => {
      if (!reloadIntent) return;
      seconds = Math.max(0, Math.ceil((reloadIntent.at - Date.now()) / 1000));
      if (seconds) return;
      try { sessionStorage.removeItem(reloadKey); reloadIntent = null; window.location.reload(); }
      catch { reloadIntent = null; error = 'storage_unavailable'; }
    }, 250);
    return () => { destroyed = true; ++generation; clearInterval(timer); clearInterval(reminder); clearInterval(countdown); };
  });
</script>

{#if !$isLoading}
  {#if needsAttention || open}
  <button type="button" bind:this={trigger} data-testid="system-updates-trigger" aria-label={available ? $_('updates.available', { values: { version: status?.latest?.version ?? '' } }) : $_('updates.title')} title={$_('updates.title')}
    onclick={() => { open = true; void read(); }}
    class="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1.5 px-2 font-mono text-[11px] text-zinc-400 transition-colors hover:bg-carbon-800 hover:text-nexus-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nexus-500">
    <Download class="h-4 w-4" aria-hidden="true" />
    {#if available}<span class="h-1.5 w-1.5 bg-nexus-500" aria-hidden="true"></span><span class="hidden lg:inline">v{status?.latest?.version}</span>{/if}
  </button>
  {/if}
  <IndustrialDialog bind:open busy={confirming} returnFocus={needsAttention ? undefined : returnFocus} title={$_('updates.title')} description={$_('updates.description')} closeLabel={$_('common.close')} scrollBody width="38rem">
    {#snippet body()}
      <div data-testid="system-updates-dialog" class="space-y-4">
        <dl class="grid grid-cols-2 gap-3 border-b border-carbon-600 pb-4">
          <div><dt class="nx-field-label">{$_('updates.current')}</dt><dd class="mt-1 font-mono text-zinc-200">{status?.running_version ?? '—'}</dd></div>
          <div><dt class="nx-field-label">{$_('updates.target')}</dt><dd class="mt-1 font-mono text-nexus-300">{status?.latest?.version ?? '—'}</dd></div>
          <div><dt class="nx-field-label">{$_('updates.published')}</dt><dd class="mt-1 text-sm text-zinc-300">{status?.latest?.published_at ? new Date(status.latest.published_at).toLocaleString() : '—'}</dd></div>
          <div><dt class="nx-field-label">{$_('updates.checked')}</dt><dd class="mt-1 text-sm text-zinc-300">{status?.checked_at ? new Date(status.checked_at).toLocaleString() : '—'}</dd></div>
        </dl>
        {#if releaseUrl}<a href={releaseUrl} target="_blank" rel="noopener noreferrer" class="text-sm text-nexus-300 underline">{$_('updates.releaseNotes')}</a>{/if}
        {#if status?.selected_version && status.selected_version !== status.running_version}<p class="text-sm text-zinc-400">{$_('updates.selected')}: <span class="font-mono">{status.selected_version}</span></p>{/if}
        {#if checkingRelease || status?.checking || (loading && !status)}<p role="status" class="text-sm text-zinc-400">{$_('updates.checking')}</p>{/if}
        {#if error || status?.check_error}<p role="alert" class="text-sm text-red-400">{reason(error ?? status!.check_error!)} <span class="font-mono">({error ?? status?.check_error})</span></p>{/if}
        {#if pendingId || (reloadIntent && ready)}<p role="status" data-testid="update-unknown" class="text-sm text-amber-400">{$_('updates.unknown')}</p>{/if}
        {#if reloadIntent}<p role="status" data-testid="update-countdown" class="font-mono text-sm text-nexus-300">{$_('updates.countdown', { values: { seconds } })}</p>{/if}
        {#if status?.operation}
          <div role="status" data-testid="update-operation" data-phase={status.operation.phase} class="space-y-2 border-l-2 border-nexus-500 bg-carbon-900 p-3 text-sm">
            <p class="font-mono text-zinc-200">{status.operation.source_version} → {status.operation.target_version}</p>
            <p>{$_(`updates.phases.${status.operation.phase}`)}</p>
            {#if status.operation.error}<p class="text-red-400">{reason(status.operation.error)} <span class="font-mono">({status.operation.error})</span></p>{/if}
            {#if status.operation.phase === 'succeeded' && !reloadIntent}<p class="text-emerald-400">{$_('updates.refreshHint')}</p>{/if}
          </div>
        {/if}
        {#if status?.unavailable_reason}<p class="text-sm text-amber-400">{reason(status.unavailable_reason)} <span class="font-mono">({status.unavailable_reason})</span></p>{/if}
        <p class="text-sm text-zinc-400">{$_('updates.downtime')}</p>
      </div>
    {/snippet}
    {#snippet footer()}
      <Button variant="outline" disabled={loading || !!status?.checking || submitting || confirming} onclick={() => void read(true)} data-testid="updates-check">{$_('updates.check')}</Button>
      {#if ready}
        <Button disabled={submitting || confirming || !!pendingId || !!reloadIntent} onclick={event => void install(event.currentTarget as HTMLElement)} data-testid="updates-install">{$_('updates.install')}</Button>
      {:else}
        <Button disabled={!status?.can_upgrade || blocked || loading} onclick={event => void upgrade(event.currentTarget as HTMLElement)} data-testid="updates-upgrade">{$_('updates.download')}</Button>
      {/if}
    {/snippet}
  </IndustrialDialog>
{/if}
