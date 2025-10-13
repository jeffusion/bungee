<script lang="ts">
  import { onMount } from 'svelte';
  import { pop } from 'svelte-spa-router';
  import { RoutesAPI } from '../lib/api/routes';
  import type { Route } from '../lib/api/routes';
  import { validateRoute, validateWeights, type ValidationError } from '../lib/validation';
  import UpstreamForm from '../lib/components/UpstreamForm.svelte';
  import HeadersEditor from '../lib/components/HeadersEditor.svelte';
  import BodyEditor from '../lib/components/BodyEditor.svelte';
  import RouteTemplates from '../lib/components/RouteTemplates.svelte';
  import TransformerEditor from '../lib/components/TransformerEditor.svelte';
  import { toast } from '../lib/stores/toast';
  import { _ } from '../lib/i18n';

  export let params: { path?: string } = {};

  let isEditMode = false;
  let originalPath = '';
  let loading = true;
  let saving = false;
  let showTemplates = false;
  let route: Route = {
    path: '',
    upstreams: [{
      target: '',
      weight: 100,
      priority: 1
    }],
    headers: { add: {}, remove: [], default: {} },
    body: { add: {}, remove: [], replace: {}, default: {} }
  };

  // Validation
  let errors: ValidationError[] = [];
  let weightErrors: ValidationError[] = [];
  let allErrors: ValidationError[] = [];
  let isValid = false;
  let validationDebounce: number | null = null;

  // 异步验证函数
  async function performValidation() {
    try {
      const routeErrors = await validateRoute(route);
      const routeWeightErrors = validateWeights(route.upstreams);

      errors = routeErrors;
      weightErrors = routeWeightErrors;
      allErrors = [...routeErrors, ...routeWeightErrors];
      isValid = allErrors.length === 0 && route.upstreams.length > 0;
    } catch (error) {
      console.error('Validation failed:', error);
      // 如果验证失败，设置为无效状态
      isValid = false;
    }
  }

  // 响应式验证（防抖）
  $: {
    // 依赖route的变化
    route && (() => {
      if (validationDebounce) {
        clearTimeout(validationDebounce);
      }
      validationDebounce = setTimeout(() => {
        performValidation();
      }, 300) as any;
    })();
  }

  // Path rewrite entries
  let pathRewriteEntries: Array<{ pattern: string; replacement: string }> = [];
  $: {
    if (!pathRewriteEntries.length && route.pathRewrite) {
      pathRewriteEntries = Object.entries(route.pathRewrite || {}).map(([pattern, replacement]) => ({
        pattern,
        replacement
      }));
    }
    const rewrite: Record<string, string> = {};
    pathRewriteEntries
      .filter(e => e.pattern.trim())
      .forEach(e => {
        rewrite[e.pattern] = e.replacement;
      });
    route.pathRewrite = Object.keys(rewrite).length > 0 ? rewrite : undefined;
  }

  // Transformer handling
  let routeTransformer = typeof route.transformer === 'string' ? route.transformer : null;
  $: route.transformer = routeTransformer || undefined;

  // Failover handling
  let failoverEnabled = false;
  $: {
    if (failoverEnabled) {
      if (!route.failover) route.failover = { enabled: true };
      else route.failover.enabled = true;
    } else {
      route.failover = undefined;
    }
  }

  // Health check handling
  let healthCheckEnabled = false;
  $: {
    if (healthCheckEnabled) {
      if (!route.healthCheck) route.healthCheck = { enabled: true };
      else route.healthCheck.enabled = true;
    } else {
      route.healthCheck = undefined;
    }
  }

  function addPathRewrite() {
    pathRewriteEntries = [...pathRewriteEntries, { pattern: '', replacement: '' }];
  }

  function removePathRewrite(index: number) {
    pathRewriteEntries = pathRewriteEntries.filter((_, i) => i !== index);
  }

  function addUpstream() {
    route.upstreams = [
      ...route.upstreams,
      {
        target: '',
        weight: 100,
        priority: route.upstreams.length + 1
      }
    ];
  }

  function removeUpstream(index: number) {
    if (route.upstreams.length <= 1) {
      alert($_('routeEditor.upstreamRequired'));
      return;
    }
    route.upstreams = route.upstreams.filter((_, i) => i !== index);
  }

  function duplicateUpstream(index: number) {
    const originalUpstream = route.upstreams[index];
    // 深度克隆upstream配置
    const duplicatedUpstream = JSON.parse(JSON.stringify(originalUpstream));

    // 更新target URL以避免完全重复
    if (duplicatedUpstream.target) {
      // 如果URL末尾有数字，递增；否则添加 -copy
      const urlMatch = duplicatedUpstream.target.match(/^(.+?)(-\d+)?$/);
      if (urlMatch) {
        const [, baseUrl, suffix] = urlMatch;
        if (suffix) {
          const num = parseInt(suffix.slice(1)) + 1;
          duplicatedUpstream.target = `${baseUrl}-${num}`;
        } else {
          duplicatedUpstream.target = `${baseUrl}-copy`;
        }
      } else {
        duplicatedUpstream.target = `${duplicatedUpstream.target}-copy`;
      }
    }

    // 调整priority避免冲突
    if (duplicatedUpstream.priority !== undefined) {
      duplicatedUpstream.priority = Math.max(...route.upstreams.map(u => u.priority || 1)) + 1;
    }

    // 插入到当前upstream之后
    route.upstreams = [
      ...route.upstreams.slice(0, index + 1),
      duplicatedUpstream,
      ...route.upstreams.slice(index + 1)
    ];
  }

  async function handleSave() {
    if (!isValid) {
      toast.show($_('routeEditor.saveFailed', { values: { error: $_('common.error') } }), 'error');
      return;
    }

    try {
      saving = true;

      if (isEditMode) {
        await RoutesAPI.update(originalPath, route);
        toast.show($_('routeEditor.routeUpdated'), 'success');
      } else {
        await RoutesAPI.create(route);
        toast.show($_('routeEditor.routeSaved'), 'success');
      }

      pop();
    } catch (e: any) {
      toast.show($_('routeEditor.saveFailed', { values: { error: e.message } }), 'error');
    } finally {
      saving = false;
    }
  }

  function handleCancel() {
    if (confirm($_('routeEditor.cancel') + '?')) {
      pop();
    }
  }

  function handleTemplateSelect(event: CustomEvent<Partial<Route>>) {
    const template = event.detail;
    route = {
      ...route,
      ...template,
      headers: template.headers || route.headers,
      body: template.body || route.body,
      upstreams: template.upstreams?.map(u => ({
        ...u,
        headers: u.headers || { add: {}, remove: [], default: {} },
        body: u.body || { add: {}, remove: [], replace: {}, default: {} }
      })) || route.upstreams
    };

    // Resync UI state from the new route object
    routeTransformer = typeof route.transformer === 'string' ? route.transformer : null;
    failoverEnabled = route.failover?.enabled || false;
    healthCheckEnabled = route.healthCheck?.enabled || false;
    if (route.pathRewrite) {
      pathRewriteEntries = Object.entries(route.pathRewrite).map(([pattern, replacement]) => ({
        pattern,
        replacement
      }));
    } else {
      pathRewriteEntries = [];
    }

    toast.show($_('routeEditor.routeSaved'), 'success');
  }

  onMount(async () => {
    if (params.path) {
      isEditMode = true;
      originalPath = decodeURIComponent(params.path);

      try {
        const existingRoute = await RoutesAPI.get(originalPath);
        if (existingRoute) {
          route = existingRoute;
          // 确保基本结构
          route.headers = route.headers || { add: {}, remove: [], default: {} };
          route.body = route.body || { add: {}, remove: [], replace: {}, default: {} };
          route.upstreams = route.upstreams.map(u => ({
            ...u,
            headers: u.headers || { add: {}, remove: [], default: {} },
            body: u.body || { add: {}, remove: [], replace: {}, default: {} }
          }));
          if (route.pathRewrite) {
            pathRewriteEntries = Object.entries(route.pathRewrite).map(([pattern, replacement]) => ({
              pattern,
              replacement
            }));
          }

          // Sync UI state from loaded route data
          routeTransformer = typeof route.transformer === 'string' ? route.transformer : null;
          failoverEnabled = route.failover?.enabled || false;
          healthCheckEnabled = route.healthCheck?.enabled || false;
        } else {
          toast.show($_('routes.noRoutes'), 'error');
          pop();
        }
      } catch (e: any) {
        toast.show($_('routeEditor.saveFailed', { values: { error: e.message } }), 'error');
        pop();
      }
    }
    loading = false;
  });
