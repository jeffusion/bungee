<script lang="ts">
  import { location, replace } from 'svelte-spa-router';
  import { _ } from '$i18n';
  import { PluginsAPI, type Plugin } from '$api/plugins';
  import ModelMappingCatalogManager from '$components/domain/model-mapping/ModelMappingCatalogManager.svelte';
  import PluginHost from '$components/shell/PluginHost.svelte';
  import { toast } from '$stores/toast';
  import { getPluginText } from '$utils/plugin-i18n';
  import PluginIcon from '$components/shell/PluginIcon.svelte';
  import { LoadingIndicator, PanelCard, StatusBadge } from '$components/industrial';
  import { generatedWidgetRegistry, componentSourceMap } from '$components/native-widgets/generated';
  import { resolveNativeSettings } from '$components/native-widgets/settings-resolution';

  let { params = { name: '' } }: { params?: { name: string; path?: string } } = $props();

  let plugin = $state<Plugin | null>(null);
  let loading = $state(true);
  let activeTabPath = $state('');
  let settings = $derived(plugin ? resolveNativeSettings(plugin, activeTabPath, generatedWidgetRegistry, componentSourceMap) : null);
  let loadGeneration = 0;

  $effect(() => {
    const fullPath = $location;
    const prefix = `/plugins/${params.name}`;
    let internalPath = fullPath.replace(prefix, '');
    if (internalPath.startsWith('/')) internalPath = internalPath.substring(1);
    activeTabPath = '/' + internalPath;
    if (plugin && (!internalPath || internalPath === '') && !loading) {
      redirectToDefaultTab();
    }
  });

  async function loadPlugin(name: string) {
    const generation = ++loadGeneration;
    loading = true; plugin = null;
    try {
      const plugins = await PluginsAPI.list();
      if (generation !== loadGeneration) return;
      plugin = plugins.find((p) => p.name === name) || null;
      if (!plugin) {
        toast.show(`未找到插件：${name}`, 'error');
      } else {
        const prefix = `/plugins/${name}`;
        const internalPath = $location.replace(prefix, '');
        if (!internalPath || internalPath === '/') redirectToDefaultTab();
      }
    } catch (e: any) {
      if (generation === loadGeneration) toast.show('插件详情加载失败：' + e.message, 'error');
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }

  function redirectToDefaultTab() {
    if (!plugin) return;
    if (plugin.metadata?.contributes?.nativeSettingsComponent !== undefined) return;
    if (plugin.metadata?.contributes?.settings || plugin.metadata?.ui?.settings) {
      const settingsPath = plugin.metadata?.contributes?.settings || plugin.metadata?.ui?.settings;
      replace(`/plugins/${plugin.name}${settingsPath}`);
    }
  }

  $effect(() => {
    void loadPlugin(params.name);
    return () => { loadGeneration++; };
  });
</script>

<div class="nx-page py-5 space-y-4">
  {#if loading}
    <PanelCard title="LOADING PLUGIN" tag="WAIT">
      <LoadingIndicator label="LOADING PLUGIN" height="sm" />
    </PanelCard>
  {:else if !plugin}
    <PanelCard title={$_('plugins.notFound')} tag="404" stripe="red">
      <div class="py-6 text-center">
        <a href="/__ui/#/plugins" class="nx-btn-primary">{$_('plugins.backToPlugins')}</a>
      </div>
    </PanelCard>
  {:else}
    <!-- Plugin header -->
    <div class="flex items-center gap-4">
      <span class="flex h-14 w-14 items-center justify-center border border-carbon-500 bg-carbon-950 text-nexus-400 shrink-0">
        <PluginIcon icon={plugin.metadata?.icon} fallback={plugin.name} sizeClass="h-6 w-6" />
      </span>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-3 flex-wrap">
          <h1 class="nx-display text-xl text-zinc-50 tracking-[0.02em] truncate">
            {getPluginText(plugin.metadata?.name, plugin.name, $_) || plugin.name}
          </h1>
          <span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">
            {plugin.version && plugin.version !== 'unknown' ? `v${plugin.version}` : '— UNVERSIONED'}
          </span>
          {#if plugin.enabled}
            <StatusBadge variant="active" dot>{$_('plugins.enabled')}</StatusBadge>
          {:else}
            <StatusBadge variant="muted">{$_('plugins.disabled')}</StatusBadge>
          {/if}
        </div>
        <p class="text-xs text-zinc-400 mt-1 truncate">
          {getPluginText(plugin.metadata?.description, plugin.name, $_) || $_('plugins.noDescription')}
        </p>
      </div>
    </div>

    <!-- Content panel -->
    {#if settings?.kind === 'native'}
      {@const SettingsComponent = settings.component}
      {#key plugin.name}<SettingsComponent />{/key}
    {:else}
      <PanelCard
        title={plugin.name.toUpperCase()}
        tag={activeTabPath ? activeTabPath.toUpperCase() : 'DETAIL'}
        flush
      >
        {#if settings?.kind === 'error'}
          <p role="alert" class="p-4 text-sm text-red-300">{settings.message}</p>
        {:else if plugin.name === 'model-mapping' && activeTabPath === '/catalog'}
          <ModelMappingCatalogManager />
        {:else if activeTabPath}
          {#key plugin.name}<PluginHost pluginName={plugin.name} path={activeTabPath} height="calc(100dvh - 220px)" />{/key}
        {:else}
          <div class="flex justify-center items-center h-64 font-mono text-[11px] uppercase tracking-command text-zinc-500">
            Select a tab to view content
          </div>
        {/if}
      </PanelCard>
    {/if}
  {/if}
</div>
