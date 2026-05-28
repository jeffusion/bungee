<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { _ } from '../lib/i18n';
  import { ServiceReferencedError, ServicesAPI, type Service } from '../lib/api/services';
  import { RoutesAPI, type Route } from '../lib/api/routes';
  import RelationshipLink from '../lib/components/RelationshipLink.svelte';
  import HealthSummary from '../lib/components/HealthSummary.svelte';
  import EndpointQuickPreview from '../lib/components/EndpointQuickPreview.svelte';
  import {
    getServiceConsumers,
    getServiceHealthAggregate,
  } from '../lib/utils/route-service-view-model';
  import { toast } from '../lib/stores/toast';
  import {
    PanelCard,
    KpiCard,
    StatusDot,
    StatusBadge,
    IconButton,
    LoadingIndicator,
  } from '../lib/components/industrial';

  // ----- state ---------------------------------------------------------
  let services: Service[] = [];
  let routes: Route[] = [];
  let loading = true;
  let error: string | null = null;
  let searchQuery = '';
  let isInitialLoad = true;

  // Delete confirmation state (custom modal due to friction-input)
  let showDeleteDialog = false;
  let serviceToDelete: Service | null = null;
  let deleteConfirmationInput = '';

  $: isReferenced = serviceToDelete ? getServiceConsumers(serviceToDelete.name, routes).count > 0 : false;
  $: referencingRoutes = serviceToDelete ? getServiceConsumers(serviceToDelete.name, routes).routes : [];
  $: canConfirmDelete = serviceToDelete && !isReferenced && deleteConfirmationInput === serviceToDelete.name;

  // Endpoint drawer
  let showEndpointsDrawer = false;
  let selectedServiceForEndpoints: Service | null = null;

  let deletingNames = new Set<string>();

  // Dropdown open state per row (replaces daisyUI dropdown)
  let openMenuFor: string | null = null;

  async function loadData(silent = false) {
    const shouldShowLoading = !silent && isInitialLoad;
    try {
      if (shouldShowLoading) loading = true;
      const [s, r] = await Promise.all([ServicesAPI.list(), RoutesAPI.list()]);
      services = s; routes = r;
      error = null;
      isInitialLoad = false;
    } catch (e: any) {
      error = e.message;
      if (!silent) toast.show(e.message, 'error');
    } finally {
      if (shouldShowLoading) loading = false;
    }
  }

  async function handleDelete(service: Service) {
    serviceToDelete = service;
    deleteConfirmationInput = '';
    showDeleteDialog = true;
    openMenuFor = null;
  }

  async function confirmDelete() {
    if (!serviceToDelete || isReferenced) return;
    deletingNames.add(serviceToDelete.name);
    deletingNames = deletingNames;
    try {
      await ServicesAPI.delete(serviceToDelete.name);
      toast.show($_('services.deleted'), 'success');
      showDeleteDialog = false;
      await loadData();
    } catch (e: unknown) {
      if (e instanceof ServiceReferencedError) {
        toast.show($_('services.deleteBlockedByReferences', {
          values: { name: e.serviceName, routes: e.routePaths.join(', ') }
        }), 'error');
      } else {
        toast.show(e instanceof Error ? e.message : $_('services.deleteFailed'), 'error');
      }
    } finally {
      if (serviceToDelete) {
        deletingNames.delete(serviceToDelete.name);
        deletingNames = deletingNames;
      }
      serviceToDelete = null;
      deleteConfirmationInput = '';
    }
  }

  function cancelDelete() {
    showDeleteDialog = false;
    serviceToDelete = null;
    deleteConfirmationInput = '';
  }

  function handleCreate() {
    push('/services/new');
  }

  function handleEdit(name: string) {
    push(`/services/edit/${encodeURIComponent(name)}`);
  }

  async function handleDuplicate(service: Service) {
    openMenuFor = null;
    try {
      const newName = `${service.name}-copy`;
      const duplicatedService = { ...service, name: newName };
      await ServicesAPI.create(duplicatedService);
      toast.show($_('serviceEditor.serviceSaved'), 'success');
      await loadData();
    } catch (e: any) {
      toast.show(e.message, 'error');
    }
  }

  function openEndpointsDrawer(service: Service) {
    selectedServiceForEndpoints = service;
    showEndpointsDrawer = true;
  }

  function closeEndpointsDrawer() {
    showEndpointsDrawer = false;
  }

  $: if (!showEndpointsDrawer) selectedServiceForEndpoints = null;

  function getUpstreamStatus(upstream: any): 'healthy' | 'unhealthy' | 'half_open' {
    if (!upstream.status) return 'healthy';
    if (upstream.status === 'HEALTHY') return 'healthy';
    if (upstream.status === 'HALF_OPEN') return 'half_open';
    return 'unhealthy';
  }

  $: serviceViewModels = services.map((service) => {
    const consumers = getServiceConsumers(service.name, routes);
    const health = getServiceHealthAggregate(service);
    return { service, consumers, health, isUnreferenced: consumers.count === 0 };
  });

  $: summary = {
    totalServices: services.length,
    healthy: serviceViewModels.filter((vm) => vm.health.state === 'healthy').length,
    degraded: serviceViewModels.filter((vm) => vm.health.state === 'degraded').length,
    unhealthy: serviceViewModels.filter((vm) => vm.health.state === 'unhealthy').length,
    empty: serviceViewModels.filter((vm) => vm.health.state === 'empty').length,
    totalEndpoints: services.reduce((acc, s) => acc + s.endpoints.length, 0),
    referenced: serviceViewModels.filter((vm) => !vm.isUnreferenced).length,
    unreferenced: serviceViewModels.filter((vm) => vm.isUnreferenced).length,
  };

  $: filteredViewModels = serviceViewModels.filter((vm) => {
    const q = searchQuery.toLowerCase();
    return (
      vm.service.name.toLowerCase().includes(q) ||
      (vm.service.description?.toLowerCase().includes(q) ?? false) ||
      vm.service.endpoints.some((e) => e.target.toLowerCase().includes(q)) ||
      vm.consumers.routePaths.some((p) => p.toLowerCase().includes(q))
    );
  });

  let refreshInterval: any;
  onMount(() => {
    loadData();
    refreshInterval = setInterval(() => loadData(true), 5000);
  });
  onDestroy(() => {
    if (refreshInterval) clearInterval(refreshInterval);
  });

  // Close any open dropdown when clicking outside
  function handleDocClick(e: MouseEvent) {
    if (openMenuFor && !(e.target as HTMLElement).closest('[data-row-menu]')) {
      openMenuFor = null;
    }
  }

  function handleEsc(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (openMenuFor) openMenuFor = null;
      else if (showEndpointsDrawer) closeEndpointsDrawer();
      else if (showDeleteDialog) cancelDelete();
    }
  }
