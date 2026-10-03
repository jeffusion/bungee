<script lang="ts">
  import * as Tooltip from '$components/ui/tooltip';
  import PluginActivationDialog from '$components/domain/plugin/PluginActivationDialog.svelte';
  import { activationBlockedReason, activationDependencies, accountError } from '$components/domain/plugin/activation-state';
  import { onMount } from 'svelte';
  import { _ } from '$i18n';
  import { isLoading } from 'svelte-i18n';
  import { ConfigurationOperationTimeoutError, ConfigurationOperationDegradedError } from '$api/config';
  import { publicationRecovery } from '$stores/runtime';
  import { publicationMessage } from '$components/domain/config/publication-state';
  import { PluginsAPI, setPluginEnabled, type Plugin } from '$api/plugins';
  import { toast } from '$stores/toast';
  import { pluginList, pluginsLoading, refreshPlugins } from '$stores/plugins';
  import { getPluginText } from '$utils/plugin-i18n';
  import PluginIcon from '$components/shell/PluginIcon.svelte';
  import {
    PanelCard,
    KpiCard,
    SystemAlertBar,
    SegmentedControl,
    LoadingIndicator,
    BSwitch,
  } from '$components/industrial';

  let processing = $state<string[]>([]);
  let selected = $state<{plugin: Plugin; enabled: boolean; dependencies: string[]} | null>(null);
  let operationNotice = $state<{key:string;plugin?:string;errorKey?:string;keepDependencies?:boolean}|null>(null), operationDetail = $state('');
  let searchQuery = $state('');
  let filterState = $state<'all' | 'enabled' | 'disabled'>('all');
  function pluginDisplayName(name: string) {
    const plugin = $pluginList.find(item => item.name === name);
    return getPluginText(plugin?.metadata?.name, name, $_) || name;
  }
  function noticeText() {
    if (!operationNotice) return '';
    const value = operationNotice;
    return $_(value.key, {values:{name:value.plugin ? pluginDisplayName(value.plugin) : '', error:value.errorKey ? $_(value.errorKey) : '', dependencies:value.keepDependencies ? $_('pluginActivation.keepDependencies') : ''}});
  }
  const dependencyNames = $derived.by(() => { $_; return selected?.dependencies.map(pluginDisplayName) ?? []; });
  async function refreshServerState(): Promise<boolean> {
    try { pluginList.set(await PluginsAPI.list({preserveSessionOnUnauthorized:true})); return true; }
    catch (error) {
      operationNotice = {key:'pluginActivation.refreshFailed'};
      operationDetail = accountError(error).detail;
      return false;
    }
  }
  function requestToggle(plugin: Plugin, enabled: boolean) {
    if (processing.includes(plugin.name) || activationBlockedReason(plugin, pluginDisplayName, $_)) return;
    const dependencies = enabled ? activationDependencies(plugin, $pluginList).map(item => item.name) : [];
    if (plugin.management || dependencies.length) selected = {plugin, enabled, dependencies};
    else void togglePlugin(plugin, enabled);
  }
  async function togglePlugin(plugin: Plugin, enabled: boolean) {
    if (processing.includes(plugin.name)) return;
    processing = [...processing, plugin.name]; operationNotice = null; operationDetail = '';
    let accepted = false;
    try {
      await setPluginEnabled(plugin.name, enabled, { onAccepted: () => { accepted = true; operationNotice = {key:'pluginActivation.stages.awaitingPublication'}; } });
      if (await refreshServerState()) {
        operationNotice = {key:enabled ? 'pluginActivation.enabledNotice' : 'pluginActivation.disabledNotice',plugin:plugin.name,keepDependencies:!enabled && Object.keys(plugin.dependencies ?? {}).length > 0};
        toast.show(noticeText(), 'success');
      }
    } catch (error) {
      await publicationRecovery.refresh();
      const publicationWarning = error instanceof ConfigurationOperationTimeoutError || error instanceof ConfigurationOperationDegradedError;
      if (publicationWarning) {
        const message = error instanceof ConfigurationOperationTimeoutError ? $_('configurationSave.waitingStopped')
          : $_(`configurationSave.${publicationMessage($publicationRecovery.publication, $publicationRecovery.fresh)}`);
        toast.show(message, 'warning');
      }
      const translated = accountError(error);
      operationNotice = {key:accepted ? 'pluginActivation.acceptedError' : 'pluginActivation.operationError',errorKey:translated.key};
      operationDetail = translated.detail;
      await refreshServerState();
    } finally { processing = processing.filter(name => name !== plugin.name); }
  }

  onMount(async () => {
    await refreshPlugins();
  });

  // ---- Derived state ------------------------------------------------
  const total = $derived($pluginList.length);
  const enabledCount = $derived($pluginList.filter((p) => p.enabled).length);
  const disabledCount = $derived(total - enabledCount);

  /** Derive capability tags from a plugin's manifest contributes. */
  function capabilitiesOf(plugin: Plugin): Array<'config' | 'widget' | 'page' | 'middleware'> {
    const c = plugin.metadata?.contributes;
    const caps = new Set<'config' | 'widget' | 'page' | 'middleware'>();
    if (c?.settings) caps.add('config');
    if (c?.widgets?.length || c?.nativeWidgets?.length) caps.add('widget');
    if (c?.navigation?.length) caps.add('page');
    if (caps.size === 0) caps.add('middleware'); // hook-only plugins
    return Array.from(caps);
  }

  // Only enabled plugins expose their settings and contributed pages.
  function getPluginActions(
    plugin: Plugin
  ): Array<{ kind: 'config' | 'page'; label: string; href: string }> {
    if (!plugin.enabled) return [];
    const c = plugin.metadata?.contributes;
    const actions: Array<{ kind: 'config' | 'page'; label: string; href: string }> = [];

    // Page action (rare; first nav contribution wins)
    const navItems = c?.navigation ?? [];
    const firstNavPath = navItems[0]?.path;
    if (firstNavPath) {
      actions.push({
        kind: 'page',
        label: $_('plugins.capability.page'),
        href: `/#/extensions/${plugin.name}${firstNavPath}`,
      });
    }

    // Config action — preferred CTA; pushed last so it ends up primary
    const settingsPath = c?.settings || plugin.metadata?.ui?.settings;
    if (settingsPath) {
      actions.push({
        kind: 'config',
        label: $_('plugins.settings'),
        href: `/#/plugins/${plugin.name}${settingsPath}`,
      });
    }

    return actions;
  }

  const filterOptions = $derived($isLoading ? [] : [
    { value: 'all',      label: $_('plugins.filter.all')      + ` (${total})` },
    { value: 'enabled',  label: $_('plugins.filter.enabled')  + ` (${enabledCount})` },
    { value: 'disabled', label: $_('plugins.filter.disabled') + ` (${disabledCount})` },
  ]);

  const filteredPlugins = $derived($isLoading ? [] : $pluginList.filter((p) => {
    if (filterState === 'enabled' && !p.enabled) return false;
    if (filterState === 'disabled' && p.enabled) return false;
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    const displayName = (getPluginText(p.metadata?.name, p.name, $_) || p.name).toLowerCase();
    const desc = (getPluginText(p.metadata?.description, p.name, $_) || '').toLowerCase();
    return p.name.toLowerCase().includes(q) || displayName.includes(q) || desc.includes(q);
  }));
