<script lang="ts">
  import type { Upstream } from '../api/routes';
  import { validateUpstreamSync } from '../validation/upstream-validator';
  import HeadersEditor from './HeadersEditor.svelte';
  import BodyEditor from './BodyEditor.svelte';
  import TransformerEditor from './TransformerEditor.svelte';
  import { _ } from '../i18n';

  export let upstream: Upstream;
  export let index: number;
  export let onRemove: () => void;
  export let onDuplicate: () => void;
  export let showAdvanced: boolean = false;

  $: errors = validateUpstreamSync(upstream, index);

  // 确保基本结构
  $: {
    upstream.headers = upstream.headers || { add: {}, remove: [], default: {} };
    upstream.body = upstream.body || { add: {}, remove: [], replace: {}, default: {} };
  }

  // 处理 transformer 变化
  let transformerValue = typeof upstream.transformer === 'string' ? upstream.transformer : null;
  $: upstream.transformer = transformerValue || undefined;
</script>

<div class="card bg-base-100 shadow-sm border border-base-300">
  <div class="card-body p-4">
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

    <div class="grid grid-cols-1 gap-4">
      <!-- Target URL -->
      <div class="form-control">
        <label class="label" for="upstream-target-{index}">
          <span class="label-text font-semibold">
            {$_('upstream.targetUrl')} <span class="text-error">*</span>
          </span>
        </label>
        <input
          id="upstream-target-{index}"
          type="url"
          placeholder={$_('upstream.targetPlaceholder')}
          class="input input-bordered"
          class:input-error={errors.some(e => e.field.includes('target'))}
          bind:value={upstream.target}
          required
        />
        {#if errors.some(e => e.field.includes('target'))}
          <label class="label" for="upstream-target-{index}">
            <span class="label-text-alt text-error">
              {errors.find(e => e.field.includes('target'))?.message}
            </span>
          </label>
        {/if}
      </div>

      <!-- Weight and Priority -->
      <div class="grid grid-cols-2 gap-4">
        <div class="form-control">
          <label class="label" for="upstream-weight-{index}">
            <span class="label-text">{$_('upstream.weight')}</span>
            <span class="label-text-alt text-xs">{$_('upstream.weightHelp')}</span>
          </label>
          <input
            id="upstream-weight-{index}"
            type="number"
            placeholder="100"
            class="input input-bordered"
            min="1"
            bind:value={upstream.weight}
          />
        </div>

        <div class="form-control">
          <label class="label" for="upstream-priority-{index}">
            <span class="label-text">Priority</span>
            <span class="label-text-alt text-xs">Failover order</span>
          </label>
          <input
            id="upstream-priority-{index}"
            type="number"
            placeholder="1"
            class="input input-bordered"
            min="0"
            bind:value={upstream.priority}
          />
        </div>
      </div>

      <!-- Transformer -->
      <TransformerEditor bind:transformer={transformerValue} label={$_('upstream.transformer')} />

      <!-- Advanced Settings -->
      <div class="collapse collapse-arrow bg-base-200">
        <input type="checkbox" bind:checked={showAdvanced} />
        <div class="collapse-title text-sm font-medium">
          {$_('upstream.transformerHelp')}
        </div>
        <div class="collapse-content space-y-6">
          <HeadersEditor bind:value={upstream.headers} label={$_('headers.title')} />
          <div class="divider"></div>
          <BodyEditor bind:value={upstream.body} label={$_('body.title')} />
        </div>
      </div>
    </div>
  </div>
</div>