</script>

<div class="p-6 max-w-6xl mx-auto">
  <!-- Header -->
  <div class="mb-6 flex justify-between items-start">
    <div>
      <h1 class="text-3xl font-bold">
        {isEditMode ? $_('routeEditor.editRoute') : $_('routeEditor.newRoute')}
      </h1>
      <p class="text-sm text-gray-500 mt-1">
        {isEditMode ? `${$_('routeEditor.editRoute')}: ${originalPath}` : $_('routes.subtitle')}
      </p>
    </div>
    {#if !isEditMode}
      <button
        type="button"
        class="btn btn-sm btn-outline"
        on:click={() => showTemplates = true}
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        {$_('routeEditor.useTemplate')}
      </button>
    {/if}
  </div>

  {#if loading}
    <div class="flex justify-center items-center h-64">
      <span class="loading loading-spinner loading-lg"></span>
    </div>
  {:else}
    <form on:submit|preventDefault={handleSave} class="space-y-8">
      <!-- Basic Information -->
      <div class="card bg-base-100 shadow-md">
        <div class="card-body">
          <h2 class="card-title">{$_('routeEditor.routePath')}</h2>

          <!-- Path -->
          <div class="form-control">
            <label class="label" for="route-path">
              <span class="label-text font-semibold">
                {$_('routes.path')} <span class="text-error">*</span>
              </span>
              <span class="label-text-alt text-xs">
                {$_('routeEditor.pathHelp')}
              </span>
            </label>
            <input
              id="route-path"
              type="text"
              placeholder={$_('routeEditor.pathPlaceholder')}
              class="input input-bordered"
              class:input-error={errors.some(e => e.field === 'path')}
              bind:value={route.path}
              required
            />
            {#if errors.some(e => e.field === 'path')}
              <label class="label" for="route-path">
                <span class="label-text-alt text-error">
                  {errors.find(e => e.field === 'path')?.message}
                </span>
              </label>
            {/if}
          </div>

          <!-- Path Rewrite -->
          <div class="form-control">
            <label class="label" for="path-rewrite-pattern-0">
              <span class="label-text font-semibold">{$_('routeEditor.pathRewrite')} ({$_('routeEditor.optional')})</span>
              <span class="label-text-alt text-xs">
                {$_('routeEditor.pathRewriteHelp')}
              </span>
            </label>
            <div class="space-y-2">
              {#each pathRewriteEntries as entry, index}
                <div class="flex gap-2">
                  <input
                    id={`path-rewrite-pattern-${index}`}
                    type="text"
                    placeholder={$_('routeEditor.patternPlaceholder')}
                    class="input input-bordered input-sm flex-1"
                    bind:value={entry.pattern}
                  />
                  <input
                    id={`path-rewrite-replacement-${index}`}
                    type="text"
                    placeholder={$_('routeEditor.replacementPlaceholder')}
                    class="input input-bordered input-sm flex-1"
                    bind:value={entry.replacement}
                  />
                  <button
                    type="button"
                    class="btn btn-sm btn-error btn-square"
                    on:click={() => removePathRewrite(index)}
                  >
                    ✕
                  </button>
                </div>
              {/each}
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                on:click={addPathRewrite}
              >
                {$_('routeEditor.addPathRewriteRule')}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Upstreams -->
      <div class="card bg-base-100 shadow-md">
        <div class="card-body">
          <div class="flex justify-between items-center">
            <h2 class="card-title">
              {$_('routeEditor.upstreams')} <span class="text-error">*</span>
            </h2>
            <button
              type="button"
              class="btn btn-sm btn-primary"
              on:click={addUpstream}
            >
              {$_('routeEditor.addUpstream')}
            </button>
          </div>

          {#if errors.some(e => e.field === 'upstreams')}
            <div class="alert alert-error">
              <span>{errors.find(e => e.field === 'upstreams')?.message}</span>
            </div>
          {/if}

          <div class="space-y-4 mt-4">
            {#each route.upstreams as _, index}
              <UpstreamForm
                bind:upstream={route.upstreams[index]}
                {index}
                onRemove={() => removeUpstream(index)}
                onDuplicate={() => duplicateUpstream(index)}
              />
            {/each}
          </div>

          {#if weightErrors.length > 0}
            <div class="alert alert-warning mt-4">
              <span>{weightErrors[0].message}</span>
            </div>
          {/if}
        </div>
      </div>

      <!-- Route-level Transformer & Modifications -->
      <div class="card bg-base-100 shadow-md">
        <div class="card-body">
          <h2 class="card-title">{$_('routeEditor.transformer')}</h2>
          <p class="text-sm text-gray-500 mb-4">
            {$_('routeEditor.transformerHelp')}
          </p>

          <div class="space-y-6">
            <TransformerEditor bind:transformer={routeTransformer} label={$_('routeEditor.transformer')} />
            <div class="divider"></div>
            <HeadersEditor bind:value={route.headers} label={$_('headers.title')} />
            <div class="divider"></div>
            <BodyEditor bind:value={route.body} label={$_('body.title')} />
          </div>
        </div>
      </div>

      <!-- Failover Configuration -->
      <div class="card bg-base-100 shadow-md">
        <div class="card-body">
          <h2 class="card-title">{$_('routeEditor.failoverTitle')} ({$_('routeEditor.optional')})</h2>

          <div class="form-control">
            <label class="label cursor-pointer justify-start gap-4">
              <input
                type="checkbox"
                class="checkbox"
                bind:checked={failoverEnabled}
              />
              <span class="label-text">{$_('routeEditor.enableFailover')}</span>
            </label>
          </div>

          {#if route.failover?.enabled}
            <div class="form-control mt-4">
              <label class="label" for="failover-status-codes">
                <span class="label-text">{$_('routeEditor.retryableStatusCodes')}</span>
              </label>
              <input
                id="failover-status-codes"
                type="text"
                placeholder={$_('routeEditor.retryableStatusCodesPlaceholder')}
                class="input input-bordered"
                value={route.failover.retryableStatusCodes?.join(', ') || ''}
                on:input={(e) => {
                  const codes = e.currentTarget.value
                    .split(',')
                    .map(s => parseInt(s.trim()))
                    .filter(n => !isNaN(n));
                  if (!route.failover) route.failover = { enabled: true };
                  route.failover.retryableStatusCodes = codes;
                }}
              />
            </div>
          {/if}
        </div>
      </div>

      <!-- Health Check Configuration -->
      <div class="card bg-base-100 shadow-md">
        <div class="card-body">
          <h2 class="card-title">{$_('routeEditor.healthCheckTitle')} ({$_('routeEditor.optional')})</h2>

          <div class="form-control">
            <label class="label cursor-pointer justify-start gap-4">
              <input
                type="checkbox"
                class="checkbox"
                bind:checked={healthCheckEnabled}
              />
              <span class="label-text">{$_('routeEditor.enableHealthCheck')}</span>
            </label>
          </div>

          {#if route.healthCheck?.enabled}
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
              <div class="form-control">
                <label class="label" for="health-check-interval">
                  <span class="label-text">{$_('routeEditor.intervalMs')}</span>
                </label>
                <input
                  id="health-check-interval"
                  type="number"
                  placeholder={$_('routeEditor.intervalPlaceholder')}
                  class="input input-bordered"
                  bind:value={route.healthCheck.interval}
                />
              </div>

              <div class="form-control">
                <label class="label" for="health-check-timeout">
                  <span class="label-text">{$_('routeEditor.timeoutMs')}</span>
                </label>
                <input
                  id="health-check-timeout"
                  type="number"
                  placeholder={$_('routeEditor.timeoutPlaceholder')}
                  class="input input-bordered"
                  bind:value={route.healthCheck.timeout}
                />
              </div>

              <div class="form-control">
                <label class="label" for="health-check-path">
                  <span class="label-text">{$_('routeEditor.healthCheckPath')}</span>
                </label>
                <input
                  id="health-check-path"
                  type="text"
                  placeholder={$_('routeEditor.healthCheckPathPlaceholder')}
                  class="input input-bordered"
                  bind:value={route.healthCheck.path}
                />
              </div>
            </div>
          {/if}
        </div>
      </div>

      <!-- Actions -->
      <div class="flex justify-end gap-4">
        <button
          type="button"
          class="btn btn-ghost"
          on:click={handleCancel}
          disabled={saving}
        >
          {$_('routeEditor.cancel')}
        </button>
        <button
          type="submit"
          class="btn btn-primary"
          disabled={!isValid || saving}
        >
          {#if saving}
            <span class="loading loading-spinner"></span>
            {$_('routeEditor.saving')}
          {:else}
            {isEditMode ? $_('routeEditor.routeUpdated') : $_('routeEditor.routeSaved')}
          {/if}
        </button>
      </div>

      <!-- Validation Summary -->
      {#if allErrors.length > 0}
        <div class="alert alert-warning">
          <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <h3 class="font-bold">{$_('common.error')}</h3>
            <ul class="text-xs list-disc list-inside">
              {#each allErrors as error}
                <li>{error.field}: {error.message}</li>
              {/each}
            </ul>
          </div>
        </div>
      {/if}
    </form>
  {/if}

  <!-- Route Templates Modal -->
  <RouteTemplates bind:showTemplates on:select={handleTemplateSelect} />
</div>
