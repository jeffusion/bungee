<script lang="ts">
  import type { Upstream } from '$api/routes';
  import { validateUpstreamSync } from '$validation/upstream-validator';
  import HeadersEditor from './HeadersEditor.svelte';
  import BodyEditor from './BodyEditor.svelte';
  import QueryEditor from './QueryEditor.svelte';
  import PluginEditor from '$components/domain/plugin/PluginEditor.svelte';
  import { _ } from '$i18n';
  import { Input } from '$components/ui/input';
  import { BCheckbox, IconButton } from '$components/industrial';

  export let upstream: Upstream;
  export let index: number;
  export let onRemove: () => void;
  export let onDuplicate: () => void;
  export let showHeader: boolean = true;
  export let isService: boolean = false;

  $: errors = upstream ? validateUpstreamSync(upstream, index) : [];

  // Initialize defaults once on mount, not reactively
  // (reactive read+write on same object causes effect_update_depth_exceeded)
  import { onMount } from 'svelte';
  onMount(() => {
    if (upstream) {
      upstream.headers = upstream.headers || { add: {}, remove: [], default: {} };
      upstream.body = upstream.body || { add: {}, remove: [], replace: {}, default: {} };
      upstream.query = upstream.query || { add: {}, remove: [], replace: {}, default: {} };
      if (!upstream.plugins) upstream.plugins = [];
    }
  });

  // Collapsible sub-section state
  let openSection: 'headers' | 'body' | 'query' | null = null;
  function toggleSection(name: 'headers' | 'body' | 'query') {
    openSection = openSection === name ? null : name;
  }
</script>

{#if upstream}
<div class="nx-panel-raised">
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

  <div class="nx-panel-body grid grid-cols-1 gap-4">
    <!-- Target URL -->
    <label class="block space-y-1.5">
      <span class="nx-label">// {$_('upstream.targetUrl')} *</span>
      <Input
        type="url"
        placeholder={$_('upstream.targetPlaceholder')}
        bind:value={upstream.target}
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
          bind:value={upstream.condition}
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
      <PluginEditor bind:plugins={upstream.plugins} label="" />
    </div>

    <!-- Advanced sections separator -->
    <div class="flex items-center gap-3 pt-2">
      <span class="h-px flex-1 bg-carbon-600"></span>
      <span class="nx-label">// {$_('routeEditor.requestModification')}</span>
      <span class="h-px flex-1 bg-carbon-600"></span>
    </div>

    <!-- Collapsible Headers -->
    <div class="border border-carbon-600 bg-carbon-950/60">
      <button
        type="button"
        class="w-full flex items-center justify-between px-3 py-2 font-mono text-[11px] uppercase tracking-command text-zinc-200 hover:text-nexus-300 hover:bg-carbon-700/30 transition-colors"
        on:click={() => toggleSection('headers')}
      >
        <span class="flex items-center gap-2">
          <span class={openSection === 'headers' ? 'nx-stripe' : 'nx-stripe nx-stripe-zinc'} aria-hidden="true"></span>
          {$_('headers.title')}
        </span>
        <svg viewBox="0 0 24 24" class="h-3.5 w-3.5 transition-transform" style:transform={openSection === 'headers' ? 'rotate(180deg)' : ''} fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {#if openSection === 'headers'}
        <div class="border-t border-carbon-600 p-3">
          <HeadersEditor bind:value={upstream.headers} label={$_('headers.title')} showHelp={false} showLabel={false} />
        </div>
      {/if}
    </div>

    <!-- Collapsible Body -->
    <div class="border border-carbon-600 bg-carbon-950/60">
      <button
        type="button"
        class="w-full flex items-center justify-between px-3 py-2 font-mono text-[11px] uppercase tracking-command text-zinc-200 hover:text-nexus-300 hover:bg-carbon-700/30 transition-colors"
        on:click={() => toggleSection('body')}
      >
        <span class="flex items-center gap-2">
          <span class={openSection === 'body' ? 'nx-stripe' : 'nx-stripe nx-stripe-zinc'} aria-hidden="true"></span>
          {$_('body.title')}
        </span>
        <svg viewBox="0 0 24 24" class="h-3.5 w-3.5 transition-transform" style:transform={openSection === 'body' ? 'rotate(180deg)' : ''} fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {#if openSection === 'body'}
        <div class="border-t border-carbon-600 p-3">
          <BodyEditor bind:value={upstream.body} label={$_('body.title')} showHelp={false} showLabel={false} />
        </div>
      {/if}
    </div>

    <!-- Collapsible Query -->
    <div class="border border-carbon-600 bg-carbon-950/60">
      <button
        type="button"
        class="w-full flex items-center justify-between px-3 py-2 font-mono text-[11px] uppercase tracking-command text-zinc-200 hover:text-nexus-300 hover:bg-carbon-700/30 transition-colors"
        on:click={() => toggleSection('query')}
      >
        <span class="flex items-center gap-2">
          <span class={openSection === 'query' ? 'nx-stripe' : 'nx-stripe nx-stripe-zinc'} aria-hidden="true"></span>
          {$_('query.title')}
        </span>
        <svg viewBox="0 0 24 24" class="h-3.5 w-3.5 transition-transform" style:transform={openSection === 'query' ? 'rotate(180deg)' : ''} fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {#if openSection === 'query'}
        <div class="border-t border-carbon-600 p-3">
          <QueryEditor bind:value={upstream.query} label={$_('query.title')} showHelp={false} showLabel={false} />
        </div>
      {/if}
    </div>
  </div>
</div>
{/if}
