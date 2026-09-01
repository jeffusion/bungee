<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { pop, querystring } from 'svelte-spa-router';
  import { sortBy } from 'lodash-es';
  import { resolveRouteEndpoints, RoutesAPI } from '$api/routes';
  import type { Route, Service } from '$api/routes';
  import { ServicesAPI } from '$api/services';
  import { validateRoute, validateWeights, type ValidationError } from '$validation';
  import RouteTemplates from '$components/domain/route/RouteTemplates.svelte';
  import ConfirmDialog from '$components/shell/ConfirmDialog.svelte';
  import BasicInfoSection from '$components/domain/route/sections/BasicInfoSection.svelte';
  import UpstreamTargetSection from '$components/domain/route/sections/UpstreamTargetSection.svelte';
  import ModificationSection from '$components/domain/route/sections/ModificationSection.svelte';
  import AuthSection from '$components/domain/route/sections/AuthSection.svelte';
  import CorsSection from '$components/domain/route/sections/CorsSection.svelte';
  import RateLimitSection from '$components/domain/route/sections/RateLimitSection.svelte';
  import RetrySection from '$components/domain/route/sections/RetrySection.svelte';
  import DirectResponseSection from '$components/domain/route/sections/DirectResponseSection.svelte';
  import { toast } from '$stores/toast';
  import { _ } from '$i18n';
  import { v4 as uuidv4 } from 'uuid';
  import { getModifierKey, isModifierPressed } from '$utils/platform';
  import { LoadingIndicator, PanelCard, StatusBadge, StatusDot } from '$components/industrial';

  export let params: { path?: string } = {};

  let isEditMode = false;
  let originalPath = '';
  let loading = true;
  let saving = false;
  let showTemplates = false;
  type RouteEditorSection = 'match' | 'target' | 'processing' | 'policy' | 'response' | 'plugins' | 'review';
  let activeSection: RouteEditorSection = 'match';
  let showValidationDetails = false;

  function isRouteEditorSection(value: string | null): value is RouteEditorSection {
    const valid: RouteEditorSection[] = ['match', 'target', 'processing', 'policy', 'response', 'plugins', 'review'];
    return value !== null && (valid as string[]).includes(value);
  }

  $: {
    if ($querystring) {
      const p = new URLSearchParams($querystring);
      const s = p.get('section');
      if (isRouteEditorSection(s)) activeSection = s;
    }
  }

  let route: Route = {
    path: '',
    endpoints: [{ _uid: uuidv4(), target: '', weight: 100, priority: 1 }],
    headers: { add: {}, remove: [], default: {} },
    body: { add: {}, remove: [], replace: {}, default: {} },
    query: { add: {}, remove: [], replace: {}, default: {} },
    plugins: [],
  };

  let services: Service[] = [];
  $: resolvedEndpoints = resolveRouteEndpoints(route, services);

  let errors: ValidationError[] = [];
  let weightErrors: ValidationError[] = [];
  let allErrors: ValidationError[] = [];
  let isValid = false;
  let validationDebounce: any = null;

  let lastAutoSave: number | null = null;
  let autoSaveInterval: any = null;

  // Confirm dialog state
  let showConfirmDialog = false;
  let confirmDialogTitle = '';
  let confirmDialogMessage = '';
  let confirmDialogCallback: (() => void) | null = null;

  function showConfirm(title: string, message: string, callback: () => void) {
    confirmDialogTitle = title;
    confirmDialogMessage = message;
    confirmDialogCallback = callback;
    showConfirmDialog = true;
  }
  function handleConfirmYes() {
    showConfirmDialog = false;
    if (confirmDialogCallback) { confirmDialogCallback(); confirmDialogCallback = null; }
  }
  function handleConfirmNo() {
    showConfirmDialog = false;
    confirmDialogCallback = null;
  }

  function handleKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      if (isValid && !saving) handleSave();
    }
    if (event.key === 'Escape') handleCancel();
    if (event.key >= '1' && event.key <= '7' && isModifierPressed(event) && !event.altKey) {
      const sections: RouteEditorSection[] = ['match', 'target', 'processing', 'policy', 'response', 'plugins', 'review'];
      const target = sections[parseInt(event.key) - 1];
      if (target) { activeSection = target; event.preventDefault(); }
    }
  }

  function autoSaveDraft() {
    if (!isEditMode) {
      try {
        localStorage.setItem('bungee-route-draft', JSON.stringify(route));
        lastAutoSave = Date.now();
      } catch (e) {
        console.error('Failed to auto-save draft:', e);
      }
    }
  }

  function formatRelativeTime(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return $_('autosave.justNow');
    if (seconds < 3600) return $_('autosave.minutesAgo', { values: { minutes: Math.floor(seconds / 60) } });
    return $_('autosave.hoursAgo', { values: { hours: Math.floor(seconds / 3600) } });
  }

  async function performValidation() {
    try {
      const endpointsForValidation = route.endpoints && route.endpoints.length > 0 ? route.endpoints : resolvedEndpoints;
      const routeErrors = await validateRoute(route, services);
      const routeWeightErrors = validateWeights(endpointsForValidation);
      errors = routeErrors;
      weightErrors = routeWeightErrors;
      allErrors = [...routeErrors, ...routeWeightErrors];
      const hasGlobalResponseBypass = route.direct_response?.enabled || route.redirect?.enabled;
      isValid = allErrors.length === 0 && (hasGlobalResponseBypass || Boolean(route.service) || endpointsForValidation.length > 0);
    } catch (error) {
      console.error('Validation failed:', error);
      isValid = false;
    }
  }

  $: {
    route && (() => {
      if (validationDebounce) clearTimeout(validationDebounce);
      validationDebounce = setTimeout(() => performValidation(), 300);
    })();
  }

  async function handleSave() {
    if (!isValid) {
      toast.show($_('routeEditor.saveFailed', { values: { error: $_('common.error') } }), 'error');
      return;
    }
    try {
      saving = true;
      const hasDirectResponse = route.direct_response?.enabled || route.redirect?.enabled;
      const sortedRoute = {
        ...route,
        endpoints: !hasDirectResponse && !route.service && route.endpoints && route.endpoints.length > 0
          ? sortBy(route.endpoints, [(endpoint: any) => endpoint.priority ?? 1])
          : undefined,
        service: hasDirectResponse ? undefined : route.service,
      };
      if (!sortedRoute.endpoints) delete sortedRoute.endpoints;

      if (isEditMode) {
        await RoutesAPI.update(originalPath, sortedRoute);
        toast.show($_('routeEditor.routeUpdated'), 'success');
      } else {
        await RoutesAPI.create(sortedRoute);
        toast.show($_('routeEditor.routeSaved'), 'success');
        localStorage.removeItem('bungee-route-draft');
      }
      pop();
    } catch (e: any) {
      toast.show($_('routeEditor.saveFailed', { values: { error: e.message } }), 'error');
    } finally {
      saving = false;
    }
  }

  function handleCancel() {
    showConfirm($_('confirmDialog.cancelTitle'), $_('confirmDialog.cancelMessage'), () => pop());
  }

  function handleTemplateSelect(event: CustomEvent<Partial<Route>>) {
    const template = event.detail;
    route = {
      ...route,
      ...template,
      headers: template.headers || route.headers,
      body: template.body || route.body,
      query: template.query || route.query,
      endpoints: template.endpoints?.map((u) => ({
        ...u,
        _uid: uuidv4(),
        headers: u.headers || { add: {}, remove: [], default: {} },
        body: u.body || { add: {}, remove: [], replace: {}, default: {} },
        query: u.query || { add: {}, remove: [], replace: {}, default: {} },
      })) || route.endpoints,
    };
    toast.show($_('routeEditor.templateApplied'), 'success');
  }

  onMount(async () => {
    window.addEventListener('keydown', handleKeydown);
        services = await ServicesAPI.list();
    autoSaveInterval = setInterval(() => autoSaveDraft(), 30000);

    if (params.path) {
      isEditMode = true;
      originalPath = decodeURIComponent(params.path);
      try {
        const existingRoute = await RoutesAPI.get(originalPath);
        if (existingRoute) {
          route = existingRoute;
          route.headers = route.headers || { add: {}, remove: [], default: {} };
          route.body = route.body || { add: {}, remove: [], replace: {}, default: {} };
          route.query = route.query || { add: {}, remove: [], replace: {}, default: {} };
          route.plugins = route.plugins || [];
          route.endpoints = route.endpoints?.map((u) => ({
            ...u,
            _uid: u._uid ?? uuidv4(),
            headers: u.headers || { add: {}, remove: [], default: {} },
            body: u.body || { add: {}, remove: [], replace: {}, default: {} },
            query: u.query || { add: {}, remove: [], replace: {}, default: {} },
          }));
        } else {
          toast.show($_('routes.noRoutes'), 'error');
          pop();
        }
      } catch (e: any) {
        toast.show($_('routeEditor.saveFailed', { values: { error: e.message } }), 'error');
        pop();
      }
    } else {
      try {
        const draft = localStorage.getItem('bungee-route-draft');
        if (draft) {
          const parsedDraft = JSON.parse(draft);
          showConfirm(
            $_('confirmDialog.restoreDraftTitle'),
            $_('confirmDialog.restoreDraftMessage'),
            () => { route = parsedDraft; }
          );
        }
      } catch (e) {
        console.error('Failed to restore draft:', e);
      }
    }
    loading = false;
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown);
    if (autoSaveInterval) clearInterval(autoSaveInterval);
  });

  // Navigation items
  $: navItems = loading ? [] : ([
    {
      id: 'match'      as RouteEditorSection,
      label: $_('routeEditor.builder.match'),
      icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
      badge: '',
    },
    {
      id: 'target'     as RouteEditorSection,
      label: $_('routeEditor.builder.target'),
      icon: 'M13 10V3L4 14h7v7l9-11h-7z',
      // Badge:
      //  · direct_response / redirect → "—" (no upstream)
      //  · service-backed             → service count, not service name
      //  · custom endpoints           → "EP·N" so "Target" + "1" doesn't
      //                                  read as "Target #1"
      badge: (route.direct_response?.enabled || route.redirect?.enabled)
        ? '—'
        : route.service
          ? '1'
          : route.endpoints?.length
            ? `EP·${route.endpoints.length}`
            : '',
    },
    {
      id: 'processing' as RouteEditorSection,
      label: $_('routeEditor.builder.processing'),
      icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
      badge: route.retry?.enabled ? '✓' : '',
    },
    {
      id: 'policy'     as RouteEditorSection,
      label: $_('routeEditor.builder.policy'),
      icon: 'M9 12l2 2 4-4m5.618-4.016A9 9 0 112.683 13.317',
      badge: (route.rate_limit?.enabled || route.auth?.enabled || route.cors?.enabled) ? '✓' : '',
    },
    {
      id: 'response'   as RouteEditorSection,
      label: $_('routeEditor.builder.response'),
      icon: 'M14 5l7 7m0 0l-7 7m7-7H3',
      badge: (route.response_rules?.some((r) => r.enabled) || route.direct_response?.enabled || route.redirect?.enabled) ? '✓' : '',
    },
    {
      id: 'plugins'    as RouteEditorSection,
      label: $_('routeEditor.builder.plugins'),
      icon: 'M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 011-1h1a2 2 0 100-4H7a1 1 0 01-1-1V7a1 1 0 011-1h3a1 1 0 001-1V4z',
      // "×N" so "Plugins" + "2" doesn't read as "Plugins #2"
      badge: route.plugins?.length ? `×${route.plugins.length}` : '',
    },
    {
      id: 'review'     as RouteEditorSection,
      label: $_('routeEditor.builder.review'),
      icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
      badge: '',
    },
  ]);
