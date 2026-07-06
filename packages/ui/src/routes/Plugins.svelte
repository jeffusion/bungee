<script lang="ts" context="module">
  // Module-scope state — survives component instance re-render. Svelte 4
  // component re-renders re-execute the instance body, which would
  // re-initialize any `let`/`const` declared there. Putting the
  // processing set on module scope guarantees it persists across the
  // ticks we use to force reactivity for `<BSwitch disabled>`.
  const processingState = { names: new Set<string>() };
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { _ } from '$i18n';
  import { PluginsAPI, type Plugin } from '$api/plugins';
  import { toast } from '$stores/toast';
  import { pluginList, pluginsLoading, refreshPlugins, updatePluginState } from '$stores/plugins';
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

  // Per-plugin processing set — only the toggle currently in flight is
  // disabled, so concurrent toggles on different plugins can proceed.
  // Earlier we used a single global `processing` boolean, which let one
  // toggle's `finally` unblock ALL toggles (including ones whose API call
  // was still in flight), causing cascading mis/dis/en-ablement under
  // rapid clicks.
  //
  // We keep the set on a stable module-scope holding object and mutate
  // only its `.names` property — never reassign the `let` to a new Set.
  // To still force Svelte to re-evaluate `<BSwitch disabled>` we bump
  // `processingTick`, which IS a component-instance `let`. Reassigning
  // a `let` to a primitive triggers the Svelte reactivity pass without
  // touching the persistent processing set.
  let processingTick = 0;

  // ---- Search + filter state ----------------------------------------
  let searchQuery = '';
  let filterState: 'all' | 'enabled' | 'disabled' = 'all';

  async function togglePlugin(plugin: Plugin, newStatus: boolean) {
    // Re-entry guard: if this plugin is mid-toggle, ignore further clicks.
    // Without this, a user can stack N concurrent enables/disables on the
    // same plugin and the store becomes indeterminate vs. server state.
    if (processingState.names.has(plugin.name)) {
      return;
    }
    processingState.names.add(plugin.name);
    processingTick = processingTick + 1;

    // Optimistic UI: reflect new state immediately so the user sees the
    // toggle flip without waiting for the server. If the API call fails
    // we roll back via full refresh (server is the source of truth).
    updatePluginState(plugin.name, newStatus);

    try {
      if (newStatus) {
        await PluginsAPI.enable(plugin.name);
      } else {
        await PluginsAPI.disable(plugin.name);
      }
      const pluginDisplayName = getPluginText(plugin.metadata?.name, plugin.name, $_) || plugin.name;
      const statusText = newStatus ? $_('plugins.enabled') : $_('plugins.disabled');
      toast.show(`${pluginDisplayName}: ${statusText}`, 'success');
    } catch (e: any) {
      toast.show($_('common.error') + ': ' + e.message, 'error');
      // Roll back to server truth on failure.
      await refreshPlugins();
    } finally {
      processingState.names.delete(plugin.name);
      processingTick = processingTick + 1;
    }
  }

  onMount(() => {
    refreshPlugins();
  });

  // ---- Derived state ------------------------------------------------
  $: total = $pluginList.length;
  $: enabledCount = $pluginList.filter((p) => p.enabled).length;
  $: disabledCount = total - enabledCount;

  /** Derive capability tags from a plugin's manifest contributes. */
  function capabilitiesOf(plugin: Plugin): Array<'config' | 'widget' | 'page' | 'middleware'> {
    const c = plugin.metadata?.contributes;
    const caps = new Set<'config' | 'widget' | 'page' | 'middleware'>();
    if (c?.settings) caps.add('config');
    if (c?.widgets?.length || c?.nativeWidgets?.length) caps.add('widget');
    if (c?.navigation?.length || plugin.metadata?.menus?.length) caps.add('page');
    if (caps.size === 0) caps.add('middleware'); // hook-only plugins
    return Array.from(caps);
  }

  /**
   * Compute the concrete action buttons a plugin's card should expose.
   *
   * Earlier we rendered a one-size-fits-all "详情" button that linked to
   * `/plugins/{name}`. For every plugin without `contributes.settings`
   * the PluginDetailLayout has nothing to redirect to — the user ended
   * up on an empty 500px panel. Only `model-mapping` had actual content
   * to show; the other seven plugins were dead-ends.
   *
   * Rule now:
   *   - `contributes.settings`           → show 「配置」 → settings tab
   *   - `contributes.widgets|nativeWidgets` → show 「看板」 → /#/ dashboard
   *   - `contributes.navigation|menus`   → show 「页面」 → first nav path
   *   - none of the above (hooks-only)   → no action buttons; the toggle
   *                                         is the only management surface
   *
   * Returned in declaration order so the most "configurable" action
   * appears first; the last entry is treated as the primary CTA.
   */
  function getPluginActions(
    plugin: Plugin
  ): Array<{ kind: 'config' | 'widget' | 'page'; label: string; href: string; title?: string }> {
    const c = plugin.metadata?.contributes;
    const actions: Array<{ kind: 'config' | 'widget' | 'page'; label: string; href: string; title?: string }> = [];

    // Page action (rare; first nav contribution wins)
    const navItems = c?.navigation ?? [];
    const menuItems = plugin.metadata?.menus ?? [];
    const firstNavPath = navItems[0]?.path ?? menuItems[0]?.path;
    if (firstNavPath) {
      actions.push({
        kind: 'page',
        label: $_('plugins.capability.page'),
        href: `/__ui/#/extensions/${plugin.name}${firstNavPath}`,
      });
    }

    // Widget action — anchor to the dashboard (no per-widget deep-link yet)
    if (c?.widgets?.length || c?.nativeWidgets?.length) {
      actions.push({
        kind: 'widget',
        label: $_('plugins.capability.widget'),
        href: '/__ui/#/',
        title: $_('plugins.capability.widget'),
      });
    }

    // Config action — preferred CTA; pushed last so it ends up primary
    const settingsPath = c?.settings || plugin.metadata?.ui?.settings;
    if (settingsPath) {
      actions.push({
        kind: 'config',
        label: $_('plugins.settings'),
        href: `/__ui/#/plugins/${plugin.name}${settingsPath}`,
      });
    }

    return actions;
  }

  $: filterOptions = [
    { value: 'all',      label: $_('plugins.filter.all')      + ` (${total})` },
    { value: 'enabled',  label: $_('plugins.filter.enabled')  + ` (${enabledCount})` },
    { value: 'disabled', label: $_('plugins.filter.disabled') + ` (${disabledCount})` },
  ];

  $: filteredPlugins = $pluginList.filter((p) => {
    if (filterState === 'enabled' && !p.enabled) return false;
    if (filterState === 'disabled' && p.enabled) return false;
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    const displayName = (getPluginText(p.metadata?.name, p.name, $_) || p.name).toLowerCase();
    const desc = (getPluginText(p.metadata?.description, p.name, $_) || '').toLowerCase();
    return p.name.toLowerCase().includes(q) || displayName.includes(q) || desc.includes(q);
  });
