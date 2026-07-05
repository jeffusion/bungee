<script lang="ts">
  import { onMount, createEventDispatcher } from 'svelte';
  import { _ } from '$i18n';
  import { getCleanupConfig, triggerCleanup, type CleanupConfig, type CleanupResult } from '$api/logs';
  import { toast } from '$stores/toast';
  import { BSwitch, LoadingIndicator, StatusBadge, SystemAlertBar } from '$components/industrial';
  import { Input } from '$components/ui/input';
  import { Button } from '$components/ui/button';

  export let value: any = null;
  export let label: string = '';

  const dispatch = createEventDispatcher();

  let cleanupConfig: CleanupConfig | null = null;
  let cleanupLoading = false;
  let cleaningUp = false;
  let lastCleanupResult: CleanupResult | null = null;

  // 确保 value 有正确的结构
  $: if (!value) {
    value = {
      body: {
        enabled: false,
        max_size: 5120,
        retention_days: 1
      }
    };
  }

  $: if (value && !value.body) {
    value.body = {
      enabled: false,
      max_size: 5120,
      retention_days: 1
    };
  }

  function handleInput() {
    dispatch('input');
  }

function handleBodyRecordingChange(checked: boolean) {
		value.body.enabled = checked;
		handleInput();
	}

  $: cleanupActive = cleanupConfig ? cleanupConfig.isActive ?? cleanupConfig.is_active ?? false : false;
  $: cleanupRetention = cleanupConfig ? cleanupConfig.retentionDays ?? cleanupConfig.retention_days ?? null : null;
  $: cleanupInterval = cleanupConfig ? cleanupConfig.scheduleIntervalHours ?? cleanupConfig.schedule_interval_hours ?? null : null;
  $: cleanupDeletedSqliteRecords = lastCleanupResult ? lastCleanupResult.deletedSqliteRecords ?? lastCleanupResult.deleted_sqlite_records ?? 0 : 0;
  $: cleanupDeletedFileLogFiles = lastCleanupResult ? lastCleanupResult.deletedFileLogFiles ?? lastCleanupResult.deleted_file_log_files ?? 0 : 0;
  $: cleanupDeletedBodyDirs = lastCleanupResult ? lastCleanupResult.deletedBodyDirs ?? lastCleanupResult.deleted_body_dirs ?? 0 : 0;
  $: cleanupDeletedBodyFiles = lastCleanupResult ? lastCleanupResult.deletedBodyFiles ?? lastCleanupResult.deleted_body_files ?? 0 : 0;
  $: cleanupDurationMs = lastCleanupResult ? lastCleanupResult.durationMs ?? lastCleanupResult.duration_ms ?? 0 : 0;

  async function loadCleanupConfig() {
    cleanupLoading = true;
    try {
      cleanupConfig = await getCleanupConfig();
    } catch (error) {
      console.error('Failed to load cleanup config:', error);
      toast.show($_('common.error') + ': ' + (error instanceof Error ? error.message : 'Unknown error'), 'error');
    } finally {
      cleanupLoading = false;
    }
  }

  async function handleManualCleanup() {
    if (!confirm($_('logging.confirmCleanup'))) {
      return;
    }

    cleaningUp = true;
    try {
      lastCleanupResult = await triggerCleanup();
      toast.show($_('logging.cleanupSuccess'), 'success');
      await loadCleanupConfig();
    } catch (error) {
      console.error('Failed to trigger cleanup:', error);
      toast.show($_('logging.cleanupFailed', { values: { error: error instanceof Error ? error.message : 'Unknown error' } }), 'error');
    } finally {
      cleaningUp = false;
    }
  }

  onMount(() => {
    loadCleanupConfig();
  });
</script>

