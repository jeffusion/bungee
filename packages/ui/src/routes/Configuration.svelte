<script lang="ts">
  import { onMount } from 'svelte';
  import { isLoading } from 'svelte-i18n';
  import { _ } from '$i18n';
  import { getConfig, updateConfig, validateConfig } from '$api/config';
  import { reloadSystem, restartSystem } from '$api/system';
  import { toast } from '$stores/toast';
  import type { AppConfig } from '$types';
  import AuthEditor from '$components/domain/config/AuthEditor.svelte';
  import LoggingEditor from '$components/domain/config/LoggingEditor.svelte';
  import ConfirmDialog from '$components/shell/ConfirmDialog.svelte';
  import { Input } from '$components/ui/input';
  import { Textarea } from '$components/ui/textarea';
  import { Button } from '$components/ui/button';
  import { BSelect } from '$components/industrial';
  import {
    KpiCard,
    PanelCard,
    SectionDivider,
    SegmentedControl,
    StatusBadge,
    SystemAlertBar,
    IconButton,
    LoadingIndicator,
  } from '$components/industrial';

  const logLevelOptions = [
    { label: 'Debug', value: 'debug' },
    { label: 'Info', value: 'info' },
    { label: 'Warning', value: 'warn' },
    { label: 'Error', value: 'error' },
  ];

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
      editingConfig = JSON.parse(JSON.stringify(config));
      jsonText = JSON.stringify(config, null, 2);
      jsonError = null;
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
      const validation = await validateConfig(editingConfig);
      if (!validation.valid) {
        toast.show($_('configuration.validationFailed', { values: { error: validation.error } }), 'error');
        return;
      }
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
    const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
    const filename = `bungee-config-${new Date().toISOString().split('T')[0]}.json`;
    const a = document.createElement('a');
    a.setAttribute('href', dataUri);
    a.setAttribute('download', filename);
    a.click();
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
        jsonError = null;
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

  function configSnapshot(value: AppConfig | null): string {
    return JSON.stringify(value ?? null);
  }

  $: editModeOptions = $isLoading ? [] : [
    { value: 'form', label: $_('configuration.formEditor') },
    { value: 'json', label: $_('configuration.jsonEditor') },
  ];

  $: if (editMode === 'form' && editingConfig) {
    jsonText = JSON.stringify(editingConfig, null, 2);
    jsonError = null;
  }

  $: isDirty = !!config && !!editingConfig && configSnapshot(config) !== configSnapshot(editingConfig);
  $: restartRequired = !!config && !!editingConfig && (
    config.port !== editingConfig.port ||
    config.workers !== editingConfig.workers ||
    config.log_level !== editingConfig.log_level ||
    config.body_parser_limit !== editingConfig.body_parser_limit
  );
  $: routeCount = editingConfig?.routes?.length ?? 0;
  $: authEnabled = editingConfig?.auth?.enabled ?? false;
  $: bodyLoggingEnabled = editingConfig?.logging?.body?.enabled ?? false;
</script>

