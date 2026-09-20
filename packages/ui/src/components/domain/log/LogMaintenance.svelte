<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { _ } from '$i18n';
  import { getCleanupConfig, triggerCleanup, type CleanupConfig } from '$api/logs';
  import { ApiError } from '$api/client';
  import { confirmAction } from '$stores/confirmation';
  import { Button } from '$components/ui/button';
  import { PanelCard, StatusBadge } from '$components/industrial';
  let config = $state<CleanupConfig | null>(null), busy = $state(false), readFailed = $state(false);
  let outcome = $state<'idle' | 'executed' | 'refreshFailed' | 'rejected' | 'unknown'>('idle');
  let feedback: HTMLParagraphElement | undefined;
  async function load() {
    try { config = await getCleanupConfig(); readFailed = false; return true; }
    catch { readFailed = true; return false; }
  }
  async function cleanup() {
    if (busy || !config || ['executed', 'refreshFailed', 'unknown'].includes(outcome)) return;
    if (!await confirmAction({ title: $_('settings.logMaintenance'), message: $_('settings.cleanupImmediate'),
      confirmText: $_('logging.manualCleanup'), cancelText: $_('confirmDialog.cancel') })) return;
    busy = true; outcome = 'idle';
    try {
      await triggerCleanup(); outcome = 'executed';
      if (!await load()) outcome = 'refreshFailed';
    } catch (error) {
      outcome = error instanceof ApiError && error.status >= 400 && error.status < 500 ? 'rejected' : 'unknown';
    } finally { busy = false; await tick(); feedback?.focus(); }
  }
  onMount(() => { void load(); });
</script>

<details class="border border-carbon-600 bg-carbon-900" data-testid="logs-maintenance">
  <summary class="cursor-pointer px-4 py-3 font-mono text-sm text-zinc-200">{$_('settings.logMaintenance')}</summary>
  <PanelCard title={$_('logging.cleanupConfig')} corners={false}>
    <div class="space-y-3">
      <p class="text-sm text-zinc-400">{$_('settings.cleanupImmediate')}</p>
      {#if config && !readFailed}
        <StatusBadge variant={(config.isActive ?? config.is_active) ? 'active' : 'muted'}>{$_((config.isActive ?? config.is_active) ? 'logging.active' : 'logging.inactive')}</StatusBadge>
        <p class="text-sm text-zinc-300">{$_('logging.retentionDays')}: {config.retentionDays ?? config.retention_days ?? '—'} · {$_('logging.cleanupInterval')}: {config.scheduleIntervalHours ?? config.schedule_interval_hours ?? '—'} {$_('logging.hours')}</p>
      {:else}<p class="text-sm text-zinc-400">{$_('settings.unknown')}</p>{/if}
      <div class="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={busy || !config || ['executed', 'refreshFailed', 'unknown'].includes(outcome)} onclick={cleanup} data-testid="cleanup-start">{$_('logging.manualCleanup')}</Button>
        <Button variant="ghost" disabled={busy} onclick={load}>{$_('settings.refresh')}</Button>
        <a href="/#/config" class="text-sm text-nexus-300 underline">{$_('settings.editPolicy')}</a>
      </div>
      {#if outcome !== 'idle'}
        <p bind:this={feedback} tabindex="-1" role="status" class="text-sm text-zinc-200 focus:outline-nexus-500" data-testid="cleanup-outcome">{$_(`settings.cleanupOutcome.${outcome}`)}</p>
      {:else if readFailed}<p role="alert" class="text-sm text-red-400">{$_('settings.cleanupReadFailed')}</p>{/if}
    </div>
  </PanelCard>
</details>