</script>

<div class="min-h-screen flex flex-col">
  <!-- ===== Breadcrumb ============================================ -->
  <div class="border-b border-carbon-600 bg-carbon-900/70 backdrop-blur sticky top-16 z-30">
    <div class="max-w-7xl mx-auto px-6 py-3">
      <nav class="flex items-center gap-2 font-mono text-[11px] uppercase tracking-command">
        <button type="button" class="text-zinc-500 hover:text-nexus-300 transition-colors" on:click={() => (window.location.hash = '/')}>
          {$_('breadcrumb.home')}
        </button>
        <span class="text-zinc-700">/</span>
        <button type="button" class="text-zinc-500 hover:text-nexus-300 transition-colors" on:click={() => (window.location.hash = '/routes')}>
          {$_('breadcrumb.routes')}
        </button>
        <span class="text-zinc-700">/</span>
        <span class="text-nexus-300 flex items-center gap-2">
          <span>{isEditMode ? $_('breadcrumb.editRoute') : $_('breadcrumb.newRoute')}</span>
          {#if isEditMode}
            <code class="px-1.5 py-0.5 border border-carbon-500 bg-carbon-900 text-zinc-300 normal-case">{originalPath}</code>
          {/if}
        </span>
      </nav>
    </div>
  </div>

  {#if loading}
    <LoadingIndicator label="LOADING ROUTE" class="flex-1" height="none" />
  {:else}
    <div class="max-w-7xl mx-auto w-full flex flex-col lg:flex-row gap-4 p-4 sm:p-6">
      <!-- ===== Side nav =========================================== -->
      <aside class="w-full lg:w-56 flex-shrink-0" data-testid="builder-nav">
        <div class="lg:sticky lg:top-32 space-y-3">
          <PanelCard title={$_('routeEditor.builderTitle')} tag={$_('routeEditor.builderNavTag')} flush>
            <ul class="divide-y divide-carbon-600">
              {#each navItems as item}
                <li>
                  <button
                    class="nx-side-nav-btn"
                    class:is-active={activeSection === item.id}
                    on:click={() => (activeSection = item.id)}
                    data-testid={`route-nav-${item.id}`}
                  >
                    {#if activeSection === item.id}
                      <span class="nx-caret-left mr-1.5" aria-hidden="true"></span>
                    {:else}
                      <span class="inline-block w-[5px] h-2 mr-1.5"></span>
                    {/if}
                    <svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="1.8">
                      <path stroke-linecap="round" stroke-linejoin="round" d={item.icon} />
                    </svg>
                    <span class="flex-1 text-left truncate">{item.label}</span>
                    {#if item.badge}
                      <span class={item.badge === '✓' ? 'nx-sidenav-badge-tick' : 'nx-sidenav-badge'}>
                        {item.badge}
                      </span>
                    {/if}
                  </button>
                </li>
              {/each}
            </ul>
          </PanelCard>

          {#if !isEditMode}
            <button class="nx-btn-ghost w-full justify-center" on:click={() => (showTemplates = true)}>
              <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              {$_('routeEditor.useTemplate')}
            </button>
          {/if}

          <PanelCard title={$_('shortcuts.title')} tag={$_('shortcuts.tag')}>
            <ul class="space-y-1.5 font-mono text-[11px]">
              <li class="flex items-center gap-1.5">
                <kbd class="nx-kbd">{getModifierKey()}</kbd><span class="text-zinc-600">+</span><kbd class="nx-kbd">S</kbd>
                <span class="text-zinc-400 ml-2">{$_('shortcuts.save')}</span>
              </li>
              <li class="flex items-center gap-1.5">
                <kbd class="nx-kbd">{getModifierKey()}</kbd><span class="text-zinc-600">+</span><kbd class="nx-kbd">1-7</kbd>
                <span class="text-zinc-400 ml-2">{$_('shortcuts.switchSection')}</span>
              </li>
              <li class="flex items-center gap-1.5">
                <kbd class="nx-kbd">Esc</kbd>
                <span class="text-zinc-400 ml-2">{$_('shortcuts.cancel')}</span>
              </li>
            </ul>
          </PanelCard>
        </div>
      </aside>

      <!-- ===== Content panel ===================================== -->
      <section class="flex-1 min-w-0 space-y-4 pb-16">
        {#if activeSection === 'match'}
          <PanelCard title={$_('routeEditor.builder.match')} tag="MA-01">
            <div data-testid="section-match" class="space-y-5">
              <BasicInfoSection bind:route {errors} showOnly="path" />
              <BasicInfoSection bind:route {errors} showOnly="rewrite" />
            </div>
          </PanelCard>

        {:else if activeSection === 'target'}
          <PanelCard
            title={$_('routeEditor.builder.target')}
            tag={route.service ? 'SVC' : `EP=${route.endpoints?.length ?? 0}`}
          >
            <div data-testid="route-nav-target" data-testid-section="target" class="space-y-4">
              <UpstreamTargetSection
                bind:route
                {errors}
                {weightErrors}
                bind:services
                on:navigatetosection={(e) => (activeSection = e.detail.section as RouteEditorSection)}
              />
            </div>
          </PanelCard>

        {:else if activeSection === 'processing'}
          <div data-testid="section-processing" class="space-y-4">
            <PanelCard title={$_('routeEditor.builder.processing')} tag="MOD">
              <ModificationSection bind:route />
            </PanelCard>

            <PanelCard title={$_('routeEditor.timeoutSettings')} tag="TO-01">
              <BasicInfoSection bind:route {errors} showOnly="timeouts" />
            </PanelCard>

            <PanelCard title={$_('routeEditor.retry')} tag={route.retry?.enabled ? 'ENABLED' : 'IDLE'} stripe={route.retry?.enabled ? 'orange' : 'zinc'}>
              <RetrySection bind:route />
            </PanelCard>
          </div>

        {:else if activeSection === 'policy'}
          <div data-testid="section-policy" class="space-y-4">
            <PanelCard title={$_('auth.routeAuth')} tag={route.auth?.enabled ? 'ENABLED' : 'IDLE'} stripe={route.auth?.enabled ? 'orange' : 'zinc'}>
              <AuthSection bind:route />
            </PanelCard>

            <PanelCard title={$_('routeEditor.cors')} tag={route.cors?.enabled ? 'ENABLED' : 'IDLE'} stripe={route.cors?.enabled ? 'orange' : 'zinc'}>
              <CorsSection bind:route />
            </PanelCard>

            <PanelCard title={$_('routeEditor.rateLimit')} tag={route.rate_limit?.enabled ? 'ENABLED' : 'IDLE'} stripe={route.rate_limit?.enabled ? 'orange' : 'zinc'}>
              <RateLimitSection bind:route />
            </PanelCard>
          </div>

        {:else if activeSection === 'response'}
          <PanelCard title={$_('routeEditor.builder.response')} tag={(route.direct_response?.enabled || route.redirect?.enabled) ? 'BYPASS' : 'PASSTHRU'}>
            <div data-testid="section-response">
              <DirectResponseSection bind:route />
            </div>
          </PanelCard>

        {:else if activeSection === 'plugins'}
          <PanelCard title={$_('routeEditor.builder.plugins')} tag={`N=${route.plugins?.length ?? 0}`}>
            <div data-testid="section-plugins">
              <BasicInfoSection bind:route {errors} showOnly="plugins" />
            </div>
          </PanelCard>

        {:else if activeSection === 'review'}
          <div data-testid="section-review" class="space-y-4">
            <PanelCard title={$_('routeEditor.builder.match')} tag="REVIEW">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <span class="nx-label-sm block mb-1">{$_('routes.path')}</span>
                  <code class="font-mono text-[12px] text-zinc-100">{route.path || '—'}</code>
                </div>
                {#if route.path_rewrite && Object.keys(route.path_rewrite).length > 0}
                  <div>
                    <span class="nx-label-sm block mb-1">{$_('routeEditor.pathRewrite')}</span>
                    <div class="space-y-1">
                      {#each Object.entries(route.path_rewrite) as [pattern, replacement]}
                        <div class="font-mono text-[11px] border border-carbon-600 bg-carbon-900/60 px-2 py-1 flex items-center gap-2">
                          <span class="text-zinc-200">{pattern}</span>
                          <svg viewBox="0 0 24 24" class="h-3 w-3 text-zinc-500" fill="none" stroke="currentColor" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                          </svg>
                          <span class="text-nexus-300">{replacement}</span>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>
            </PanelCard>

            <PanelCard title="{$_('routeEditor.builder.processing')} & {$_('routeEditor.builder.policy')}" tag="REVIEW">
              <div class="space-y-3">
                {#if (route.headers && Object.keys(route.headers).length > 0) || (route.body && Object.keys(route.body).length > 0) || (route.query && Object.keys(route.query).length > 0)}
                  <div>
                    <span class="nx-label-sm block mb-1.5">{$_('routeEditor.builder.processing')}</span>
                    <div class="flex flex-wrap gap-1.5">
                      {#if route.headers && Object.keys(route.headers).length > 0}
                        <StatusBadge variant="muted">{$_('routeEditor.review.headersModification')}</StatusBadge>
                      {/if}
                      {#if route.body && Object.keys(route.body).length > 0}
                        <StatusBadge variant="muted">{$_('routeEditor.review.bodyModification')}</StatusBadge>
                      {/if}
                      {#if route.query && Object.keys(route.query).length > 0}
                        <StatusBadge variant="muted">{$_('routeEditor.review.queryModification')}</StatusBadge>
                      {/if}
                    </div>
                  </div>
                {/if}

                <div>
                  <span class="nx-label-sm block mb-1.5">{$_('routeEditor.builder.policy')}</span>
                  <div class="flex flex-wrap gap-1.5">
                    {#if route.auth?.enabled}<StatusBadge variant="active" dot>{$_('routeEditor.review.auth')}</StatusBadge>{:else}<StatusBadge variant="muted">{$_('routeEditor.review.auth')}</StatusBadge>{/if}
                    {#if route.cors?.enabled}<StatusBadge variant="active" dot>{$_('routeEditor.review.cors')}</StatusBadge>{:else}<StatusBadge variant="muted">{$_('routeEditor.review.cors')}</StatusBadge>{/if}
                    {#if route.rate_limit?.enabled}<StatusBadge variant="active" dot>{$_('routeEditor.review.rateLimit')}</StatusBadge>{:else}<StatusBadge variant="muted">{$_('routeEditor.review.rateLimit')}</StatusBadge>{/if}
                    {#if route.retry?.enabled}<StatusBadge variant="active" dot>{$_('routeEditor.review.retry')}</StatusBadge>{:else}<StatusBadge variant="muted">{$_('routeEditor.review.retry')}</StatusBadge>{/if}
                  </div>
                </div>

                {#if route.plugins && route.plugins.length > 0}
                  <div>
                    <span class="nx-label-sm block mb-1.5">{$_('routeEditor.builder.plugins')}</span>
                    <div class="flex flex-wrap gap-1">
                      {#each route.plugins as plugin}
                        <StatusBadge variant="info">
                          {typeof plugin === 'string' ? plugin : plugin.name}
                        </StatusBadge>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>
            </PanelCard>

            <PanelCard title={$_('routeEditor.builder.target')} tag="REVIEW">
              {#if route.service}
                <div>
                  <span class="nx-label-sm block mb-1">{$_('routeEditor.review.referencedService')}</span>
                  <span class="font-mono text-[12px] text-nexus-300">{route.service}</span>
                </div>
              {:else if route.endpoints && route.endpoints.length > 0}
                <div>
                  <span class="nx-label-sm block mb-2">{$_('routeEditor.review.customEndpoints')} ({route.endpoints.length})</span>
                  <div class="space-y-1">
                    {#each route.endpoints as endpoint}
                      <div class="font-mono text-[11px] border border-carbon-600 bg-carbon-900/60 px-2 py-1 flex justify-between items-center gap-3">
                        <span class="text-zinc-200 truncate">{endpoint.target}</span>
                        <span class="text-zinc-500 shrink-0">w:{endpoint.weight ?? 100} · p:{endpoint.priority ?? 1}</span>
                      </div>
                    {/each}
                  </div>
                </div>
              {:else}
                <span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">— {$_('routeEditor.review.noTarget')}</span>
              {/if}
            </PanelCard>

            <PanelCard title={$_('routeEditor.builder.response')} tag="REVIEW">
              <div class="space-y-2">
                {#if route.direct_response?.enabled}
                  <div class="flex items-center gap-2">
                    <StatusBadge variant="online">{$_('routeEditor.review.directResponse')}</StatusBadge>
                    <span class="font-mono text-[11px] text-zinc-400">{$_('routeEditor.review.status')}: {route.direct_response.status}</span>
                  </div>
                {/if}
                {#if route.redirect?.enabled}
                  <div class="flex items-center gap-2">
                    <StatusBadge variant="online">{$_('routeEditor.review.redirect')}</StatusBadge>
                    <span class="font-mono text-[11px] text-zinc-400">{$_('routeEditor.review.url')}: {route.redirect.url} ({$_('routeEditor.review.status')}: {route.redirect.status ?? 302})</span>
                  </div>
                {/if}
                {#if route.response_rules && route.response_rules.some((r) => r.enabled)}
                  <div>
                    <span class="nx-label-sm block mb-1.5">{$_('routeEditor.review.responseRules')}</span>
                    <div class="space-y-1">
                      {#each route.response_rules.filter((r) => r.enabled) as rule}
                        <div class="border border-carbon-600 bg-carbon-900/60 px-2 py-1 flex justify-between items-center font-mono text-[11px]">
                          <span class="text-zinc-200">{rule.path} ({rule.match_type ?? 'exact'})</span>
                          <StatusBadge variant="muted">{rule.type}</StatusBadge>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}
                {#if !route.direct_response?.enabled && !route.redirect?.enabled && (!route.response_rules || !route.response_rules.some((r) => r.enabled))}
                  <span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">— {$_('routeEditor.review.noResponseRules')}</span>
                {/if}
              </div>
            </PanelCard>
          </div>
        {/if}
      </section>
    </div>
  {/if}

  <!-- ===== Bottom action bar ==================================== -->
  <div class="fixed bottom-0 left-0 right-0 bg-carbon-950 border-t border-carbon-600 shadow-industrial-lg z-40">
    <div class="max-w-7xl mx-auto px-6 py-3">
      <div class="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div class="flex items-center gap-4 min-w-0">
          {#if allErrors.length > 0}
            <div class="flex items-center gap-2 min-w-0">
              <StatusDot status="danger" />
              <span class="font-mono text-[11px] uppercase tracking-command text-red-300">
                {allErrors.length} {$_('validation.errors')}
              </span>
              <button class="font-mono text-[10px] uppercase tracking-command text-zinc-400 hover:text-nexus-300 hover:underline transition-colors" on:click={() => (showValidationDetails = !showValidationDetails)} data-testid="route-validation-toggle">
                [{showValidationDetails ? $_('common.hide') : $_('common.show')}]
              </button>
            </div>
          {:else if isValid}
            <div class="flex items-center gap-2">
              <StatusDot status="ok" />
              <span class="font-mono text-[11px] uppercase tracking-command text-emerald-300">
                {$_('validation.allGood')}
              </span>
            </div>
          {/if}
          {#if lastAutoSave && !isEditMode}
            <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500 hidden md:inline">
              {$_('autosave.lastSaved')}: {formatRelativeTime(lastAutoSave)}
            </span>
          {/if}
        </div>

        <div class="flex items-center gap-2">
          <button class="nx-btn-ghost" on:click={handleCancel} disabled={saving}>
            {$_('common.cancel')}
          </button>
          <button class="nx-btn-primary" disabled={!isValid || saving} on:click={handleSave} data-testid="route-save-button">
            {#if saving}
              <LoadingIndicator label="" size="xs" centered={false} />
            {:else}
              <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
                <path stroke-linecap="round" stroke-linejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
              </svg>
            {/if}
            {$_('common.save')}
          </button>
        </div>
      </div>

      {#if showValidationDetails && allErrors.length > 0}
        <div class="mt-3 border border-red-500/40 bg-red-500/5 px-3 py-2" data-testid="route-validation-message">
          <ul class="space-y-1">
            {#each allErrors as err}
              <li class="flex items-start gap-2 font-mono text-[11px]">
                <span class="text-red-400">×</span>
                <span class="text-red-200">{err.field}:</span>
                <span class="text-zinc-400">{err.message}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  </div>

  <!-- Templates modal -->
  <RouteTemplates bind:showTemplates on:select={handleTemplateSelect} />

  <!-- Confirm dialog -->
  <ConfirmDialog
    bind:open={showConfirmDialog}
    title={confirmDialogTitle}
    message={confirmDialogMessage}
    confirmText={$_('confirmDialog.yes')}
    cancelText={$_('confirmDialog.no')}
  confirmClass="nx-btn-primary"
    on:confirm={handleConfirmYes}
    on:cancel={handleConfirmNo}
  />
</div>