<div class="space-y-4">
  {#if label}
    <h3 class="text-lg font-semibold">{label}</h3>
  {/if}

  <!-- Body Recording -->
  <div class="flex flex-col gap-2 border border-carbon-600 bg-carbon-950/40 px-3 py-3 md:flex-row md:items-center md:justify-between">
    <div class="min-w-0 space-y-1">
      <div class="flex items-center gap-2">
        <span class="font-mono text-[12px] font-bold uppercase tracking-command text-zinc-100">{$_('logging.bodyRecording')}</span>
        <StatusBadge variant={value.body.enabled ? 'online' : 'muted'} dot>{value.body.enabled ? 'BODY ON' : 'BODY OFF'}</StatusBadge>
      </div>
      <p class="font-mono text-[10px] uppercase tracking-command text-zinc-500">{$_('logging.bodyRecordingHelp')}</p>
    </div>

		<BSwitch
			bind:checked={value.body.enabled}
			onchange={handleBodyRecordingChange}
		/>
  </div>

  {#if value.body.enabled}
    <div class="pl-3 space-y-4">
      <!-- Max Size -->
      <label class="block space-y-1.5" for="logging-max-size">
        <span class="nx-label">// {$_('logging.maxSize')}</span>
        <div class="flex gap-2 items-center">
          <Input
            id="logging-max-size"
            type="number"
            class="flex-1"
            value={value.body.max_size ?? ''}
            oninput={(e) => { value.body.max_size = Number((e.currentTarget as HTMLInputElement).value) || undefined; handleInput(); }}
            min="1024"
            max="102400"
            step="1024"
          />
          <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">KB</span>
        </div>
        <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">{$_('logging.maxSizeHelp')}</span>
      </label>

      <!-- Retention Days -->
      <label class="block space-y-1.5" for="logging-retention-days">
        <span class="nx-label">// {$_('logging.retentionDays')}</span>
        <div class="flex gap-2 items-center">
          <Input
            id="logging-retention-days"
            type="number"
            class="flex-1"
            value={value.body.retention_days ?? ''}
            oninput={(e) => { value.body.retention_days = Number((e.currentTarget as HTMLInputElement).value) || undefined; handleInput(); }}
            min="1"
            max="30"
          />
          <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">{$_('logging.days')}</span>
        </div>
        <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">{$_('logging.retentionDaysHelp')}</span>
      </label>
    </div>
  {/if}

  <div class="border-t border-carbon-600 my-2"></div>

  <!-- Cleanup Configuration -->
  <div class="flex items-center justify-between gap-3">
    <h4 class="font-mono text-[12px] font-bold uppercase tracking-command text-zinc-100">{$_('logging.cleanupConfig')}</h4>
    {#if cleanupConfig}
      <StatusBadge variant={cleanupActive ? 'active' : 'muted'} dot>
        {cleanupActive ? $_('logging.active') : $_('logging.inactive')}
      </StatusBadge>
    {/if}
  </div>

  {#if cleanupLoading}
    <LoadingIndicator label={$_('common.loading')} size="sm" centered={false} />
  {:else if cleanupConfig}
    <div class="border border-carbon-600 bg-carbon-950/60 p-4 space-y-2">
      <div class="flex justify-between gap-3 font-mono text-[11px] uppercase tracking-command">
        <span class="text-zinc-500">{$_('logging.cleanupStatus')}</span>
        <span class={cleanupActive ? 'text-emerald-300' : 'text-zinc-400'}>
          {cleanupActive ? $_('logging.active') : $_('logging.inactive')}
        </span>
      </div>
      <div class="flex justify-between gap-3 font-mono text-[11px] uppercase tracking-command">
        <span class="text-zinc-500">{$_('logging.cleanupRetention')}</span>
        <span class="text-zinc-200">{cleanupRetention ?? '—'} {$_('logging.days')}</span>
      </div>
      <div class="flex justify-between gap-3 font-mono text-[11px] uppercase tracking-command">
        <span class="text-zinc-500">{$_('logging.cleanupInterval')}</span>
        <span class="text-zinc-200">{cleanupInterval ?? '—'} {$_('logging.hours')}</span>
      </div>
    </div>

    <Button
      variant="outline"
      size="sm"
      onclick={handleManualCleanup}
      disabled={cleaningUp}
    >
      {#if cleaningUp}
        <LoadingIndicator label="" size="xs" centered={false} />
      {:else}
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      {/if}
      {$_('logging.manualCleanup')}
    </Button>

    {#if lastCleanupResult}
      <SystemAlertBar tone="success" title={$_('logging.lastCleanup')}>
          <div class="mt-1 space-y-1 font-mono text-[10px] uppercase tracking-command text-zinc-500">
            <div>{$_('logging.deletedSqliteRecords')}: {cleanupDeletedSqliteRecords}</div>
            <div>{$_('logging.deletedFileLogFiles')}: {cleanupDeletedFileLogFiles}</div>
            <div>{$_('logging.deletedBodyFiles')}: {cleanupDeletedBodyDirs} {$_('logging.dirs')}, {cleanupDeletedBodyFiles} {$_('logging.files')}</div>
            <div>{$_('logging.duration')}: {cleanupDurationMs}ms</div>
          </div>
      </SystemAlertBar>
    {/if}
  {/if}
</div>
