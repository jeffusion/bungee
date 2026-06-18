<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { sortBy } from 'lodash-es';
  import type { Route, Service, Upstream } from '$api/routes';
  import type { ValidationError } from '$validation';
  import { ServicesAPI } from '$api/services';
  import { _ } from '$i18n';
  import { toast } from '$stores/toast';
  import ConfirmDialog from '$components/shell/ConfirmDialog.svelte';
  import UpstreamsSection from './UpstreamsSection.svelte';
import { LoadingIndicator, SystemAlertBar, PanelCard, IconButton, StatusBadge } from '$components/industrial';
  import { Input } from '$components/ui/input';

  export let route: Route;
  export let errors: ValidationError[] = [];
  export let weightErrors: ValidationError[] = [];
  export let services: Service[] = [];

  type TargetMode = 'service' | 'custom';

  const dispatch = createEventDispatcher<{
    modechange: { mode: TargetMode },
    navigatetosection: { section: string }
  }>();

  let mode: TargetMode = route.service ? 'service' : 'custom';
  let searchQuery = '';
  let saveServiceName = '';
  let savingService = false;
  let showSwitchConfirm = false;
  let showCustomConfirm = false;
  let pendingServiceName: string | null = null;
  let activeRoute = route;

  $: if (route !== activeRoute) {
    activeRoute = route;
    mode = route.service ? 'service' : 'custom';
  }

  $: filteredServices = services.filter(service =>
    service.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  $: selectedService = services.find(service => service.name === route.service);
  $: isServiceMissing = route.service && !selectedService;
  $: groupedServiceEndpoints = selectedService ? groupEndpointsByPriority(selectedService.endpoints) : [];

  function groupEndpointsByPriority(endpoints: Upstream[]): Array<{ priority: number; endpoints: Upstream[] }> {
    const eps = endpoints || [];
    const sorted = sortBy(eps, [(endpoint) => endpoint.priority || 1]);
    const groups: Array<{ priority: number; endpoints: Upstream[] }> = [];

    for (const endpoint of sorted) {
      const priority = endpoint.priority || 1;
      let group = groups.find(item => item.priority === priority);
      if (!group) {
        group = { priority, endpoints: [] };
        groups.push(group);
      }
      group.endpoints.push(endpoint);
    }

    return groups;
  }

  function getHealthColor(status?: string) {
    switch (status) {
      case 'HEALTHY': return 'bg-emerald-500';
      case 'UNHEALTHY': return 'bg-red-500';
      case 'HALF_OPEN': return 'bg-amber-500';
      default: return 'bg-emerald-500';
    }
  }

  function getHealthTitle(status?: string) {
    return status || 'HEALTHY';
  }

  function formatInterval(intervalMs?: number): string {
    if (!intervalMs) return '';
    if (intervalMs % 1000 === 0) return `${intervalMs / 1000}s`;
    return `${intervalMs}ms`;
  }

  function emitModeChange(nextMode: TargetMode) {
    dispatch('modechange', { mode: nextMode });
  }

  function switchToService() {
    if (mode === 'service') return;

    if (route.service) {
      mode = 'service';
      emitModeChange('service');
      return;
    }

    if ((route.endpoints?.length ?? 0) > 0) {
      showSwitchConfirm = true;
      return;
    }

    mode = 'service';
    route.endpoints = undefined;
    emitModeChange('service');
  }

  function confirmSwitchToService() {
    showSwitchConfirm = false;
    mode = 'service';
    route.endpoints = undefined;
    if (pendingServiceName) {
      route.service = pendingServiceName;
      pendingServiceName = null;
    }
    emitModeChange('service');
  }

  function cancelSwitchToService() {
    showSwitchConfirm = false;
    pendingServiceName = null;
  }

  function switchToCustom() {
    if (mode === 'custom') return;

    if (route.service) {
      showCustomConfirm = true;
      return;
    }

    mode = 'custom';
    route.service = undefined;
    emitModeChange('custom');
  }

  function confirmSwitchToCustom() {
    showCustomConfirm = false;
    mode = 'custom';
    route.service = undefined;
    emitModeChange('custom');
  }

  function cancelSwitchToCustom() {
    showCustomConfirm = false;
  }

  function selectService(name: string) {
    if ((route.endpoints?.length ?? 0) > 0) {
      pendingServiceName = name;
      showSwitchConfirm = true;
      return;
    }

    mode = 'service';
    route.endpoints = undefined;
    route.service = name;
    searchQuery = '';
    emitModeChange('service');

    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  function clearService() {
    route.service = undefined;
  }

  async function saveAsService() {
    const name = saveServiceName.trim();
    const endpoints = route.endpoints ?? [];

    if (!name || endpoints.length === 0) return;

    try {
      savingService = true;
      await ServicesAPI.create({
        name,
        endpoints: endpoints.map(({ _uid, ...endpoint }) => endpoint),
      });

      const createdService: Service = {
        name,
        endpoints: endpoints.map(endpoint => ({ ...endpoint })),
      };

      services = [...services, createdService];
      route.endpoints = undefined;
      route.service = name;
      mode = 'service';
      saveServiceName = '';
      toast.show($_('routeEditor.serviceCreated'), 'success');
      emitModeChange('service');
    } catch (error) {
      const message = error instanceof Error ? error.message : $_('common.error');
      toast.show(message, 'error');
    } finally {
      savingService = false;
    }
  }
</script>

<div>
  <div class="mb-4 inline-flex border border-carbon-600 bg-carbon-900">
    <button type="button" class="px-4 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-command transition-colors {mode === 'service' ? 'bg-nexus-500 text-black' : 'text-zinc-400 hover:text-nexus-300 hover:bg-carbon-700'}" on:click={switchToService} data-testid="mode-service">
      {$_('routeEditor.referenceService')}
    </button>
    <button type="button" class="px-4 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-command transition-colors {mode === 'custom' ? 'bg-nexus-500 text-black' : 'text-zinc-400 hover:text-nexus-300 hover:bg-carbon-700'}" on:click={switchToCustom} data-testid="mode-custom">
      {$_('routeEditor.customEndpoints')}
    </button>
  </div>

  {#if mode === 'service'}
    <div class="space-y-4">
      {#if !route.service}
        <PanelCard title={$_('routeEditor.selectServiceTitle')}>
          <svelte:fragment slot="actions">
            <div class="w-48">
              <Input
                type="text"
                placeholder={$_('routeEditor.searchServices')}
                bind:value={searchQuery}
                class="h-[28px] text-[12px]"
              />
            </div>
          </svelte:fragment>

          {#if filteredServices.length === 0}
            <div class="text-center py-12 bg-carbon-950/60/30 rounded-lg border-2 border-dashed border-carbon-600">
              <p class="text-zinc-500">{$_('routeEditor.noServicesFound')}</p>
            </div>
          {:else}
            <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {#each filteredServices as service}
                <button
                  type="button"
                  class="group border border-carbon-600 bg-carbon-950/60/70 hover:bg-nexus-500/10 hover:border-nexus-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nexus-500 transition-all text-left p-4"
                  on:click={() => selectService(service.name)}
                >
                  <div class="flex items-start justify-between gap-4">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/30"></span>
                        <span class="font-semibold text-zinc-100 group-hover:text-nexus-300 transition-colors truncate">{service.name}</span>
                      </div>
                      <div class="text-xs text-zinc-500 mt-2">
                        {$_('routeEditor.serviceEndpointCount', { values: { count: service.endpoints.length } })}
                      </div>
                    </div>
                    <StatusBadge variant="online">{$_('common.select')}</StatusBadge>
                  </div>
                  <div class="flex items-center gap-1.5 mt-3">
                    {#each service.endpoints.slice(0, 5) as ep}
                      <div class="w-2.5 h-2.5 rounded-full {getHealthColor(ep.status)}" title={getHealthTitle(ep.status)}></div>
                    {/each}
                    {#if service.endpoints.length > 5}
                      <span class="text-[10px] opacity-50">+{service.endpoints.length - 5}</span>
                    {/if}
                  </div>
                </button>
              {/each}
            </div>
          {/if}
        </PanelCard>
      {:else}
        {#if isServiceMissing}
          <div class="mb-4" data-testid="broken-service-warning">
            <SystemAlertBar
              title={$_('services.brokenServiceWarning', { values: { name: route.service } })}
              tone="danger"
            >
              <svelte:fragment slot="action">
                <button class="nx-btn-ghost nx-btn-sm" on:click={clearService}>{$_('common.reset')}</button>
              </svelte:fragment>
            </SystemAlertBar>
          </div>
        {/if}
        <PanelCard
          title={route.service}
          tag={!isServiceMissing ? `${selectedService?.endpoints.length} EP` : "MISSING"}
          stripe={isServiceMissing ? "red" : "orange"}
        >
          <svelte:fragment slot="actions">
            <div class="flex gap-2">
              {#if !isServiceMissing && selectedService}
                <IconButton
                  size="sm"
                  title={$_("breadcrumb.editService")}
                  on:click={() => window.location.hash = `/services/edit/${encodeURIComponent(selectedService.name)}`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </IconButton>
              {/if}
              <IconButton
                size="sm"
                variant="danger"
                title={$_('routeEditor.removeServiceReference')}
                on:click={clearService}
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m2 0H7m3-3h4a1 1 0 011 1v2H9V5a1 1 0 011-1z" />
                </svg>
              </IconButton>
            </div>
          </svelte:fragment>

          <div class="space-y-3">
            {#if !isServiceMissing}
              <div class="space-y-2">
                {#each groupedServiceEndpoints as group}
                    <div class="border border-carbon-600 overflow-hidden">
                    <div class="bg-carbon-950/60 px-3 py-2 text-xs font-semibold flex items-center gap-2">
                      <div class="w-2 h-2 rounded-full bg-nexus-500"></div>
                      {$_('upstream.priority')} {group.priority}
                    </div>
                    <div class="divide-y divide-carbon-600">
                      {#each group.endpoints as endpoint}
                        <div class="grid grid-cols-[1fr_auto_auto] gap-3 items-center px-3 py-2 text-sm" class:opacity-50={endpoint.is_disabled}>
                          <div class="font-mono truncate" title={endpoint.target}>{endpoint.target}</div>
                          <div class="text-xs text-zinc-500">{$_('upstream.weight')}: {endpoint.weight || 100}</div>
                          <div class="flex items-center gap-2 text-xs">
                            <span class="w-2 h-2 rounded-full {getHealthColor(endpoint.status)}"></span>
                            <span>{getHealthTitle(endpoint.status)}</span>
                          </div>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>

              <div class="text-sm text-zinc-300 space-y-1">
                {#if selectedService?.health_check?.enabled}
                  <div class="flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    {$_('serviceEditor.healthCheck')}: {selectedService.health_check.path || '/health'}
                    {#if selectedService.health_check.interval_ms}
                      · {formatInterval(selectedService.health_check.interval_ms)}
                    {/if}
                  </div>
                {/if}
                {#if selectedService?.failover?.enabled}
                  <div class="flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                    {$_('serviceEditor.failover')}: {$_("routeEditor.review.enabled")}
                  </div>
                {/if}
                {#if selectedService?.sticky_session?.enabled}
                  <div class="flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a8 8 0 11-16 0 8 8 0 0116 0zm-4-5a5 5 0 117 0 5 5 0 01-7 0z" /></svg>
                    {$_('routeEditor.stickySessionTitle')}: {$_("routeEditor.review.enabled")}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        </PanelCard>
      {/if}
    </div>
  {:else}
    <UpstreamsSection bind:route {errors} {weightErrors} />

    <PanelCard>
      <div class="flex flex-col gap-2 md:flex-row md:items-center">
        <input
          type="text"
          class="nx-input flex-1"
          placeholder={$_('routeEditor.saveAsServiceName')}
          bind:value={saveServiceName}
        />
        <button
          type="button"
          class="nx-btn-primary nx-btn-sm shrink-0 whitespace-nowrap"
          on:click={saveAsService}
          disabled={savingService || !saveServiceName.trim() || (route.endpoints?.length ?? 0) === 0}
        >
          {#if savingService}
            <LoadingIndicator label="" size="xs" centered={false} />
          {/if}
          {$_('routeEditor.saveAsServiceButton')}
        </button>
      </div>
    </PanelCard>
  {/if}
</div>

<ConfirmDialog
  bind:open={showSwitchConfirm}
  title={$_('common.confirm')}
  message={$_('routeEditor.switchToServiceConfirm')}
  confirmText={$_('confirmDialog.yes')}
  cancelText={$_('confirmDialog.no')}
  confirmClass="nx-btn-primary"
  on:confirm={confirmSwitchToService}
  on:cancel={cancelSwitchToService}
/>

<ConfirmDialog
  bind:open={showCustomConfirm}
  title={$_('common.confirm')}
  message={$_('routeEditor.switchToCustomConfirm')}
  confirmText={$_('confirmDialog.yes')}
  cancelText={$_('confirmDialog.no')}
  confirmClass="nx-btn-primary"
  on:confirm={confirmSwitchToCustom}
  on:cancel={cancelSwitchToCustom}
/>
