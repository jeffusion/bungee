<script lang="ts">
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { _ } from '$i18n';
  import { resolveRouteEndpoints, RoutesAPI } from '$api/routes';
  import type { Route, Service } from '$api/routes';
  import { getConfig } from '$api/config';
  import ConfirmDialog from '$components/shell/ConfirmDialog.svelte';
  import FeatureBadge from '$components/domain/route/FeatureBadge.svelte';
  import { toast } from '$stores/toast';
  import {
    getRouteTargetSummary,
    getRouteFeatureBadges,
    getServiceHealthAggregate,
  } from '$utils/route-service-view-model';
  import type {
    RouteTargetSummaryKind,
    RouteFeatureBadgeSection,
    ServiceHealthAggregate,
  } from '$utils/route-service-view-model';
	import {
		PanelCard,
		KpiCard,
		StatusDot,
		StatusBadge,
		IconButton,
		LoadingIndicator,
		BSelect,
	} from '$components/industrial';
	import { Input } from '$components/ui/input';
	import { Button } from '$components/ui/button';

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  let routes: Route[] = [];
  let services: Service[] = [];
  let loading = true;
  let error: string | null = null;
  let searchQuery = '';

  let filterTargetType: 'all' | RouteTargetSummaryKind = 'all';
  let filterFeature: 'all' | RouteFeatureBadgeSection = 'all';
  let filterHealth: 'all' | ServiceHealthAggregate['state'] = 'all';

  let isInitialLoad = true;
  let showDeleteDialog = false;
  let routeToDelete: Route | null = null;
  let deletingPaths = new Set<string>();
  let duplicatingPaths = new Set<string>();
  let importing = false;

  // ------------------------------------------------------------------
  // Data loading
  // ------------------------------------------------------------------
  async function loadRoutes(silent = false) {
    const shouldShowLoading = !silent && isInitialLoad;
    try {
      if (shouldShowLoading) loading = true;
      const [loadedRoutes, config] = await Promise.all([RoutesAPI.list(), getConfig()]);
      routes = loadedRoutes;
      services = config.services ?? [];
      error = null;
      isInitialLoad = false;
    } catch (e: any) {
      error = e.message;
      if (!silent) toast.show(e.message, 'error');
    } finally {
      if (shouldShowLoading) loading = false;
    }
  }

  // ------------------------------------------------------------------
  // CRUD handlers
  // ------------------------------------------------------------------
  function handleCreate() {
    push('/routes/new');
  }

  async function handleDelete(route: Route) {
    routeToDelete = route;
    showDeleteDialog = true;
  }

  async function confirmDelete() {
    if (!routeToDelete) return;
    deletingPaths.add(routeToDelete.path);
    deletingPaths = deletingPaths;
    try {
      await RoutesAPI.delete(routeToDelete.path);
      toast.show($_('routes.deleted', { values: { path: routeToDelete.path } }), 'success');
      await loadRoutes();
    } catch (e: any) {
      toast.show($_('routes.deleteFailed', { values: { error: e.message } }), 'error');
    } finally {
      deletingPaths.delete(routeToDelete.path);
      deletingPaths = deletingPaths;
      routeToDelete = null;
    }
  }

  function cancelDelete() {
    routeToDelete = null;
  }

  async function handleDuplicate(route: Route) {
    duplicatingPaths.add(route.path);
    duplicatingPaths = duplicatingPaths;
    try {
      await RoutesAPI.duplicate(route.path);
      toast.show($_('routes.duplicated', { values: { path: route.path } }), 'success');
      await loadRoutes();
    } catch (e: any) {
      toast.show($_('routes.duplicateFailed', { values: { error: e.message } }), 'error');
    } finally {
      duplicatingPaths.delete(route.path);
      duplicatingPaths = duplicatingPaths;
    }
  }

  function handleExportAll() {
    if (routes.length === 0) {
      toast.show($_('routes.noRoutesToExport'), 'warning');
      return;
    }
    const dataStr = JSON.stringify(routes, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
    const filename = `bungee-routes-${new Date().toISOString().split('T')[0]}.json`;
    const a = document.createElement('a');
    a.setAttribute('href', dataUri);
    a.setAttribute('download', filename);
    a.click();
    toast.show($_('routes.exported'), 'success');
  }

  function handleImportRoutes() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e: any) => {
      const file = e.target.files[0];
      if (!file) return;
      importing = true;
      try {
        const text = await file.text();
        const imported = JSON.parse(text);
        if (!Array.isArray(imported)) throw new Error($_('routes.importMustBeArray'));
        let successCount = 0, failCount = 0;
        for (const route of imported) {
          try { await RoutesAPI.create(route); successCount++; }
          catch (err: any) { failCount++; console.error(`Failed to import route ${route.path}:`, err); }
        }
        if (successCount > 0) {
          const msg = failCount > 0
            ? $_('routes.importPartialSuccess', { values: { success: successCount, failed: failCount } })
            : $_('routes.importSuccess', { values: { success: successCount } });
          toast.show(msg, 'success');
          await loadRoutes();
        } else {
          toast.show($_('routes.importFailed', { values: { error: `${failCount} routes failed` } }), 'error');
        }
      } catch (err: any) {
        toast.show($_('routes.importFailed', { values: { error: err.message } }), 'error');
      } finally {
        importing = false;
      }
    };
    input.click();
  }

  // ------------------------------------------------------------------
  // Derived data
  // ------------------------------------------------------------------
  function getRouteHealthAggregate(route: Route, services: Service[]): ServiceHealthAggregate {
    const target = getRouteTargetSummary(route, services);
    if (target.kind === 'direct_response') {
      return { total: 0, healthy: 0, halfOpen: 0, unhealthy: 0, disabled: 0, state: 'neutral' };
    }
    if (target.kind === 'service') {
      const service = services.find((s) => s.name === target.serviceName);
      if (service) return getServiceHealthAggregate(service);
      return { total: 0, healthy: 0, halfOpen: 0, unhealthy: 0, disabled: 0, state: 'unhealthy' };
    }
    if (target.kind === 'custom_endpoints') {
      const endpoints = route.endpoints ?? [];
      if (endpoints.length === 0) return { total: 0, healthy: 0, halfOpen: 0, unhealthy: 0, disabled: 0, state: 'empty' };
      const agg = endpoints.reduce<ServiceHealthAggregate>(
        (acc, ep) => {
          if (ep.is_disabled) { acc.disabled += 1; return acc; }
          const status = ep.status ?? 'HEALTHY';
          if (status === 'UNHEALTHY') acc.unhealthy += 1;
          else if (status === 'HALF_OPEN') acc.halfOpen += 1;
          else acc.healthy += 1;
          return acc;
        },
        { total: endpoints.length, healthy: 0, halfOpen: 0, unhealthy: 0, disabled: 0, state: 'neutral' }
      );
      const active = agg.total - agg.disabled;
      if (active === 0) agg.state = 'neutral';
      else if (agg.unhealthy > 0) agg.state = 'unhealthy';
      else if (agg.halfOpen > 0) agg.state = 'degraded';
      else agg.state = 'healthy';
      return agg;
    }
    return { total: 0, healthy: 0, halfOpen: 0, unhealthy: 0, disabled: 0, state: 'empty' };
  }

  $: filteredRoutes = routes.filter((route) => {
    const target = getRouteTargetSummary(route, services);
    const badges = getRouteFeatureBadges(route);
    const healthAgg = getRouteHealthAggregate(route, services);
    const endpoints = resolveRouteEndpoints(route, services);
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      route.path.toLowerCase().includes(q) ||
      (route.service?.toLowerCase().includes(q) ?? false) ||
      endpoints.some((u) => u.target.toLowerCase().includes(q));
    const matchesTargetType = filterTargetType === 'all' || target.kind === filterTargetType;
    const matchesFeature = filterFeature === 'all' || badges.some((b) => b.section === filterFeature);
    const matchesHealth = filterHealth === 'all' || healthAgg.state === filterHealth;
    return matchesSearch && matchesTargetType && matchesFeature && matchesHealth;
  });

  $: uniqueServiceRefsCount = new Set(
    routes
      .map((r) => getRouteTargetSummary(r, services))
      .filter((t) => t.kind === 'service' && t.serviceName)
      .map((t) => t.serviceName)
  ).size;

  $: healthyRoutesCount = routes.filter((r) => {
    const s = getRouteHealthAggregate(r, services).state;
    return s === 'healthy' || s === 'neutral';
  }).length;

  $: featuredRoutesCount = routes.filter((r) => getRouteFeatureBadges(r).length > 0).length;

  $: anyFiltersActive =
    !!searchQuery ||
    filterTargetType !== 'all' ||
    filterFeature !== 'all' ||
    filterHealth !== 'all';

  function clearFilters() {
    searchQuery = '';
    filterTargetType = 'all';
    filterFeature = 'all';
    filterHealth = 'all';
  }

  // ------------------------------------------------------------------
  // Feature → editor section deep-link
  // ------------------------------------------------------------------
  function getEditorSectionForFeature(section: string): string {
    if (section === 'retry' || section === 'modification') return 'processing';
    if (section === 'auth' || section === 'rateLimit' || section === 'cors') return 'policy';
    if (section === 'directResponse') return 'response';
    if (section === 'plugins') return 'plugins';
    return 'match';
  }

  function gotoFeature(routePath: string, section: string) {
    const targetSection = getEditorSectionForFeature(section);
    push(`/routes/edit/${encodeURIComponent(routePath)}?section=${targetSection}`);
  }

  // ------------------------------------------------------------------
  // Status helpers
  // ------------------------------------------------------------------
  type HealthState = ServiceHealthAggregate['state'];
  const healthDotStatus: Record<HealthState, 'ok' | 'warn' | 'danger' | 'idle' | 'accent'> = {
    healthy: 'ok',
    degraded: 'warn',
    unhealthy: 'danger',
    neutral: 'idle',
    empty: 'idle',
  };
  const healthTextClass: Record<HealthState, string> = {
    healthy: 'text-emerald-300',
    degraded: 'text-amber-300',
    unhealthy: 'text-red-300',
    neutral: 'text-zinc-500',
    empty: 'text-zinc-500',
  };
  function healthLabel(s: HealthState): string {
    if (s === 'healthy') return 'HEALTHY';
    if (s === 'degraded') return 'DEGRADED';
    if (s === 'unhealthy') return 'FAULT';
    if (s === 'neutral') return 'N/A';
    return 'EMPTY';
  }

  onMount(() => {
    loadRoutes();
    const refreshInterval = setInterval(() => loadRoutes(true), 5000);
    return () => clearInterval(refreshInterval);
  });
