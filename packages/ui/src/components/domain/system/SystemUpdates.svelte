<script lang="ts">
  import { onMount } from 'svelte';
  import type { SystemUpdateStatus } from '@jeffusion/bungee-types';
  import { api, ApiError } from '$api/client';
  import { _, isLoading } from '$i18n';
  import { confirmAction } from '$stores/confirmation';
  import { getAuthStateRevision, isAuthenticationStateCurrent } from '$stores/auth';
  import { IndustrialDialog, StatusBadge } from '$components/industrial';
  import { Button } from '$components/ui/button';
  import Download from 'lucide-svelte/icons/download';
  import Info from 'lucide-svelte/icons/info';
  import Loader2 from 'lucide-svelte/icons/loader-2';
  import TriangleAlert from 'lucide-svelte/icons/triangle-alert';
  import { version } from '../../../../../../package.json';

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
  let errorContext = $state<'status' | 'check' | 'operation' | null>(null);
  let destroyed = false;
  let generation = 0;
  const active = $derived(!!status?.operation && !['succeeded', 'failed', 'cancelled'].includes(status.operation.phase));
  const blocked = $derived(submitting || confirming || !!pendingId || !!reloadIntent || active);
  const ready = $derived(status?.operation?.phase === 'awaiting_confirmation');
  const newerRelease = $derived(!!status?.latest && status.latest.version.localeCompare(status.running_version, undefined, { numeric: true }) > 0);
  const operationFailed = $derived(!!status?.operation?.error || status?.operation?.phase === 'failed' || status?.operation?.phase === 'cancelled');
  const unknownResult = $derived(pendingId !== null && error === 'result_unknown' && errorContext === 'operation');
  const checkFailed = $derived(!!status?.check_error || (!!error && errorContext === 'check'));
  const statusReadFailed = $derived(!!error && errorContext === 'status');
  const actionError = $derived(!!error && errorContext !== 'status' && errorContext !== 'check');
  const unavailableRelease = $derived(newerRelease && (status?.can_upgrade === false || !!status?.unavailable_reason)
    && !checkFailed && !statusReadFailed && !operationFailed && !actionError);
  const downloadAction = $derived(newerRelease && status?.can_upgrade === true && !status?.unavailable_reason && !status?.check_error
    && !status?.checking && !checkingRelease && (unknownResult || (!error && !loading)));
  const available = $derived(downloadAction && !blocked && !operationFailed);
  const needsAttention = $derived(available || active || !!pendingId || !!reloadIntent || actionError
    || operationFailed || unavailableRelease || checkingRelease || !!status?.checking || submitting || confirming);
  const triggerState = $derived(available ? 'available'
    : pendingId || reloadIntent ? 'pending'
    : active || submitting || confirming ? 'progress'
    : checkingRelease || status?.checking ? 'checking'
    : loading ? 'reading'
    : operationFailed || actionError ? 'attention'
    : unavailableRelease ? 'unavailable'
    : 'idle');
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
    release_check_failed: 'check', release_rate_limited: 'check', invalid_release: 'check', status_unavailable: 'status',
    download_failed: 'download', digest_mismatch: 'digest', shutdown_failed: 'shutdown', startup_failed: 'startup',
    update_cancelled: 'cancelled', result_unknown: 'unknown', storage_unavailable: 'storage',
  };
  function reason(code: string, fallback = 'generic') { return $_(`updates.errors.${reasonKeys[code] ?? fallback}`); }
  function requestReason(code: string, fallback = 'generic') {
    const contextFallback = errorContext === 'status' ? 'status' : errorContext === 'check' ? 'check'
      : errorContext === 'operation' ? 'operation' : fallback;
    return reason(code, contextFallback);
  }
  function triggerLabel() {
    if (triggerState === 'available') return $_('updates.trigger.available', { values: { version: status?.latest?.version ?? '' } });
    if (triggerState === 'checking') return $_('updates.trigger.checking');
    if (triggerState === 'reading') return $_('updates.trigger.reading');
    if (triggerState === 'progress') return $_('updates.trigger.progress');
    if (triggerState === 'pending') return $_('updates.trigger.pending');
    if (triggerState === 'attention') return $_('updates.trigger.attention');
    if (triggerState === 'unavailable') return $_('updates.trigger.unavailable');
    return $_('updates.title');
  }
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
      if (!destroyed && generation === requestGeneration) { apply(value); error = null; errorContext = null; }
    } catch (cause) {
      if (!destroyed && generation === requestGeneration) {
        error = cause instanceof ApiError ? cause.message : check ? 'release_check_failed' : 'status_unavailable';
        errorContext = check ? 'check' : 'status';
      }
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
      if (!destroyed) { apply(value); error = null; errorContext = null; }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) {
        pendingId = null; sessionStorage.removeItem(pendingKey);
        if (path.endsWith('/confirm')) { reloadIntent = null; sessionStorage.removeItem(reloadKey); }
      }
      if (!destroyed) { error = cause instanceof ApiError ? cause.message : 'result_unknown'; errorContext = 'operation'; }
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
    const timer = setInterval(() => { if (active || pendingId) void read(); }, 2_000);
    const countdown = setInterval(() => {
      if (!reloadIntent) return;
      seconds = Math.max(0, Math.ceil((reloadIntent.at - Date.now()) / 1000));
      if (seconds) return;
      try { sessionStorage.removeItem(reloadKey); reloadIntent = null; window.location.reload(); }
      catch { reloadIntent = null; error = 'storage_unavailable'; }
    }, 250);
    return () => { destroyed = true; ++generation; clearInterval(timer); clearInterval(countdown); };
  });