<div class="px-6 py-5 space-y-5" data-testid="page-config">
  <!-- ===== Header =============================================== -->
  <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
    <div class="flex items-center gap-3">
      <span class="nx-stripe" aria-hidden="true"></span>
      <div class="flex flex-col leading-tight">
        <span class="nx-label">// {$_('configuration.subtitle')}</span>
        <h1 class="nx-display text-xl text-zinc-50 tracking-[0.02em]">
          {$_('configuration.title')}
        </h1>
        <div class="mt-1 flex flex-wrap items-center gap-2">
          <StatusBadge variant={jsonError ? 'fault' : isDirty ? 'standby' : 'active'} dot>
            {jsonError ? 'JSON ERROR' : isDirty ? 'DIRTY' : 'CLEAN'}
          </StatusBadge>
          {#if restartRequired}
            <StatusBadge variant="standby" dot>RESTART REQUIRED</StatusBadge>
          {/if}
        </div>
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <IconButton title={$_('configuration.export')} on:click={handleExport} disabled={loading || !config}>
        <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
      </IconButton>
      <IconButton title={$_('configuration.import')} on:click={handleImport} disabled={loading}>
        <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
      </IconButton>
      <Button variant="default" onclick={handleSave} disabled={saving || loading || !!jsonError || !isDirty} data-testid="config-save-button">
        {#if saving}
          <LoadingIndicator label="" size="xs" centered={false} />
        {:else}
          <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
          </svg>
        {/if}
        {$_('configuration.save')}
      </Button>
    </div>
  </div>

  {#if loading}
    <PanelCard title={$_('configuration.title')} tag="LOADING">
      <LoadingIndicator label="LOADING CONFIG" />
    </PanelCard>
  {:else if error}
    <PanelCard title={$_('common.error')} tag="ERR" stripe="red">
      <p class="font-mono text-xs uppercase tracking-command text-red-300" data-testid="config-validation-message">{error}</p>
    </PanelCard>
  {:else if editingConfig}
    <!--
      KPI strip — 6 cards laid out as 2/3/6 columns so every breakpoint
      stays symmetrical (2×3, 3×2, 6×1) with no orphan tile and no
      "right-side gap". Each card carries an explicit `unit` so the
      right edge always has a label keeping the metric from drifting to
      the left.
    -->
    <section class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
      <KpiCard
        label="CONFIG"
        value={jsonError ? 'ERROR' : isDirty ? 'DIRTY' : 'CLEAN'}
        unit="STATE"
        tone={jsonError ? 'danger' : isDirty ? 'warn' : 'ok'}
        stripe={jsonError ? 'red' : isDirty ? 'amber' : 'emerald'}
      >
        <span slot="foot" class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
          V{editingConfig.config_version ?? '—'} · {jsonError ? 'PARSE ERROR' : 'VALID BUFFER'}
        </span>
      </KpiCard>
      <KpiCard label="PORT" value={editingConfig.port ?? 8088} unit="TCP">
        <span slot="foot" class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
          {#if jsonError}<span class="text-amber-400">STALE · </span>{/if}{editingConfig.workers ?? 2} WORKERS
        </span>
      </KpiCard>
      <KpiCard label="AUTH" value={authEnabled ? 'ON' : 'OFF'} unit="GATE" tone={authEnabled ? 'accent' : 'auto'} stripe={authEnabled ? 'orange' : 'zinc'}>
        <span slot="foot" class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
          {#if jsonError}<span class="text-amber-400">STALE · </span>{/if}{authEnabled ? 'PROTECTED' : 'OPEN'}
        </span>
      </KpiCard>
      <KpiCard label="LOGGING" value={bodyLoggingEnabled ? 'BODY' : 'OFF'} unit="LOG" tone={bodyLoggingEnabled ? 'accent' : 'auto'} stripe={bodyLoggingEnabled ? 'orange' : 'zinc'}>
        <span slot="foot" class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
          {#if jsonError}<span class="text-amber-400">STALE · </span>{/if}{editingConfig.logging?.body?.retention_days ?? '—'} DAY RETENTION
        </span>
      </KpiCard>
      <!--
        Replaces ROUTES / SERVICES — those have their own management
        pages (/#/routes, /#/services); a "configuration center" should
        surface server-runtime parameters instead. LOG LEVEL and BODY
        LIMIT are the next two most-consulted runtime knobs and are not
        otherwise visible without scrolling into the form.
      -->
      <KpiCard
        label="LOG LEVEL"
        value={(editingConfig.log_level ?? 'info').toUpperCase()}
        unit="LVL"
        tone={editingConfig.log_level === 'debug' ? 'warn' : editingConfig.log_level === 'error' ? 'danger' : 'auto'}
        stripe={editingConfig.log_level === 'debug' ? 'amber' : editingConfig.log_level === 'error' ? 'red' : 'orange'}
      >
        <span slot="foot" class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
          {#if jsonError}<span class="text-amber-400">STALE · </span>{/if}{editingConfig.log_level === 'debug' ? 'VERBOSE OUTPUT' : 'STANDARD'}
        </span>
      </KpiCard>
      <KpiCard label="BODY LIMIT" value={(editingConfig.body_parser_limit ?? '50mb').toUpperCase()} unit="REQ">
        <span slot="foot" class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
          {#if jsonError}<span class="text-amber-400">STALE · </span>{/if}REQUEST SIZE CAP
        </span>
      </KpiCard>
    </section>

    <!-- Editor mode selector -->
    <div class="flex items-center justify-between">
      <SegmentedControl options={editModeOptions} bind:value={editMode} ariaLabel="edit mode" />
    </div>

    {#if editMode === 'form'}
      <!-- ===== System settings ============================= -->
      <PanelCard title={$_('configuration.systemSettings')} tag="SYS">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label class="block space-y-1.5">
            <span class="nx-label">// {$_('configuration.serverPort')}</span>
            <Input
              type="number"
              value={editingConfig.port ?? ''}
              oninput={(e) => (editingConfig.port = Number((e.currentTarget as HTMLInputElement).value) || undefined)}
              placeholder="8088"
            />
          </label>
          <label class="block space-y-1.5">
            <span class="nx-label">// {$_('configuration.workerProcesses')}</span>
            <Input
              type="number"
              value={editingConfig.workers ?? ''}
              oninput={(e) => (editingConfig.workers = Number((e.currentTarget as HTMLInputElement).value) || undefined)}
              min="1"
              placeholder="2"
            />
            <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">{$_('configuration.workerProcessesHelp')}</span>
          </label>
          <label class="block space-y-1.5">
            <span class="nx-label">// {$_('configuration.logLevel')}</span>
            <BSelect
              options={logLevelOptions}
              value={editingConfig.log_level}
              onchange={(val: string) => (editingConfig.log_level = val)}
              ariaLabel={$_('configuration.logLevel')}
              data-testid="config-log-level-select"
            />
          </label>
          <label class="block space-y-1.5">
            <span class="nx-label">// {$_('configuration.bodyParserLimit')}</span>
            <Input
              type="text"
              value={editingConfig.body_parser_limit ?? ''}
              oninput={(e) => (editingConfig.body_parser_limit = (e.currentTarget as HTMLInputElement).value)}
              placeholder="50mb"
            />
            <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">{$_('configuration.bodyParserLimitHelp')}</span>
          </label>
        </div>
      </PanelCard>

      <!-- ===== Global auth ================================ -->
      <PanelCard title={$_('auth.globalAuth')} tag="AUTH" stripe={editingConfig.auth?.enabled ? 'orange' : 'zinc'}>
        <AuthEditor bind:value={editingConfig.auth} label={$_('auth.globalAuth')} />
      </PanelCard>

      <!-- ===== Logging ==================================== -->
      <PanelCard title={$_('logging.title')} tag="LOG">
        <LoggingEditor bind:value={editingConfig.logging} />
      </PanelCard>

      <!-- ===== Route management note ====================== -->
      <SystemAlertBar
        tone="info"
        title={$_('routes.title')}
        subtitle={`${$_('configuration.routesConfigured', { values: { count: routeCount } })} · ${$_('configuration.manageRoutes')}`}
      >
        <a slot="action" href="/__ui/#/routes" class="inline-flex items-center gap-1 px-2 py-1 border border-carbon-500 text-zinc-200 hover:bg-carbon-800 hover:border-nexus-500 transition-colors font-mono text-[11px] uppercase tracking-command">
          <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          {$_('routes.title')}
        </a>
      </SystemAlertBar>
    {:else}
      <!-- ===== JSON editor ============================== -->
      <PanelCard title={$_('configuration.jsonConfiguration')} tag={jsonError ? 'PARSE-ERR' : 'JSON'} stripe={jsonError ? 'red' : 'orange'}>
        {#if jsonError}
          <div class="border-l-2 border-l-red-500 bg-red-500/5 px-3 py-2 mb-3 space-y-1" data-testid="config-validation-message">
            <p class="font-mono text-[10px] uppercase tracking-command text-red-300">
              {$_('configuration.jsonParseError', { values: { error: '' } }).replace(/[:：].*$/, '')}
            </p>
            <!-- Error body in mono but preserving original casing for readability;
                 JSON parser messages are mixed-case and `tracking-command` makes them
                 harder to read at 10–11px. -->
            <p class="font-mono text-[12px] text-red-200 leading-snug break-all">
              {jsonError}
            </p>
          </div>
        {/if}

        <Textarea
          class="resize-y h-96 leading-relaxed"
          value={jsonText}
          oninput={handleJsonChange}
          placeholder={$_('configuration.jsonPlaceholder')}
          spellcheck={false}
        />

        <p class="mt-2 font-mono text-[10px] uppercase tracking-command text-zinc-500">
          {$_('configuration.jsonHelp')}
        </p>
      </PanelCard>
    {/if}

    <SectionDivider label="SYSTEM OPERATIONS" />
    <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
      <SystemAlertBar
        tone={restartRequired ? 'warn' : 'info'}
        title={$_('configuration.requiresRestart')}
        subtitle={restartRequired ? 'PENDING FIELD CHANGE DETECTED' : 'PORT / WORKERS / LOG_LEVEL / BODY LIMIT'}
      >
        <Button slot="action" variant="default" onclick={() => (showRestartModal = true)} disabled={restarting || loading}>
          {#if restarting}
            <LoadingIndicator label="" size="xs" centered={false} />
          {:else}
            <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          {/if}
          {$_('configuration.restart')}
        </Button>
      </SystemAlertBar>

      <SystemAlertBar
        tone="info"
        title={$_('configuration.reload')}
        subtitle="RELOAD RUNTIME CONFIGURATION FROM DISK"
      >
        <Button slot="action" variant="outline" onclick={handleReload} disabled={reloading || loading}>
          {#if reloading}
            <LoadingIndicator label="" size="xs" centered={false} />
          {:else}
            <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          {/if}
          {$_('configuration.reload')}
        </Button>
      </SystemAlertBar>
    </div>
  {/if}

  <!-- ===== Restart confirm ============================== -->
  <ConfirmDialog
    bind:open={showRestartModal}
    title={$_('configuration.confirmRestart')}
    message={`${$_('configuration.restartMessage')} · ${$_('configuration.restartWarning')}`}
    confirmText={$_('configuration.restart')}
    cancelText={$_('common.cancel')}
    confirmClass="nx-btn-warn"
    on:confirm={handleRestart}
    on:cancel={() => (showRestartModal = false)}
  />
</div>
