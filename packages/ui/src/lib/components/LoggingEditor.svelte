<script lang="ts">
  import { onMount, createEventDispatcher } from 'svelte';
  import { _ } from '../i18n';
  import { getCleanupConfig, triggerCleanup, type CleanupConfig, type CleanupResult } from '../api/logs';
  import { toast } from '../stores/toast';

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
        maxSize: 5120,
        retentionDays: 1
      }
    };
  }

  $: if (value && !value.body) {
    value.body = {
      enabled: false,
      maxSize: 5120,
      retentionDays: 1
    };
  }

  function handleInput() {
    dispatch('input');
  }

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
  <div class="form-control">
    <label class="label cursor-pointer justify-start gap-4">
      <input
        type="checkbox"
        class="checkbox"
        bind:checked={value.body.enabled}
        on:change={handleInput}
      />
      <div class="flex-1">
        <span class="label-text font-semibold">{$_('logging.bodyRecording')}</span>
        <p class="text-xs text-gray-500 mt-1">{$_('logging.bodyRecordingHelp')}</p>
      </div>
    </label>
  </div>

  {#if value.body.enabled}
    <div class="ml-8 space-y-4">
      <!-- Max Size -->
      <div class="form-control">
        <label class="label">
          <span class="label-text">{$_('logging.maxSize')}</span>
        </label>
        <div class="flex gap-2 items-center">
          <input
            type="number"
            class="input input-bordered flex-1"
            bind:value={value.body.maxSize}
            on:input={handleInput}
            min="1024"
            max="102400"
            step="1024"
          />
          <span class="text-sm text-gray-500">KB</span>
        </div>
        <label class="label">
          <span class="label-text-alt">{$_('logging.maxSizeHelp')}</span>
        </label>
      </div>

      <!-- Retention Days -->
      <div class="form-control">
        <label class="label">
          <span class="label-text">{$_('logging.retentionDays')}</span>
        </label>
        <div class="flex gap-2 items-center">
          <input
            type="number"
            class="input input-bordered flex-1"
            bind:value={value.body.retentionDays}
            on:input={handleInput}
            min="1"
            max="30"
          />
          <span class="text-sm text-gray-500">{$_('logging.days')}</span>
        </div>
        <label class="label">
          <span class="label-text-alt">{$_('logging.retentionDaysHelp')}</span>
        </label>
      </div>
    </div>
  {/if}

  <div class="divider"></div>

  <!-- Cleanup Configuration -->
  <h4 class="font-semibold">{$_('logging.cleanupConfig')}</h4>

  {#if cleanupLoading}
    <div class="flex items-center gap-2">
      <span class="loading loading-spinner loading-sm"></span>
      <span class="text-sm">{$_('common.loading')}</span>
    </div>
  {:else if cleanupConfig}
    <div class="bg-base-200 p-4 rounded-lg space-y-2">
      <div class="flex justify-between text-sm">
        <span class="text-gray-500">{$_('logging.cleanupStatus')}</span>
        <span class="font-semibold {cleanupConfig.isActive ? 'text-success' : 'text-error'}">
          {cleanupConfig.isActive ? $_('logging.active') : $_('logging.inactive')}
        </span>
      </div>
      <div class="flex justify-between text-sm">
        <span class="text-gray-500">{$_('logging.cleanupRetention')}</span>
        <span class="font-semibold">{cleanupConfig.retentionDays} {$_('logging.days')}</span>
      </div>
      <div class="flex justify-between text-sm">
        <span class="text-gray-500">{$_('logging.cleanupInterval')}</span>
        <span class="font-semibold">{cleanupConfig.scheduleIntervalHours} {$_('logging.hours')}</span>
      </div>
    </div>

    <button
      class="btn btn-outline btn-sm w-full"
      on:click={handleManualCleanup}
      disabled={cleaningUp}
    >
      {#if cleaningUp}
        <span class="loading loading-spinner loading-xs"></span>
      {:else}
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      {/if}
      {$_('logging.manualCleanup')}
    </button>

    {#if lastCleanupResult}
      <div class="alert alert-success">
        <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div class="text-sm">
          <div class="font-semibold">{$_('logging.lastCleanup')}</div>
          <div class="mt-1 space-y-1">
            <div>{$_('logging.deletedSqliteRecords')}: {lastCleanupResult.deletedSqliteRecords}</div>
            <div>{$_('logging.deletedFileLogFiles')}: {lastCleanupResult.deletedFileLogFiles}</div>
            <div>{$_('logging.deletedBodyFiles')}: {lastCleanupResult.deletedBodyDirs} {$_('logging.dirs')}, {lastCleanupResult.deletedBodyFiles} {$_('logging.files')}</div>
            <div>{$_('logging.duration')}: {lastCleanupResult.durationMs}ms</div>
          </div>
        </div>
      </div>
    {/if}
  {/if}
</div>