</script>

<div class="px-6 py-5 space-y-5" data-testid="page-plugins">
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
      on:click={() => refreshPlugins()}
      disabled={$pluginsLoading}
      title={$_('plugins.refreshHint')}
    >
      <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
      {$_('common.refresh')}
    </button>
  </div>

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
        <span class="nx-label block mb-1.5">// {$_('plugins.searchPlaceholder')}</span>
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
        <span class="nx-label block mb-1.5">// {$_('plugins.filter.all')}</span>
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
        <button class="nx-btn-ghost" on:click={() => { searchQuery = ''; filterState = 'all'; }}>
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
        {@const actions = getPluginActions(plugin)}
        {@const displayName = getPluginText(plugin.metadata?.name, plugin.name, $_) || plugin.name}
        {@const description = getPluginText(plugin.metadata?.description, plugin.name, $_)}
        {@const versionLabel = plugin.version && plugin.version !== 'unknown' ? `v${plugin.version}` : $_('plugins.unversioned')}

        <PanelCard
          title={displayName}
          tag={versionLabel}
          stripe={plugin.enabled ? 'orange' : 'zinc'}
          corners={false}
        >
          <div class="flex flex-col gap-3" data-testid={plugin.name === 'token-stats' ? 'plugin-card-token-stats' : 'plugin-card'}>
            <!-- Icon + capability tags -->
            <div class="flex items-start gap-3">
              <span class="flex h-10 w-10 items-center justify-center border border-carbon-500 bg-carbon-950 {plugin.enabled ? 'text-nexus-400' : 'text-zinc-500'} shrink-0">
                <PluginIcon icon={plugin.metadata?.icon} fallback={plugin.name} />
              </span>
              <div class="flex flex-wrap gap-1.5 pt-1">
                {#each caps as cap}
                  <span class="nx-feature-tag">{$_(`plugins.capability.${cap}`)}</span>
                {/each}
              </div>
            </div>

            <!-- Description (min-h ensures uniform card height) -->
            {#if description}
              <p
                class="text-xs text-zinc-400 min-h-[40px] line-clamp-2"
                title={description}
              >
                {description}
              </p>
            {:else}
              <p class="text-xs text-zinc-600 italic min-h-[40px]">
                {$_('plugins.noDescription')}
              </p>
            {/if}

            <!--
              Toggle + action buttons.
              Actions are only rendered when the plugin is enabled AND
              the manifest declares concrete extension points. Hooks-only
              plugins (5 of 8 in the demo set) intentionally render no
              buttons — the toggle is their only management surface,
              avoiding the dead-end "详情" link this section used to have.
            -->
            <div class="flex items-center justify-between pt-3 border-t border-carbon-600">
              <div class="flex items-center gap-2">
                <BSwitch
                  size="default"
                  checked={plugin.enabled}
                  disabled={processingTick >= 0 && processingState.names.has(plugin.name)}
                  onchange={(newChecked) => togglePlugin(plugin, newChecked)}
                  aria-label={plugin.enabled ? $_('plugins.disable') : $_('plugins.enable')}
                />
                <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
                  {$_('plugins.enabledState')}
                </span>
              </div>

              {#if plugin.enabled && actions.length > 0}
                <div class="flex items-center gap-1">
                  {#each actions as action, i (action.kind)}
                    {@const isPrimary = i === actions.length - 1}
                    <a
                      href={action.href}
                      class={isPrimary ? 'nx-btn-primary nx-btn-sm' : 'nx-btn-ghost nx-btn-sm'}
                      title={action.title || action.label}
                    >
                      {#if action.kind === 'config'}
                        <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                          <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                      {:else if action.kind === 'widget'}
                        <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="1.8">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M3 12h6m-6 4h6m12-8h-6m6 4h-6m-6-8v16M3 6h18a0 0 0 010 0v0a0 0 0 01-0 0H3a0 0 0 01-0-0v0a0 0 0 010-0z" />
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
