<script lang="ts">
  import { onMount } from 'svelte';
  import { _ } from '../lib/i18n';
  import { getConfig, updateConfig, validateConfig } from '../lib/api/config';
  import { reloadSystem, restartSystem } from '../lib/api/system';
  import { toast } from '../lib/stores/toast';
  import type { AppConfig } from '../lib/types';
  import AuthEditor from '../lib/components/AuthEditor.svelte';
  import LoggingEditor from '../lib/components/LoggingEditor.svelte';

  let config: AppConfig | null = null;
  let editingConfig: AppConfig | null = null;
  let error: string | null = null;
  let loading = true;
  let reloading = false;
  let restarting = false;
  let saving = false;
  let editMode: 'form' | 'json' = 'form';
  let jsonText = '';
  let jsonError: string | null = null;
  let showRestartModal = false;

  async function loadConfig() {
    try {
      config = await getConfig();
      editingConfig = JSON.parse(JSON.stringify(config)); // Deep clone
      jsonText = JSON.stringify(config, null, 2);
      error = null;
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  function handleJsonChange() {
    jsonError = null;
    try {
      editingConfig = JSON.parse(jsonText);
    } catch (e: any) {
      jsonError = e.message;
    }
  }

  async function handleSave() {
    if (!editingConfig) return;

    saving = true;
    try {
      // 验证配置
      const validation = await validateConfig(editingConfig);
      if (!validation.valid) {
        toast.show($_('configuration.validationFailed', { values: { error: validation.error } }), 'error');
        return;
      }

      // 保存配置
      const result = await updateConfig(editingConfig);
      if (result.success) {
        toast.show($_('configuration.saved'), 'success');
        config = JSON.parse(JSON.stringify(editingConfig));
      } else {
        toast.show($_('configuration.saveFailed', { values: { error: result.message } }), 'error');
      }
    } catch (e: any) {
      toast.show($_('configuration.saveFailed', { values: { error: e.message } }), 'error');
    } finally {
      saving = false;
    }
  }

  function handleExport() {
    if (!config) return;
    const dataStr = JSON.stringify(config, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    const exportFileDefaultName = `bungee-config-${new Date().toISOString().split('T')[0]}.json`;

    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
    toast.show($_('configuration.exported'), 'success');
  }

  function handleImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e: any) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        const text = await file.text();
        const imported = JSON.parse(text);
        editingConfig = imported;
        jsonText = JSON.stringify(imported, null, 2);
        toast.show($_('configuration.imported'), 'success');
      } catch (err: any) {
        toast.show($_('configuration.importFailed', { values: { error: err.message } }), 'error');
      }
    };
    input.click();
  }

  async function handleReload() {
    reloading = true;
    try {
      const result = await reloadSystem();
      if (result.success) {
        toast.show($_('configuration.reloaded'), 'success');
        await loadConfig();
      } else {
        toast.show($_('configuration.reloadFailed', { values: { error: result.message } }), 'error');
      }
    } catch (e: any) {
      toast.show($_('configuration.reloadFailed', { values: { error: e.message } }), 'error');
    } finally {
      reloading = false;
    }
  }

  async function handleRestart() {
    showRestartModal = false;
    restarting = true;
    try {
      const result = await restartSystem();
      if (result.success) {
        toast.show($_('configuration.restartSent'), 'success');
      } else {
        // 显示详细的错误信息
        if (result.error && result.error.includes('daemon mode')) {
          toast.show($_('configuration.restartDaemonOnly'), 'error', 8000);
        } else {
          toast.show($_('configuration.restartFailed', { values: { error: result.error || result.message } }), 'error');
        }
      }
    } catch (e: any) {
      toast.show($_('configuration.restartFailed', { values: { error: e.message } }), 'error');
    } finally {
      restarting = false;
    }
  }

  onMount(() => {
    loadConfig();
  });
</script>

