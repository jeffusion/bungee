<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { PluginsAPI, type PluginSchema } from '$api/plugins';
  import DynamicPluginForm from './DynamicPluginForm.svelte';
  import PluginConfigDisplay from './PluginConfigDisplay.svelte';
  import { _ } from '$i18n';
  import type { EditorPluginBinding } from '$api/config-adapters';
  import { isVirtualField } from '$utils/field-transform';
  import { getPluginText } from '$utils/plugin-i18n';
  import { Button } from '$components/ui/button';
  import { BSelect } from '$components/industrial';
  import { PanelCard } from '$components/industrial';

  export let plugins: Array<EditorPluginBinding | string> = [];
  export let protectedBindingIds: readonly string[] = [];
  function isProtected(index: number): boolean {
    const binding = plugins[index];
    return typeof binding !== 'string' && !!binding?._uid && protectedBindingIds.includes(binding._uid);
  }
  $: if (!plugins) {
    plugins = [];
  }
  export let label = 'Plugins';
  export let scope: 'global' | 'route' | 'service' | 'upstream' | '' = '';
  export let scopeName = '';

  const dispatch = createEventDispatcher();

  let availablePlugins: PluginSchema[] = [];
  let showAddDialog = false;
  let selectedPluginName: string | null = null;
  let editingPluginIndex: number | null = null;
  let pluginConfig: Record<string, any> = {};
  let configErrors: Record<string, string> = {};

  onMount(async () => {
    try {
      const schemas = await PluginsAPI.getEnabledSchemas();
      availablePlugins = Object.values(schemas);

      if (availablePlugins.length === 0) {
        console.warn('No enabled plugins available. Please enable plugins in Plugin Management first.');
      }
    } catch (error) {
      console.error('Failed to load plugin schemas:', error);
    }
  });

  // Reactive: cache plugin metadata only — do NOT call $_() inside `$:` (migration guard).
  // i18n label is resolved in the template at render time, where $_() is safe.
  $: pluginOptions = availablePlugins.map(p => ({
    value: p.name,
    metaName: p.metadata?.name ?? p.name,
    name: p.name,
    version: p.version,
  }));

  function handleAddPlugin() {
    showAddDialog = true;
    selectedPluginName = null;
    pluginConfig = {};
    configErrors = {};
    editingPluginIndex = null;
  }

  function handleEditPlugin(index: number) {
    if (isProtected(index)) return;
    showAddDialog = true;
    editingPluginIndex = index;
    const plugin = plugins[index];

    if (typeof plugin === 'string') {
      selectedPluginName = plugin;
      pluginConfig = {};
    } else {
      selectedPluginName = plugin.name;
      pluginConfig = JSON.parse(JSON.stringify(plugin.options || {}));
    }

    configErrors = {};
  }

  function handleRemovePlugin(index: number) {
    if (isProtected(index)) return;
    plugins = plugins.filter((_, i) => i !== index);
    dispatch('change', plugins);
  }

  function handlePluginSelect(value: string | string[]) {
    selectedPluginName = (Array.isArray(value) ? value[0] : value) || null;
    pluginConfig = {};
    configErrors = {};
  }

  function handleConfigChange(event: CustomEvent) {
    pluginConfig = event.detail;
  }

  function handleConfigValidate(event: CustomEvent) {
    configErrors = event.detail;
  }

  function handleSavePlugin() {
    if (!selectedPluginName) return;
    if (editingPluginIndex !== null && isProtected(editingPluginIndex)) return;

    const plugin = availablePlugins.find(p => p.name === selectedPluginName);
    if (plugin && plugin.configSchema.length > 0) {
      const requiredFields = plugin.configSchema.filter((f: any) => f.required);
      for (const field of requiredFields) {
        if (isVirtualField(field)) {
          if (field.fieldTransform?.fields) {
            const missingFields = field.fieldTransform.fields.filter(
              (realField: string) => !pluginConfig[realField]
            );
            if (missingFields.length > 0) {
              configErrors = {
                ...configErrors,
                [field.name]: `${field.label} is required`
              };
              return;
            }
          }
        }
        else if (!pluginConfig[field.name]) {
          configErrors = {
            ...configErrors,
            [field.name]: `${field.label} is required`
          };
          return;
        }
      }
    }

    if (Object.keys(configErrors).length > 0) {
      return;
    }

    const existing = editingPluginIndex === null ? undefined : plugins[editingPluginIndex];
    const newPlugin: EditorPluginBinding = {
      ...(typeof existing === 'object' ? existing : {}),
      name: selectedPluginName,
    };
    if (Object.keys(pluginConfig).length > 0) {
      newPlugin.options = { ...(typeof existing === 'object' ? existing.options : {}), ...pluginConfig };
    }
    if (editingPluginIndex !== null) {
      plugins = plugins.map((p, i) => i === editingPluginIndex ? newPlugin : p);
    } else {
      plugins = [...plugins, newPlugin];
    }

    dispatch('change', plugins);
    showAddDialog = false;
  }

  function handleCancelDialog() {
    showAddDialog = false;
    selectedPluginName = null;
    pluginConfig = {};
    configErrors = {};
    editingPluginIndex = null;
  }

  $: selectedPluginSchema = selectedPluginName
    ? availablePlugins.find(p => p.name === selectedPluginName)?.configSchema || []
    : [];