</script>

<svelte:window on:click={handleDocClick} on:keydown={handleEsc} />

<div class="px-6 py-5 space-y-5">
  <!-- ===== Page header ============================================= -->
  <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
    <div class="flex items-center gap-3">
      <span class="nx-stripe" aria-hidden="true"></span>
      <div class="flex flex-col leading-tight">
        <span class="nx-label">// {$_('services.subtitle')}</span>
        <h1 class="nx-display text-xl text-zinc-50 tracking-[0.02em]">
          {$_('services.title')}
        </h1>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <button class="nx-btn-primary" on:click={handleCreate}>
        <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        {$_('services.newService')}
      </button>
    </div>
  </div>

  <!-- ===== KPI strip =============================================== -->
  <section class="grid grid-cols-2 lg:grid-cols-4 gap-3">
    <KpiCard label={$_('services.summary.totalServices')} value={summary.totalServices} unit="UNITS">
      <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-zinc-500" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
      </svg>
      <div slot="foot" class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span class="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-command">
          <StatusDot status="ok" />
          <span class="text-emerald-300">{summary.healthy}</span>
        </span>
        {#if summary.degraded > 0}
          <span class="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-command">
            <StatusDot status="warn" />
            <span class="text-amber-300">{summary.degraded}</span>
          </span>
        {/if}
        {#if summary.unhealthy > 0}
          <span class="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-command">
            <StatusDot status="danger" />
            <span class="text-red-300">{summary.unhealthy}</span>
          </span>
        {/if}
        {#if summary.empty > 0}
          <span class="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-command">
            <StatusDot status="idle" />
            <span class="text-zinc-500">{summary.empty}</span>
          </span>
        {/if}
      </div>
    </KpiCard>

    <KpiCard label={$_('services.summary.totalEndpoints')} value={summary.totalEndpoints} unit="EP">
      <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-zinc-500" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
      </svg>
    </KpiCard>

    <KpiCard
      label={$_('services.summary.referenced')}
      value={summary.referenced}
      unit="LINKED"
      tone="accent"
    >
      <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-nexus-500" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
      </svg>
    </KpiCard>

    <KpiCard
      label={$_('services.summary.unreferenced')}
      value={summary.unreferenced}
      unit="ORPHAN"
      tone={summary.unreferenced > 0 ? 'warn' : 'auto'}
      stripe={summary.unreferenced > 0 ? 'amber' : 'orange'}
    >
      <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-zinc-500" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    </KpiCard>
  </section>

  <!-- ===== Filter panel =========================================== -->
  <PanelCard title={$_('routes.filters.label')} tag="FILTER" flush>
    <div class="px-4 py-3">
      <label class="block">
        <span class="nx-label block mb-1.5">// {$_('common.search')}</span>
        <div class="relative">
          <svg class="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder={$_('common.search')}
            class="nx-input pl-9"
            bind:value={searchQuery}
          />
        </div>
      </label>
    </div>
  </PanelCard>

  <!-- ===== Content ================================================ -->
  {#if loading}
    <PanelCard title={$_('services.title')} tag="LOADING">
      <LoadingIndicator label="LOADING SERVICE INVENTORY" />
    </PanelCard>
  {:else if error}
    <PanelCard title={$_('common.error')} tag="ERR" stripe="red">
      <p class="font-mono text-xs uppercase tracking-command text-red-300">{error}</p>
    </PanelCard>
  {:else if serviceViewModels.length === 0}
    <PanelCard title={$_('services.noServices')} tag="EMPTY" stripe="zinc">
      <div class="py-10 text-center space-y-4">
        <p class="text-sm text-zinc-400 max-w-md mx-auto">
          {$_('services.noServicesMessage')}
        </p>
        <button class="nx-btn-primary" on:click={handleCreate}>
          <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          {$_('services.createFirst')}
        </button>
      </div>
    </PanelCard>
  {:else if filteredViewModels.length === 0}
    <PanelCard title={$_('routes.noMatchingRoutes')} tag="NO MATCH" stripe="amber">
      <div class="py-10 text-center">
        <p class="text-sm text-zinc-400 max-w-md mx-auto">
          {$_('routes.noMatchingMessage')}
        </p>
      </div>
    </PanelCard>
  {:else}
    <!-- Summary header (also doubles as a section label) -->
    <div class="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3" data-testid="services-board">
      {#each filteredViewModels as vm (vm.service.name)}
        <PanelCard
          title={vm.service.name}
          tag={vm.isUnreferenced ? 'ORPHAN' : `${vm.consumers.count} REF`}
          stripe={vm.health.state === 'unhealthy' ? 'red' : vm.health.state === 'degraded' ? 'amber' : vm.health.state === 'empty' ? 'zinc' : 'orange'}
          class="flex flex-col"
        >
          <!-- top-right actions overlay -->
          <svelte:fragment slot="actions">
            <div class="flex items-center gap-1" data-row-menu>
              <IconButton size="sm" title={$_('common.edit')} on:click={() => handleEdit(vm.service.name)}>
                <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </IconButton>
              <div class="relative">
                <IconButton
                  size="sm"
                  title={$_('common.show')}
                  on:click={() => (openMenuFor = openMenuFor === vm.service.name ? null : vm.service.name)}
                >
                  <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
                    <circle cx="12" cy="5" r="1.5" fill="currentColor" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><circle cx="12" cy="19" r="1.5" fill="currentColor" />
                  </svg>
                </IconButton>
                {#if openMenuFor === vm.service.name}
                  <div class="absolute right-0 top-full mt-1 w-40 border border-carbon-500 bg-carbon-900 shadow-industrial-lg p-1 z-30">
                    <button
                      class="w-full text-left px-3 py-1.5 font-mono text-[11px] uppercase tracking-command text-zinc-300 hover:text-nexus-300 hover:bg-carbon-800 transition-colors flex items-center gap-2"
                      on:click={() => handleDuplicate(vm.service)}
                    >
                      <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="1.8">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      <span>{$_('common.copy')}</span>
                    </button>
                    <button
                      class="w-full text-left px-3 py-1.5 font-mono text-[11px] uppercase tracking-command text-red-300 hover:text-red-200 hover:bg-red-500/10 transition-colors flex items-center gap-2"
                      on:click={() => handleDelete(vm.service)}
                      disabled={deletingNames.has(vm.service.name)}
                    >
                      <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="1.8">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      <span>{$_('common.delete')}</span>
                    </button>
                  </div>
                {/if}
              </div>
            </div>
          </svelte:fragment>

          <div class="flex flex-col gap-3" data-testid="service-card">
            <!-- description -->
            {#if vm.service.description}
              <p class="text-xs text-zinc-500 line-clamp-2" title={vm.service.description}>
                {vm.service.description}
              </p>
            {/if}

            <!-- stats row -->
            <div
              class="flex items-center justify-between border border-carbon-600 bg-carbon-950/60 px-3 py-2"
              data-testid="service-stats"
            >
              <HealthSummary aggregate={vm.health} />
<div class="flex items-center gap-4 font-mono">
            <div class="flex flex-col items-end leading-none">
              <span class="nx-label-sm">{$_('services.endpointLabel')}</span>
              <span class="mt-0.5 text-[12px] text-zinc-200">{vm.service.endpoints.length}</span>
            </div>
            <div class="flex flex-col items-end leading-none">
              <span class="nx-label-sm">{$_('services.consumerLabel')}</span>
              <span class="mt-0.5 text-[12px] text-zinc-200">{vm.consumers.count}</span>
            </div>
            {#if vm.service.plugins && vm.service.plugins.length > 0}
            <div class="flex flex-col items-end leading-none">
              <span class="nx-label-sm">{$_('services.pluginLabel')}</span>
              <span class="mt-0.5 text-[12px] text-nexus-300">{vm.service.plugins.length}</span>
            </div>
            {/if}
          </div>
            </div>

            <!-- endpoints preview -->
            <div>
              <div class="flex justify-between items-center mb-1.5">
                <span class="nx-label">// {$_('services.endpointsPreview')}</span>
                {#if vm.service.endpoints.length > 3}
                  <button
                    class="font-mono text-[10px] uppercase tracking-command text-nexus-300 hover:text-nexus-200 hover:underline transition-colors"
                    on:click={() => openEndpointsDrawer(vm.service)}
                    data-testid="view-all-endpoints"
                  >
                    {$_('services.viewEndpoints')} →
                  </button>
                {/if}
              </div>
              <EndpointQuickPreview
                endpoints={vm.service.endpoints}
                limit={3}
                on:overflowClick={() => openEndpointsDrawer(vm.service)}
              />
            </div>

            <!-- referenced-by -->
            <div class="pt-3 border-t border-carbon-600">
              <span class="nx-label block mb-1.5">// {$_('services.referencedBy')}</span>
              <div class="flex flex-wrap gap-1.5" data-testid="consumer-tags">
                {#each vm.consumers.routes as route}
                  <RelationshipLink type="route" name={route.path} className="text-[11px]" />
                {:else}
                  <span class="font-mono text-[10px] uppercase tracking-command text-zinc-600">— {$_('services.noReferences')}</span>
                {/each}
              </div>
            </div>
          </div>
        </PanelCard>
      {/each}
    </div>
  {/if}

  <!-- ===== Endpoints drawer ===================================== -->
  {#if showEndpointsDrawer && selectedServiceForEndpoints}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
    <div
      class="fixed inset-0 z-[100] flex justify-end bg-black/70 backdrop-blur-sm"
      on:click={(e) => { if (e.target === e.currentTarget) closeEndpointsDrawer(); }}
      role="dialog"
      aria-modal="true"
    >
      <div class="w-full max-w-2xl h-full bg-carbon-950 border-l border-carbon-600 shadow-industrial-lg flex flex-col">
        <header class="flex items-center justify-between px-5 py-3 border-b border-carbon-600 bg-carbon-900">
          <div class="flex items-center gap-2.5">
            <span class="nx-stripe" aria-hidden="true"></span>
            <div class="flex flex-col leading-tight">
              <span class="nx-label-sm">// {$_('upstreamsModal.title')}</span>
              <span class="nx-display text-base text-zinc-50">{selectedServiceForEndpoints.name}</span>
            </div>
          </div>
          <IconButton title={$_('common.close')} on:click={closeEndpointsDrawer}>
            <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </IconButton>
        </header>

        <div class="px-5 py-3 border-b border-carbon-600 bg-carbon-900/60">
          <span class="font-mono text-[11px] uppercase tracking-command text-zinc-400">
            {$_('services.endpointsCount', { values: { count: selectedServiceForEndpoints.endpoints.length } })}
          </span>
        </div>

        <div class="flex-1 overflow-auto">
          <table class="w-full" data-testid="endpoints-drawer-table">
            <thead class="border-b border-carbon-600 bg-carbon-900/60 sticky top-0">
              <tr>
                <th class="text-left nx-label py-2.5 px-4 w-14">{$_('routeCard.tableHeaders.status')}</th>
                <th class="text-left nx-label py-2.5 px-4">{$_('routeCard.tableHeaders.target')}</th>
                <th class="text-right nx-label py-2.5 px-4 w-20">{$_('routeCard.tableHeaders.weight')}</th>
                <th class="text-right nx-label py-2.5 px-4 w-20">{$_('routeCard.tableHeaders.priority')}</th>
              </tr>
            </thead>
            <tbody>
              {#each selectedServiceForEndpoints.endpoints as upstream}
                {@const status = getUpstreamStatus(upstream)}
                <tr class="border-b border-carbon-600/60 hover:bg-carbon-700/40 transition-colors" class:opacity-50={upstream.is_disabled}>
                  <td class="py-2.5 px-4">
                    <StatusDot
                      status={upstream.is_disabled ? 'idle' : status === 'healthy' ? 'ok' : status === 'half_open' ? 'warn' : 'danger'}
                    />
                  </td>
                  <td class="py-2.5 px-4">
                    <div class="flex flex-col">
                      <code class="text-[12px] font-mono text-zinc-200 break-all">{upstream.target}</code>
                      {#if upstream.description}
                        <span class="font-mono text-[10px] text-zinc-500 mt-0.5">{upstream.description}</span>
                      {/if}
                    </div>
                  </td>
                  <td class="py-2.5 px-4 text-right font-mono text-[12px] text-zinc-300 tabular-nums">{upstream.weight ?? 100}</td>
                  <td class="py-2.5 px-4 text-right font-mono text-[12px] text-zinc-300 tabular-nums">{upstream.priority ?? 1}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <footer class="px-5 py-3 border-t border-carbon-600 bg-carbon-900 flex justify-end">
          <button class="nx-btn-primary" on:click={closeEndpointsDrawer}>{$_('common.close')}</button>
        </footer>
      </div>
    </div>
  {/if}

  <!-- ===== Delete confirmation (custom modal — has friction input) ==== -->
  {#if showDeleteDialog && serviceToDelete}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
    <div
      class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      on:click={(e) => { if (e.target === e.currentTarget) cancelDelete(); }}
      role="dialog"
      aria-modal="true"
      data-testid="delete-service-modal"
    >
      <div class="nx-panel-raised nx-bracketed relative w-full max-w-lg">
        <span class="nx-corner nx-corner-tl" aria-hidden="true"></span>
        <span class="nx-corner nx-corner-tr" aria-hidden="true"></span>
        <span class="nx-corner nx-corner-bl" aria-hidden="true"></span>
        <span class="nx-corner nx-corner-br" aria-hidden="true"></span>

        <header class="nx-panel-head">
          <div class="nx-panel-head-title">
            <span class={isReferenced ? 'nx-stripe nx-stripe-amber' : 'nx-stripe nx-stripe-red'} aria-hidden="true"></span>
            <span>{isReferenced ? $_('services.deleteReferencedTitle') : $_('services.deleteUnreferencedTitle')}</span>
          </div>
          <IconButton title={$_('common.cancel')} on:click={cancelDelete}>
            <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2.4">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </IconButton>
        </header>

        <div class="nx-panel-body space-y-4">
          {#if isReferenced}
            <div class="border-l-2 border-l-amber-500 bg-amber-500/5 px-4 py-3 flex items-start gap-3">
              <svg viewBox="0 0 24 24" class="h-5 w-5 shrink-0 text-amber-400 mt-0.5" fill="none" stroke="currentColor" stroke-width="1.8">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span class="text-sm text-amber-200">
                {$_('services.deleteReferencedMessage', { values: { name: serviceToDelete.name } })}
              </span>
            </div>

            <div class="space-y-2">
              <span class="nx-label">// {$_('services.referencedBy')}</span>
              <div class="flex flex-wrap gap-2" data-testid="referenced-routes-container">
                {#each referencingRoutes as route}
                  <RelationshipLink type="route" name={route.path} />
                {/each}
              </div>
            </div>
          {:else}
            <p class="text-sm text-zinc-300">
              {$_('services.deleteUnreferencedMessage', { values: { name: serviceToDelete.name } })}
            </p>

            <label class="block space-y-1.5">
              <span class="nx-label">// {$_('services.deleteUnreferencedFriction')}</span>
              <input
                type="text"
                class="nx-input"
                bind:value={deleteConfirmationInput}
                placeholder={serviceToDelete.name}
                data-testid="delete-confirm-input"
              />
            </label>
          {/if}
        </div>

        <footer class="border-t border-carbon-600 px-4 py-3 flex justify-end gap-2 bg-carbon-900/60">
          <button class="nx-btn-ghost" on:click={cancelDelete}>{$_('common.cancel')}</button>
          {#if !isReferenced}
            <button
              class="nx-btn-danger"
              disabled={!canConfirmDelete || deletingNames.has(serviceToDelete.name)}
              on:click={confirmDelete}
              data-testid="confirm-delete-btn"
            >
              {#if deletingNames.has(serviceToDelete.name)}
                <LoadingIndicator label="" size="xs" centered={false} />
              {/if}
              {$_('common.delete')}
            </button>
          {/if}
        </footer>
      </div>
    </div>
  {/if}
</div>