<div class="p-6">
  <!-- Header -->
  <div class="flex justify-between items-center mb-6">
    <div>
      <h1 class="text-3xl font-bold">{$_('configuration.title')}</h1>
      <p class="text-sm text-gray-500 mt-1">
        {$_('configuration.subtitle')}
      </p>
    </div>
    <div class="flex gap-2">
      <button
        class="btn btn-outline btn-sm"
        on:click={handleExport}
        disabled={loading || !config}
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        {$_('configuration.export')}
      </button>
      <button
        class="btn btn-outline btn-sm"
        on:click={handleImport}
        disabled={loading}
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
        {$_('configuration.import')}
      </button>
      <button
        class="btn btn-success btn-sm"
        on:click={handleSave}
        disabled={saving || loading || !!jsonError}
      >
        {#if saving}
          <span class="loading loading-spinner loading-xs"></span>
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
          </svg>
        {/if}
        {$_('configuration.save')}
      </button>
      <button
        class="btn btn-primary btn-sm"
        on:click={handleReload}
        disabled={reloading || loading}
      >
        {#if reloading}
          <span class="loading loading-spinner loading-xs"></span>
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        {/if}
        {$_('configuration.reload')}
      </button>
      <button
        class="btn btn-warning btn-sm"
        on:click={() => showRestartModal = true}
        disabled={restarting || loading}
      >
        {#if restarting}
          <span class="loading loading-spinner loading-xs"></span>
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        {/if}
        {$_('configuration.restart')}
      </button>
    </div>
  </div>

  {#if loading}
    <div class="flex justify-center items-center h-64">
      <span class="loading loading-spinner loading-lg"></span>
    </div>
  {:else if error}
    <div class="alert alert-error">
      <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span>{$_('common.error')}: {error}</span>
    </div>
  {:else if editingConfig}
    <!-- Mode Tabs -->
    <div class="tabs tabs-boxed mb-4">
      <button
        class="tab"
        class:tab-active={editMode === 'form'}
        on:click={() => editMode = 'form'}
      >
        {$_('configuration.formEditor')}
      </button>
      <button
        class="tab"
        class:tab-active={editMode === 'json'}
        on:click={() => editMode = 'json'}
      >
        {$_('configuration.jsonEditor')}
      </button>
    </div>

    {#if editMode === 'form'}
      <!-- Card 1: System Configuration -->
      <div class="card bg-base-100 shadow-xl mb-4">
        <div class="card-body">
          <h2 class="card-title">{$_('configuration.systemSettings')}</h2>

          <!-- Server Settings -->
          <div class="form-control">
            <label class="label" for="config-port">
              <span class="label-text">{$_('configuration.serverPort')}</span>
            </label>
            <input
              id="config-port"
              type="number"
              class="input input-bordered"
              bind:value={editingConfig.port}
              placeholder="8088"
            />
          </div>

          <div class="form-control">
            <label class="label" for="config-workers">
              <span class="label-text">{$_('configuration.workerProcesses')}</span>
            </label>
            <input
              id="config-workers"
              type="number"
              class="input input-bordered"
              bind:value={editingConfig.workers}
              min="1"
              placeholder="2"
            />
            <div class="label">
              <span class="label-text-alt">{$_('configuration.workerProcessesHelp')}</span>
            </div>
          </div>

          <div class="form-control">
            <label class="label" for="config-log-level">
              <span class="label-text">{$_('configuration.logLevel')}</span>
            </label>
            <select
              id="config-log-level"
              class="select select-bordered"
              bind:value={editingConfig.logLevel}
            >
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warning</option>
              <option value="error">Error</option>
            </select>
          </div>

          <div class="form-control">
            <label class="label" for="config-body-limit">
              <span class="label-text">{$_('configuration.bodyParserLimit')}</span>
            </label>
            <input
              id="config-body-limit"
              type="text"
              class="input input-bordered"
              bind:value={editingConfig.bodyParserLimit}
              placeholder="50mb"
            />
            <div class="label">
              <span class="label-text-alt">{$_('configuration.bodyParserLimitHelp')}</span>
            </div>
          </div>

          <div class="divider"></div>

          <!-- Global Authentication Settings -->
          <AuthEditor
            bind:value={editingConfig.auth}
            label={$_('auth.globalAuth')}
          />

          <div class="divider"></div>

          <div class="alert alert-warning">
            <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{$_('configuration.requiresRestart')}</span>
          </div>
        </div>
      </div>

      <!-- Card 2: Logging Configuration -->
      <div class="card bg-base-100 shadow-xl mb-4">
        <div class="card-body">
          <h2 class="card-title">{$_('logging.title')}</h2>

          <LoggingEditor
            bind:value={editingConfig.logging}
          />
        </div>
      </div>

      <!-- Card 3: Route Management -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title">{$_('routes.title')}</h2>

          <div class="alert alert-info">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
            <span>
              {$_('configuration.routesConfigured', { values: { count: editingConfig.routes.length } })}
              {$_('configuration.manageRoutes')}
            </span>
          </div>
        </div>
      </div>
    {:else}
      <!-- JSON Editor -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title">{$_('configuration.jsonConfiguration')}</h2>

          {#if jsonError}
            <div class="alert alert-error mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{$_('configuration.jsonParseError', { values: { error: jsonError } })}</span>
            </div>
          {/if}

          <textarea
            class="textarea textarea-bordered font-mono text-sm h-96"
            bind:value={jsonText}
            on:input={handleJsonChange}
            placeholder={$_('configuration.jsonPlaceholder')}
          ></textarea>

          <p class="text-sm text-gray-500 mt-2">
            {$_('configuration.jsonHelp')}
          </p>
        </div>
      </div>
    {/if}
  {/if}

  <!-- Restart Confirmation Modal -->
  <input type="checkbox" bind:checked={showRestartModal} class="modal-toggle" />
  <div class="modal" class:modal-open={showRestartModal}>
    <div class="modal-box">
      <h3 class="font-bold text-lg">{$_('configuration.confirmRestart')}</h3>
      <p class="py-4">
        {$_('configuration.restartMessage')}
      </p>
      <div class="alert alert-warning">
        <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <span>{$_('configuration.restartWarning')}</span>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost" on:click={() => showRestartModal = false}>
          {$_('common.cancel')}
        </button>
        <button class="btn btn-warning" on:click={handleRestart}>
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {$_('configuration.restart')}
        </button>
      </div>
    </div>
  </div>
</div>
