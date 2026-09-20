<script lang="ts">

  import { onMount, onDestroy, untrack } from 'svelte';
  import { _, isLoading } from '$i18n';
  import { runtimeUpstreams, publicationRecovery, unresolvedPublication } from '$stores/runtime';
  import type { RuntimeUpstreamsResponse } from '$api/runtime';
  import HealthSummary from '$components/domain/service/HealthSummary.svelte';
  import type { StatsHistoryV2, TimeRange } from '$types';
  import MonitoringCharts from '$components/charts/MonitoringCharts.svelte';
  import PluginHost from '$components/shell/PluginHost.svelte';
  import { pluginList, refreshPlugins } from '$stores/plugins';
  import { getNativeWidget, getWidgetSource } from '$components/native-widgets';
  import type { NativeWidgetHeader, NativeWidgetHeaderChange } from '$components/native-widgets/widget-header';
  import { Button } from '$components/ui/button';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import type { ComponentType, SvelteComponent } from 'svelte';
  import { RoutesAPI } from '$api/routes';
  import type { Route, Service } from '$api/routes';
  import { ServicesAPI } from '$api/services';
  import {
    getRouteTargetSummary,
    getRouteFeatureBadges,
    getRouteHealthAggregate,
    getServiceHealthAggregate,
  } from '$utils/route-service-view-model';
  import type { ServiceHealthAggregate } from '$utils/route-service-view-model';
  import {
    KpiCard,
    PanelCard,
    SegmentedControl,
    SectionDivider,
    StatusBadge,
    StatusDot,
    MetricBar,
    SystemAlertBar,
    LoadingIndicator,
  } from '$components/industrial';

  let selectedRange: TimeRange = $state('1h');
  const publication = $derived($publicationRecovery.publication);
  const recovery = $derived($publicationRecovery.accepted ?? publication?.recovery);
  const recoveryActive = $derived(recovery?.state === 'scheduled' || recovery?.state === 'running');
  const showRecovery = $derived($publicationRecovery.fresh && unresolvedPublication(publication));
  const canRetryPublication = $derived($publicationRecovery.fresh && publication?.retryable && recovery?.state === 'stopped'
    && publication.operation?.error_code !== 'old_worker_drain_failed' && $publicationRecovery.accepted === null);
  let widgetHeaders: Record<string, NativeWidgetHeader | null> = $state({});
  const headerChannels = new Map<string, { component: ComponentType<SvelteComponent>; report: NativeWidgetHeaderChange }>();

  function getHeaderReporter(key: string, component: ComponentType<SvelteComponent>): NativeWidgetHeaderChange {
    const previous = headerChannels.get(key);
    if (previous?.component === component) return previous.report;
    delete widgetHeaders[key]; widgetHeaders = { ...widgetHeaders };
    const channel = { component, report: (header: NativeWidgetHeader | null) => {
      if (headerChannels.get(key) !== channel) return;
      if (header !== null && (typeof header?.summary !== 'string' || typeof header?.refresh?.label !== 'string'
        || typeof header.refresh.busy !== 'boolean' || typeof header.refresh.disabled !== 'boolean' || typeof header.refresh.run !== 'function')) return;
      widgetHeaders = { ...widgetHeaders, [key]: header === null ? null : {
        summary: header.summary, refresh: { label: header.refresh.label, busy: header.refresh.busy, disabled: header.refresh.disabled, run: header.refresh.run },
      } };
    } };
    headerChannels.set(key, channel);
    return channel.report;
  }
  function pruneHeaderChannels(keys: Set<string>) {
    for (const key of headerChannels.keys()) if (!keys.has(key)) {
      headerChannels.delete(key); delete widgetHeaders[key];
    }
    widgetHeaders = { ...widgetHeaders };
  }

  let pluginPanels: Array<{pluginName: string, path: string, title: string, w: number, h: number}> = $state([]);
  let nativeWidgetPanels: Array<{
    pluginName: string;
    id: string;
    title: string;
    component: ComponentType<SvelteComponent>;
    props: Record<string, any>;
    w: number;
    h: number;
  }> = $state([]);

  let calculatedStats: {
    totalRequests: number;
    requestsPerMinute: number;
    successRate: number;
    avgResponseTime: number;
  } | null = $state(null);

  let servicesStats: {
    totalServices: number;
    healthyServices: number;
    degradedServices: number;
    totalEndpoints: number;
    healthyEndpoints: number;
    unhealthyEndpoints: number;
    halfOpenEndpoints: number;
    mixedEndpoints: number;
    unknownEndpoints: number;
    services: Service[];
  } | null = $state(null);

  let routesData: Route[] = $state([]);
  let servicesData: Service[] = $state([]);
  let configInterval: any;

  function handleDataLoaded(data: StatsHistoryV2 | null) {
    calculatedStats = calculateStats(data);
  }

  async function loadConfig() {
    try {
      const [services, routes] = await Promise.all([ServicesAPI.list(), RoutesAPI.list()]);
      servicesData = services;
      routesData = routes;
    } catch (e) {
      console.error('Failed to load config for dashboard:', e);
    }
  }


  function calculateServicesStats(services: Service[], runtime: RuntimeUpstreamsResponse | null) {
    let totalServices = services.length;
    let healthyServices = 0;
    let degradedServices = 0;
    let totalEndpoints = 0;
    let healthyEndpoints = 0;
    let unhealthyEndpoints = 0;
    let halfOpenEndpoints = 0;
    let mixedEndpoints = 0;
    let unknownEndpoints = 0;

    services.forEach((s) => {
      const health = getServiceHealthAggregate(s, runtime);
      totalEndpoints += health.total;
      healthyEndpoints += health.healthy;
      unhealthyEndpoints += health.unhealthy;
      halfOpenEndpoints += health.halfOpen;
      mixedEndpoints += health.mixed;
      unknownEndpoints += health.unknown;
      if (health.state === 'healthy') healthyServices++;
      else degradedServices++;
    });

    return {
      totalServices, healthyServices, degradedServices,
      totalEndpoints, healthyEndpoints, unhealthyEndpoints, halfOpenEndpoints, mixedEndpoints, unknownEndpoints,
      services,
    };
  }

  function calculateStats(history: StatsHistoryV2 | null) {
    if (!history || history.requests.length === 0) return null;
    const totalRequests = history.requests.reduce((s, v) => s + v, 0);
    const rangeInSeconds = getRangeInSeconds(selectedRange);
    const requestsPerMinute = (totalRequests / rangeInSeconds) * 60;
    const totalErrors = history.errors.reduce((s, v) => s + v, 0);
    const successRate =
      totalRequests > 0 ? ((totalRequests - totalErrors) / totalRequests) * 100 : 100;
    const avgResponseTime =
      history.responseTime.length > 0
        ? history.responseTime.reduce((s, v) => s + v, 0) / history.responseTime.length
        : 0;
    return { totalRequests, requestsPerMinute, successRate, avgResponseTime };
  }

  function getRangeInSeconds(range: TimeRange): number {
    switch (range) {
      case '1h': return 3600;
      case '12h': return 43200;
      case '24h': return 86400;
      default: return 3600;
    }
  }

  function formatCount(n: number | null | undefined): string {
    if (n === null || n === undefined || !Number.isFinite(n)) return '—';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  // Map success rate to a tone for the KPI card
  function rateTone(rate: number): 'ok' | 'warn' | 'danger' {
    if (rate >= 99) return 'ok';
    if (rate >= 95) return 'warn';
    return 'danger';
  }

  // Route health dot status mapping
  const healthDotStatus: Record<ServiceHealthAggregate['state'], 'ok' | 'warn' | 'danger' | 'idle' | 'accent'> = {
    healthy: 'ok',
    degraded: 'warn',
    mixed: 'warn',
    unknown: 'idle',
    unhealthy: 'danger',
    neutral: 'idle',
    empty: 'idle',
  };

  const healthTextClass: Record<ServiceHealthAggregate['state'], string> = {
    healthy: 'text-emerald-300',
    degraded: 'text-amber-300',
    mixed: 'text-amber-300',
    unknown: 'text-zinc-400',
    unhealthy: 'text-red-300',
    neutral: 'text-zinc-500',
    empty: 'text-zinc-500',
  };

  // Feature badge section → compact abbreviation for dashboard row
  const featureAbbr: Record<string, string> = {
    auth: 'AUTH',
    cors: 'CORS',
    rateLimit: 'RL',
    retry: 'RTY',
    directResponse: 'DR',
    plugins: 'PLG',
    modification: 'MOD',
  };


  onMount(() => {
    refreshPlugins();
    loadConfig();
    configInterval = setInterval(loadConfig, 30000);
  });

  onDestroy(() => {
    headerChannels.clear();
    if (configInterval) clearInterval(configInterval);
  });

  const RANGE_OPTIONS = [
    { value: '1h', key: 'monitoring.range.oneHour' },
    { value: '12h', key: 'monitoring.range.twelveHours' },
    { value: '24h', key: 'monitoring.range.twentyFourHours' },
  ];




  $effect(() => {
    servicesStats = calculateServicesStats(servicesData, $runtimeUpstreams);
  });
  $effect(() => {
    const panels: any[] = [];
    const nativePanels: any[] = [];

    $pluginList.forEach((p) => {
      if (!p.enabled || !p.metadata) return;

      if (p.metadata.contributes?.nativeWidgets) {
        p.metadata.contributes.nativeWidgets.forEach((widget: any) => {
          if (getWidgetSource(widget.component) !== p.name) return;
          const Component = getNativeWidget(widget.component);
          if (!Component) return;

          let w = 1, h = 1;
          switch (widget.size) {
            case 'medium': w = 2; h = 1; break;
            case 'large': w = 2; h = 2; break;
            case 'full': w = 4; h = 2; break;
            case 'small':
            default: w = 1; h = 1; break;
          }

          nativePanels.push({
            pluginName: p.name,
            id: widget.id,
            title: `plugins.${p.name}.${widget.title}`,
            component: Component,
            props: { ...widget.props, selectedRange, pluginName: p.name, onHeaderChange: untrack(() => getHeaderReporter(`${p.name}:${widget.id}`, Component)) },
            w, h,
          });
        });
      }

      if (p.metadata.contributes?.widgets) {
        p.metadata.contributes.widgets.forEach((widget) => {
          let w = 1, h = 1;
          switch (widget.size) {
            case 'medium': w = 2; h = 1; break;
            case 'large': w = 2; h = 2; break;
            case 'full': w = 4; h = 2; break;
            case 'small':
            default: w = 1; h = 1; break;
          }
          panels.push({ pluginName: p.name, path: widget.path, title: widget.title, w, h });
        });
      } else if (p.metadata.ui?.dashboard) {
        p.metadata.ui.dashboard.forEach((panel) => {
          panels.push({
            pluginName: p.name,
            path: panel.path,
            title: panel.title,
            w: panel.size?.w || 1,
            h: panel.size?.h || 1,
          });
        });
      }
    });

    nativeWidgetPanels = nativePanels;
    untrack(() => pruneHeaderChannels(new Set(nativePanels.map(panel => `${panel.pluginName}:${panel.id}`))));
    pluginPanels = panels;
  });
  let rangeSegmentOptions = $derived($isLoading ? [] : RANGE_OPTIONS.map((o) => ({ value: o.value, label: $_(o.key) })));
  // Build the rows for the SERVICE HEALTH list
  let serviceRows = $derived((servicesStats?.services ?? []).slice(0, 6).map((s) => {
    const health = getServiceHealthAggregate(s, $runtimeUpstreams);
    const { total, healthy } = health;
    const ratio = total === 0 ? 0 : (healthy / total) * 100;
    const status = healthDotStatus[health.state];
    return { name: s.name, total, healthy, health, ratio, status };
  }));
  // Build the rows for the ROUTE OVERVIEW list
  let routeRows = $derived(routesData.slice(0, 6).map((route) => {
    const target = getRouteTargetSummary(route, servicesData);
    const healthAgg = getRouteHealthAggregate(route, servicesData, $runtimeUpstreams);
    const badges = getRouteFeatureBadges(route);
    const featureTags = badges.map((b) => featureAbbr[b.section] ?? b.section).filter(Boolean);
    return { route, target, healthAgg, featureTags };
  }));
  // Route summary stats for the header badge
  let routesOverviewStats = $derived((() => {
    const total = routesData.length;
    let serviceBound = 0;
    let customEp = 0;
    let directResp = 0;
    let missing = 0;
    let healthy = 0;
    let unhealthy = 0;
    let unknown = 0;
    let mixed = 0;

    routesData.forEach((route) => {
      const target = getRouteTargetSummary(route, servicesData);
      if (target.kind === 'service') serviceBound++;
      else if (target.kind === 'custom_endpoints') customEp++;
      else if (target.kind === 'direct_response') directResp++;
      else if (target.kind === 'missing_service') missing++;

      const health = getRouteHealthAggregate(route, servicesData, $runtimeUpstreams);
      if (health.state === 'healthy' || health.state === 'neutral') healthy++;
      else if (health.state === 'unhealthy' || health.state === 'degraded') unhealthy++;
      else if (health.state === 'unknown') unknown++;
      else if (health.state === 'mixed') mixed++;
    });

    const hasIssue = missing > 0 || unhealthy > 0 || mixed > 0;
    return { total, serviceBound, customEp, directResp, missing, healthy, unhealthy, unknown, mixed, hasIssue };
  })());
</script>

<div class="nx-page py-5 space-y-5" data-testid="page-dashboard">
  <!-- ===== Page header bar ============================================ -->
  <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
    <div class="flex flex-col gap-1">
      <span class="nx-label">// {$_('dashboard.dataRange')}</span>
      <SectionDivider label={$_('dashboard.title')} />
    </div>
    <SegmentedControl
      ariaLabel={$_('dashboard.dataRange')}
      options={rangeSegmentOptions}
      bind:value={selectedRange}
      class="shrink-0"
    />
  </div>
  {#if $publicationRecovery.readStatus === 'stale'}
    <SystemAlertBar tone="warn"><p class="text-sm text-zinc-300">{$_('settings.runtimeUnavailable')} <a href="/#/config" class="text-nexus-300 underline">{$_('settings.details')}</a></p></SystemAlertBar>
  {/if}

  {#if showRecovery && publication && !$isLoading}
    <section data-testid="dashboard-publication-recovery" aria-label={$_('publicationRecovery.label')} aria-live="polite" aria-atomic="true">
      <SystemAlertBar tone="warn" class="flex-wrap !gap-3 !px-4 !py-3 [&>div:first-child]:flex-1">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2" role="status">
          <span class="text-sm font-semibold text-zinc-100" data-testid="publication-recovery-status">
            {$_(recoveryActive ? 'publicationRecovery.progress' : recovery?.state === 'stopped'
              ? 'publicationRecovery.stopped' : 'publicationRecovery.notActive')}
          </span>
          {#if recoveryActive}
            <StatusBadge variant="standby">{$_(recovery?.state === 'scheduled' ? 'publicationRecovery.scheduled' : 'publicationRecovery.running')}</StatusBadge>
          {/if}
          {#if canRetryPublication}
            <Button size="sm" variant="outline" onclick={() => publicationRecovery.retry()}
              disabled={$publicationRecovery.pending} aria-busy={$publicationRecovery.pending}
              data-testid="publication-retry-button">
              {$_($publicationRecovery.pending ? 'publicationRecovery.submitting' : 'publicationRecovery.retry')}
            </Button>
          {/if}
        </div>
        <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-400">
          {#if recovery}
            <span data-testid="publication-recovery-attempts">{$_('publicationRecovery.attempts', { values: {
              count: recovery.attempt_count ?? $_('publicationRecovery.unavailable'), max: recovery.max_attempts ?? $_('publicationRecovery.unavailable')
            } })}</span>
          {/if}
          <span data-testid="publication-recovery-revisions">{$_('publicationRecovery.revisions', { values: {
            target: publication.target_revision, serving: publication.serving_revision ?? $_('publicationRecovery.unavailable')
          } })}</span>
        </div>
        {#if $publicationRecovery.notice}
          <p class="mt-1 text-sm text-amber-300" data-testid="publication-recovery-error">{$_(`publicationRecovery.errors.${$publicationRecovery.notice}`)}</p>
        {/if}
      </SystemAlertBar>
    </section>
  {/if}

  <!-- ===== KPI strip ================================================== -->
  <section class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
	<KpiCard
		data-testid="dashboard-kpi-total-requests"
		label={$_('dashboard.totalRequests')}
		value={calculatedStats ? formatCount(calculatedStats.totalRequests) : null}
		unit="REQ"
	>
        <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-zinc-500" fill="none" stroke="currentColor" stroke-width="1.8">
          <path stroke-linecap="round" stroke-linejoin="round" d="M7 8h10M7 12h6m-6 4h10M5 4h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z" />
        </svg>
        <div slot="foot" class="text-[10px] text-zinc-500">{$_('dashboard.kpiChainTooltip.requests')}</div>
	</KpiCard>

	<KpiCard
  label={$_('dashboard.requestsPerMinute')}
  value={calculatedStats ? calculatedStats.requestsPerMinute.toFixed(2) : null}
  unit="REQ/M"
    >
      <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-zinc-500" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
      <div slot="foot" class="text-[10px] text-zinc-500">{$_('dashboard.kpiChainTooltip.requests')}</div>
    </KpiCard>

    <KpiCard
      label={$_('dashboard.successRate')}
      value={calculatedStats ? calculatedStats.successRate.toFixed(1) : null}
      unit="%"
      tone={calculatedStats ? rateTone(calculatedStats.successRate) : 'auto'}
    >
      <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-zinc-500" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
      <div slot="foot" class="text-[10px] text-zinc-500">{$_('dashboard.kpiChainTooltip.successRate')}</div>
    </KpiCard>

    <KpiCard
      label={$_('dashboard.avgResponseTime')}
      value={calculatedStats ? calculatedStats.avgResponseTime.toFixed(0) : null}
      unit="MS"
    >
      <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-zinc-500" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <div slot="foot" class="text-[10px] text-zinc-500">{$_('dashboard.kpiChainTooltip.responseTime')}</div>
    </KpiCard>

<KpiCard
  label={$_('dashboard.clusterOverview')}
  value={servicesStats || routesOverviewStats ? `${servicesStats?.totalServices ?? 0} / ${routesOverviewStats?.total ?? 0}` : null}
  unit="SVC / RT"
  stripe={servicesStats && servicesStats.unhealthyEndpoints > 0 ? 'red' : routesOverviewStats && routesOverviewStats.missing > 0 ? 'red' : servicesStats && servicesStats.halfOpenEndpoints > 0 ? 'amber' : routesOverviewStats && routesOverviewStats.unhealthy > 0 ? 'amber' : 'orange'}
>
  <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-nexus-500" fill="none" stroke="currentColor" stroke-width="1.8">
    <path stroke-linecap="round" stroke-linejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
  </svg>
  <div slot="foot" class="flex flex-wrap items-center gap-x-3 gap-y-1">
    {#if servicesStats}
    <span class="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-command">
      {#if servicesStats.unknownEndpoints > 0}
      <StatusDot status="idle" />
      <span class="text-zinc-400">{$_('upstreamsModal.statusUnknown')}</span>
      {:else if servicesStats.degradedServices === 0 && servicesStats.totalEndpoints > 0}
      <StatusDot status="ok" />
      <span class="text-emerald-300">{$_('dashboard.servicesCompact', { values: { healthy: servicesStats.healthyServices, total: servicesStats.totalServices } })}</span>
      {:else}
      <StatusDot status="warn" />
      <span class="text-amber-300">{$_('dashboard.servicesCompact', { values: { healthy: servicesStats.healthyServices, total: servicesStats.totalServices } })}</span>
      {/if}
    </span>
    <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
      {$_('dashboard.endpointsCompact', { values: { total: servicesStats.totalEndpoints } })}
    </span>
    {#if servicesStats.unhealthyEndpoints > 0}
    <span class="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-command">
      <StatusDot status="danger" />
      <span class="text-red-300">{$_('dashboard.unhealthyEndpoints', { values: { count: servicesStats.unhealthyEndpoints } })}</span>
    </span>
    {/if}
    {/if}
    {#if routesOverviewStats && routesOverviewStats.total > 0}
    <span class="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-command">
      {#if routesOverviewStats.unknown > 0}
      <StatusDot status="idle" />
      <span class="text-zinc-400">{$_('upstreamsModal.statusUnknown')}</span>
      {:else if routesOverviewStats.unhealthy > 0 || routesOverviewStats.mixed > 0}
      <StatusDot status="warn" />
      <span class="text-amber-300">{$_('dashboard.routesHealthCompact', { values: { healthy: routesOverviewStats.healthy, total: routesOverviewStats.total } })}</span>
      {:else}
      <StatusDot status="ok" />
      <span class="text-emerald-300">{$_('dashboard.routesHealthCompact', { values: { healthy: routesOverviewStats.healthy, total: routesOverviewStats.total } })}</span>
      {/if}
    </span>
    {#if routesOverviewStats.missing > 0}
    <span class="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-command">
      <StatusDot status="danger" />
      <span class="text-red-300">{routesOverviewStats.missing} MISSING</span>
    </span>
    {/if}
    {/if}
  </div>
</KpiCard>
  </section>

  <!-- ===== Services health + Route overview + Monitoring layout ========= -->
  <section class="grid grid-cols-1 lg:grid-cols-3 lg:grid-rows-1 gap-3 lg:min-h-[560px]">
    <div class="min-h-0 flex flex-col gap-3">
      <SectionDivider label={$_('dashboard.clusterOverview')} />
      <div class="grid grid-rows-1 lg:grid-rows-2 gap-3 min-h-0 flex-1">
        <PanelCard
          title={$_('dashboard.serviceOverview')}
          tag="HEALTH"
          scrollable
        >
        <svelte:fragment slot="actions">
          {#if servicesStats}
            {#if servicesStats.unknownEndpoints > 0 || servicesStats.totalEndpoints === 0}
              <StatusBadge variant="muted" dot>{$_('upstreamsModal.statusUnknown')}</StatusBadge>
            {:else if servicesStats.mixedEndpoints > 0}
              <StatusBadge variant="standby" dot>{$_('runtime.mixed')}</StatusBadge>
            {:else if servicesStats.unhealthyEndpoints > 0}
              <StatusBadge variant="fault" dot>FAULT</StatusBadge>
            {:else if servicesStats.halfOpenEndpoints > 0}
              <StatusBadge variant="standby" dot>WARN</StatusBadge>
            {:else}
              <StatusBadge variant="active" dot>NOMINAL</StatusBadge>
            {/if}
          {/if}
        </svelte:fragment>

        {#if serviceRows.length === 0}
          <div class="py-6 text-center">
            <p class="nx-label">{$_('dashboard.noData')}</p>
          </div>
        {:else}
          <ul class="space-y-2.5">
            {#each serviceRows as row}
              <li>
                <div class="flex items-center justify-between gap-3">
                  <div class="flex items-center gap-2 min-w-0">
                    <StatusDot status={row.status} />
                    <span class="font-mono text-[12px] font-semibold uppercase tracking-command text-zinc-200 truncate">
                      {row.name}
                    </span>
                  </div>
                  <span class="font-mono text-[11px] uppercase tracking-command text-zinc-400 shrink-0">
                    <HealthSummary aggregate={row.health} />
                  </span>
                </div>
                <div class="mt-1.5">
                  <MetricBar
                    label="HEALTH"
                    value={row.ratio}
                    valueLabel={row.health.unknown > 0 ? $_('runtime.unavailable') : `${row.ratio.toFixed(0)}%`}
                    tone={row.status === 'idle' ? 'neutral' : 'auto'}
                    warnAt={100}
                    dangerAt={50}
                  />
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </PanelCard>

      <PanelCard
        title={$_('dashboard.routeOverview')}
        tag="ROUTES"
        scrollable
      >
        <svelte:fragment slot="actions">
          {#if routesOverviewStats.unknown > 0}
            <StatusBadge variant="muted" dot>{$_('upstreamsModal.statusUnknown')}</StatusBadge>
          {:else if routesOverviewStats.mixed > 0}
            <StatusBadge variant="standby" dot>{$_('runtime.mixed')}</StatusBadge>
          {:else if routesOverviewStats.hasIssue}
            {#if routesOverviewStats.missing > 0}
              <StatusBadge variant="fault" dot>FAULT</StatusBadge>
            {:else}
              <StatusBadge variant="standby" dot>WARN</StatusBadge>
            {/if}
          {:else if routesOverviewStats.total > 0}
            <StatusBadge variant="active" dot>NOMINAL</StatusBadge>
          {/if}
        </svelte:fragment>

        {#if routeRows.length === 0}
          <div class="py-6 text-center">
            <p class="nx-label">{$_('dashboard.noData')}</p>
          </div>
        {:else}
          <ul class="space-y-2.5">
            {#each routeRows as row}
              <li>
                <div class="flex items-center justify-between gap-3">
                  <div class="flex items-center gap-2 min-w-0">
                    {#if row.target.kind === 'direct_response'}
                      <StatusDot status="accent" />
                    {:else}
                      <StatusDot status={healthDotStatus[row.healthAgg.state]} />
                    {/if}
                    <a
                      href="/#/routes/edit/{encodeURIComponent(row.route.path)}"
                      class="font-mono text-[12px] font-semibold text-nexus-300 hover:text-nexus-200 hover:underline tracking-tight truncate max-w-[160px]"
                    >{row.route.path}</a>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <!-- Target type label -->
                    {#if row.target.kind === 'service'}
                      <span class="font-mono text-[10px] uppercase tracking-command text-zinc-300">{row.target.serviceName}</span>
                    {:else if row.target.kind === 'missing_service'}
                      <span class="font-mono text-[10px] uppercase tracking-command text-red-300">{row.target.serviceName}</span>
                    {:else if row.target.kind === 'custom_endpoints'}
                      <span class="font-mono text-[10px] uppercase tracking-command text-zinc-400">CUSTOM EP</span>
                    {:else if row.target.kind === 'direct_response'}
                      <span class="font-mono text-[10px] uppercase tracking-command text-nexus-300">DIRECT</span>
                    {:else}
                      <span class="font-mono text-[10px] uppercase tracking-command text-zinc-600">—</span>
                    {/if}
                    <!-- Health ratio (skip for direct_response) -->
                    {#if row.target.kind !== 'direct_response' && row.healthAgg.total > 0}
                      <span class="font-mono text-[10px] uppercase tracking-command {healthTextClass[row.healthAgg.state]}">
                        <HealthSummary aggregate={row.healthAgg} />
                      </span>
                    {/if}
                  </div>
                </div>
                <!-- Feature tags row -->
                {#if row.featureTags.length > 0}
                  <div class="mt-1 flex flex-wrap gap-1">
                    {#each row.featureTags as tag}
                      <span class="inline-block font-mono text-[9px] uppercase tracking-command text-zinc-500 bg-carbon-700/60 px-1.5 py-0.5 rounded-sm">{tag}</span>
                    {/each}
                  </div>
                {/if}
              </li>
  {/each}
  </ul>
  {/if}
  </PanelCard>
      </div>
    </div>

    <!-- Monitoring (right column, 2/3 width) -->
    <div class="lg:col-span-2 min-h-0" data-testid="dashboard-chart-traffic">
      <MonitoringCharts selectedRange={selectedRange} onDataLoaded={handleDataLoaded} />
    </div>
  </section>

  <!-- ===== Native plugin widgets ====================================== -->
  {#if nativeWidgetPanels.length > 0}
    <section class="space-y-3">
      <SectionDivider label={$_('dashboard.nativeExtensions')} />
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {#each nativeWidgetPanels as panel (`${panel.pluginName}:${panel.id}`)}
          {@const header = widgetHeaders[`${panel.pluginName}:${panel.id}`]}
          <PanelCard
            title={$_(panel.title)}
            tag={header ? '' : panel.pluginName.toUpperCase()}
            flush
            scrollable
            class="h-64 {panel.w >= 2 ? 'md:col-span-2' : ''} {panel.w === 2 ? 'lg:col-span-2' : ''} {panel.w === 4 ? 'lg:col-span-4' : ''} {panel.h >= 2 ? 'row-span-2' : ''}"
          >
            <svelte:fragment slot="title-extra">
              {#if header}<span class="min-w-0 flex-1 truncate text-xs font-normal normal-case tracking-normal text-zinc-400" title={header.summary} role="status" data-testid="native-widget-summary">{header.summary}</span>{/if}
            </svelte:fragment>
            <svelte:fragment slot="actions">
              {#if header}<Button variant="ghost" size="sm" class="aspect-square px-0" aria-label={header.refresh.label} title={header.refresh.label} aria-busy={header.refresh.busy} disabled={header.refresh.busy || header.refresh.disabled} onclick={header.refresh.run}>
                <span class="inline-flex h-3.5 w-3.5 items-center justify-center" aria-hidden="true">{#if header.refresh.busy}<LoadingIndicator size="xs" centered={false} label="" />{:else}<RefreshCw class="h-3.5 w-3.5" />{/if}</span>
              </Button>{/if}
            </svelte:fragment>
            <div class="p-2 h-full">
              <panel.component {...panel.props} />
            </div>
          </PanelCard>
        {/each}
      </div>
    </section>
  {/if}

  <!-- ===== iframe plugin panels ======================================= -->
  {#if pluginPanels.length > 0}
    <section class="space-y-3">
      <SectionDivider label="EXTENSIONS" />
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {#each pluginPanels as panel}
          <PanelCard
            title={panel.title}
            tag={panel.pluginName.toUpperCase()}
            flush
            class="h-64 {panel.w >= 2 ? 'md:col-span-2' : ''} {panel.w === 2 ? 'lg:col-span-2' : ''} {panel.w === 4 ? 'lg:col-span-4' : ''} {panel.h >= 2 ? 'row-span-2' : ''}"
          >
            <PluginHost pluginName={panel.pluginName} path={panel.path} />
          </PanelCard>
        {/each}
      </div>
    </section>
  {/if}

  <!-- ===== Footer alert =============================================== -->
  <SystemAlertBar
    tone={servicesStats && servicesStats.unhealthyEndpoints > 0 ? 'warn' : 'info'}
    title={servicesStats && servicesStats.unhealthyEndpoints > 0
      ? $_('dashboard.unhealthyEndpoints', { values: { count: servicesStats.unhealthyEndpoints } })
      : 'BUNGEE REVERSE PROXY'}
    subtitle={servicesStats && servicesStats.unhealthyEndpoints > 0
      ? `${servicesStats.totalEndpoints} endpoints monitored · ${servicesStats.healthyEndpoints} healthy`
      : `${servicesStats?.totalEndpoints ?? 0} endpoints monitored · sync range ${selectedRange}`}
  >
    <a slot="action" href="/#/services" class="nx-btn-outline">
      <span>{$_('nav.services')}</span>
      <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </a>
  </SystemAlertBar>
</div>