</script>

<div class="px-6 py-5 space-y-5" data-testid="page-routes">
  <!-- ===== Page header ============================================= -->
  <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
    <div class="flex items-center gap-3">
      <span class="nx-stripe" aria-hidden="true"></span>
      <div class="flex flex-col leading-tight">
        <span class="nx-label">// {$_('routes.subtitle')}</span>
        <h1 class="nx-display text-xl text-zinc-50 tracking-[0.02em]">
          {$_('routes.title')}
        </h1>
      </div>
    </div>

    <div class="flex items-center gap-2">
      <IconButton title={$_('routes.export')} on:click={handleExportAll}>
        <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
      </IconButton>
      <IconButton title={$_('routes.import')} on:click={handleImportRoutes} disabled={importing}>
        {#if importing}
          <LoadingIndicator label="" size="xs" centered={false} />
        {:else}
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
        {/if}
      </IconButton>
      <button class="nx-btn-primary" on:click={handleCreate} data-testid="route-new-button">
        <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        {$_('routes.newRoute')}
      </button>
    </div>
  </div>

  <!-- ===== KPI strip ============================================== -->
  <section class="grid grid-cols-2 lg:grid-cols-4 gap-3">
    <KpiCard label={$_('routes.kpi.totalRoutes')} value={routes.length} unit="ROUTES">
      <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-zinc-500" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
      </svg>
    </KpiCard>

    <KpiCard label={$_('routes.kpi.linkedServices')} value={uniqueServiceRefsCount} unit="UNITS">
      <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-zinc-500" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
      </svg>
    </KpiCard>

    <KpiCard
      label={$_('routes.kpi.healthyRoutes')}
      value={healthyRoutesCount}
      unit={`/ ${routes.length}`}
      tone={healthyRoutesCount === routes.length && routes.length > 0 ? 'ok' : 'auto'}
      stripe={healthyRoutesCount < routes.length ? 'amber' : 'orange'}
    >
      <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-zinc-500" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    </KpiCard>

    <KpiCard label={$_('routes.kpi.featuredRoutes')} value={featuredRoutesCount} unit="WITH-FX">
      <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-zinc-500" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    </KpiCard>
  </section>

	<!-- ===== Filters panel ========================================== -->
	<PanelCard title={$_('routes.filters.label')} tag="FILTER" flush>
	<div class="px-4 py-3 grid grid-cols-1 lg:grid-cols-[1fr_auto_auto_auto_auto] gap-3 items-end">
	<!-- Search -->
	<div class="block">
		<label class="mb-1.5 block font-mono text-[10px] uppercase tracking-command text-zinc-500">// {$_('routes.searchPlaceholder')}</label>
		<div class="relative">
			<svg class="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
				<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
			</svg>
			<Input
				type="text"
				placeholder={$_('routes.searchPlaceholder')}
				class="pl-9"
				bind:value={searchQuery}
			/>
		</div>
	</div>

	<!-- Target type -->
	<div class="block">
		<label class="mb-1.5 block font-mono text-[10px] uppercase tracking-command text-zinc-500">// TARGET</label>
		<BSelect
			options={[
				{ value: 'all', label: $_('routes.filters.targetType.all') },
				{ value: 'service', label: $_('routes.filters.targetType.service') },
				{ value: 'custom_endpoints', label: $_('routes.filters.targetType.custom') },
				{ value: 'direct_response', label: $_('routes.filters.targetType.direct') },
				{ value: 'missing_service', label: $_('routes.filters.targetType.missing') },
				{ value: 'empty', label: $_('routes.filters.targetType.empty') },
			]}
			bind:value={filterTargetType}
			placeholder={$_('routes.filters.targetType.all')}
			ariaLabel="Filter by target type"
			autoWidth={true}
		/>
	</div>

	<!-- Feature -->
	<div class="block">
		<label class="mb-1.5 block font-mono text-[10px] uppercase tracking-command text-zinc-500">// FEATURE</label>
		<BSelect
			options={[
				{ value: 'all', label: $_('routes.filters.feature.all') },
				{ value: 'auth', label: $_('routeFeatures.auth') },
				{ value: 'cors', label: $_('routeFeatures.cors') },
				{ value: 'rateLimit', label: $_('routeFeatures.rateLimit') },
				{ value: 'retry', label: $_('routeFeatures.retry') },
				{ value: 'directResponse', label: $_('routeFeatures.directResponse') },
				{ value: 'plugins', label: $_('routeFeatures.plugins') },
				{ value: 'modification', label: $_('routeFeatures.modification') },
			]}
			bind:value={filterFeature}
			placeholder={$_('routes.filters.feature.all')}
			ariaLabel="Filter by feature"
			autoWidth={true}
		/>
	</div>

	<!-- Health -->
	<div class="block">
		<label class="mb-1.5 block font-mono text-[10px] uppercase tracking-command text-zinc-500">// HEALTH</label>
		<BSelect
			options={[
				{ value: 'all', label: $_('routes.filters.health.all') },
				{ value: 'healthy', label: $_('routes.filters.health.healthy') },
				{ value: 'degraded', label: $_('routes.filters.health.degraded') },
				{ value: 'unhealthy', label: $_('routes.filters.health.unhealthy') },
				{ value: 'neutral', label: $_('routes.filters.health.neutral') },
				{ value: 'empty', label: $_('routes.filters.health.empty') },
			]}
			bind:value={filterHealth}
			placeholder={$_('routes.filters.health.all')}
			ariaLabel="Filter by health"
			autoWidth={true}
		/>
	</div>

	<!-- Reset -->
	<Button
		variant={anyFiltersActive ? 'destructive' : 'ghost'}
		onclick={clearFilters}
		disabled={!anyFiltersActive}
		class="h-[34px] font-mono text-[11px] uppercase tracking-command"
	>
		<svg viewBox="0 0 24 24" class="mr-1 h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
			<path stroke-linecap="round" stroke-linejoin="round" d="M4 4l16 16M20 4L4 20" />
		</svg>
		RESET
	</Button>
	</div>
	</PanelCard>

  <!-- ===== Inventory table ======================================== -->
  {#if loading}
    <PanelCard title={$_('routes.title')} tag="LOADING">
      <LoadingIndicator label="LOADING ROUTE INVENTORY" />
    </PanelCard>
  {:else if error}
    <PanelCard title={$_('common.error')} tag="ERR" stripe="red">
      <p class="font-mono text-xs uppercase tracking-command text-red-300">{error}</p>
    </PanelCard>
  {:else if filteredRoutes.length === 0}
    <PanelCard
      title={routes.length === 0 ? $_('routes.noRoutes') : $_('routes.noMatchingRoutes')}
      tag={routes.length === 0 ? 'EMPTY' : 'NO MATCH'}
      stripe={routes.length === 0 ? 'zinc' : 'amber'}
    >
      <div class="py-10 text-center space-y-4">
        <p class="text-sm text-zinc-400 max-w-md mx-auto">
          {routes.length === 0 ? $_('routes.noRoutesMessage') : $_('routes.noMatchingMessage')}
        </p>
        {#if routes.length === 0}
      <button class="nx-btn-primary" on:click={handleCreate} data-testid="route-new-button">
            <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            {$_('routes.createFirstRoute')}
          </button>
        {:else}
	<Button variant="ghost" onclick={clearFilters} class="font-mono text-[11px] uppercase tracking-command">RESET FILTERS</Button>
        {/if}
      </div>
    </PanelCard>
  {:else}
    <PanelCard
      title="ROUTE INVENTORY"
      tag="N={filteredRoutes.length}/{routes.length}"
      flush
    >
      <!-- ===== Desktop table ========================== -->
      <div class="hidden md:block">
        <table class="w-full" data-testid="route-rules-table">
          <thead class="border-b border-carbon-600 bg-carbon-900/60">
            <tr>
              <th class="text-left nx-label font-bold py-2.5 px-4 first:pl-6">{$_('routes.tableHeaders.route')}</th>
              <th class="text-left nx-label font-bold py-2.5 px-4">{$_('routes.tableHeaders.target')}</th>
              <th class="text-left nx-label font-bold py-2.5 px-4">{$_('routes.tableHeaders.features')}</th>
              <th class="text-left nx-label font-bold py-2.5 px-4">{$_('routes.tableHeaders.health')}</th>
              <th class="text-right nx-label font-bold py-2.5 px-4 last:pr-6">{$_('routes.tableHeaders.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {#each filteredRoutes as route}
              {@const target = getRouteTargetSummary(route, services)}
              {@const badges = getRouteFeatureBadges(route)}
              {@const healthAgg = getRouteHealthAggregate(route, services)}
              {@const service = target.kind === 'service' ? services.find((s) => s.name === target.serviceName) : null}
              <tr
                class="group border-b border-carbon-600/70 hover:bg-carbon-700/40 transition-colors"
                data-testid="route-row"
              >
                <!-- Path -->
                <td class="py-3 px-4 first:pl-6">
                  <button
                    class="inline-flex items-center gap-1.5 font-mono text-[12px] text-nexus-300 hover:text-nexus-200 hover:underline tracking-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nexus-500"
                    on:click={() => push(`/routes/edit/${encodeURIComponent(route.path)}`)}
                    data-testid="route-path-link"
                  >
                    <span class="nx-caret-left" aria-hidden="true"></span>
                    <span class="truncate max-w-[260px]">{route.path}</span>
                  </button>
                </td>

                <!-- Target -->
                <td class="py-3 px-4" data-testid="target-cell">
                  {#if target.kind === 'service'}
                    <div class="flex items-center gap-2">
                      <StatusDot status="ok" />
                      <button
                        class="font-mono text-[12px] text-zinc-200 hover:text-nexus-300 transition-colors"
                        on:click={() => push(`/services/edit/${encodeURIComponent(target.serviceName ?? '')}`)}
                      >
                        {target.serviceName}
                      </button>
                      <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
                        · {service?.endpoints?.length ?? '?'} EP
                      </span>
                    </div>
                  {:else if target.kind === 'missing_service'}
                    <div class="flex items-center gap-2">
                      <StatusDot status="danger" />
                      <span class="font-mono text-[12px] text-red-300">{target.serviceName}</span>
                      <StatusBadge variant="fault">MISSING</StatusBadge>
                    </div>
                  {:else if target.kind === 'custom_endpoints'}
                    <div class="flex items-center gap-2">
                      <StatusDot status="idle" />
                      <span class="font-mono text-[12px] uppercase tracking-command text-zinc-300">
                        {$_('routes.targetTypes.customEndpoints')}
                      </span>
                      <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
                        · {route.endpoints?.length ?? 0} EP
                      </span>
                    </div>
                  {:else if target.kind === 'direct_response'}
                    <div class="flex items-center gap-2">
                      <StatusDot status="accent" />
                      <span class="font-mono text-[12px] uppercase tracking-command text-nexus-300">
                        {$_('routes.targetTypes.directResponse')}
                      </span>
                    </div>
                  {:else}
                    <span class="font-mono text-[11px] uppercase tracking-command text-zinc-600">— EMPTY</span>
                  {/if}
                </td>

                <!-- Features -->
                <td class="py-3 px-4" data-testid="feature-cell">
                  {#if badges.length > 0}
                    <div class="flex flex-wrap gap-1 max-w-xs">
                      {#each badges as badge}
                        <FeatureBadge
                          {badge}
                          on:click={() => gotoFeature(route.path, badge.section)}
                        />
                      {/each}
                    </div>
                  {:else}
                    <span class="font-mono text-[11px] text-zinc-600">—</span>
                  {/if}
                </td>

                <!-- Health -->
                <td class="py-3 px-4" data-testid="health-cell">
                  {#if target.kind === 'direct_response'}
                    <div class="flex items-center gap-2">
                      <StatusDot status="idle" />
                      <span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">N/A</span>
                    </div>
                  {:else}
                    <div class="flex items-center gap-2">
                      <StatusDot status={healthDotStatus[healthAgg.state]} />
                      <span class="font-mono text-[11px] uppercase tracking-command {healthTextClass[healthAgg.state]}">
                        {healthLabel(healthAgg.state)}
                      </span>
                      {#if healthAgg.total > 0}
                        <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
                          · {healthAgg.healthy}/{healthAgg.total}
                        </span>
                      {/if}
                    </div>
                  {/if}
                </td>

                <!-- Actions -->
                <td class="py-3 px-4 last:pr-6 text-right">
                  <div
                    class="inline-flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
                    data-testid="action-controls"
                  >
                    <IconButton
                      size="sm"
                      title={$_('common.edit')}
                      on:click={() => push(`/routes/edit/${encodeURIComponent(route.path)}`)}
                    >
                      <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </IconButton>
                    <IconButton
                      size="sm"
                      title={$_('routeCard.duplicate')}
                      disabled={duplicatingPaths.has(route.path)}
                      on:click={() => handleDuplicate(route)}
                    >
                      {#if duplicatingPaths.has(route.path)}
                        <LoadingIndicator label="" size="xs" centered={false} />
                      {:else}
                        <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                        </svg>
                      {/if}
                    </IconButton>
                    <IconButton
                      size="sm"
                      variant="danger"
                      title={$_('common.delete')}
                      disabled={deletingPaths.has(route.path)}
                      on:click={() => handleDelete(route)}
                    >
                      {#if deletingPaths.has(route.path)}
                        <LoadingIndicator label="" size="xs" centered={false} />
                      {:else}
                        <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      {/if}
                    </IconButton>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <!-- ===== Mobile cards ============================ -->
      <div class="md:hidden divide-y divide-carbon-600" data-testid="route-rules-list">
        {#each filteredRoutes as route}
          {@const target = getRouteTargetSummary(route, services)}
          {@const badges = getRouteFeatureBadges(route)}
          {@const healthAgg = getRouteHealthAggregate(route, services)}
          {@const service = target.kind === 'service' ? services.find((s) => s.name === target.serviceName) : null}
          <div class="px-4 py-3 space-y-3" data-testid="route-row">
            <div class="flex items-start justify-between gap-3">
              <button
                class="inline-flex items-center gap-1.5 font-mono text-[12px] text-nexus-300 hover:text-nexus-200 hover:underline tracking-tight"
                on:click={() => push(`/routes/edit/${encodeURIComponent(route.path)}`)}
                data-testid="route-path-link"
              >
                <span class="nx-caret-left"></span>
                <span class="truncate max-w-[200px]">{route.path}</span>
              </button>
              <div class="inline-flex gap-1" data-testid="action-controls">
                <IconButton size="sm" title={$_('common.edit')} on:click={() => push(`/routes/edit/${encodeURIComponent(route.path)}`)}>
                  <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                </IconButton>
                <IconButton size="sm" title={$_('routeCard.duplicate')} on:click={() => handleDuplicate(route)} disabled={duplicatingPaths.has(route.path)}>
                  <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" /></svg>
                </IconButton>
                <IconButton size="sm" variant="danger" title={$_('common.delete')} on:click={() => handleDelete(route)} disabled={deletingPaths.has(route.path)}>
                  <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </IconButton>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3 text-[11px]">
              <div data-testid="target-cell">
                <span class="nx-label block mb-1">// {$_('routes.tableHeaders.target')}</span>
                {#if target.kind === 'service'}
                  <div class="flex items-center gap-1.5"><StatusDot status="ok" /><span class="font-mono text-zinc-200">{target.serviceName}</span></div>
                {:else if target.kind === 'missing_service'}
                  <div class="flex items-center gap-1.5"><StatusDot status="danger" /><span class="font-mono text-red-300">{target.serviceName} · MISSING</span></div>
                {:else if target.kind === 'custom_endpoints'}
                  <div class="flex items-center gap-1.5"><StatusDot status="idle" /><span class="font-mono uppercase tracking-command text-zinc-300">{$_('routes.targetTypes.customEndpoints')}</span></div>
                {:else if target.kind === 'direct_response'}
                  <div class="flex items-center gap-1.5"><StatusDot status="accent" /><span class="font-mono uppercase tracking-command text-nexus-300">{$_('routes.targetTypes.directResponse')}</span></div>
                {:else}
                  <span class="font-mono text-zinc-600">—</span>
                {/if}
              </div>
              <div data-testid="health-cell">
                <span class="nx-label block mb-1">// {$_('routes.tableHeaders.health')}</span>
                {#if target.kind === 'direct_response'}
                  <div class="flex items-center gap-1.5"><StatusDot status="idle" /><span class="font-mono uppercase tracking-command text-zinc-500">N/A</span></div>
                {:else}
                  <div class="flex items-center gap-1.5">
                    <StatusDot status={healthDotStatus[healthAgg.state]} />
                    <span class="font-mono uppercase tracking-command {healthTextClass[healthAgg.state]}">{healthLabel(healthAgg.state)}</span>
                  </div>
                {/if}
              </div>
            </div>

            {#if badges.length > 0}
              <div data-testid="feature-cell">
                <span class="nx-label block mb-1">// {$_('routes.tableHeaders.features')}</span>
                <div class="flex flex-wrap gap-1">
                  {#each badges as badge}
                    <FeatureBadge
                      {badge}
                      on:click={() => gotoFeature(route.path, badge.section)}
                    />
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>

      <svelte:fragment slot="foot">
        <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
          {$_('routes.showingRoutes', { values: { count: filteredRoutes.length, total: routes.length } })}
        </span>
      </svelte:fragment>
    </PanelCard>
  {/if}

  <!-- ===== Delete confirm dialog ================================= -->
  <ConfirmDialog
    bind:open={showDeleteDialog}
    title={$_('routes.confirmDelete')}
    message={routeToDelete ? $_('routes.confirmDeleteMessage', { values: { path: routeToDelete.path } }) : ''}
    confirmText={$_('common.delete')}
    cancelText={$_('common.cancel')}
    confirmClass="nx-btn-danger"
    on:confirm={confirmDelete}
    on:cancel={cancelDelete}
  />
</div>
