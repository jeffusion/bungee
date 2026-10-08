<script lang="ts">

  import { onMount, onDestroy, untrack } from 'svelte';
  import { _, isLoading } from '$i18n';
  import { runtimeUpstreams, publicationRecovery, unresolvedPublication } from '$stores/runtime';
  import { publicationMessage } from '$components/domain/config/publication-state';
  import type { RuntimeUpstreamsResponse } from '$api/runtime';
  import HealthSummary from '$components/domain/service/HealthSummary.svelte';
  import type { StatsHistoryV2, TimeRange } from '$types';
  import DashboardBoard from '$components/dashboard/DashboardBoard.svelte';
  import TrendChart from '$components/dashboard/TrendChart.svelte';
  import Sparkline from '$components/dashboard/Sparkline.svelte';
  import { dashboardMetrics, successRate, failureRate, successHistory, failureHistory, rankFailures } from '$components/dashboard/outcomes';
  import { bucketTrend, completedBuckets } from '$components/dashboard/trends';
  import { GRID_COLUMNS, type CardDefinition, type KpiMetric } from '$components/dashboard/layout';
  import { getDashboardStats } from '$api/stats';
  import type { UpstreamOutcomeStats } from '$types';
  import Plug from 'lucide-svelte/icons/plug';
  import PluginHost from '$components/shell/PluginHost.svelte';
  import { pluginList, refreshPlugins } from '$stores/plugins';
  import { getNativeWidget, getWidgetSource } from '$components/native-widgets';
  import type { NativeWidgetHeader, NativeWidgetHeaderChange } from '$components/native-widgets/widget-header';
  import { Button } from '$components/ui/button';
  import { formatCompactNumber } from '$utils/format-number';
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
    BCarouselList,
    MetricBar,
    StatusBadge,
    StatusDot,
    SystemAlertBar,
    LoadingIndicator,
  } from '$components/industrial';

  let history: StatsHistoryV2 | null = $state(null);
  let upstreamStats: UpstreamOutcomeStats[] = $state([]);
  let refreshing = $state(false);
  let statsError = $state(false);
  let configError = $state(false);
  let lastUpdated: number | null = $state(null);
  let statsStartTime: number | null = $state(null);
  let layoutEditing = $state(false);
  let requestVersion = 0;
  let disposed = false;
  let configVersion = 0;
  let statsInterval: ReturnType<typeof setInterval>;
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
        ...(typeof header.actions === 'function' ? { actions: header.actions } : {}),
        ...(typeof header.footer === 'function' ? { footer: header.footer } : {}),
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

  let pluginPanels: Array<{pluginName: string, path: string, title: string, w: number, h: number, enabled: boolean}> = $state([]);
  let nativeWidgetPanels: Array<{
    pluginName: string;
    id: string;
    title: string;
    component: ComponentType<SvelteComponent>;
    props: Record<string, any>;
    presentation?: 'kpi';
    w: number;
    h: number;
    enabled: boolean;
  }> = $state([]);

  let calculatedStats: ReturnType<typeof dashboardMetrics> | null = $state(null);

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
  let configInterval: ReturnType<typeof setInterval>;

  async function loadStatistics() {
    if (layoutEditing || disposed) return;
    const version = ++requestVersion;
    const range = selectedRange;
    refreshing = true;
    try {
      const snapshot = await getDashboardStats(range);
      if (version !== requestVersion || disposed || layoutEditing) return;
      history = snapshot.history;
      calculatedStats = dashboardMetrics(snapshot);
      upstreamStats = snapshot.upstreams;
      lastUpdated = snapshot.endTime;
      statsStartTime = snapshot.startTime;
      statsError = false;
    } catch {
      if (version !== requestVersion || disposed || layoutEditing) return;
      statsError = true;
      history = null; calculatedStats = null; upstreamStats = [];
    }
    refreshing = false;
  }
  function setLayoutEditing(editing: boolean) {
    layoutEditing = editing;
    if (editing) { requestVersion++; configVersion++; refreshing = false; }
    else { loadStatistics(); loadConfig(); }
  }

  async function loadConfig() {
    if (layoutEditing || disposed) return;
    const version = ++configVersion;
    try {
      const [services, routes] = await Promise.all([ServicesAPI.list(), RoutesAPI.list()]);
      if (version !== configVersion || disposed || layoutEditing) return;
      servicesData = services;
      routesData = routes;
      configError = false;
    } catch (e) {
      if (version === configVersion && !disposed) configError = true;
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

  function rateTone(rate: number): 'ok' | 'warn' | 'danger' {
    return rate >= 99 ? 'ok' : rate >= 95 ? 'warn' : 'danger';
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
    statsInterval = setInterval(loadStatistics, 30000);
  });

  onDestroy(() => {
    disposed = true; requestVersion++; configVersion++;
    clearInterval(statsInterval);
    headerChannels.clear();
    if (configInterval) clearInterval(configInterval);
  });

  $effect(() => {
    selectedRange;
    untrack(() => {
      requestVersion++;
      history = null; calculatedStats = null; upstreamStats = [];
      loadStatistics();
    });
  });

  $effect(() => {
    servicesStats = calculateServicesStats(servicesData, $runtimeUpstreams);
  });
  $effect(() => {
    const panels: any[] = [];
    const nativePanels: any[] = [];

    $pluginList.forEach((p) => {
      if (!p.metadata) return;

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
            w, h, presentation: widget.presentation, enabled: p.enabled,
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
          panels.push({ pluginName: p.name, path: widget.path, title: widget.title, w, h, enabled: p.enabled });
        });
      } else if (p.metadata.ui?.dashboard) {
        p.metadata.ui.dashboard.forEach((panel) => {
          panels.push({
            pluginName: p.name,
            path: panel.path,
            title: panel.title,
            w: panel.size?.w || 1,
            h: panel.size?.h || 1,
            enabled: p.enabled,
          });
        });
      }
    });

    nativeWidgetPanels = nativePanels;
    untrack(() => pruneHeaderChannels(new Set(nativePanels.map(panel => `${panel.pluginName}:${panel.id}`))));
    pluginPanels = panels;
  });
  // Build the rows for the SERVICE HEALTH list
  let serviceRows = $derived((servicesStats?.services ?? []).map((s) => {
    const health = getServiceHealthAggregate(s, $runtimeUpstreams);
    const { total, healthy } = health;
    const ratio = total === 0 ? 0 : (healthy / total) * 100;
    const status = healthDotStatus[health.state];
    return { id: s._uid ?? s.name, name: s.name, total, healthy, health, ratio, status };
  }));
  // Build the rows for the ROUTE OVERVIEW list
  let routeRows = $derived(routesData.map((route) => {
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

  const pluginDefinitions = $derived<CardDefinition[]>([
    ...nativeWidgetPanels.map(panel => {
      return { id: `plugin:native:${panel.pluginName}:${panel.id}`, title: panel.title,
        description: 'dashboardLayout.nativePlugin', group: 'plugin' as const, tag: panel.pluginName.toUpperCase(),
        pluginName: panel.pluginName, presentation: panel.presentation,
        w: Math.min(GRID_COLUMNS, Math.round(panel.w * GRID_COLUMNS / 4)),
        h: panel.h >= 2 ? 8 : 4, enabled: panel.enabled };
    }),
    ...pluginPanels.map(panel => ({ id: `plugin:iframe:${panel.pluginName}:${panel.path}`, title: panel.title,
      description: 'dashboardLayout.iframePlugin', group: 'plugin' as const, tag: panel.pluginName.toUpperCase(),
      pluginName: panel.pluginName, w: Math.min(GRID_COLUMNS, Math.round(panel.w * GRID_COLUMNS / 4)), h: panel.h >= 2 ? 8 : 4, enabled: panel.enabled })),
  ]);
  const timeLabels = $derived(history?.timestamps.map(timestamp => new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) ?? []);
  const comparison = $derived.by(() => history && statsStartTime != null && lastUpdated != null
    ? completedBuckets(history.timestamps, statsStartTime, lastUpdated, selectedRange) : null);
  const healthyStatus = $derived(servicesStats && servicesStats.totalEndpoints > 0 && servicesStats.unknownEndpoints === 0
    ? servicesStats.unhealthyEndpoints > 0 ? 'danger' : servicesStats.mixedEndpoints > 0 || servicesStats.halfOpenEndpoints > 0 ? 'warn' : 'ok' : 'idle');
  function trendValues(id: string): number[] {
    if (!history) return [];
    return id === 'chart.requests' || id === 'kpi.requests' || id === 'kpi.rpm' ? history.requests :
      id === 'chart.latency' || id === 'kpi.latency' ? history.responseTime :
      id === 'chart.success' || id === 'kpi.success' ? successHistory(history) : failureHistory(history);
  }
  function trendTone(id: string): 'orange' | 'sky' | 'emerald' | 'red' {
    return id.includes('latency') ? 'sky' : id.includes('success') ? 'emerald' : id.includes('errors') ? 'red' : 'orange';
  }
  function upstreamHost(upstream: string): string { try { return new URL(upstream).host; } catch { return upstream; } }
  function kpiMetric(definition: CardDefinition): KpiMetric {
    if (definition.id === 'kpi.cluster') return {
      value: servicesStats ? `${servicesStats.totalServices} / ${routesData.length}` : null, unit: 'SVC / RT',
      stripe: healthyStatus === 'danger' || routesOverviewStats.missing > 0 ? 'red' : healthyStatus === 'warn' || routesOverviewStats.hasIssue ? 'amber' : 'orange',
      trendLabel: `${$_('dashboardLayout.serviceHealth', { values: { healthy: servicesStats?.healthyServices ?? '—', total: servicesStats?.totalServices ?? '—' } })} · ${$_('dashboard.routesHealthCompact', { values: { healthy: routesOverviewStats.healthy, total: routesOverviewStats.total } })}`,
      trendCaption: '',
      trendTitle: $_('dashboardLayout.endpointsOnline', { values: { healthy: servicesStats?.healthyEndpoints ?? '—', total: servicesStats?.totalEndpoints ?? '—' } }),
    };
    const value = definition.id === 'kpi.requests' ? calculatedStats?.totalRequests : definition.id === 'kpi.success' ? calculatedStats?.successRate : definition.id === 'kpi.latency' ? calculatedStats?.avgResponseTime : calculatedStats?.requestsPerMinute;
    const success = definition.id === 'kpi.success';
    const values = trendValues(definition.id);
    const pair = comparison ? [values[comparison.previous], values[comparison.current]] : [];
    const needsRequests = success || definition.id === 'kpi.latency';
    const hasSamples = comparison && history && [comparison.previous, comparison.current]
      .every(index => Number.isFinite(history!.requests[index]) && history!.requests[index] > 0);
    const trend = needsRequests && !hasSamples ? null : bucketTrend(pair, success);
    const isNew = !needsRequests && pair[0] === 0 && Number.isFinite(pair[1]) && pair[1] > 0;
    const formatTime = (timestamp: number) => new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const currentStart = comparison && history ? Date.parse(history.timestamps[comparison.current]) : null;
    const trendTitle = comparison && history && currentStart != null
      ? `${$_('dashboardLayout.bucketComparison')} ${formatTime(Date.parse(history.timestamps[comparison.previous]))}–${formatTime(currentStart)} → ${formatTime(currentStart)}–${formatTime(currentStart + comparison.intervalMs)} · ${selectedRange}`
      : '';
    return {
      value: value == null ? null : definition.id === 'kpi.requests' ? formatCompactNumber(value) : success ? value.toFixed(1) : definition.id === 'kpi.rpm' ? value.toFixed(2) : value.toFixed(0),
      unit: success ? '%' : definition.id === 'kpi.latency' ? 'MS' : definition.id === 'kpi.rpm' ? 'REQ/M' : 'REQ',
      tone: success && value != null ? rateTone(value) : 'auto', trend,
      trendChange: isNew ? 'up' : undefined,
      trendLabel: isNew ? $_('dashboardLayout.newActivity') : trend == null ? '—' : `${trend >= 0 ? '+' : ''}${trend.toFixed(1)}${success ? ' pp' : '%'}`,
      trendCaption: $_(selectedRange === '1h' ? 'dashboardLayout.previousMinute' : selectedRange === '24h' ? 'dashboardLayout.previousHour' : 'dashboardLayout.previousBucket'),
      trendTitle,
      trendDirection: definition.id === 'kpi.latency' ? 'down' : 'up',
    };
  }
  const carouselLabels = $derived($isLoading ? {} : {
    previous: $_('dashboardLayout.carousel.previous'), next: $_('dashboardLayout.carousel.next'),
    pause: $_('dashboardLayout.carousel.pause'), play: $_('dashboardLayout.carousel.play'),
    reducedMotion: $_('dashboardLayout.carousel.reducedMotion'), slide: $_('dashboardLayout.carousel.page'),
    goTo: (position: number, total: number) => $_('dashboardLayout.carousel.position', { values: { position, total } }),
    position: (position: number, total: number) => $_('dashboardLayout.carousel.position', { values: { position, total } }),
  });
  const statusSegments = [
    { key: 'status2xx' as const, label: '2xx', color: 'bg-zinc-300', tone: 'ok' as const },
    { key: 'status3xx' as const, label: '3xx', color: 'bg-zinc-500', tone: 'neutral' as const },
    { key: 'status4xx' as const, label: '4xx', color: 'bg-amber-500', tone: 'warn' as const },
    { key: 'status5xx' as const, label: '5xx', color: 'bg-red-500', tone: 'danger' as const },
    { key: 'statusOther' as const, label: '—', color: 'bg-zinc-600', tone: 'neutral' as const },
  ];
</script>

{#snippet outcomeSummary(row: UpstreamOutcomeStats)}
  <div class="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] leading-relaxed">
    <span class="text-zinc-300">{$_('dashboardLayout.successfulRequests')} {row.requestCounts?.success ?? '—'} · {successRate(row.requestCounts)?.toFixed(2) ?? '—'}%</span>
    <span class:text-red-300={(row.requestCounts?.failed ?? 0) > 0} class="text-zinc-400">{$_('dashboardLayout.failedRequests')} {row.requestCounts?.failed ?? '—'} · {failureRate(row.requestCounts)?.toFixed(2) ?? '—'}%</span>
  </div>
{/snippet}

<div class="nx-page pt-[22px] pb-24 max-sm:pt-4 max-sm:pb-[120px]" data-testid="page-dashboard">
  <DashboardBoard plugins={pluginDefinitions} bind:selectedRange {lastUpdated} {refreshing} refreshError={statsError || configError}
    metric={kpiMetric} onrefresh={() => { loadStatistics(); loadConfig(); }} oneditingchange={setLayoutEditing}>
    {#snippet alerts()}
  {#if $publicationRecovery.readStatus === 'stale'}
    <SystemAlertBar tone="warn"><p class="text-sm text-zinc-300">{$_('settings.runtimeUnavailable')} <a href="/#/config" class="text-nexus-300 underline">{$_('settings.details')}</a></p></SystemAlertBar>
  {/if}

  {#if showRecovery && publication && !$isLoading}
    <section data-testid="dashboard-publication-recovery" aria-label={$_('publicationRecovery.label')} aria-live="polite" aria-atomic="true">
      <SystemAlertBar tone="warn" class="flex-wrap !gap-3 !px-4 !py-3 [&>div:first-child]:flex-1">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2" role="status">
          <span class="text-sm font-semibold text-zinc-100" data-testid="publication-recovery-status">
            {$_(publication.operation?.error_code === 'old_worker_drain_failed'
              ? `configurationSave.${publicationMessage(publication, $publicationRecovery.fresh)}`
              : recoveryActive ? 'publicationRecovery.progress' : recovery?.state === 'stopped'
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


      {#if servicesStats && servicesStats.unhealthyEndpoints > 0}
        <SystemAlertBar tone="danger" title={$_('dashboard.unhealthyEndpoints', { values: { count: servicesStats.unhealthyEndpoints } })}
          subtitle={$_('dashboardLayout.healthWarning')} class="mb-4">
          {#snippet action()}<a href="/#/services" class="nx-btn-outline">{$_('nav.services')}</a>{/snippet}
        </SystemAlertBar>
      {/if}
      {#if configError || statsError}
        <SystemAlertBar tone="warn" title={$_('dashboardLayout.dataUnavailable')} subtitle={$_('dashboardLayout.retryHint')} class="mb-4" />
      {/if}
    {/snippet}
    {#snippet extra(definition: CardDefinition)}
      {#if definition.group === 'kpi'}
        <svg viewBox="0 0 24 24" class="h-3.5 w-3.5 shrink-0 text-zinc-500" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d={definition.id === 'kpi.requests' ? 'M7 8h10M7 12h6m-6 4h10M5 4h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z' :
            definition.id === 'kpi.rpm' ? 'M13 10V3L4 14h7v7l9-11h-7z' : definition.id === 'kpi.latency' ? 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' :
            definition.id === 'kpi.success' ? 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' : 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4'} />
        </svg>
      {:else if definition.group === 'health'}
        {@const status = definition.id === 'health.services' ? healthyStatus : routesOverviewStats.unknown > 0 || routesOverviewStats.total === 0 ? 'idle' : routesOverviewStats.missing > 0 ? 'danger' : routesOverviewStats.hasIssue ? 'warn' : 'ok'}
        <StatusBadge variant={status === 'ok' ? 'active' : status === 'danger' ? 'fault' : status === 'warn' ? 'standby' : 'muted'} dot>
          {$_(status === 'ok' ? 'dashboardLayout.health.healthy' : status === 'warn' ? 'dashboardLayout.health.degraded' : status === 'danger' ? 'dashboardLayout.health.unhealthy' : 'upstreamsModal.statusUnknown')}
        </StatusBadge>
      {:else if definition.id.startsWith('plugin:native:')}
        {@const panel = nativeWidgetPanels.find(panel => `plugin:native:${panel.pluginName}:${panel.id}` === definition.id)}
        {@const header = panel && widgetHeaders[`${panel.pluginName}:${panel.id}`]}
        {#if header}
          {#if header.actions}{@render header.actions()}{/if}
          <span class="max-w-[140px] truncate text-xs text-zinc-400" title={header.summary} role="status" data-testid="native-widget-summary">{header.summary}</span>
          <Button variant="link" size="icon" class="!h-6 !w-6 !p-0" aria-label={header.refresh.label} title={header.refresh.label} aria-busy={header.refresh.busy}
            disabled={header.refresh.busy || header.refresh.disabled} onclick={header.refresh.run}>
            {#if header.refresh.busy}<LoadingIndicator size="xs" centered={false} label="" />{:else}<RefreshCw class="h-3.5 w-3.5" />{/if}
          </Button>
        {:else}<span class="nx-panel-head-tag">{definition.tag}</span>{/if}
      {:else}<span class="nx-panel-head-tag">{definition.tag}</span>{/if}
    {/snippet}
    {#snippet footer(definition: CardDefinition)}
      {@const panel = nativeWidgetPanels.find(panel => `plugin:native:${panel.pluginName}:${panel.id}` === definition.id)}
      {@const footerContent = panel && widgetHeaders[`${panel.pluginName}:${panel.id}`]?.footer}
      {#if definition.enabled !== false && footerContent}{@render footerContent()}{/if}
    {/snippet}
    {#snippet content(definition: CardDefinition)}
      {#if definition.enabled === false}
        <div class="flex h-full flex-col justify-center gap-1"><strong class="flex items-center gap-2 font-mono text-[11px] tracking-command text-zinc-300"><Plug class="h-4 w-4" />{$_('dashboardLayout.pluginDisabled')}</strong><p class="text-xs text-zinc-500">{$_('dashboardLayout.pluginSlotRetained')}</p><a href="/#/plugins" class="mt-1 text-xs text-nexus-300 hover:underline">{$_('nav.plugins')}</a></div>
      {:else if definition.group === 'kpi'}
        {#if definition.id === 'kpi.cluster'}<StatusDot status={healthyStatus} />
        {:else}<Sparkline values={trendValues(definition.id)} tone={trendTone(definition.id)} />{/if}
      {:else if definition.group === 'trend'}
        {@const values = trendValues(definition.id)}
        {@const samples = values.filter(Number.isFinite)}
        {@const total = samples.reduce((sum, value) => sum + value, 0)}
        {@const unit = definition.id === 'chart.latency' ? 'MS' : definition.id === 'chart.success' ? '%' : 'REQ'}
        <div class="flex h-full min-h-0 flex-col gap-2.5" data-testid={definition.id === 'chart.requests' ? 'dashboard-chart-traffic' : undefined}>
          <div class="dashboard-chart-summary flex max-h-[22px] flex-wrap items-baseline gap-x-[18px] gap-y-1.5 overflow-hidden">
            <span class="flex items-baseline gap-1.5 font-display text-lg font-bold leading-none text-zinc-100">{values.length ? definition.id === 'chart.latency' ? Math.round(calculatedStats?.avgResponseTime ?? 0).toLocaleString() : definition.id === 'chart.success' ? calculatedStats?.successRate?.toFixed(2) ?? '—' : total.toLocaleString() : '—'}<small class="font-mono text-[10px] font-normal tracking-chiseled text-zinc-500">{unit}</small></span>
            <span class="dashboard-stat">{$_('dashboardLayout.peak')} <b>{samples.length ? Math.max(...samples).toLocaleString() : '—'}</b></span>
            <span class="dashboard-stat">{definition.id === 'chart.errors' ? $_('dashboardLayout.errorRate') : $_('dashboardLayout.average')} <b>{values.length ? definition.id === 'chart.errors' ? calculatedStats?.failureRate == null ? '—' : `${calculatedStats.failureRate.toFixed(2)}%` : samples.length ? (total / samples.length).toFixed(1) : '—' : '—'}</b></span>
          </div>
          <div class="min-h-0 flex-1">
            {#if refreshing && !history}<LoadingIndicator height="sm" />
            {:else if values.length}<TrendChart labels={timeLabels} {values} label={$_(definition.title)} tone={trendTone(definition.id)} unit={definition.id === 'chart.latency' ? 'ms' : definition.id === 'chart.success' ? '%' : ''} />
            {:else}<div class="dashboard-no-data">{$_('dashboard.noData')}</div>{/if}
          </div>
        </div>
      {:else if definition.group === 'upstream'}
        <div class="flex h-full min-h-0 flex-col gap-3" class:overflow-y-auto={definition.id === 'chart.failures'}>
          {#if definition.id === 'chart.status'}
            {#if upstreamStats.length}<BCarouselList items={upstreamStats} itemKey={row => row.upstream} labels={carouselLabels} ariaLabel={$_(definition.title)}>
              {#snippet children(row, measuring)}
              <section class="space-y-2" aria-label={upstreamHost(row.upstream)} data-testid={measuring ? undefined : 'upstream-status-row'}>
                <MetricBar label={upstreamHost(row.upstream)} value={row.totalRequests} max={row.totalRequests} tone="neutral"
                  valueLabel={`${$_('dashboardLayout.total')} ${row.totalRequests.toLocaleString()}`}
                  segments={statusSegments.map(segment => ({ label: segment.key === 'statusOther' ? $_('dashboardLayout.otherStatus') : segment.label, value: row.httpStatusCounts?.[segment.key] ?? 0, tone: segment.tone }))} />
                <dl class="dashboard-status-breakdown font-mono text-[10px] tabular-nums">
                  {#each statusSegments as segment}
                    <div class="min-w-0" data-status={segment.key}>
                      <dt class="flex items-center gap-1.5 text-zinc-400"><i class="h-2 w-2 shrink-0 {segment.color}" aria-hidden="true"></i>{segment.key === 'statusOther' ? $_('dashboardLayout.otherStatus') : segment.label}</dt>
                      <dd class="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5"><span class="text-zinc-200">{row.httpStatusCounts?.[segment.key].toLocaleString() ?? '—'}</span><span class="text-zinc-500">{row.httpStatusCounts ? `${row.totalRequests ? (row.httpStatusCounts[segment.key] / row.totalRequests * 100).toFixed(1) : '0.0'}%` : '—'}</span></dd>
                    </div>
                  {/each}
                </dl>
              </section>
              {/snippet}
            </BCarouselList>{:else}<div class="dashboard-no-data">{$_('dashboard.noData')}</div>{/if}
          {:else}
            {@const failure = definition.id === 'chart.failures'}
            {@const rows = failure ? rankFailures(upstreamStats) : upstreamStats}
            {@const total = upstreamStats.reduce((sum, row) => sum + row.totalRequests, 0)}
            {@const maximum = Math.max(1, ...rows.map(row => failure ? (row.requestCounts?.failed ?? 0) : row.totalRequests))}
            <div class="flex shrink-0 flex-wrap justify-between gap-2">
              {#if failure}
                <span class="dashboard-stat">{$_('dashboardLayout.failedRequests')} <b>{upstreamStats.some(row => !row.requestCounts) ? '—' : upstreamStats.reduce((sum, row) => sum + (row.requestCounts?.failed ?? 0), 0)}</b></span>
              {:else}<span class="dashboard-stat">{$_('dashboardLayout.total')} <b>{total.toLocaleString()}</b></span>{/if}
            </div>
            {#snippet distributionRow(row: UpstreamOutcomeStats, measuring = false)}
              <div class="space-y-1.5" data-testid={measuring ? undefined : failure ? 'upstream-failure-row' : 'upstream-distribution-row'}>
                <MetricBar label={upstreamHost(row.upstream)} value={failure ? (row.requestCounts?.failed ?? 0) : row.totalRequests} max={failure ? row.totalRequests : maximum} tone="neutral"
                  valueLabel={failure ? $_('dashboardLayout.attemptCount', { values: { count: row.totalRequests } }) : `${row.totalRequests.toLocaleString()} · ${$_('dashboardLayout.trafficShare')} ${row.percentage.toFixed(1)}%`}
                  segments={failure ? [
                    { label: $_('dashboardLayout.failedRequests'), value: (row.requestCounts?.failed ?? 0), tone: 'danger' },
                  ] : [
                    { label: $_('dashboardLayout.successfulRequests'), value: row.requestCounts?.success ?? 0, tone: 'ok' },
                    { label: $_('dashboardLayout.failedRequests'), value: row.requestCounts?.failed ?? 0, tone: 'danger' },
                  ]} />
                {@render outcomeSummary(row)}
              </div>
            {/snippet}
            {#if failure}
              {#each rows as row (row.upstream)}{@render distributionRow(row)}{/each}
            {:else if rows.length}
              <div class="min-h-0 flex-1">
                <BCarouselList items={rows} itemKey={row => row.upstream} labels={carouselLabels} ariaLabel={$_(definition.title)}>
                  {#snippet children(row, measuring)}{@render distributionRow(row, measuring)}{/snippet}
                </BCarouselList>
              </div>
            {/if}
            {#if !rows.length}<div class="dashboard-no-data">{$_('dashboard.noData')}</div>{/if}
          {/if}
        </div>
      {:else if definition.id === 'health.services'}
        <div class="flex h-full min-h-0 flex-col">
          <div class="dashboard-health-summary flex shrink-0 flex-wrap gap-x-4 gap-y-1.5 border-b border-carbon-600 pb-2.5"><span class="dashboard-stat">{$_('nav.services')} <b>{servicesStats?.totalServices ?? '—'}</b></span><span class="dashboard-stat">{$_('dashboardLayout.health.healthy')} <b>{servicesStats?.healthyServices ?? '—'}</b></span><span class="dashboard-stat">{$_('dashboardLayout.endpoints')} <b>{servicesStats?.healthyEndpoints ?? '—'}/{servicesStats?.totalEndpoints ?? '—'}</b></span></div>
          {#if serviceRows.length}<div class="min-h-0 flex-1">
            <BCarouselList items={serviceRows} itemKey={row => row.id} gap={0} labels={carouselLabels} ariaLabel={$_('dashboard.serviceOverview')}>
              {#snippet children(row, measuring)}
              <div class="dashboard-health-row" data-testid={measuring ? undefined : 'service-overview-row'}><StatusDot status={row.status} /><span class="truncate font-mono text-xs font-semibold tracking-tight text-zinc-200" title={row.name}>{row.name}</span><span class="font-mono text-[10px] tracking-industrial {healthTextClass[row.health.state]}"><HealthSummary aggregate={row.health} showDot={false} /></span>
                <MetricBar class="col-start-2 col-end-4" label={$_('dashboardLayout.endpoints')}
                  value={row.ratio} tone={row.status === 'idle' ? 'neutral' : row.status === 'accent' ? 'accent' : row.status}
                  valueLabel={row.health.unknown > 0 ? $_('runtime.unavailable') : `${row.ratio.toFixed(0)}%`} />
              </div>
              {/snippet}
            </BCarouselList>
          </div>{/if}
          {#if !serviceRows.length}<div class="dashboard-no-data">{$_('dashboard.noData')}</div>{/if}
        </div>
      {:else if definition.id === 'health.routes'}
        <div class="flex h-full min-h-0 flex-col">
          <div class="dashboard-health-summary flex shrink-0 flex-wrap gap-x-4 gap-y-1.5 border-b border-carbon-600 pb-2.5"><span class="dashboard-stat">{$_('nav.routes')} <b>{routesOverviewStats.total}</b></span><span class="dashboard-stat">{$_('dashboardLayout.boundServices')} <b>{routesOverviewStats.serviceBound}</b></span><span class="dashboard-stat">{$_('dashboardLayout.directResponse')} <b>{routesOverviewStats.directResp}</b></span></div>
          {#if routeRows.length}<div class="min-h-0 flex-1">
            <BCarouselList items={routeRows} itemKey={row => row.route._uid ?? row.route.path} gap={0} labels={carouselLabels} ariaLabel={$_('dashboard.routeOverview')}>
              {#snippet children(row, measuring)}
              <div class="dashboard-health-row" data-testid={measuring ? undefined : 'route-overview-row'}><StatusDot status={row.target.kind === 'direct_response' ? 'accent' : healthDotStatus[row.healthAgg.state]} />
                <a href="/#/routes/edit/{encodeURIComponent(row.route.path)}" class="truncate font-mono text-xs font-semibold text-nexus-300 hover:text-nexus-200 hover:underline" title={row.route.path}>{row.route.path}</a>
                <span class="font-mono text-[10px] tracking-industrial {healthTextClass[row.healthAgg.state]}">{#if row.target.kind === 'direct_response'}{$_('dashboardLayout.directResponse')}{:else}<HealthSummary aggregate={row.healthAgg} showDot={false} />{/if}</span>
                <div class="col-start-2 col-end-4 flex min-w-0 flex-wrap items-center gap-1.5"><span class="truncate font-mono text-[10px] tracking-industrial text-zinc-400">→ {row.target.kind === 'service' || row.target.kind === 'missing_service' ? row.target.serviceName : row.target.kind === 'direct_response' ? 'DIRECT' : row.target.kind === 'custom_endpoints' ? 'CUSTOM EP' : '—'}</span>
                  {#each row.featureTags as tag}<span class="dashboard-feature-tag border border-carbon-600 bg-carbon-900/60 px-1.5 font-mono text-[9px] leading-4 tracking-command text-zinc-400">{tag}</span>{/each}
                </div>
              </div>
              {/snippet}
            </BCarouselList>
          </div>{/if}
          {#if !routeRows.length}<div class="dashboard-no-data">{$_('dashboard.noData')}</div>{/if}
        </div>
      {:else if definition.id.startsWith('plugin:native:')}
        {@const panel = nativeWidgetPanels.find(panel => `plugin:native:${panel.pluginName}:${panel.id}` === definition.id)}
        {#if panel}<panel.component {...panel.props} />{/if}
      {:else if definition.id.startsWith('plugin:iframe:')}
        {@const panel = pluginPanels.find(panel => `plugin:iframe:${panel.pluginName}:${panel.path}` === definition.id)}
        {#if panel}<div class="dashboard-plugin-frame h-full min-h-0"><PluginHost pluginName={panel.pluginName} path={panel.path} height="100%" /></div>{/if}
      {/if}
    {/snippet}
  </DashboardBoard>
</div>

<style>
  .dashboard-status-breakdown { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
  @container (max-width: 360px) { .dashboard-status-breakdown { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .dashboard-plugin-frame :global(> div) { min-height: 0; height: 100%; }
  .dashboard-stat { font-family: theme('fontFamily.mono'); font-size: 10px; letter-spacing: .1em; color: var(--nx-text-mute); white-space: nowrap; }
  .dashboard-stat b { font-weight: 400; color: var(--nx-text); font-variant-numeric: tabular-nums; }
  .dashboard-no-data { display: flex; height: 100%; min-height: 56px; align-items: center; justify-content: center; font-family: theme('fontFamily.mono'); font-size: 11px; color: var(--nx-text-mute); }
  .dashboard-health-row { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 6px 10px; padding: 9px 0; border-bottom: 1px solid var(--nx-edge); }
  @container (max-height: 170px) { .dashboard-chart-summary { display: none; } }
  @container (max-height: 180px) { .dashboard-health-summary { display: none; } }
  @container (max-width: 300px) { .dashboard-feature-tag { display: none; } }
</style>