</script>

<div class="nx-page py-5 space-y-5" data-testid="page-plugins">
  <!-- ===== Page header ============================================ -->
  <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
    <div class="flex items-center gap-3">
      <span class="nx-stripe" aria-hidden="true"></span>
      <div class="flex flex-col leading-tight">
        <span class="nx-label">// {$_('plugins.subtitle')}</span>
        <h1 class="nx-display text-xl text-zinc-50 tracking-[0.02em]">
          {$_('plugins.title')}
        </h1>
      </div>
    </div>
    <button
      class="nx-btn-ghost"
      onclick={refreshServerState}
      disabled={$pluginsLoading}
      title={$_('plugins.refreshHint')}
    >
      <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
      {$_('common.refresh')}
    </button>
  </div>

  {#if selected}<PluginActivationDialog plugin={selected.plugin} enabled={selected.enabled} dependencies={dependencyNames} onclose={() => { selected = null; }} oncomplete={async () => { await refreshServerState(); }} />{/if}
  {#if operationNotice}<PanelCard title={$_('pluginActivation.operationTitle')} tag="STATUS"><p role="status" class="text-sm text-zinc-300">{noticeText()}</p>{#if operationDetail}<details class="text-sm text-zinc-400"><summary>{$_('pluginActivation.technicalDetails')}</summary><pre class="whitespace-pre-wrap break-all">{operationDetail}</pre></details>{/if}</PanelCard>{/if}
  <!-- ===== KPI strip (kept bracketed — these are the page's headline metrics) -->
  <section class="grid grid-cols-3 gap-3">
    <KpiCard label={$_('plugins.title')} value={total} unit="TOTAL">
      <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-zinc-500" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
      </svg>
    </KpiCard>
    <KpiCard label={$_('plugins.enabled')} value={enabledCount} unit="ACTIVE" tone="ok">
      <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-emerald-400" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    </KpiCard>
    <KpiCard
      label={$_('plugins.disabled')}
      value={disabledCount}
      unit="DISABLED"
      stripe={disabledCount > 0 ? 'zinc' : 'orange'}
    >
      <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-zinc-500" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636m12.728 12.728L5.636 5.636" />
      </svg>
    </KpiCard>
  </section>

  <!-- ===== Filter / search bar =================================== -->
  <PanelCard title={$_('routes.filters.label')} tag="FILTER" flush>
    <div class="px-4 py-3 flex flex-col gap-3 md:flex-row md:items-end">
      <label class="block flex-1">
        <span class="nx-field-label block mb-1.5">{$_('plugins.searchPlaceholder')}</span>
        <div class="relative">
          <svg class="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            class="nx-input pl-9"
            bind:value={searchQuery}
            placeholder={$_('plugins.searchPlaceholder')}
            data-testid="plugin-search-input"
          />
        </div>
      </label>
      <div>
        <span class="nx-field-label block mb-1.5">{$_('plugins.filter.all')}</span>
        <SegmentedControl
          options={filterOptions}
          bind:value={filterState}
          ariaLabel={$_('plugins.filter.all')}
        />
      </div>
    </div>
  </PanelCard>

  <!-- ===== Plugin list ============================================ -->
  {#if $pluginsLoading}
    <PanelCard title={$_('plugins.title')} tag="LOADING">
      <LoadingIndicator label="LOADING PLUGINS" />
    </PanelCard>
  {:else if $pluginList.length === 0}
    <PanelCard title={$_('plugins.noPlugins')} tag="EMPTY" stripe="zinc">
      <div class="py-10 text-center space-y-2">
        <p class="text-sm text-zinc-400 max-w-md mx-auto">
          {$_('plugins.noPluginsDesc')}
        </p>
      </div>
    </PanelCard>
  {:else if filteredPlugins.length === 0}
    <PanelCard title={$_('plugins.noMatch')} tag="NO MATCH" stripe="amber">
      <div class="py-8 text-center space-y-3">
        <p class="text-sm text-zinc-400">{$_('plugins.noMatchMessage')}</p>
        <button class="nx-btn-ghost" onclick={() => { searchQuery = ''; filterState = 'all'; }}>
          {$_('routes.filters.label')} ✕
        </button>
      </div>
    </PanelCard>
  {:else}
    <!--
      Plugin grid — each card has `corners={false}` because in a list of
      ≥4 peer items the corner brackets stop signalling focus and become
      visual noise (see INDUSTRIAL_DESIGN_SYSTEM §3.2.1).
    -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {#each filteredPlugins as plugin (plugin.name)}
        {@const caps = capabilitiesOf(plugin)}
        {@const blockedReason = activationBlockedReason(plugin, pluginDisplayName, $_)}
        {@const dependencies = Object.keys(plugin.dependencies ?? {})}
        {@const actions = getPluginActions(plugin)}
        {@const displayName = getPluginText(plugin.metadata?.name, plugin.name, $_) || plugin.name}
        {@const description = getPluginText(plugin.metadata?.description, plugin.name, $_)}
        {@const versionLabel = plugin.version && plugin.version !== 'unknown' ? `v${plugin.version}` : $_('plugins.unversioned')}

        <PanelCard
          title={displayName}
          tag={versionLabel}
          stripe={plugin.enabled ? 'orange' : 'zinc'}
          corners={false}
          scrollable
          class="plugin-management-card h-full"
        >
          <div class="flex h-full flex-col gap-3" data-testid={plugin.name === 'token-stats' ? 'plugin-card-token-stats' : 'plugin-card'}>
            <!-- Icon + capability tags -->
            <div class="flex shrink-0 items-start gap-3">
              <span class="flex h-10 w-10 items-center justify-center border border-carbon-500 bg-carbon-950 {plugin.enabled ? 'text-nexus-400' : 'text-zinc-500'} shrink-0">
                <PluginIcon icon={plugin.metadata?.icon} fallback={plugin.name} />
              </span>
              <div class="flex flex-wrap gap-1.5 pt-1">
                {#each caps as cap}
                  <span class="nx-feature-tag">{$_(`plugins.capability.${cap}`)}</span>
                {/each}
              </div>
            </div>

            {#if processing.includes(plugin.name)}<p role="status" class="text-sm text-zinc-300">{$_('pluginActivation.publishing')}</p>{/if}
            <!-- The description fills the remaining card body. -->
            {#if description}
              <p
                class="text-xs text-zinc-400 min-h-[40px] flex-1 line-clamp-2"
              >
                {description}
              </p>
            {:else}
              <p class="text-xs text-zinc-600 italic min-h-[40px] flex-1">
                {$_('plugins.noDescription')}
              </p>
            {/if}

            <div class="plugin-card-actions flex h-[45px] shrink-0 items-center justify-between pt-3 border-t border-carbon-600">
              <div class="flex items-center gap-2">
                {#snippet toggle()}
                {#key `${plugin.enabled}:${processing.includes(plugin.name)}:${selected?.plugin.name ?? ''}`}
                  <BSwitch
                    size="default"
                    checked={plugin.enabled}
                    disabled={processing.includes(plugin.name) || !!activationBlockedReason(plugin, pluginDisplayName, $_) || !!selected}
                    onchange={(newChecked) => requestToggle(plugin, newChecked)}
                    description={plugin.enabled ? $_('plugins.disable') : $_('plugins.enable')}
                  />
                {/key}
                {/snippet}
                {#if blockedReason || dependencies.length}
                  <Tooltip.Root openDelay={200} closeOnEscape>
                    <Tooltip.Trigger asChild let:builder>
                      <!-- A disabled switch cannot receive focus; its wrapper exposes the explanation. -->
                      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                      <span {...builder} use:builder.action role="group" tabindex={blockedReason ? 0 : -1} aria-label={$_('pluginActivation.dependencyLabel', {values:{name:displayName}})} class="inline-flex outline-none focus-visible:ring-2 focus-visible:ring-nexus-500">
                        {@render toggle()}
                      </span>
                    </Tooltip.Trigger>
                    <Tooltip.Content class="max-w-xs break-words" side="top">
                      <div class="space-y-2">
                        {#if blockedReason}<p>{blockedReason}</p>{/if}
                        {#if dependencies.length}
                          <p class="font-semibold">{$_('pluginActivation.dependencyTitle')}</p>
                          <ul class="list-disc pl-4">{#each dependencies as dependency}<li>{pluginDisplayName(dependency)}</li>{/each}</ul>
                          <p>{$_('pluginActivation.dependencyHelp')}</p>
                        {/if}
                      </div>
                    </Tooltip.Content>
                  </Tooltip.Root>
                {:else}{@render toggle()}{/if}
                <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
                  {$_('plugins.enabledState')}
                </span>
              </div>

              {#if actions.length > 0}
                <div class="flex items-center gap-1">
                  {#each actions as action, i (action.kind)}
                    {@const isPrimary = i === actions.length - 1}
                    <a
                      href={action.href}
                      class={isPrimary ? 'nx-btn-primary nx-btn-sm' : 'nx-btn-ghost nx-btn-sm'}
                    >
                      {#if action.kind === 'config'}
                        <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                          <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                      {:else if action.kind === 'page'}
                        <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="1.8">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      {/if}
                      {action.label}
                    </a>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        </PanelCard>
      {/each}
    </div>

    <!-- Footer hint — where to install new plugins -->
    <SystemAlertBar
      tone="info"
      title={$_('plugins.installHint.title')}
      subtitle={$_('plugins.installHint.subtitle')}
    />
  {/if}
</div>

<style>
  :global(.plugin-management-card > header) {
    height: 44px;
    min-height: 44px;
  }
</style>