</script>

{#if !$isLoading}
  <div class="flex shrink-0 items-center pr-2 md:pr-[18px]">
  {#if available}
    <StatusBadge variant="online" dot>v{status?.running_version ?? version}</StatusBadge>
  {:else}
    <span class="font-mono text-[11px] text-zinc-400">v{status?.running_version ?? version}</span>
  {/if}
  {#if needsAttention || open}
  <button type="button" bind:this={trigger} data-testid="system-updates-trigger" aria-label={triggerLabel()} title={triggerLabel()}
    onclick={() => { open = true; void read(); }}
    class={`flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1.5 px-2 font-mono text-[11px] transition-colors hover:bg-carbon-800 hover:text-nexus-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nexus-500 ${triggerState === 'available' ? 'text-nexus-300' : triggerState === 'attention' ? 'text-red-400' : triggerState === 'unavailable' ? 'text-amber-400' : triggerState === 'checking' || triggerState === 'reading' ? 'text-sky-400' : 'text-zinc-400'}`}>
    {#if triggerState === 'available'}<Download class="h-4 w-4" aria-hidden="true" />
    {:else if triggerState === 'checking' || triggerState === 'reading' || triggerState === 'progress' || triggerState === 'pending'}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />
    {:else if triggerState === 'attention' || triggerState === 'unavailable'}<TriangleAlert class="h-4 w-4" aria-hidden="true" />
    {:else}<Info class="h-4 w-4" aria-hidden="true" />{/if}
  </button>
  {/if}
  </div>
  <IndustrialDialog bind:open busy={confirming} returnFocus={needsAttention ? undefined : returnFocus} title={$_('updates.title')}
    description={$_(downloadAction || active || pendingId || reloadIntent ? 'updates.description' : 'updates.statusDescription')}
    closeLabel={$_('common.close')} scrollBody width="38rem">
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
        {#if checkingRelease || status?.checking}<p role="status" data-testid="updates-checking" class="text-sm text-zinc-400">{$_('updates.checking')}</p>
        {:else if loading}<p role="status" data-testid="updates-reading" class="text-sm text-zinc-400">{$_('updates.reading')}</p>{/if}
        {#if error || status?.check_error}<p role="alert" class="text-sm text-red-400">{error ? requestReason(error) : requestReason(status!.check_error!, 'check')}</p>{/if}
        {#if pendingId || (reloadIntent && ready)}<p role="status" data-testid="update-unknown" class="text-sm text-amber-400">{$_('updates.unknown')}</p>{/if}
        {#if reloadIntent}<p role="status" data-testid="update-countdown" class="font-mono text-sm text-nexus-300">{$_('updates.countdown', { values: { seconds } })}</p>{/if}
        {#if status?.operation}
          <div role="status" data-testid="update-operation" data-phase={status.operation.phase} class="space-y-2 border-l-2 border-nexus-500 bg-carbon-900 p-3 text-sm">
            <p class="font-mono text-zinc-200">{status.operation.source_version} → {status.operation.target_version}</p>
            <p>{$_(`updates.phases.${status.operation.phase}`)}</p>
            {#if status.operation.error}<p class="text-red-400">{reason(status.operation.error, 'operation')}</p>{/if}
            {#if status.operation.phase === 'succeeded' && !reloadIntent}<p class="text-emerald-400">{$_('updates.refreshHint')}</p>{/if}
          </div>
        {/if}
        {#if status?.unavailable_reason}
          <p role="status" data-testid="updates-unavailable" class="text-sm text-amber-400">{reason(status.unavailable_reason, 'capability')}</p>
        {:else if unavailableRelease && status && !status.operation}
          <p role="status" data-testid="updates-unavailable" class="text-sm text-amber-400">{$_('updates.notInstallable')}</p>
        {/if}
        {#if downloadAction || active || reloadIntent}<p data-testid="updates-downtime" class="text-sm text-zinc-400">{$_('updates.downtime')}</p>{/if}
      </div>
    {/snippet}
    {#snippet footer()}
      <Button variant="outline" disabled={loading || submitting || confirming} onclick={() => void read(true)} data-testid="updates-check">{$_('updates.check')}</Button>
      {#if ready}
        <Button disabled={submitting || confirming || !!pendingId || !!reloadIntent} onclick={event => void install(event.currentTarget as HTMLElement)} data-testid="updates-install">{$_('updates.install')}</Button>
      {:else if downloadAction}
        <Button disabled={blocked || loading || checkingRelease || !!status?.checking} onclick={event => void upgrade(event.currentTarget as HTMLElement)} data-testid="updates-upgrade">{$_('updates.download')}</Button>
      {/if}
    {/snippet}
  </IndustrialDialog>
{/if}
