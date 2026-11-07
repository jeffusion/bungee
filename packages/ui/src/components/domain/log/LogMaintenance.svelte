<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { _, isLoading } from '$i18n';
  import { getCleanupConfig, triggerCleanup, type CleanupConfig } from '$api/logs';
  import { ApiError } from '$api/client';
  import { confirmAction } from '$stores/confirmation';
  import { Button } from '$components/ui/button';
  import { StatusBadge } from '$components/industrial';
  let config = $state<CleanupConfig | null>(null), busy = $state(false), readFailed = $state(false);
  let outcome = $state<'idle' | 'executed' | 'refreshFailed' | 'rejected' | 'unknown'>('idle');
  let feedback = $state<HTMLParagraphElement>();
  async function load() {
    try { config = await getCleanupConfig(); readFailed = false; return true; }
    catch { readFailed = true; return false; }
  }
  async function cleanup() {
    if (busy || !config || ['executed', 'refreshFailed', 'unknown'].includes(outcome)) return;
    if (!await confirmAction({ title: $_('logging.manualCleanup'), message: $_('settings.cleanupImmediate'),
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

<div class="space-y-4 p-5" data-testid="logs-maintenance">
  {#if !$isLoading}
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span class="text-sm font-medium text-zinc-100">{$_('logging.cleanupSchedule')}</span>
        {#if config && !readFailed}
          {@const active = config.isActive ?? config.is_active}
          {@const interval = config.scheduleIntervalHours ?? config.schedule_interval_hours}
          <StatusBadge variant={active ? 'active' : 'muted'}>{$_(active ? 'logging.active' : 'logging.inactive')}</StatusBadge>
          {#if active && interval !== undefined}
            <span class="text-sm text-zinc-400">{$_('logging.cleanupCadence', { values: { value: interval } })}</span>
          {/if}
        {:else if !readFailed}<span class="text-sm text-zinc-400">{$_('common.loading')}</span>{/if}
      </div>
      <Button variant="ghost" disabled={busy} onclick={load}>{$_('settings.refresh')}</Button>
    </div>
    <div class="flex flex-wrap items-center justify-between gap-3 border-t border-carbon-600 pt-4 sm:flex-nowrap sm:gap-6">
      <div class="space-y-1">
        <p class="text-sm font-medium text-zinc-100">{$_('logging.manualCleanupTitle')}</p>
        <p class="text-sm text-zinc-400">{$_('settings.cleanupImmediate')}</p>
      </div>
      <Button class="shrink-0" variant="outline" disabled={busy || !config || ['executed', 'refreshFailed', 'unknown'].includes(outcome)}
        onclick={cleanup} data-testid="cleanup-start">{$_('logging.manualCleanup')}</Button>
    </div>
    {#if outcome !== 'idle'}
      <p bind:this={feedback} tabindex="-1" role="status" class="border-l-2 border-nexus-500 pl-3 text-sm text-zinc-200 focus:outline-nexus-500" data-testid="cleanup-outcome">{$_(`settings.cleanupOutcome.${outcome}`)}</p>
    {:else if readFailed}<p role="alert" class="border-l-2 border-red-500 pl-3 text-sm text-red-400">{$_('settings.cleanupReadFailed')}</p>{/if}
  {/if}
</div>
