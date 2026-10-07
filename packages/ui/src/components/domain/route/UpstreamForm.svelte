<script lang="ts">
  import type { Upstream } from '$api/routes';
  import { hasInvalidManagedBinding } from '$api/config-adapters';
  import DirectionalModificationEditor from './DirectionalModificationEditor.svelte';
  import PluginEditor from '$components/domain/plugin/PluginEditor.svelte';
  import UpstreamSourcePicker from './UpstreamSourcePicker.svelte';
  import { _ } from '$i18n';
  import { Input } from '$components/ui/input';
  import { BCheckbox, IconButton, PanelCard } from '$components/industrial';

  let { upstream = $bindable(), index, onRemove, onDuplicate, showHeader = true, isService = false }: {
    upstream: Upstream; index: number; onRemove: () => void; onDuplicate: () => void; showHeader?: boolean; isService?: boolean;
  } = $props();
  let accountLabel = $state<string | null>(null);

  let invalidManagedBinding = $derived(upstream ? hasInvalidManagedBinding(upstream) : false);
  let managedBinding = $derived(upstream?.plugins?.find(binding => typeof binding !== 'string'
    && binding._uid === upstream.managedBy?.bindingId && binding.name === upstream.managedBy?.plugin));
  let accountRef = $derived(typeof managedBinding === 'object' && typeof managedBinding.options?.accountRef === 'string'
    ? managedBinding.options.accountRef : null);

  // Initialize defaults once on mount, not reactively
  // (reactive read+write on same object causes effect_update_depth_exceeded)
  import { onMount } from 'svelte';
  onMount(() => {
    if (upstream) {
      if (!upstream.plugins && !upstream.managedBy) upstream.plugins = [];
    }
  });

</script>

{#if upstream}
<div class={showHeader ? 'nx-panel-raised' : ''} data-testid="upstream-form">
  {#if showHeader}
    <header class="nx-panel-head">
      <div class="nx-panel-head-title">
        <span class="nx-stripe" aria-hidden="true"></span>
        <span>{$_('upstream.title', { values: { index: index + 1 } })}</span>
      </div>
      <div class="flex items-center gap-1">
        <IconButton size="sm" title={$_('routeCard.duplicate')} on:click={onDuplicate}>
          <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </IconButton>
        <IconButton size="sm" variant="danger" title={$_('upstream.remove')} on:click={onRemove}>
          <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </IconButton>
      </div>
    </header>
  {/if}

  <div class={`${showHeader ? 'nx-panel-body ' : ''}grid grid-cols-1 gap-4`}>
    <UpstreamSourcePicker bind:upstream onresolve={label => accountLabel = label} />
    {#if upstream.managedBy}
      <PanelCard title={$_('upstream.managedTitle')} tag="PLUGIN">
        <dl class="space-y-2 text-sm min-w-0">
          <div><dt class="nx-label">{$_('upstream.managedSource')}</dt><dd class="font-mono break-all text-nexus-300">{upstream.managedBy.plugin} / {upstream.managedBy.contributionId}</dd></div>
          <div><dt class="nx-label">{$_('upstream.sourceAccount')}</dt><dd class="font-mono break-all text-zinc-200">{accountLabel ?? accountRef ?? $_('upstream.managedAccountUnknown')}</dd></div>
          {#if accountLabel}<div class="font-mono text-xs text-zinc-400 break-all">accountRef: {accountRef}</div>{/if}
        </dl>
        <p class="mt-3 text-xs text-zinc-400">{$_('upstream.managedHelp')}</p>
        {#if invalidManagedBinding}
          <p role="alert" class="mt-3 border-l-2 border-red-500 bg-red-500/5 p-3 text-sm text-red-300">{$_('upstream.managedInvalid')}</p>
        {/if}
      </PanelCard>
    {/if}
    <!-- Target URL -->
    <label class="block space-y-1.5">
      <span class="nx-label">// {$_('upstream.targetUrl')} *</span>
      <Input
        type="url"
        placeholder={$_('upstream.targetPlaceholder')}
        bind:value={upstream.target}
        readonly={!!upstream.managedBy}
        required={true}
        data-testid={isService ? "service-endpoint-url-input" : "route-upstream-url-input"}
      />
    </label>

    <!-- Description -->
    <label class="block space-y-1.5">
      <span class="nx-label">// {$_('upstream.description')}</span>
      <Input
        type="text"
        value={upstream.description ?? ''}
        oninput={(e) => { upstream.description = (e.target as HTMLInputElement).value; }}
        placeholder={$_('upstream.descriptionPlaceholder')}
      />
      <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">{$_('upstream.descriptionHelp')}</span>
    </label>

    <!-- Condition -->
    <div class="space-y-1.5">
      <label class="block space-y-1.5">
        <span class="nx-label">// {$_('upstream.condition')}</span>
        <Input
          type="text"
          placeholder={$_('upstream.conditionPlaceholder')}
          value={upstream.condition ?? ''}
          oninput={(e) => {
            const condition = (e.target as HTMLInputElement).value;
            if (condition.trim()) upstream.condition = condition;
            else delete upstream.condition;
          }}
          data-testid="upstream-condition-input"
        />
      </label>
      <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">{$_('upstream.conditionHelp')}</span>
    </div>

    <!-- Disabled toggle -->
    <div class="space-y-1.5">
      <BCheckbox
        checked={!!upstream.is_disabled}
        onchange={(v) => { upstream.is_disabled = v; }}
        label={$_('upstream.disabled')}
        description={$_('upstream.disabledHelp')}
      />
    </div>

    <!-- Weight and Priority -->
    <div class="grid grid-cols-2 gap-3">
      <div class="space-y-1.5">
        <label class="block space-y-1.5">
          <span class="nx-label">// {$_('upstream.weight')}</span>
          <Input
            type="number"
            placeholder="100"
            min={1}
            bind:value={upstream.weight}
            data-testid={isService ? undefined : "route-upstream-weight-input"}
          />
        </label>
        <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">{$_('upstream.weightHelp')}</span>
      </div>
      <div class="space-y-1.5">
        <label class="block space-y-1.5">
          <span class="nx-label">// {$_('upstream.priority')}</span>
          <Input
            type="number"
            placeholder="1"
            min={0}
            bind:value={upstream.priority}
            data-testid={isService ? undefined : "route-upstream-priority-input"}
          />
        </label>
        <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">{$_('upstream.priorityHelp')}</span>
      </div>
    </div>

    <!-- Plugins -->
    <div class="space-y-2">
      <span class="nx-label">// {$_('upstream.upstreamPlugins')}</span>
      <p class="font-mono text-[10px] uppercase tracking-command text-zinc-500">{$_('upstream.upstreamPluginsHelp')}</p>
      {#if !invalidManagedBinding}
        <PluginEditor bind:plugins={upstream.plugins} label="" scope="upstream" protectedBindingIds={upstream.managedBy ? [upstream.managedBy.bindingId] : []} />
      {/if}
    </div>

    <DirectionalModificationEditor bind:policy={upstream} />
  </div>
</div>
{/if}
