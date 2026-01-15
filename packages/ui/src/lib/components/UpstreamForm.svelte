<script lang="ts">
  import type { Upstream } from '../api/routes';
  import { validateUpstreamSync } from '../validation/upstream-validator';
  import HeadersEditor from './HeadersEditor.svelte';
  import BodyEditor from './BodyEditor.svelte';
  import QueryEditor from './QueryEditor.svelte';
  import PluginEditor from './PluginEditor.svelte';
  import { _ } from '../i18n';
  import { UrlInput, ExpressionInput, NumberInput } from './smart-input';

  export let upstream: Upstream;
  export let index: number;
  export let onRemove: () => void;
  export let onDuplicate: () => void;
  export let showHeader: boolean = true;

  $: errors = validateUpstreamSync(upstream, index);

  // 确保基本结构
  $: {
    upstream.headers = upstream.headers || { add: {}, remove: [], default: {} };
    upstream.body = upstream.body || { add: {}, remove: [], replace: {}, default: {} };
    upstream.query = upstream.query || { add: {}, remove: [], replace: {}, default: {} };
    if (!upstream.plugins) {
      upstream.plugins = [];
    }
  }
</script>

<div class="card bg-base-100 shadow-sm border border-base-300">
  <div class="card-body p-4">
    {#if showHeader}
    <div class="flex justify-between items-center mb-4">
      <h3 class="font-semibold">{$_('upstream.title', { values: { index: index + 1 } })}</h3>
      <div class="flex gap-2">
        <button
          type="button"
          class="btn btn-sm btn-outline btn-square"
          on:click={onDuplicate}
          title={$_('routeCard.duplicate')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>
        <button
          type="button"
          class="btn btn-sm btn-error btn-square"
          on:click={onRemove}
          title={$_('upstream.remove')}
        >
          ✕
        </button>
      </div>
    </div>
    {/if}

    <div class="grid grid-cols-1 gap-4">
      <!-- Target URL -->
      <div class="form-control">
        <UrlInput
          label={$_('upstream.targetUrl') + ' *'}
          placeholder={$_('upstream.targetPlaceholder')}
          bind:value={upstream.target}
          required={true}
        />
      </div>

      <!-- Description -->
      <div class="form-control">
        <label class="label" for="upstream-description-{index}">
          <span class="label-text">{$_('upstream.description')}</span>
          <span class="label-text-alt text-xs">{$_('upstream.descriptionHelp')}</span>
        </label>
        <input
          id="upstream-description-{index}"
          type="text"
          placeholder={$_('upstream.descriptionPlaceholder')}
          class="input input-bordered"
          bind:value={upstream.description}
        />
      </div>

      <!-- Condition Expression -->
      <div class="form-control">
        <ExpressionInput
          label={$_('upstream.condition')}
          placeholder={$_('upstream.conditionPlaceholder')}
          bind:value={upstream.condition}
        />
        <div class="label">
          <span class="label-text-alt text-xs">{$_('upstream.conditionHelp')}</span>
        </div>
      </div>

      <!-- Disabled Toggle -->
      <div class="form-control">
        <label class="label cursor-pointer justify-start gap-3">
          <input
            type="checkbox"
            class="checkbox checkbox-primary"
            bind:checked={upstream.disabled}
          />
          <div class="flex flex-col">
            <span class="label-text font-medium">{$_('upstream.disabled')}</span>
            <span class="label-text-alt text-gray-500">{$_('upstream.disabledHelp')}</span>
          </div>
        </label>
      </div>

      <!-- Weight and Priority -->
      <div class="grid grid-cols-2 gap-4">
        <div class="form-control">
          <NumberInput
            label={$_('upstream.weight')}
            placeholder="100"
            min={1}
            bind:value={upstream.weight}
          />
          <div class="label">
            <span class="label-text-alt text-xs">{$_('upstream.weightHelp')}</span>
          </div>
        </div>

        <div class="form-control">
          <NumberInput
            label={$_('upstream.priority')}
            placeholder="1"
            min={0}
            bind:value={upstream.priority}
          />
          <div class="label">
            <span class="label-text-alt text-xs">{$_('upstream.priorityHelp')}</span>
          </div>
        </div>
      </div>

      <!-- Plugin -->
      <div>
        <h4 class="text-sm font-semibold mb-1">{$_('upstream.upstreamPlugins')}</h4>
        <p class="text-xs text-gray-500 mb-2">
          {$_('upstream.upstreamPluginsHelp')}
        </p>
        <PluginEditor bind:plugins={upstream.plugins} label="" />
      </div>

      <!-- Advanced Settings Section -->
      <div class="divider text-sm font-semibold">{$_('routeEditor.requestModification')}</div>

      <!-- Advanced Settings - Headers -->
      <div class="collapse collapse-arrow bg-base-200">
        <input type="checkbox" />
        <div class="collapse-title text-sm font-medium">
          {$_('headers.title')}
        </div>
        <div class="collapse-content">
          <HeadersEditor bind:value={upstream.headers} label={$_('headers.title')} showHelp={false} showLabel={false} />
        </div>
      </div>

      <!-- Advanced Settings - Body -->
      <div class="collapse collapse-arrow bg-base-200">
        <input type="checkbox" />
        <div class="collapse-title text-sm font-medium">
          {$_('body.title')}
        </div>
        <div class="collapse-content">
          <BodyEditor bind:value={upstream.body} label={$_('body.title')} showHelp={false} showLabel={false} />
        </div>
      </div>

      <!-- Advanced Settings - Query -->
      <div class="collapse collapse-arrow bg-base-200">
        <input type="checkbox" />
        <div class="collapse-title text-sm font-medium">
          {$_('query.title')}
        </div>
        <div class="collapse-content">
          <QueryEditor bind:value={upstream.query} label={$_('query.title')} showHelp={false} showLabel={false} />
        </div>
      </div>
    </div>
  </div>
</div>
