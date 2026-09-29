<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { pop, querystring } from 'svelte-spa-router';
  import { sortBy } from 'lodash-es';
  import { resolveRouteEndpoints, RoutesAPI, RouteStaleError } from '$api/routes';
  import { ConfigurationStaleError } from '$api/config';
  import { consumeRouteSourceHandoff, prepareRouteSourceHandoff, RouteSourceHandoffError, type RouteSourceHandoffErrorCode } from '$api/source-handoff';
  import type { RouteV2 } from '@jeffusion/bungee-types';
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
  import { isLoading } from 'svelte-i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import { v4 as uuidv4 } from 'uuid';
  import { getModifierKey, isModifierPressed } from '$utils/platform';
  import { DEFAULT_REQUEST_MS } from '$utils/route-timeouts';
  import { LoadingIndicator, PanelCard, StatusBadge, StatusDot } from '$components/industrial';

  let { params = {} }: { params?: { path?: string } } = $props();
  const handoffText = (key: string) => $isLoading ? '' : getPluginText(key, 'chatgpt-oauth', $_);
  const handoffErrorKeys: Record<RouteSourceHandoffErrorCode, string> = {
    invalid_handoff: 'ui.routeHandoffInvalid',
    route_changed: 'ui.routeHandoffChanged',
    unsupported_target: 'ui.routeHandoffUnsupported',
    source_unavailable: 'ui.routeHandoffSourceUnavailable',
    account_unavailable: 'ui.routeHandoffAccountUnavailable',
  };
  const handoffErrorText = (error: unknown) => {
    const code = error instanceof RouteSourceHandoffError ? error.code : error === 'invalid_handoff' ? 'invalid_handoff' : null;
    return handoffText(code ? handoffErrorKeys[code] : 'ui.routeDraftError');
  };
  const lifetime = new AbortController();
  let baseline: RouteV2 | null = $state.raw(null);
  let conflictMessage = $state(''), handoffMessage = $state('');
  let handoffError = $state.raw<unknown>(null);
  let reloading = $state(false);
  let handoffDraft = false;
  let editorPath = '';
  const currentEditor = () => !lifetime.signal.aborted && window.location.hash.slice(1).split('?')[0] === editorPath;

  let isEditMode = $state(false);
  let originalPath = $state('');
  let loading = $state(true);
  let saving = $state(false);
  let showTemplates = $state(false);
  type RouteEditorSection = 'match' | 'target' | 'forward' | 'processing' | 'policy' | 'response' | 'plugins' | 'review';
  let activeSection = $state<RouteEditorSection>('match');
  let showValidationDetails = $state(false);

  function isRouteEditorSection(value: string | null): value is RouteEditorSection {
    const valid: RouteEditorSection[] = ['match', 'target', 'forward', 'processing', 'policy', 'response', 'plugins', 'review'];
    return value !== null && (valid as string[]).includes(value);
  }

  $effect(() => {
    if ($querystring) {
      const p = new URLSearchParams($querystring);
      const s = p.get('section');
      if (isRouteEditorSection(s)) activeSection = s;
    }
  });

  let route = $state<Route>({
    path: '',
    endpoints: [{ _uid: uuidv4(), target: '', weight: 100, priority: 1 }],
    headers: { add: {}, remove: [], replace: {} },
    body: { add: {}, remove: [], replace: {}, default: {} },
    query: { add: {}, remove: [], replace: {}, default: {} },
    plugins: [],
  });
  let pendingRestore = $state.raw<{ draft: Route; initialRoute: string } | null>(null);

  $effect(() => {
    const pending = pendingRestore;
    if (!pending) return;
    if (!currentEditor() || isEditMode || handoffDraft || JSON.stringify(route) !== pending.initialRoute) {
      pendingRestore = null;
      return;
    }
    if (loading || $isLoading) return;
    pendingRestore = null;
    showConfirm(
      $_('confirmDialog.restoreDraftTitle'),
      $_('confirmDialog.restoreDraftMessage'),
      () => {
        if (currentEditor() && !isEditMode && !handoffDraft && JSON.stringify(route) === pending.initialRoute) {
          route = normalizeRoute(pending.draft);
        }
      }
    );
  });

  let services = $state<Service[]>([]);
  let resolvedEndpoints = $derived(resolveRouteEndpoints(route, services));

  let errors = $state<ValidationError[]>([]);
  let weightErrors = $state<ValidationError[]>([]);
  let allErrors = $state<ValidationError[]>([]);
  let isValid = $state(false);

  let lastAutoSave = $state<number | null>(null);
  let autoSaveInterval: any = null;

  // Confirm dialog state
  let showConfirmDialog = $state(false);
  let confirmDialogTitle = $state('');
  let confirmDialogMessage = $state('');
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
    if (event.defaultPrevented || (event.target as HTMLElement | null)?.closest('[role="dialog"]')) return;
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      if (isValid && !saving && !loading && !reloading && !conflictMessage) void handleSave();
    }
    if (event.key === 'Escape') handleCancel();
    if (event.key >= '1' && event.key <= '8' && isModifierPressed(event) && !event.altKey) {
      const target = navItems[parseInt(event.key) - 1]?.id;
      if (target && !(event.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable], [role="textbox"], [role="combobox"]')) { activeSection = target; event.preventDefault(); }
    }
  }
  function cancelPendingRestoreOnNavigation() {
    if (!currentEditor()) pendingRestore = null;
  }

  function autoSaveDraft() {
    if (!isEditMode && !loading && !pendingRestore && !showConfirmDialog && currentEditor()) {
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

  $effect(() => {
    if ($isLoading) return;
    JSON.stringify(route); JSON.stringify(services);
    const timer = setTimeout(() => void performValidation(), 300);
    return () => clearTimeout(timer);
  });

  async function handleSave() {
    if (!isValid || saving || loading || reloading || conflictMessage || !currentEditor()) {
      toast.show($_('routeEditor.saveFailed', { values: { error: $_('common.error') } }), 'error');
      return;
    }
    try {
      saving = true;
      // Debounced form validation may not have run for the latest keystroke.
      await performValidation();
      if (!isValid) {
        if (allErrors.some((error) => error.field.startsWith('timeouts.'))) activeSection = 'forward';
        return;
      }
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
        if (!baseline) throw new Error(handoffText('ui.routeStale'));
        await RoutesAPI.update(originalPath, sortedRoute, baseline);
        toast.show($_('routeEditor.routeUpdated'), 'success');
      } else {
        await RoutesAPI.create(sortedRoute);
        toast.show($_('routeEditor.routeSaved'), 'success');
        localStorage.removeItem('bungee-route-draft');
      }
      if (currentEditor()) pop();
    } catch (e: any) {
      if (e instanceof RouteStaleError || e instanceof ConfigurationStaleError) {
        if (isEditMode) {
          conflictMessage = handoffText('ui.routeStale');
          toast.show(conflictMessage, 'error');
        } else {
          // Create has no persisted route to reload. Keep the draft and let the
          // next explicit save read a fresh configuration snapshot.
          toast.show(handoffText('ui.routeSaveError'), 'error');
        }
        return;
      }
      toast.show(handoffDraft ? handoffText('ui.routeSaveError') : $_('routeEditor.saveFailed', { values: { error: e.message } }), 'error');
    } finally {
      saving = false;
    }
  }

  function handleCancel() {
    showConfirm($_('confirmDialog.cancelTitle'), $_('confirmDialog.cancelMessage'), () => pop());
  }

  function normalizeRoute(loaded: Route): Route {
    return {
      ...loaded,
      headers: loaded.headers || { add: {}, remove: [], replace: {} },
      body: loaded.body || { add: {}, remove: [], replace: {}, default: {} },
      query: loaded.query || { add: {}, remove: [], replace: {}, default: {} },
      plugins: loaded.plugins || [],
      endpoints: loaded.endpoints?.map(u => ({
        ...u, _uid: u._uid ?? uuidv4(),
        headers: u.headers || { add: {}, remove: [], default: {} },
        body: u.body || { add: {}, remove: [], replace: {}, default: {} },
        query: u.query || { add: {}, remove: [], replace: {}, default: {} },
      })),
    };
  }

  async function loadExistingRoute() {
    const loaded = await RoutesAPI.getForEdit(originalPath, baseline?.id);
    if (!loaded) throw new Error(handoffText('ui.routeStale'));
    if (!currentEditor()) return;
    baseline = loaded.baseline;
    originalPath = loaded.route.path;
    route = normalizeRoute(loaded.route);
    conflictMessage = ''; handoffMessage = '';
  }

  function requestReload() {
    showConfirm(handoffText('ui.routeReloadTitle'), handoffText('ui.routeReloadConfirm'), async () => {
      reloading = true;
      try { await loadExistingRoute(); }
      catch { if (currentEditor()) conflictMessage = handoffText('ui.routeStale'); }
      finally { reloading = false; }
    });
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
    const hash = window.location.hash.slice(1), queryStart = hash.indexOf('?');
    editorPath = queryStart < 0 ? hash : hash.slice(0, queryStart);
    const query = queryStart < 0 ? '' : hash.slice(queryStart + 1);
    const consumed = consumeRouteSourceHandoff(query);
    handoffDraft = !!consumed.handoff || !!consumed.error;
    if (consumed.query !== query) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#${editorPath}${consumed.query ? `?${consumed.query}` : ''}`);
    if (consumed.error) handoffError = consumed.error;
    window.addEventListener('keydown', handleKeydown);
    window.addEventListener('hashchange', cancelPendingRestoreOnNavigation);
    autoSaveInterval = setInterval(() => autoSaveDraft(), 30000);
    try { const loadedServices = await ServicesAPI.list(); if (currentEditor()) services = loadedServices; }
    catch { if (currentEditor()) toast.show('无法加载服务，请刷新后重试。', 'error'); }
    if (!currentEditor()) return;

    if (params.path) {
      isEditMode = true;
      originalPath = decodeURIComponent(params.path);
      try {
        await loadExistingRoute();
      } catch (e: any) {
        if (!currentEditor()) return;
        toast.show(handoffDraft ? handoffErrorText(e) : $_('routeEditor.saveFailed', { values: { error: e.message } }), 'error');
        pop();
        return;
      }
    } else if (!handoffDraft) {
      try {
        const draft = localStorage.getItem('bungee-route-draft');
        if (draft) {
          const parsedDraft = JSON.parse(draft);
          pendingRestore = { draft: parsedDraft, initialRoute: JSON.stringify(route) };
        }
      } catch (e) {
        toast.show(e instanceof Error ? e.message : '无法加载路由草稿。', 'error');
      }
    }
    let focusIndex = -1;
    if (consumed.handoff && (!isEditMode || baseline) && currentEditor()) {
      const before = JSON.stringify(route);
      try {
        const result = await prepareRouteSourceHandoff(JSON.parse(before), consumed.handoff, lifetime.signal);
        if (!currentEditor()) return;
        if (JSON.stringify(route) !== before) throw new RouteSourceHandoffError('route_changed');
        route = normalizeRoute(result.route);
        focusIndex = result.index;
        activeSection = 'target';
        handoffMessage = handoffText(result.duplicate ? 'ui.routeDraftExisting' : 'ui.routeDraftAdded');
      } catch (error) {
        if (currentEditor()) handoffError = error;
      }
    }
    if (!currentEditor()) return;
    loading = false;
    if (focusIndex >= 0) {
      await tick();
      if (currentEditor()) {
        // The list is displayed by priority, while handoff.index refers to the original array.
        const selected = route.endpoints?.[focusIndex];
        const visibleIndex = [...(route.endpoints ?? [])].map((endpoint, index) => ({ endpoint, index }))
          .sort((a, b) => (a.endpoint.priority ?? 1) - (b.endpoint.priority ?? 1))
          .findIndex(item => item.index === focusIndex);
        const rows = document.querySelectorAll<HTMLElement>('[data-testid="route-target-section"] [role="listitem"][draggable="true"]');
        const button = rows[visibleIndex]?.querySelector<HTMLElement>('[data-testid="upstream-edit-button"]');
        if (selected && button) { button.scrollIntoView({ block: 'center' }); button.focus(); }
      }
    }
  });

  onDestroy(() => {
    lifetime.abort();
    pendingRestore = null;
    window.removeEventListener('keydown', handleKeydown);
    window.removeEventListener('hashchange', cancelPendingRestoreOnNavigation);
    if (autoSaveInterval) clearInterval(autoSaveInterval);
  });

  // Navigation items
  let navItems = $derived(loading || $isLoading ? [] : ([
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
      id: 'forward'    as RouteEditorSection,
      label: $_('routeEditor.builder.forward'),
      icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
      badge: (route.timeouts?.request_ms !== undefined || route.timeouts?.first_response_ms !== undefined || route.retry?.enabled) ? '✓' : '',
    },
    {
      id: 'processing' as RouteEditorSection,
      label: $_('routeEditor.builder.processing'),
      icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
      badge: '',
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
  ]));
