<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { _ } from '$i18n';
  import { isLoading } from 'svelte-i18n';
  import type { LogicalConfigurationV2 } from '@jeffusion/bungee-types';
  import { ApiError } from '$api/client';
  import { getToken, login, logout } from '$stores/auth';
  import { publicationRecovery } from '$stores/runtime';
  import { confirmAction } from '$stores/confirmation';
  import { settingsDirty } from '$stores/navigation-guard';
  import { token as authToken } from '$stores/auth';
  import {
    getConfigSnapshot, getConfigurationOperation, validateAggregate, commitConfiguration, importConfig,
    ConfigurationStaleError, ConfigurationOperationConflictError, ConfigurationOperationDegradedError,
    ConfigurationOperationTimeoutError, ConfigurationValidationError,
    type ConfigurationSnapshot, type ConfigurationImportEnvelope, type ConfigurationOperationState,
  } from '$api/config';
  import { PanelCard, StatusBadge, SystemAlertBar, IndustrialDialog, LoadingIndicator } from '$components/industrial';
  import { Input } from '$components/ui/input';
  import { Button } from '$components/ui/button';
  import * as Select from '$components/ui/select';
  import { Label } from '$components/ui/label';
  import { Download, Upload, RefreshCw, ChevronDown, ArrowUpRight } from 'lucide-svelte';
  import * as DropdownMenu from '$components/ui/dropdown-menu';
  import AuthEditor from '$components/domain/config/AuthEditor.svelte';
  import LoggingEditor from '$components/domain/config/LoggingEditor.svelte';
  import ConfigurationDiff from '$components/domain/config/ConfigurationDiff.svelte';
  import { configurationDiff, parseImportPreview, aggregateCounts, publicationBusy, servingStatus,
    IMPORT_LIMITS, readPendingPublication } from '$components/domain/config/workspace';
  import { retainAccepted, forgetDispatch, submissionLocked, isTerminal, queryFailure, replacementSummary, drainSummary, preCommitRejection,
    type SubmissionPhase } from '$components/domain/config/publication-state';

  type Draft = { -readonly [K in keyof LogicalConfigurationV2]: LogicalConfigurationV2[K] };
  let snapshot = $state<ConfigurationSnapshot | null>(null);
  let draft = $state<Draft | null>(null);
  let imported = $state<ConfigurationImportEnvelope | null>(null);
  let reviewOpen = $state(false), busy = $state(false), validating = $state(false), loading = $state(true);
  let conflict = $state(false), detailsOpen = $state(false), storageWarning = $state('');
  let phase = $state<SubmissionPhase>('idle');
  let notice = $state(''), validation = $state(''), validSignature = $state('');
  let rejectionSummary = $state('');
  let pendingId = $state<string | null>(null), nextAuthToken = $state('');
  let tracked = $state<ConfigurationOperationState | null>(null);
  let fileInput: HTMLInputElement;
  let reviewGeneration = 0;
  let importGeneration = 0;
  let inspectGeneration = 0;
  let disposed = false;
  let accepted = false;
  let proofForRead = $state<string | undefined>();
  let lastDetailKey = '';
  const t = (key: string) => $isLoading ? '' : $_(`settings.${key}`);
  const logLevels = $derived($isLoading ? [] : [
    { value: '', label: t('defaultLogLevel') },
    ...['debug', 'info', 'warn', 'error'].map(value => ({ value, label: t(`logLevels.${value}`) })),
  ]);
  const runtime = $derived($publicationRecovery.runtime);
  const publication = $derived($publicationRecovery.publication);
  const fresh = $derived($publicationRecovery.fresh);
  const serving = $derived(servingStatus(publication, fresh));
  const candidate = $derived(snapshot && draft ? imported?.aggregate ?? { ...snapshot.config, logical_configuration: draft } : null);
  const diff = $derived(snapshot && candidate ? configurationDiff(snapshot.config, candidate, [$authToken ?? '', nextAuthToken]) : []);
  const changeCount = $derived($isLoading ? '' : $_('settings.changeCount', { values: { count: diff.length } }));
  const signature = $derived(candidate ? JSON.stringify(candidate) : '');
  const nextAuthRequired = $derived(!!snapshot && !!candidate && candidate.logical_configuration.auth?.enabled === true
    && JSON.stringify(snapshot.config.logical_configuration.auth) !== JSON.stringify(candidate.logical_configuration.auth));
  // Our own accepted revision is not a foreign CAS conflict while its outcome is being followed.
  const staleBaseline = $derived(!!snapshot && !!runtime && runtime.revision !== snapshot.revision);
  const runtimeConflict = $derived(!pendingId && !busy && staleBaseline && !(phase === 'terminal' && tracked?.operation.committed_revision === runtime?.revision));
  const locked = $derived(loading || busy || submissionLocked(phase) || publicationBusy(publication));
  const operationId = $derived(pendingId ?? (!fresh && tracked && (!publication?.operation || tracked.operation.committed_revision >= publication.operation.committed_revision)
    ? tracked.operation.mutation_id : publication?.operation?.operation_id ?? tracked?.operation.mutation_id) ?? null);
  const operationState = $derived(pendingId ? tracked?.operation.mutation_id === pendingId ? tracked.operation.state : 'unknown'
    : phase === 'terminal' && tracked?.operation.mutation_id === operationId ? tracked.operation.state
    : !fresh || !publication ? 'unknown' : publication.operation ? publication.operation.state ?? 'unknown' : 'none');
  const detailsForced = $derived(!!pendingId || publicationBusy(publication));
  const authNeedsLogin = $derived(phase === 'terminal' && !!proofForRead && proofForRead.replace(/^Bearer /, '') !== $authToken);
  const canPublish = $derived(reviewOpen && !locked && !validating && !!snapshot && !!candidate && diff.length > 0
    && validSignature === signature && fresh && !!publication && !conflict && !staleBaseline && !authNeedsLogin
    && (!nextAuthRequired || nextAuthToken.trim() !== ''));
  const importCounts = $derived(imported ? aggregateCounts(imported.aggregate) : null);
  const replacements = $derived(replacementSummary(tracked?.workers));
  const drain = $derived(drainSummary(tracked?.operation.error_code, tracked?.operation.error_detail));
  const runtimeMessage = $derived($publicationRecovery.readStatus === 'paused' ? 'runtimeTracking'
    : $publicationRecovery.readStatus === 'loading' ? 'runtimeLoading' : fresh ? 'servingNotice' : 'runtimeUnavailable');

  function readHeaders() {
    if (!proofForRead) return undefined;
    return new Headers({ Authorization: proofForRead.startsWith('Bearer ') ? proofForRead : `Bearer ${proofForRead}` });
  }
  function releaseIdentity(next: 'rejected' | 'terminal') {
    if (!forgetDispatch()) storageWarning = 'storageCleanupFailed';
    inspectGeneration++; pendingId = null; phase = next;
  }
  async function loadConfig() {
    if (disposed) return;
    loading = true;
    try {
      const loaded = await getConfigSnapshot(accepted ? readHeaders() : undefined);
      if (disposed) return;
      snapshot = loaded; draft = JSON.parse(JSON.stringify(loaded.config.logical_configuration));
      imported = null; conflict = false; validSignature = ''; nextAuthToken = '';
    } catch { if (!disposed) notice = 'loadError'; }
    finally { if (!disposed) loading = false; }
  }
  async function reloadConfig() {
    if (locked || ((diff.length || imported) && !await confirmAction({ title: t('reload'), message: t('reloadWarning'), confirmText: t('reload'), cancelText: t('stay') }))) return;
    if (disposed) return;
    notice = ''; await loadConfig(); if (disposed) return; await publicationRecovery.refresh(); await focusEditor();
  }
  async function discard() {
    if (locked || !snapshot || !await confirmAction({ title: t('discard'), message: t('discardWarning'), confirmText: t('discard'), cancelText: t('stay') })) return;
    if (disposed) return;
    draft = JSON.parse(JSON.stringify(snapshot.config.logical_configuration)); imported = null;
    nextAuthToken = ''; validSignature = ''; notice = '';
    await focusEditor();
  }
  async function focusEditor() {
    await tick();
    if (disposed) return;
    (document.querySelector<HTMLElement>('#config-log-level') ?? document.querySelector<HTMLElement>('[data-testid="settings-notice"]'))?.focus();
  }
  function cancelImport() { if (!busy && !pendingId) { importGeneration++; imported = null; nextAuthToken = ''; validSignature = ''; } }
  async function selectImport(event: Event) {
    const input = event.currentTarget as HTMLInputElement, file = input.files?.[0];
    input.value = '';
    if (!file || locked) return;
    const generation = ++importGeneration;
    imported = null; validSignature = ''; nextAuthToken = ''; reviewGeneration++;
    try {
      if (file.size > IMPORT_LIMITS.bytes) throw new Error('snapshot_limit');
      const parsed = parseImportPreview(await file.text());
      if (disposed || generation !== importGeneration || locked) return;
      imported = parsed; notice = '';
    }
    catch { if (!disposed && generation === importGeneration) notice = 'invalidImport'; }
  }
  function cancelReview() { reviewOpen = false; reviewGeneration++; validSignature = ''; validation = ''; }
  async function review() {
    if (!candidate || !diff.length || locked) return;
    rejectionSummary = ''; notice = '';
    const invalid = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-testid="page-config"] input, [data-testid="page-config"] select')]
      .find(input => !input.disabled && !input.checkValidity());
    if (invalid) { invalid.reportValidity(); notice = 'invalidCandidate'; return; }
    reviewOpen = true; validating = true; validSignature = ''; validation = '';
    const generation = ++reviewGeneration, reviewed = signature;
    try {
      const result = await validateAggregate(JSON.parse(reviewed));
      if (generation !== reviewGeneration || disposed) return;
      if (result.valid && result.errors.length === 0 && reviewed === signature) validSignature = reviewed;
      else validation = 'invalidCandidate';
    } catch { if (!disposed && generation === reviewGeneration) validation = 'validationUnavailable'; }
    finally { if (!disposed && generation === reviewGeneration) validating = false; }
  }
  function observe(state: ConfigurationOperationState) {
    if (disposed) return;
    if (pendingId && state.operation.mutation_id !== pendingId) throw new Error('operation identity mismatch');
    inspectGeneration++;
    if (!accepted && !retainAccepted(state.operation.mutation_id)) storageWarning = 'storageTrackingFailed';
    tracked = state; accepted = true;
    if (isTerminal(state.operation.state)) { releaseIdentity('terminal'); detailsOpen = true; }
    else phase = 'active';
  }
  async function publish() {
    if (!canPublish || !snapshot || !candidate) return;
    busy = true; notice = ''; storageWarning = ''; accepted = false; phase = 'idle';
    proofForRead = nextAuthRequired ? nextAuthToken.trim() : undefined;
    publicationRecovery.pause();
    const options = {
      nextAuthorization: proofForRead,
      onDispatch: (id: string) => {
        if (disposed) return;
        inspectGeneration++; tracked = null; pendingId = id; phase = 'unknown';
      },
      onOperation: observe,
    };
    try {
      if (imported) await importConfig(snapshot, JSON.parse(JSON.stringify(imported)), options);
      else await commitConfiguration(snapshot, JSON.parse(signature), options);
      if (disposed) return;
      proofForRead = undefined; nextAuthToken = ''; notice = 'published';
      cancelReview(); await loadConfig();
    } catch (error) {
      if (disposed) return;
      validSignature = '';
      const rejection = preCommitRejection(error, accepted);
      if (rejection) {
        releaseIdentity('rejected'); notice = rejection.code; rejectionSummary = rejection.summary;
      } else if (error instanceof ConfigurationStaleError || error instanceof ConfigurationOperationConflictError) {
        releaseIdentity('rejected'); conflict = true; notice = 'conflict'; proofForRead = undefined;
      } else if (error instanceof ConfigurationOperationDegradedError) {
        notice = 'degraded'; cancelReview(); await loadConfig();
      }
      else if (error instanceof ConfigurationOperationTimeoutError) notice = 'timeout';
      else if (!accepted && (error instanceof ConfigurationValidationError || (error instanceof ApiError && [400, 401, 403, 422].includes(error.status)))) {
        releaseIdentity('rejected'); notice = 'rejected'; proofForRead = undefined;
      }
      else { notice = accepted ? queryFailure(error instanceof ApiError ? error.status : undefined) : 'unknownAcceptance'; }
    } finally {
      if (disposed) return;
      busy = false;
      // A known accepted auth rotation can be read with the candidate without persisting it.
      // An unacknowledged rotation stays unknown: never probe with an unproven credential or re-PUT.
      if (!pendingId || accepted || !proofForRead) await publicationRecovery.resume(accepted ? readHeaders() : undefined);
    }
  }
  async function inspectOperation(id = operationId) {
    if (!id || busy || disposed) return;
    const generation = ++inspectGeneration, pending = pendingId;
    const current = () => !disposed && generation === inspectGeneration && pendingId === pending;
    try {
      const state = await getConfigurationOperation(id, readHeaders());
      if (!current()) return;
      const wasPending = pendingId === id;
      if (wasPending) {
        observe(state);
        if (isTerminal(state.operation.state)) {
          if (state.operation.state === 'converged') {
          if (proofForRead) login(proofForRead.replace(/^Bearer /, ''));
          else if (snapshot?.config.logical_configuration.auth?.enabled === true && candidate?.logical_configuration.auth?.enabled !== true) logout();
            proofForRead = undefined;
          }
          notice = state.operation.state === 'converged' ? 'published' : 'degraded';
          await loadConfig(); if (!disposed) await publicationRecovery.resume(readHeaders());
        } else {
          notice = 'tracking';
          await publicationRecovery.resume(readHeaders());
        }
      } else tracked = state;
    } catch (error) {
      if (!current()) return;
      if (pending === id && !accepted && error instanceof ApiError && error.status === 404) {
        if (proofForRead) { notice = 'authAcceptanceUnknown'; return; }
        // A missing durable record is not cancellation. Future writes still use snapshot CAS.
        try {
          const loaded = await getConfigSnapshot();
          if (!current() || accepted) return;
          await publicationRecovery.resume();
          if (!current() || accepted) return;
          const recovery = get(publicationRecovery);
          if (!recovery.fresh || recovery.readStatus !== 'fresh' || !recovery.runtime) {
            notice = 'snapshotReadRuntimeUnknown'; return;
          }
          snapshot = loaded; draft = JSON.parse(JSON.stringify(loaded.config.logical_configuration));
          imported = null; conflict = false; nextAuthToken = ''; proofForRead = undefined;
          tracked = null; cancelReview(); releaseIdentity('rejected'); notice = 'notSubmittedReloaded';
          await focusEditor();
        } catch { if (current()) notice = 'loadError'; }
      } else notice = queryFailure(error instanceof ApiError ? error.status : undefined);
    }
  }
  async function exportSnapshot() {
    if (busy || !await confirmAction({ title: t('export'), message: t('snapshotWarning'), confirmText: t('export'), cancelText: t('stay') })) return;
    if (disposed) return;
    try {
      const response = await fetch('/api/config/export', { headers: { Authorization: `Bearer ${getToken() ?? ''}` } });
      if (!response.ok) throw new Error('export failed');
      const blob = await response.blob();
      if (disposed) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `bungee-config-r${snapshot?.revision ?? 'snapshot'}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch { if (!disposed) notice = 'exportError'; }
  }
  function jumpTo(section: string) {
    const target = document.getElementById(`settings-${section}`);
    target?.focus({ preventScroll: true }); target?.scrollIntoView();
  }
  function globalField(key: 'log_level' | 'body_parser_limit', value: string) {
    if (!draft) return;
    if (value === '') { const next = { ...draft }; delete next[key]; draft = next; }
    else draft = { ...draft, [key]: value };
  }
  $effect(() => {
    const key = fresh && publication?.operation ? `${publication.operation.operation_id}:${publication.operation.state}` : '';
    if (key && key !== lastDetailKey && !busy && !pendingId) {
      lastDetailKey = key; void inspectOperation(publication!.operation!.operation_id);
    }
  });
  $effect(() => { settingsDirty.set(diff.length > 0 || imported !== null); });
  onMount(() => {
    void (async () => {
      try {
        const saved = readPendingPublication(); pendingId = saved?.mutationId ?? null; accepted = saved?.accepted ?? false;
        phase = pendingId ? accepted ? 'active' : 'unknown' : 'idle';
      }
      catch { phase = 'unknown'; notice = 'storageError'; }
      if (pendingId) await inspectOperation(pendingId);
      if (disposed) return;
      if (!snapshot) await loadConfig();
      if (disposed) return;
      loading = false; await publicationRecovery.refresh();
    })();
  });
  onDestroy(() => { disposed = true; reviewGeneration++; inspectGeneration++; importGeneration++; settingsDirty.set(false); });
</script>

<div class="nx-page settings-workspace py-5 space-y-5" data-testid="page-config" data-submission-phase={phase}>
  <header class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
    <div class="flex min-w-0 items-center gap-3">
      <span class="nx-stripe shrink-0" aria-hidden="true"></span>
      <div class="min-w-0 space-y-1">
        <p class="nx-label">// {t('general')}</p>
        <h1 class="nx-display text-xl text-zinc-50 tracking-[0.02em]">{$_('configuration.title')}</h1>
        <p class="text-sm text-zinc-400">{t('responsibility')}</p>
      </div>
    </div>
    <div class="flex shrink-0">
      {#if loading || busy}
        <button type="button" disabled class="inline-flex items-center gap-2 border border-carbon-600 px-3 text-xs text-zinc-300 opacity-50">{t('snapshotActions')}<ChevronDown class="h-4 w-4" aria-hidden="true" /></button>
      {:else}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger class="inline-flex items-center gap-2 border border-carbon-600 px-3 text-xs text-zinc-300 transition-colors hover:border-carbon-500 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-500">
            {t('snapshotActions')}<ChevronDown class="h-4 w-4" aria-hidden="true" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" class="w-44">
            <DropdownMenu.Item class="settings-menu-item gap-2" onclick={exportSnapshot}><Download class="h-4 w-4" aria-hidden="true" />{t('export')}</DropdownMenu.Item>
            <DropdownMenu.Item disabled={!snapshot || locked} class="settings-menu-item gap-2" onclick={() => fileInput.click()}><Upload class="h-4 w-4" aria-hidden="true" />{t('import')}</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/if}
      <input bind:this={fileInput} type="file" accept=".json" aria-label={t('import')} class="hidden" onchange={selectImport} data-testid="config-import-input" />
    </div>
  </header>

  <section class="grid gap-3 border-y border-carbon-600 py-3 sm:grid-cols-3" aria-label={t('threeFacts')}>
    <div data-testid="settings-draft-state">
      <p class="nx-field-label">{t('localEdits')}</p>
      <p class="mt-1 text-sm text-zinc-200">{t('baseline')} <strong class="nx-display">{snapshot ? `r${snapshot.revision}` : '—'}</strong> · {diff.length ? changeCount : t('clean')}</p>
    </div>
    <div data-testid="settings-publication-state">
      <p class="nx-field-label">{t('lastPublication')}</p>
      <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <p class="text-sm text-zinc-200">{t(`state.${operationState}`)}</p>
        {#if operationId}<button type="button" class="settings-text-action inline-flex items-center gap-1 border-0 bg-transparent px-0.5 text-left text-sm text-zinc-400 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-500" aria-expanded={detailsOpen || detailsForced} aria-controls="settings-publication-details" onclick={() => { if (detailsForced) document.getElementById('settings-publication-details')?.scrollIntoView(); else detailsOpen = !detailsOpen; }}>{t('details')}<ChevronDown class="h-3.5 w-3.5" aria-hidden="true" /></button>{/if}
      </div>
    </div>
    <div data-testid="settings-serving-state">
      <p class="nx-field-label">{t('currentServing')}</p>
      <div class="mt-1 flex flex-wrap items-center gap-2">
        <StatusBadge variant={serving === 'confirmed' ? 'active' : serving === 'unconfirmed' ? 'standby' : 'muted'}>
          {t(`serving.${serving}`)}{serving === 'confirmed' ? ` · r${publication?.serving_revision}` : ''}
        </StatusBadge>
        <button type="button" class="settings-text-action inline-flex items-center gap-1 border-0 bg-transparent px-0.5 text-left text-sm text-zinc-400 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-500 disabled:cursor-not-allowed disabled:opacity-50" onclick={() => publicationRecovery.refresh()} disabled={busy || !!pendingId}><RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />{t('refresh')}</button>
      </div>
    </div>
  </section>
  {#if serving !== 'confirmed'}<SystemAlertBar tone={['paused', 'loading'].includes($publicationRecovery.readStatus) ? 'info' : 'warn'}><p class="text-sm text-zinc-300" data-testid="runtime-uncertain">{t(runtimeMessage)}</p></SystemAlertBar>{/if}
  {#if storageWarning}<SystemAlertBar tone="warn"><p class="text-sm" role="status">{t(storageWarning)}</p></SystemAlertBar>{/if}
  {#if authNeedsLogin}<SystemAlertBar tone="warn"><p class="text-sm">{t('authRelogin')}</p><Button variant="outline" href="/#/login">{$_('login.submit')}</Button></SystemAlertBar>{/if}
  {#if notice || conflict || runtimeConflict}
    <SystemAlertBar tone={notice === 'published' ? 'success' : 'warn'}>
      <p class="text-sm text-zinc-200" role="status" tabindex="-1" data-testid="settings-notice">{t(conflict || runtimeConflict ? 'conflict' : notice)}{#if rejectionSummary && notice.startsWith('control_')}{` ${rejectionSummary}`}{/if}</p>
      {#if conflict || runtimeConflict}<Button variant="outline" onclick={reloadConfig} disabled={locked}>{t('reload')}</Button>{/if}
    </SystemAlertBar>
  {/if}
  {#if detailsOpen || detailsForced}
    <PanelCard title={t('publicationDetails')} tag="PUBLICATION">
      <div id="settings-publication-details" class="space-y-3 break-words" data-testid="publication-details">
        <p class="break-all font-mono text-xs text-zinc-400">{operationId ?? t('unknown')}</p>
        <p class="text-sm text-zinc-200" aria-live="polite">{t(`state.${operationState}`)}</p>
        <p class="text-sm text-zinc-400">{t('operationStages')}</p>
        {#if tracked?.operation.mutation_id === operationId}
          <p class="text-sm text-zinc-300">{t('committedRevision')}: r{tracked.operation.committed_revision ?? '—'} · {t('resultStatus')}: {tracked.operation.result_status ?? '—'}</p>
          <h3 class="nx-field-label">{t('replacementResults')}</h3>
          <ul class="space-y-1 text-sm text-zinc-300">{#each replacements as worker}<li>{t('slot')} {worker.slot ?? '—'} · {t('attempt')} {worker.attempt ?? '—'} · r{worker.revision ?? '—'} · {t(`workerState.${worker.state}`)}</li>{/each}</ul>
          {#if drain.relevant}
            <h3 class="nx-field-label">{t('drainResults')}</h3>
            {#if drain.hidden}<p class="text-sm text-amber-300">{t('failureHidden')}</p>{/if}
            {#each drain.rows as row}<p class="text-sm text-amber-300">{t('slot')} {row.slot} · {t(`drainCode.${row.code}`)}</p>{/each}
            <p class="text-sm text-zinc-400">{t('drainNoRetry')}</p>
          {/if}
        {:else}<p class="text-sm text-zinc-400">{t('unknown')}</p>{/if}
        {#if fresh && runtime}<p class="text-sm text-zinc-400">{t('workerReports')}: {(runtime.workers ?? []).map(w => `${w.slot}: r${w.revision ?? '—'}`).join(' · ') || t('unknown')}</p>{/if}
        {#if publication?.recovery}<p class="text-sm text-zinc-400">{t('recovery')}: {publication.recovery.state} · {publication.recovery.attempt_count}/{publication.recovery.max_attempts}</p>{/if}
        <div class="flex flex-wrap gap-3">
          <Button variant="outline" onclick={() => inspectOperation()} disabled={busy || !operationId}>{t('checkOperation')}</Button>
          <Button href="/#/" variant="ghost">{t('dashboardRecovery')}<ArrowUpRight class="h-4 w-4" aria-hidden="true" /></Button>
        </div>
      </div>
    </PanelCard>
  {/if}

  {#if loading}<LoadingIndicator label={t('loading')} />{:else if draft && snapshot}
    {#if imported && importCounts}
      <PanelCard title={t('importPreview')} stripe="amber">
        <div class="space-y-3" data-testid="import-preview">
          <p class="text-sm text-zinc-300">{t('snapshotWarning')}</p>
          <p class="text-sm text-zinc-300">{t('sourceRevision')}: r{imported.source_revision}</p>
          <p class="break-all font-mono text-xs text-zinc-400">{imported.content_hash}</p>
          <p class="text-sm text-zinc-300">{t('importRoutes')} {importCounts.routes} · {t('importServices')} {importCounts.services} · {t('activations')} {importCounts.activations} · {t('globalBindings')} {importCounts.bindings}</p>
          <p class="text-sm text-zinc-400">{t('importImpact')}</p>
          <ConfigurationDiff changes={diff} testId="import-diff" />
          <Button variant="outline" onclick={cancelImport} disabled={locked}>{t('cancelImport')}</Button>
        </div>
      </PanelCard>
    {/if}
    <nav class="flex flex-wrap gap-x-4 gap-y-0" aria-label={t('sections')}>
      {#each ['general', 'access', 'logging'] as section, index}
        <button type="button" style="transition-property: color" class="group inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent px-0.5 text-left text-sm text-zinc-300 duration-150 hover:text-nexus-300 focus-visible:text-nexus-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-500" onclick={() => jumpTo(section)}>
          <span aria-hidden="true" class="nx-display text-sm text-zinc-500 transition-[color] duration-150 group-hover:text-nexus-400 group-focus-visible:text-nexus-400">0{index + 1}</span>
          <span aria-hidden="true" class="font-mono text-[10px] text-zinc-600 transition-[color] duration-150 group-hover:text-nexus-400 group-focus-visible:text-nexus-400">//</span>
          {t(`sectionNav.${section}`)}
        </button>
      {/each}
    </nav>
    <section id="settings-general" tabindex="-1" aria-label={t('general')} class="scroll-mt-20">
      <PanelCard title={t('general')} tag="GLOBAL">
        <fieldset disabled={locked || reviewOpen || !!imported} class="grid gap-4 sm:grid-cols-2">
          <div class="min-w-0 space-y-1.5" data-testid="config-log-level-select">
            <Label for="config-log-level">{$_('configuration.logLevel')}</Label>
            {#key draft.log_level}
            <Select.Root selected={logLevels.find(option => option.value === (draft?.log_level ?? ''))}
              disabled={locked || reviewOpen || !!imported}
              onSelectedChange={(selected) => { globalField('log_level', selected?.value ?? ''); void focusEditor(); }}>
              <Select.Trigger id="config-log-level" class="focus-visible:border-nexus-500" data-value={draft.log_level ?? ''} aria-describedby="config-log-level-help">
                <Select.Value />
              </Select.Trigger>
              <Select.Content class="settings-select-list">
                {#each logLevels as option}<Select.Item value={option.value} label={option.label} />{/each}
              </Select.Content>
            </Select.Root>
            {/key}
            <p id="config-log-level-help" class="text-sm text-zinc-400">{t('logLevelHelp')}</p>
          </div>
          <div class="block space-y-1.5">
            <label class="nx-field-label" id="config-request-limit-label" for="config-request-limit">{$_('configuration.bodyParserLimit')}</label>
            <Input id="config-request-limit" aria-labelledby="config-request-limit-label" class="focus-visible:border-nexus-500" value={draft.body_parser_limit ?? ''} placeholder={`${t('useDefault')} (50mb)`} aria-describedby="config-request-limit-help"
              oninput={(e) => globalField('body_parser_limit', e.currentTarget.value)} />
            <p id="config-request-limit-help" class="text-sm text-zinc-400">{t('requestLimitHelp')} {t('defaultHelp')}</p>
          </div>
        </fieldset>
      </PanelCard>
    </section>
    <section id="settings-access" tabindex="-1" aria-label={t('access')} class="scroll-mt-20">
      <PanelCard title={t('access')} tag="AUTH">
        <div class="space-y-4">
          <p class="text-sm text-zinc-300">{t('authScope')}</p>
          <AuthEditor bind:value={draft.auth} label={$_('auth.enableAuth')} showHelp={false} disabled={locked || reviewOpen || !!imported} />
          {#if nextAuthRequired}
            <div class="space-y-2 border-l-2 border-amber-500 pl-3" data-testid="next-auth-section">
              <label class="block space-y-1.5"><span class="nx-field-label">{t('nextProof')}</span>
                <Input class="focus-visible:border-nexus-500" type="password" bind:value={nextAuthToken} disabled={locked || reviewOpen} autocomplete="off" aria-describedby="config-next-proof-help" data-testid="next-auth-token-input" />
              </label>
              <p id="config-next-proof-help" class="text-sm text-zinc-400">{t('nextProofHelp')}</p>
            </div>
          {/if}
        </div>
      </PanelCard>
    </section>
    <section id="settings-logging" tabindex="-1" aria-label={t('logging')} class="scroll-mt-20">
      <PanelCard title={t('logging')} tag="LOG">
        <LoggingEditor bind:value={draft.logging} disabled={locked || reviewOpen || !!imported} />
      </PanelCard>
    </section>
    {#if diff.length || imported || pendingId || busy || submissionLocked(phase) || publicationBusy(publication)}
    <footer class="sticky bottom-0 z-20 flex flex-wrap items-center justify-between gap-3 border-2 border-carbon-500 bg-carbon-900 p-3" data-testid="settings-change-bar">
      <p class="text-sm text-zinc-300">{diff.length ? `${changeCount} · r${snapshot.revision}` : t('clean')}</p>
      <div class="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
        <Button variant="outline" disabled={!diff.length || locked} onclick={discard}>{t('discard')}</Button>
        <Button disabled={!diff.length || locked} onclick={review} data-testid="config-save-button">{t('reviewPublish')}</Button>
      </div>
    </footer>
    {/if}
  {/if}
</div>

<IndustrialDialog bind:open={reviewOpen} title={t('reviewTitle')} description={t('reviewDescription')}
  busy={busy} width="52rem" scrollBody={true} closeLabel={t('closeReview')} onOpenChange={(open) => { if (!open) cancelReview(); }}>
  {#snippet body()}
    <div class="space-y-4" data-testid="config-review">
      <p class="text-sm text-zinc-300">{t('baseline')} r{snapshot?.revision} · {changeCount}</p>
      <p class="text-sm text-zinc-400">{t('redactionHelp')}</p>
      <ConfigurationDiff changes={diff} />
      {#if validating}<LoadingIndicator label={t('validating')} size="sm" centered={false} />
      {:else if validation}<p role="alert" class="text-sm text-red-400">{t(validation)}</p>
      {:else if validSignature === signature}<p class="text-sm text-zinc-300">{t('validated')}</p>{/if}
      {#if nextAuthRequired && !nextAuthToken.trim()}<p role="alert" class="text-sm text-amber-300">{t('proofRequired')}</p>{/if}
      {#if !fresh || conflict || runtimeConflict}<p role="alert" class="text-sm text-amber-300">{t(conflict || runtimeConflict ? 'conflict' : runtimeMessage)}</p>{/if}
      {#if busy || pendingId || notice === 'degraded'}<p class="text-sm text-amber-300" aria-live="polite">{t(notice || 'tracking')} · {t(`state.${operationState}`)}</p>{/if}
    </div>
  {/snippet}
  {#snippet footer()}
    <Button class="min-h-[44px] sm:min-h-[40px]" onclick={publish} disabled={!canPublish} data-testid="config-confirm-publish">{t(busy ? 'tracking' : 'publish')}</Button>
  {/snippet}
</IndustrialDialog>

<style>
  :global(html:has([data-testid="page-config"])) { scroll-padding-bottom: 2rem; }
  :global(html:has([data-testid="settings-change-bar"])) { scroll-padding-bottom: 10rem; }
  .settings-workspace :global(button), .settings-workspace :global(a), .settings-workspace :global(input:not([type="file"])) {
    min-height: 44px;
    transition-property: color, background-color, border-color, box-shadow, transform;
    transition-duration: 150ms;
  }
  :global(.settings-menu-item) { min-height: 44px; }
  .settings-workspace :global(button), .settings-workspace :global(a) { white-space: normal; }
  .settings-workspace :global(button:not([role="switch"])), .settings-workspace :global(a) { gap: 0.5rem; }
  .settings-workspace :global(input), .settings-workspace :global([data-select-trigger]) { min-width: 0; }
  .settings-workspace :global(section), .settings-workspace :global(fieldset) { min-width: 0; }
  :global(html:has([data-testid="page-config"]) [data-dialog-overlay]) { backdrop-filter: none; }
  :global(html:has([data-testid="page-config"]) [role="dialog"] button) { min-height: 44px; min-width: 44px; }
  :global(html:has([data-testid="page-config"]) [role="dialog"] > header) { padding-right: 76px; }
  :global(.settings-select-list [role="option"]) { min-height: 44px; }
  @media (min-width: 640px) {
    .settings-workspace :global(button), .settings-workspace :global(a), .settings-workspace :global(input:not([type="file"])), :global(.settings-select-list [role="option"]) { min-height: 40px; }
    :global(html:has([data-testid="page-config"]) [role="dialog"] button) { min-height: 40px; min-width: 40px; }
    :global(.settings-menu-item) { min-height: 40px; }
  }
</style>