</script>

<div class="space-y-3">
  <div class="flex items-center justify-between">
    <div class="min-w-0">
      {#if label}
        <div class="flex items-center gap-2">
          <span class="font-mono text-[11px] uppercase tracking-command text-zinc-400">// {label}</span>
          {#if scope}
            <span class="border border-nexus-500/40 bg-nexus-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-command text-nexus-300">
              {scope} scope
            </span>
          {/if}
        </div>
      {/if}
      {#if scope && scopeName}
        <p class="mt-1 font-mono text-[10px] uppercase tracking-command text-zinc-500 truncate">
          Applies at {scope} boundary: <span class="text-zinc-300">{scopeName}</span>
        </p>
      {:else if scope}
        <p class="mt-1 font-mono text-[10px] uppercase tracking-command text-zinc-500">
          Applies at {scope} boundary
        </p>
      {/if}
    </div>
    <div class="flex-shrink-0">
      <Button
        variant="outline"
        size="sm"
        onclick={handleAddPlugin}
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
        {$_('plugin.addPlugin')}
      </Button>
    </div>
  </div>

  {#if scope}
    <div class="border border-carbon-600 bg-carbon-950/50 px-3 py-2">
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div>
          <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500 block mb-1">Scope</span>
          <p class="font-mono text-[11px] uppercase tracking-command text-nexus-300">{scope}</p>
        </div>
        <div class="sm:col-span-2 min-w-0">
          <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500 block mb-1">Execution Boundary</span>
          <p class="font-mono text-[11px] uppercase tracking-command text-zinc-300 truncate">{scopeName || 'CURRENT CONFIGURATION'}</p>
        </div>
      </div>
    </div>
  {/if}

  {#if plugins.length > 0}
    <div class="space-y-2">
      {#each plugins as plugin, index}
        {@const pluginName = typeof plugin === 'string' ? plugin : plugin.name}
        {@const pluginOptions = typeof plugin === 'string' ? null : plugin.options}
        {@const pluginMeta = availablePlugins.find(p => p.name === pluginName)}
        <div class="border border-carbon-600 bg-carbon-950/60 p-3 shadow-industrial">
            <div class="flex items-start justify-between gap-3">
              <div class="flex-1 min-w-0">
                <h4 class="font-semibold text-sm mb-1">{pluginMeta?.metadata?.name ? getPluginText(pluginMeta.metadata.name, pluginName, $_) : pluginName}</h4>
                {#if isProtected(index)}
                  <p class="text-xs text-nexus-300">{$_('upstream.managedProtected')}</p>
                {/if}
                {#if !pluginMeta || (typeof plugin !== 'string' && plugin.enabled === false)}
                  <p class="text-xs text-amber-300">{$_('upstream.managedUnavailable')}</p>
                {/if}
                {#if pluginOptions && Object.keys(pluginOptions).length > 0 && pluginMeta}
                  <PluginConfigDisplay
                    schema={pluginMeta.configSchema || []}
                    config={pluginOptions}
                  />
                {/if}
              </div>
              <div class="flex gap-1 flex-shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => handleEditPlugin(index)}
                  disabled={isProtected(index)}
                >
                  {$_('common.edit')}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onclick={() => handleRemovePlugin(index)}
                  disabled={isProtected(index)}
                >
                  {$_('plugin.removePlugin')}
                </Button>
              </div>
            </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="border-l-2 border-l-sky-500 bg-sky-500/5 px-3 py-2 font-mono text-[11px] uppercase tracking-command text-sky-200">
      <span>{$_('plugin.noPluginsConfigured')}</span>
    </div>
  {/if}
</div>

{#if showAddDialog}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-carbon-950/80 p-4" on:click={handleCancelDialog}>
    <div class="w-full max-w-2xl border border-carbon-600 bg-carbon-900 shadow-industrial" on:click|stopPropagation>
      <PanelCard title={editingPluginIndex !== null ? $_('plugin.editPlugin') : $_('plugin.addPlugin')} tag="PLUGIN">
        <div class="space-y-4">
          <label class="block space-y-1.5">
            <span class="font-mono text-[11px] uppercase tracking-command text-zinc-400">// {$_('plugin.selectPlugin')}</span>
            <BSelect
              options={pluginOptions.map(o => ({
                value: o.value,
                label: `${getPluginText(o.metaName, o.name, $_)} ${o.version ? `(v${o.version})` : ''}`
              }))}
              value={selectedPluginName || ''}
              placeholder={availablePlugins.length === 0 ? $_('plugin.noEnabledPlugins') + '...' : $_('plugin.selectPluginPrompt')}
              onchange={handlePluginSelect}
              disabled={editingPluginIndex !== null || availablePlugins.length === 0}
            />
          </label>

          {#if availablePlugins.length === 0}
            <div class="border-l-2 border-l-amber-500 bg-amber-500/5 px-3 py-2 font-mono text-[11px] uppercase tracking-command text-amber-200">
              <span>{$_('plugin.noEnabledPlugins')} <a href="#/plugins" class="text-nexus-300 underline decoration-nexus-500/60 underline-offset-2">{$_('nav.plugins')}</a></span>
            </div>
          {:else if selectedPluginName}
            {@const plugin = availablePlugins.find(p => p.name === selectedPluginName)}
            {#if plugin?.description}
              <p class="text-xs text-zinc-500">{getPluginText(plugin.description, plugin.name, $_)}</p>
            {/if}
          {/if}

          {#if selectedPluginName && selectedPluginSchema.length > 0}
            <div class="border-t border-carbon-600 pt-3">
              <div class="text-sm font-semibold text-zinc-200 mb-3">{$_('plugin.pluginConfiguration')}</div>
              <DynamicPluginForm
                pluginName={selectedPluginName || ''}
                schema={selectedPluginSchema}
                bind:value={pluginConfig}
                bind:errors={configErrors}
                on:change={handleConfigChange}
                on:validate={handleConfigValidate}
              />
            </div>
          {:else if selectedPluginName}
            <div class="border-l-2 border-l-sky-500 bg-sky-500/5 px-3 py-2 font-mono text-[11px] uppercase tracking-command text-sky-200">
              <span>{$_('plugin.noConfigurationRequired')}</span>
            </div>
          {/if}

          <div class="flex justify-end gap-2 border-t border-carbon-600 pt-4">
            <Button variant="ghost" onclick={handleCancelDialog}>
              {$_('common.cancel')}
            </Button>
            <Button
              variant="default"
              disabled={!selectedPluginName || Object.keys(configErrors).length > 0}
              onclick={handleSavePlugin}
              data-testid="plugin-config-save-button"
            >
              {editingPluginIndex !== null ? $_('plugin.update') : $_('common.add')}
            </Button>
          </div>
        </div>
      </PanelCard>
    </div>
  </div>
{/if}