</script>

<div class="min-h-screen flex flex-col">
  <!-- ===== Breadcrumb ============================================ -->
  <div class="border-b border-carbon-600 bg-carbon-900/70 backdrop-blur sticky top-16 z-30">
    <div class="nx-page py-3">
      <nav class="flex items-center gap-2 font-mono text-[11px] uppercase tracking-command">
        <button type="button" class="text-zinc-500 hover:text-nexus-300 transition-colors" onclick={() => (window.location.hash = '/')}>
          {$_('breadcrumb.home')}
        </button>
        <span class="text-zinc-700">/</span>
        <button type="button" class="text-zinc-500 hover:text-nexus-300 transition-colors" onclick={() => (window.location.hash = '/routes')}>
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
    <div class="nx-page flex flex-col lg:flex-row gap-4 py-4 sm:py-6">
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
                    onclick={() => (activeSection = item.id)}
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
            <button class="nx-btn-ghost w-full justify-center" onclick={() => (showTemplates = true)}>
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
                <kbd class="nx-kbd">{getModifierKey()}</kbd><span class="text-zinc-600">+</span><kbd class="nx-kbd">1-8</kbd>
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
        {#if handoffMessage}<div role="status" class="border-l-2 border-nexus-500 bg-carbon-800 px-3 py-2 text-sm text-zinc-200" data-testid="route-handoff-notice">{handoffMessage}</div>{/if}
        {#if handoffError && !$isLoading}<div role="alert" class="border-l-2 border-amber-500 bg-carbon-800 px-3 py-2 text-sm text-amber-300" data-testid="route-handoff-error">{handoffErrorText(handoffError)}</div>{/if}
        {#if conflictMessage}<div role="alert" class="flex flex-wrap items-center gap-3 border-l-2 border-amber-500 bg-carbon-800 px-3 py-2 text-sm text-amber-300" data-testid="route-stale-warning"><span class="flex-1">{conflictMessage}</span><button type="button" class="nx-btn-ghost nx-btn-sm" disabled={reloading} onclick={requestReload}>{handoffText('ui.routeReload')}</button></div>{/if}
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
            <div data-testid="route-target-section" data-testid-section="target" class="space-y-4">
              <UpstreamTargetSection
                bind:route
                {errors}
                {weightErrors}
                bind:services
                on:navigatetosection={(e) => (activeSection = e.detail.section as RouteEditorSection)}
              />
            </div>
          </PanelCard>

        {:else if activeSection === 'forward'}
          <div data-testid="section-forward" class="space-y-4">
            <PanelCard title={$_('routeEditor.timeoutSettings')} tag="TO-01">
              <BasicInfoSection bind:route {errors} showOnly="timeouts" />
            </PanelCard>

            <PanelCard title={$_('routeEditor.retry')} tag={route.retry?.enabled ? 'ENABLED' : 'IDLE'} stripe={route.retry?.enabled ? 'orange' : 'zinc'}>
              <RetrySection bind:route />
            </PanelCard>
          </div>

        {:else if activeSection === 'processing'}
          <div data-testid="section-processing" class="space-y-4">
            <PanelCard title={$_('routeEditor.builder.processing')} tag="MOD">
              <ModificationSection bind:route />
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

            <PanelCard title={$_('routeEditor.review.requestConfiguration')} tag="REVIEW">
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
                  <span class="nx-label-sm block mb-1.5">{$_('routeEditor.builder.forward')}</span>
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <span class="nx-field-label block mb-1">{$_('routeEditor.requestTimeoutMs')}</span>
                      <span class="nx-display text-sm text-zinc-200">{route.timeouts?.request_ms ?? DEFAULT_REQUEST_MS}</span>
                      {#if route.timeouts?.request_ms === undefined}<span class="ml-2 text-sm text-zinc-400">{$_('routeEditor.review.defaultValue')}</span>{/if}
                    </div>
                    <div>
                      <span class="nx-field-label block mb-1">{$_('routeEditor.firstResponseMs')}</span>
                      {#if route.timeouts?.first_response_ms !== undefined}
                        <span class="nx-display text-sm text-zinc-200">{route.timeouts.first_response_ms}</span>
                      {:else}
                        <span class="text-sm text-zinc-400">{$_('routeEditor.review.noAdditionalHeaderDeadline')}</span>
                      {/if}
                    </div>
                  </div>
                  <div class="mt-2">
                    {#if route.retry?.enabled}<StatusBadge variant="active" dot>{$_('routeEditor.review.retry')}</StatusBadge>{:else}<StatusBadge variant="muted">{$_('routeEditor.review.retry')}</StatusBadge>{/if}
                  </div>
                </div>

                <div>
                  <span class="nx-label-sm block mb-1.5">{$_('routeEditor.builder.policy')}</span>
                  <div class="flex flex-wrap gap-1.5">
                    {#if route.auth?.enabled}<StatusBadge variant="active" dot>{$_('routeEditor.review.auth')}</StatusBadge>{:else}<StatusBadge variant="muted">{$_('routeEditor.review.auth')}</StatusBadge>{/if}
                    {#if route.cors?.enabled}<StatusBadge variant="active" dot>{$_('routeEditor.review.cors')}</StatusBadge>{:else}<StatusBadge variant="muted">{$_('routeEditor.review.cors')}</StatusBadge>{/if}
                    {#if route.rate_limit?.enabled}<StatusBadge variant="active" dot>{$_('routeEditor.review.rateLimit')}</StatusBadge>{:else}<StatusBadge variant="muted">{$_('routeEditor.review.rateLimit')}</StatusBadge>{/if}
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
    <div class="nx-page py-3">
      <div class="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div class="flex items-center gap-4 min-w-0">
          {#if allErrors.length > 0}
            <div class="flex items-center gap-2 min-w-0">
              <StatusDot status="danger" />
              <span class="font-mono text-[11px] uppercase tracking-command text-red-300">
                {allErrors.length} {$_('validation.errors')}
              </span>
              <button class="font-mono text-[10px] uppercase tracking-command text-zinc-400 hover:text-nexus-300 hover:underline transition-colors" onclick={() => (showValidationDetails = !showValidationDetails)} data-testid="route-validation-toggle">
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
          <button class="nx-btn-ghost" onclick={handleCancel} disabled={saving}>
            {$_('common.cancel')}
          </button>
          <button class="nx-btn-primary" disabled={!isValid || saving || loading || reloading || !!conflictMessage} onclick={handleSave} data-testid="route-save-button">
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
  {#if showConfirmDialog}
    <ConfirmDialog
      open={true}
      title={confirmDialogTitle}
      message={confirmDialogMessage}
      confirmText={$_('confirmDialog.yes')}
      cancelText={$_('confirmDialog.no')}
      confirmClass="nx-btn-primary"
      on:confirm={handleConfirmYes}
      on:cancel={handleConfirmNo}
    />
  {/if}
</div>
