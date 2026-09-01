<script lang="ts">
  import { onMount } from 'svelte';
  import { isLoading } from 'svelte-i18n';
  import { _ } from '$i18n';
  import {
    ConfigurationNextAuthorizationRequiredError,
    getConfigSnapshot,
    importConfig,
    updateConfig,
    validateConfig,
    type ConfigurationImportEnvelope,
    type ConfigurationSnapshot,
  } from '../api/config';
  import { toast } from '$stores/toast';
  import { getToken } from '$stores/auth';
  import type { LogicalConfigurationV2 } from '@jeffusion/bungee-types';
  import AuthEditor from '$components/domain/config/AuthEditor.svelte';
  import LoggingEditor from '$components/domain/config/LoggingEditor.svelte';
  import { Input } from '$components/ui/input';
  import { Textarea } from '$components/ui/textarea';
  import { Button } from '$components/ui/button';
  import { BSelect } from '$components/industrial';
  import {
    KpiCard,
    PanelCard,
    SegmentedControl,
    StatusBadge,
    SystemAlertBar,
    IconButton,
    LoadingIndicator,
  } from '$components/industrial';

  type EditableLogicalConfiguration = {
    -readonly [Key in keyof LogicalConfigurationV2]: LogicalConfigurationV2[Key];
  };

  const logLevelOptions = [
    { label: 'Debug', value: 'debug' },
    { label: 'Info', value: 'info' },
    { label: 'Warning', value: 'warn' },
    { label: 'Error', value: 'error' },
  ];

  let config: LogicalConfigurationV2 | null = null;
  let editingConfig: EditableLogicalConfiguration | null = null;
  let loadedSnapshot: ConfigurationSnapshot | null = null;
  let error: string | null = null;
  let loading = true;
  let saving = false;
  let editMode: 'form' | 'json' = 'form';
  let authWillChange = false;
  let nextAuthRequired = false;
  let jsonText = '';
  let jsonError: string | null = null;
  let nextAuthToken = '';
  let importNextAuthRequired = false;
  let pendingImportEnvelope: ConfigurationImportEnvelope | null = null;

  async function loadConfig() {
    try {
      loadedSnapshot = await getConfigSnapshot();
      config = loadedSnapshot.config.logical_configuration;
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

  function handleJsonChange(event: Event) {
    jsonText = (event.currentTarget as HTMLTextAreaElement).value;
    jsonError = null;
    try {
      editingConfig = JSON.parse(jsonText);
    } catch (e: any) {
      jsonError = e.message;
    }
  }

  async function handleSave() {
    if (!editingConfig || !loadedSnapshot) return;
    saving = true;
    try {
      const validation = await validateConfig(loadedSnapshot, editingConfig);
      if (!validation.valid) {
        toast.show($_('configuration.validationFailed', { values: { error: validation.error } }), 'error');
        return;
      }
      if (nextAuthRequired && nextAuthToken.trim() === '') {
        toast.show($_('auth.nextTokenRequired'), 'error');
        return;
      }
      const result = await updateConfig(loadedSnapshot, editingConfig,
        nextAuthRequired ? { nextAuthorization: nextAuthToken.trim() } : {});
      nextAuthToken = '';
      if (result.success) {
        toast.show($_('configuration.saved'), 'success');
        await loadConfig();
      } else {
        toast.show($_('configuration.saveFailed', { values: { error: result.message } }), 'error');
      }
    } catch (e: any) {
      toast.show($_('configuration.saveFailed', { values: { error: e.message } }), 'error');
    } finally {
      saving = false;
    }
  }

  async function handleExport() {
    if (!config) return;
    try {
      const response = await fetch('/__ui/api/config/export', {
        headers: { authorization: `Bearer ${getToken() ?? ''}` },
      });
      if (!response.ok) throw new Error(`Export failed: ${response.status}`);
      const envelope = await response.json();
      const dataStr = JSON.stringify(envelope, null, 2);
      const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
      const filename = `bungee-config-rev${envelope.source_revision ?? 'snapshot'}.json`;
      const a = document.createElement('a');
      a.setAttribute('href', dataUri);
      a.setAttribute('download', filename);
      a.click();
      toast.show($_('configuration.exported'), 'success');
    } catch (e: any) {
      toast.show(e.message ?? String(e), 'error');
    }
  }

  async function runImport(envelope: ConfigurationImportEnvelope) {
    if (!loadedSnapshot) return;
    try {
      await importConfig(loadedSnapshot, envelope,
        nextAuthToken.trim() !== '' ? { nextAuthorization: nextAuthToken.trim() } : {});
      pendingImportEnvelope = null;
      importNextAuthRequired = false;
      nextAuthToken = '';
      toast.show($_('configuration.imported'), 'success');
      await loadConfig();
    } catch (err: any) {
      // The import moves the auth surface to the envelope's tokens: keep the
      // envelope parked, reveal the next-auth panel, and let the user retry.
      if (err instanceof ConfigurationNextAuthorizationRequiredError) {
        pendingImportEnvelope = envelope;
        importNextAuthRequired = true;
        toast.show($_('auth.nextTokenRequired'), 'error');
        return;
      }
      toast.show($_('configuration.importFailed', { values: { error: err.message } }), 'error');
    }
  }

  function handleImport() {
    if (pendingImportEnvelope) {
      void runImport(pendingImportEnvelope);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e: any) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        await runImport(JSON.parse(await file.text()));
      } catch (err: any) {
        toast.show($_('configuration.importFailed', { values: { error: err.message } }), 'error');
      }
    };
    input.click();
  }

  onMount(() => {
    loadConfig();
  });

  function configSnapshot(value: unknown): string {
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
  $: routeCount = editingConfig?.routes?.length ?? 0;
  $: authEnabled = editingConfig?.auth?.enabled ?? false;
  $: authWillChange = !!config && !!editingConfig && configSnapshot(config.auth) !== configSnapshot(editingConfig.auth);
  $: nextAuthRequired = editingConfig?.auth?.enabled === true && authWillChange;
  $: bodyLoggingEnabled = editingConfig?.logging?.body?.enabled ?? false;
</script>

<div class="w-full max-w-7xl mx-auto px-6 py-5 space-y-5" data-testid="page-config">
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
          V2 · {jsonError ? 'PARSE ERROR' : 'VALID BUFFER'}
        </span>
      </KpiCard>
      <KpiCard label="ROUTES" value={routeCount} unit="CFG">
        <span slot="foot" class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
          {#if jsonError}<span class="text-amber-400">STALE · </span>{/if}LOGICAL CONFIG
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
          <label class="block space-y-1.5" data-testid="config-log-level-select">
            <span class="nx-label">// {$_('configuration.logLevel')}</span>
            <BSelect
              options={logLevelOptions}
              value={editingConfig.log_level}
              onchange={(val) => (editingConfig!.log_level = (Array.isArray(val) ? val[0] : val) as LogicalConfigurationV2['log_level'])}
              ariaLabel={$_('configuration.logLevel')}
            />
          </label>
          <label class="block space-y-1.5">
            <span class="nx-label">// {$_('configuration.bodyParserLimit')}</span>
            <Input
              type="text"
              value={editingConfig.body_parser_limit ?? ''}
              oninput={(e) => (editingConfig!.body_parser_limit = (e.currentTarget as HTMLInputElement).value)}
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

    {#if nextAuthRequired || importNextAuthRequired}
      <PanelCard title={$_('auth.nextToken')} tag="AUTH-NEXT" stripe="amber">
        <div class="space-y-2" data-testid="next-auth-section">
          <label class="block space-y-1.5">
            <span class="nx-label">// {$_('auth.nextToken')}</span>
            <Input
              type="password"
              value={nextAuthToken}
              oninput={(e) => (nextAuthToken = (e.currentTarget as HTMLInputElement).value)}
              placeholder={$_('auth.nextTokenPlaceholder')}
              data-testid="next-auth-token-input"
            />
          </label>
          <p class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
            {$_('auth.nextTokenHelp')}
          </p>
        </div>
      </PanelCard>
    {/if}
  {/if}
</div>
