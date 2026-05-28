<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { PluginsAPI, type PluginSchema } from '../api/plugins';
  import DynamicPluginForm from './DynamicPluginForm.svelte';
  import PluginConfigDisplay from './PluginConfigDisplay.svelte';
  import { _ } from '../i18n';
  import type { PluginConfig } from '../api/routes';
  import { isVirtualField } from '../utils/field-transform';
  import { getPluginText } from '../utils/plugin-i18n';

  export let plugins: Array<PluginConfig | string> = [];
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

  // 加载可用插件及其 schema（✅ 只显示已启用的插件）
  onMount(async () => {
    try {
      const schemas = await PluginsAPI.getEnabledSchemas();
      availablePlugins = Object.values(schemas);

      // 如果没有已启用的插件，显示提示信息
      if (availablePlugins.length === 0) {
        console.warn('No enabled plugins available. Please enable plugins in Plugin Management first.');
      }
    } catch (error) {
      console.error('Failed to load plugin schemas:', error);
    }
  });

  function handleAddPlugin() {
    showAddDialog = true;
    selectedPluginName = null;
    pluginConfig = {};
    configErrors = {};
    editingPluginIndex = null;
  }

  function handleEditPlugin(index: number) {
    showAddDialog = true;
    editingPluginIndex = index;
    const plugin = plugins[index];

    // 处理字符串和对象两种格式
    if (typeof plugin === 'string') {
      selectedPluginName = plugin;
      pluginConfig = {};
    } else {
      selectedPluginName = plugin.name;
      pluginConfig = { ...(plugin.options || {}) };
    }

    configErrors = {};
  }

  function handleRemovePlugin(index: number) {
    plugins = plugins.filter((_, i) => i !== index);
    dispatch('change', plugins);
  }

  function handlePluginSelect(event: Event) {
    const target = event.target as HTMLSelectElement;
    selectedPluginName = target.value;
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
    // 验证是否选择了插件
    if (!selectedPluginName) return;

    // 验证配置
    const plugin = availablePlugins.find(p => p.name === selectedPluginName);
    if (plugin && plugin.configSchema.length > 0) {
      // 检查必填字段
      const requiredFields = plugin.configSchema.filter((f: any) => f.required);
      for (const field of requiredFields) {
        // 🔑 虚拟字段：验证其对应的实际字段
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
        // 普通字段：直接验证
        else if (!pluginConfig[field.name]) {
          configErrors = {
            ...configErrors,
            [field.name]: `${field.label} is required`
          };
          return;
        }
      }
    }

    // 如果有错误，不保存
    if (Object.keys(configErrors).length > 0) {
      return;
    }

    // 构建插件配置对象
    const newPlugin: any = { name: selectedPluginName };
    if (Object.keys(pluginConfig).length > 0) {
      newPlugin.options = pluginConfig;
    }

    if (editingPluginIndex !== null) {
      // 编辑模式
      plugins = plugins.map((p, i) => i === editingPluginIndex ? newPlugin : p);
    } else {
      // 新增模式
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
          <span class="nx-label">// {label}</span>
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
      <button
        type="button"
        class="nx-btn-outline nx-btn-sm"
        on:click={handleAddPlugin}
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
        {$_('plugin.addPlugin')}
      </button>
    </div>
  </div>

  {#if scope}
    <div class="border border-carbon-600 bg-carbon-950/50 px-3 py-2">
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div>
          <span class="nx-label-sm block mb-1">Scope</span>
          <p class="font-mono text-[11px] uppercase tracking-command text-nexus-300">{scope}</p>
        </div>
        <div class="sm:col-span-2 min-w-0">
          <span class="nx-label-sm block mb-1">Execution Boundary</span>
          <p class="font-mono text-[11px] uppercase tracking-command text-zinc-300 truncate">{scopeName || 'CURRENT CONFIGURATION'}</p>
        </div>
      </div>
    </div>
  {/if}

  <!-- 已添加的插件列表 -->
  {#if plugins.length > 0}
    <div class="space-y-2">
      {#each plugins as plugin, index}
        {@const pluginName = typeof plugin === 'string' ? plugin : plugin.name}
        {@const pluginOptions = typeof plugin === 'string' ? null : plugin.options}
        {@const pluginMeta = availablePlugins.find(p => p.name === pluginName)}
        <div class="card bg-carbon-950/60 shadow-sm">
          <div class="card-body p-3">
            <div class="flex items-start justify-between gap-3">
              <div class="flex-1 min-w-0">
                <h4 class="font-semibold text-sm mb-1">{pluginMeta?.metadata?.name ? getPluginText(pluginMeta.metadata.name, pluginName, $_) : pluginName}</h4>
                {#if pluginOptions && Object.keys(pluginOptions).length > 0 && pluginMeta}
                  <PluginConfigDisplay
                    schema={pluginMeta.configSchema || []}
                    config={pluginOptions}
                  />
                {/if}
              </div>
              <div class="flex gap-1 flex-shrink-0">
                <button
                  type="button"
                  class="btn btn-xs btn-ghost"
                  on:click={() => handleEditPlugin(index)}
                >
                  {$_('common.edit')}
                </button>
                <button
                  type="button"
                  class="btn btn-xs btn-ghost text-error"
                  on:click={() => handleRemovePlugin(index)}
                >
                  {$_('plugin.removePlugin')}
                </button>
              </div>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="alert alert-info py-2">
      <span class="text-sm">{$_('plugin.noPluginsConfigured')}</span>
    </div>
  {/if}
</div>

<!-- 添加/编辑插件对话框 -->
{#if showAddDialog}
  <div class="modal modal-open">
    <div class="modal-box max-w-2xl">
      <h3 class="font-bold text-lg mb-4">
        {editingPluginIndex !== null ? $_('plugin.editPlugin') : $_('plugin.addPlugin')}
      </h3>

      <!-- 插件选择 -->
      <div class="form-control mb-4">
        <label class="label" for="plugin-select">
          <span class="label-text font-semibold">{$_('plugin.selectPlugin')}</span>
        </label>
        <select
          id="plugin-select"
          class="nx-input pr-7"
          value={selectedPluginName || ''}
          on:change={handlePluginSelect}
          disabled={editingPluginIndex !== null || availablePlugins.length === 0}
        >
          <option value="">
            {availablePlugins.length === 0 ? $_('plugin.noEnabledPlugins') + '...' : $_('plugin.selectPluginPrompt')}
          </option>
          {#each availablePlugins as p}
            <option value={p.name}>
              {getPluginText(p.metadata?.name ?? p.name, p.name, $_)} {p.version ? `(v${p.version})` : ''}
            </option>
          {/each}
        </select>
        {#if availablePlugins.length === 0}
          <div class="label">
            <span class="label-text-alt text-warning">
              ⚠️  {$_('plugin.noEnabledPlugins')}
              <a href="#/plugins" class="link link-primary">{$_('nav.plugins')}</a>
            </span>
          </div>
        {:else if selectedPluginName}
          {@const plugin = availablePlugins.find(p => p.name === selectedPluginName)}
          {#if plugin?.description}
            <div class="label">
              <span class="label-text-alt text-zinc-500">{getPluginText(plugin.description, plugin.name, $_)}</span>
            </div>
          {/if}
        {/if}
      </div>

      <!-- 动态配置表单 -->
      {#if selectedPluginName && selectedPluginSchema.length > 0}
        <div class="border-t border-carbon-600 my-2 my-2">{$_('plugin.pluginConfiguration')}</div>
        <DynamicPluginForm
          pluginName={selectedPluginName || ''}
          schema={selectedPluginSchema}
          bind:value={pluginConfig}
          bind:errors={configErrors}
          on:change={handleConfigChange}
          on:validate={handleConfigValidate}
        />
      {:else if selectedPluginName}
        <div class="alert alert-info py-2 mt-4">
          <span class="text-sm">{$_('plugin.noConfigurationRequired')}</span>
        </div>
      {/if}

      <!-- 操作按钮 -->
      <div class="modal-action">
        <button
          type="button"
          class="btn btn-ghost"
          on:click={handleCancelDialog}
        >
          {$_('common.cancel')}
        </button>
        <button
          type="button"
          class="btn btn-primary"
          disabled={!selectedPluginName || Object.keys(configErrors).length > 0}
          on:click={handleSavePlugin}
        >
          {editingPluginIndex !== null ? $_('plugin.update') : $_('common.add')}
        </button>
      </div>
    </div>
  </div>
{/if}
