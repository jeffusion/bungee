<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { pop } from 'svelte-spa-router';
  import { sortBy } from 'lodash-es';
  import { ServicesAPI, type Service } from '$api/services';
  import { RoutesAPI, type Route } from '$api/routes';
  import { validateWeights, type ValidationError } from '$validation';
  import UpstreamsSection from '$components/domain/route/sections/UpstreamsSection.svelte';
  import FailoverSection from '$components/domain/route/sections/FailoverSection.svelte';
  import TimeoutsSection from '$components/domain/service/TimeoutsSection.svelte';
  import LoadBalancingSection from '$components/domain/service/LoadBalancingSection.svelte';
  import HealthCheckSection from '$components/domain/service/HealthCheckSection.svelte';
  import RelationshipLink from '$components/domain/service/RelationshipLink.svelte';
  import HealthSummary from '$components/domain/service/HealthSummary.svelte';
  import EndpointQuickPreview from '$components/domain/service/EndpointQuickPreview.svelte';
  import FeatureBadge from '$components/domain/route/FeatureBadge.svelte';
  import ConfirmDialog from '$components/shell/ConfirmDialog.svelte';
  import { getServiceConsumers, getServiceHealthAggregate, getRouteFeatureBadges } from '$utils/route-service-view-model';
  import { toast } from '$stores/toast';
  import { _ } from '$i18n';
  import { v4 as uuidv4 } from 'uuid';
import { getModifierKey, isModifierPressed } from '$utils/platform';
import { LoadingIndicator, PanelCard, StatusBadge, StatusDot, SystemAlertBar, BSwitch } from '$components/industrial';
import { Input } from '$components/ui/input';
import { Textarea } from '$components/ui/textarea';
import { Button } from '$components/ui/button';
import PluginEditor from '$components/domain/plugin/PluginEditor.svelte';

  export let params: { name?: string } = {};

  let isEditMode = false;
  let originalName = '';
  let loading = true;
  let saving = false;
  type SectionId = 'identity' | 'transport' | 'endpoints' | 'availability' | 'consumers' | 'plugins' | 'review';
  let activeSection: SectionId = 'identity';
  let showValidationDetails = false;
  let allRoutes: Route[] = [];

let service: Service = {
  name: '',
  description: '',
  endpoints: [{ _uid: uuidv4(), target: '', weight: 100, priority: 1 }],
  failover: { enabled: false },
  health_check: { enabled: false },
  load_balancing: undefined,
  plugins: [],
};

  let errors: ValidationError[] = [];
  let weightErrors: ValidationError[] = [];
  let allErrors: ValidationError[] = [];
  let isValid = false;
  let validationDebounce: any = null;

  let lastAutoSave: number | null = null;
  let autoSaveInterval: any = null;

  // Confirm dialog (uses industrial ConfirmDialog now)
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
    if (confirmDialogCallback) {
      confirmDialogCallback();
      confirmDialogCallback = null;
    }
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
    if (event.key >= '1' && event.key <= '6' && isModifierPressed(event) && !event.altKey) {
      const sections: SectionId[] = ['identity', 'transport', 'endpoints', 'availability', 'consumers', 'plugins', 'review'];
      const target = sections[parseInt(event.key) - 1];
      if (target) {
        activeSection = target;
        event.preventDefault();
      }
    }
  }

  function autoSaveDraft() {
    if (!isEditMode) {
      try {
        localStorage.setItem('bungee-service-draft', JSON.stringify(service));
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
    const currentErrors: ValidationError[] = [];
    if (!service.name) {
      currentErrors.push({ field: 'name', message: $_('validation.fieldRequired') });
    } else if (!/^[a-z0-9-]+$/.test(service.name)) {
      currentErrors.push({ field: 'name', message: $_('serviceEditor.serviceNameHelp') });
    }
    if (!service.endpoints || service.endpoints.length === 0) {
      currentErrors.push({ field: 'endpoints', message: $_('validation.upstreamRequired') });
    }
    const currentWeightErrors = validateWeights(service.endpoints);
    errors = currentErrors;
    weightErrors = currentWeightErrors;
    allErrors = [...currentErrors, ...currentWeightErrors];
    isValid = allErrors.length === 0;
  }

  $: {
    service && (() => {
      if (validationDebounce) clearTimeout(validationDebounce);
      validationDebounce = setTimeout(() => performValidation(), 300);
    })();
  }

  $: consumers = getServiceConsumers(service.name, allRoutes);
  $: healthAggregate = getServiceHealthAggregate(service);

  async function handleSave() {
    if (!isValid) return;
    try {
      saving = true;
      const sortedService = {
        ...service,
        endpoints: sortBy(service.endpoints, [(e: any) => e.priority ?? 1]).map(({ _uid, ...e }: any) => e),
      };
      if (isEditMode) {
        await ServicesAPI.update(originalName, sortedService);
        toast.show($_('serviceEditor.serviceUpdated'), 'success');
      } else {
        await ServicesAPI.create(sortedService);
        toast.show($_('serviceEditor.serviceSaved'), 'success');
        localStorage.removeItem('bungee-service-draft');
      }
      pop();
    } catch (e: any) {
      toast.show(e.message || $_('serviceEditor.saveFailed'), 'error');
    } finally {
      saving = false;
    }
  }

  function handleCancel() {
    showConfirm(
      $_('confirmDialog.cancelTitle'),
      $_('confirmDialog.cancelMessage'),
      () => pop()
    );
  }

  onMount(async () => {
    window.addEventListener('keydown', handleKeydown);
    autoSaveInterval = setInterval(() => autoSaveDraft(), 30000);

    try {
      allRoutes = await RoutesAPI.list();
    } catch (e) {
      console.error('Failed to load routes for consumers:', e);
    }

    if (params.name) {
      isEditMode = true;
      originalName = decodeURIComponent(params.name);
      try {
        const existingService = await ServicesAPI.get(originalName);
        if (existingService) {
service = {
  ...existingService,
  health_check: existingService.health_check ?? { enabled: false },
  failover: existingService.failover ?? { enabled: false },
  load_balancing: existingService.load_balancing,
  endpoints: existingService.endpoints.map((e) => ({ ...e, _uid: uuidv4() })),
  plugins: existingService.plugins ?? [],
};
        } else {
          toast.show($_('serviceEditor.serviceNotFound'), 'error');
          pop();
        }
      } catch (e: any) {
        toast.show(e.message, 'error');
        pop();
      }
    } else {
      try {
        const draft = localStorage.getItem('bungee-service-draft');
        if (draft) {
          const parsedDraft = JSON.parse(draft);
          showConfirm(
            $_('confirmDialog.restoreDraftTitle'),
            $_('confirmDialog.restoreDraftMessage'),
            () => {
              service = {
                ...parsedDraft,
                load_balancing: parsedDraft.load_balancing,
              };
            }
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

  // Navigation items for the side rail
  $: navItems = loading ? [] : ([
    {
      id: 'identity'     as SectionId,
      label: $_('serviceEditor.builder.identity'),
      icon: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
      badge: '',
    },
    {
      id: 'transport'    as SectionId,
      label: $_('serviceEditor.builder.transport'),
      icon: 'M8 7h8m-8 5h8m-8 5h8',
      badge: (service.timeouts || service.load_balancing) ? '✓' : '',
    },
    {
      id: 'endpoints'    as SectionId,
      label: $_('serviceEditor.builder.endpoints'),
      icon: 'M13 10V3L4 14h7v7l9-11h-7z',
      badge: service.endpoints.length ? `EP·${service.endpoints.length}` : '',
    },
    {
      id: 'availability' as SectionId,
      label: $_('serviceEditor.builder.availability'),
      icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
      badge: (service.health_check?.enabled || service.failover?.enabled) ? '✓' : '',
    },
  {
    id: 'consumers' as SectionId,
    label: $_('serviceEditor.builder.consumers'),
    icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z',
    badge: consumers.count > 0 ? `×${consumers.count}` : '',
  },
  {
    id: 'plugins' as SectionId,
    label: $_('serviceEditor.builder.plugins'),
    icon: 'M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 011-1h1a2 2 0 100-4H7a1 1 0 01-1-1V7a1 1 0 011-1h3a1 1 0 001-1V4z',
    badge: service.plugins?.length ? `×${service.plugins.length}` : '',
  },
  {
      id: 'review'       as SectionId,
      label: $_('serviceEditor.builder.review'),
      icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
      badge: '',
    },
  ]);
</script>

<div class="min-h-screen flex flex-col">
  <!-- ===== Breadcrumb header ======================================= -->
  <div class="border-b border-carbon-600 bg-carbon-900/70 backdrop-blur sticky top-16 z-30">
    <div class="max-w-7xl mx-auto px-6 py-3">
      <nav class="flex items-center gap-2 font-mono text-[11px] uppercase tracking-command">
        <button type="button" class="text-zinc-500 hover:text-nexus-300 transition-colors" on:click={() => (window.location.hash = '/')}>
          {$_('breadcrumb.home')}
        </button>
        <span class="text-zinc-700">/</span>
        <button type="button" class="text-zinc-500 hover:text-nexus-300 transition-colors" on:click={() => (window.location.hash = '/services')}>
          {$_('breadcrumb.services')}
        </button>
        <span class="text-zinc-700">/</span>
        <span class="text-nexus-300 flex items-center gap-2">
          <span>{isEditMode ? $_('breadcrumb.editService') : $_('breadcrumb.newService')}</span>
          {#if isEditMode}
            <code class="px-1.5 py-0.5 border border-carbon-500 bg-carbon-900 text-zinc-300 normal-case">{originalName}</code>
          {/if}
        </span>
      </nav>
    </div>
  </div>

  {#if loading}
    <LoadingIndicator label="LOADING SERVICE" class="flex-1" height="none" />
  {:else}
    <div class="max-w-7xl mx-auto w-full flex flex-col lg:flex-row gap-4 p-4 sm:p-6 pb-32">
      <!-- ===== Side nav ============================================== -->
      <aside class="w-full lg:w-56 flex-shrink-0" data-testid="service-builder-nav">
        <div class="lg:sticky lg:top-32 space-y-3">
          <PanelCard title="BUILDER" tag="NAV" flush>
            <ul class="divide-y divide-carbon-600">
              {#each navItems as item}
                <li>
                  <button
                    class="nx-side-nav-btn"
                    class:is-active={activeSection === item.id}
                    on:click={() => (activeSection = item.id)}
                    data-testid={`service-nav-${item.id}`}
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

          <PanelCard title={$_('shortcuts.title')} tag="KEYS">
            <ul class="space-y-1.5 font-mono text-[11px]">
              <li class="flex items-center gap-1.5">
                <kbd class="nx-kbd">{getModifierKey()}</kbd><span class="text-zinc-600">+</span><kbd class="nx-kbd">S</kbd>
                <span class="text-zinc-400 ml-2">{$_('shortcuts.save')}</span>
              </li>
              <li class="flex items-center gap-1.5">
                <kbd class="nx-kbd">{getModifierKey()}</kbd><span class="text-zinc-600">+</span><kbd class="nx-kbd">1-6</kbd>
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

      <!-- ===== Content panel ======================================= -->
      <section class="flex-1 min-w-0 space-y-4">
        {#if activeSection === 'identity'}
          <PanelCard title={$_('serviceEditor.builder.identity')} tag="ID-01">
            <div class="space-y-5">
              <label class="block space-y-1.5">
                <span class="nx-label">// {$_('serviceEditor.serviceName')} <span class="text-red-400">*</span></span>
                <div class:border-red-500={errors.some((e) => e.field === 'name')}>
                  <Input
                    type="text"
                    value={service.name}
                    oninput={(e) => { service.name = (e.target as HTMLInputElement).value; }}
                    placeholder={$_('serviceEditor.serviceNamePlaceholder')}
                    data-testid="service-name-input"
                  />
                </div>
                <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
                  {$_('serviceEditor.serviceNameHelp')}
                </span>
                {#if errors.some((e) => e.field === 'name')}
                  <span class="block font-mono text-[10px] uppercase tracking-command text-red-300">
                    {errors.find((e) => e.field === 'name')?.message}
                  </span>
                {/if}
              </label>

              <label class="block space-y-1.5">
                <span class="nx-label">// {$_('upstream.description')}</span>
                <Textarea
                  class="h-24 resize-y"
                  value={service.description ?? ''}
                  oninput={(e) => { service.description = (e.target as HTMLTextAreaElement).value; }}
                  placeholder={$_('upstream.descriptionPlaceholder')}
                />
              </label>
            </div>
          </PanelCard>

        {:else if activeSection === 'transport'}
          <div class="space-y-4">
            <PanelCard title={$_('serviceEditor.builder.timeouts')} tag="TO-01">
              <TimeoutsSection bind:timeouts={service.timeouts} />
            </PanelCard>
            <PanelCard title={$_('serviceEditor.builder.loadBalancing')} tag="LB-01">
              <LoadBalancingSection bind:load_balancing={service.load_balancing} />
            </PanelCard>
          </div>

        {:else if activeSection === 'endpoints'}
          <PanelCard title={$_('serviceEditor.builder.endpoints')} tag="EP-{service.endpoints.length}">
            <div data-testid="service-nav-endpoints" class="space-y-4">
              <UpstreamsSection bind:route={service} {errors} {weightErrors} isService={true} />
            </div>
          </PanelCard>

        {:else if activeSection === 'availability'}
          <div class="space-y-4">
            <PanelCard title={$_('serviceEditor.builder.healthCheck')} tag="HC-01">
              <HealthCheckSection bind:health_check={service.health_check} />
            </PanelCard>
            <PanelCard title={$_('serviceEditor.builder.failover')} tag="FO-01">
              <FailoverSection bind:route={service} />
            </PanelCard>
          </div>

        {:else if activeSection === 'consumers'}
          <PanelCard title={$_('serviceEditor.consumersTitle')} tag={consumers.count > 0 ? `N=${consumers.count}` : 'NONE'}>
            <p class="text-xs text-zinc-500 mb-4">{$_('serviceEditor.consumersHelp')}</p>

            {#if service.name}
              {#if consumers.count > 0}
                <div class="space-y-2" data-testid="service-consumers-list">
                  {#each consumers.routes as consumerRoute}
                    <div class="flex items-center justify-between gap-3 border border-carbon-600 bg-carbon-900/60 px-3 py-2 hover:bg-carbon-700/40 transition-colors">
                      <RelationshipLink type="route" name={consumerRoute.path} />
                      <div class="flex items-center gap-1 flex-wrap">
                        {#each getRouteFeatureBadges(consumerRoute) as badge}
                          <FeatureBadge {badge} />
                        {/each}
                      </div>
                    </div>
                  {/each}
                </div>
              {:else}
                <div class="py-10 text-center border border-dashed border-carbon-500">
                  <svg viewBox="0 0 24 24" class="h-10 w-10 mx-auto text-zinc-600 mb-3" fill="none" stroke="currentColor" stroke-width="1.4">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 010 5.656m-5.656 0a4 4 0 010-5.656m9.9-2.12a8 8 0 010 11.314m-14.142 0a8 8 0 010-11.314" />
                  </svg>
                  <p class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('serviceEditor.noConsumers')}</p>
                </div>
              {/if}
            {:else}
              <div class="py-8 text-center">
                <p class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('serviceEditor.consumersNameRequired')}</p>
              </div>
            {/if}
  </PanelCard>

{:else if activeSection === 'plugins'}
  <PanelCard title={$_('serviceEditor.builder.plugins')} tag={`N=${service.plugins?.length ?? 0}`}>
    <div data-testid="section-plugins">
      <PluginEditor
        bind:plugins={service.plugins}
        label="Service Plugins"
        scope="service"
        scopeName={service.name || 'NEW SERVICE'}
      />
    </div>
  </PanelCard>

{:else if activeSection === 'review'}
          <div class="space-y-4" data-testid="service-review-summary">
            <PanelCard title={$_('serviceEditor.reviewTitle')} tag="REVIEW">
              <p class="text-xs text-zinc-500 mb-4">{$_('serviceEditor.reviewHelp')}</p>

              <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div class="border border-carbon-600 bg-carbon-900/60 px-3 py-2">
                  <span class="nx-label-sm block mb-1">{$_('serviceEditor.serviceName')}</span>
                  <p class="font-mono text-[12px] text-zinc-100 truncate" title={service.name}>{service.name || '—'}</p>
                  <p class="font-mono text-[10px] text-zinc-500 mt-0.5 truncate">{service.description || $_('serviceEditor.reviewNoDescription')}</p>
                </div>
                <div class="border border-carbon-600 bg-carbon-900/60 px-3 py-2">
                  <span class="nx-label-sm block mb-1">{$_('services.endpointLabel')}</span>
                  <p class="nx-display text-2xl text-nexus-300">{service.endpoints.length}</p>
                  <p class="font-mono text-[10px] text-zinc-500 mt-0.5">
                    {$_('serviceEditor.reviewTotalWeight', { values: { weight: service.endpoints.reduce((sum, e) => sum + (e.weight || 100), 0) } })}
                  </p>
                </div>
                <div class="border border-carbon-600 bg-carbon-900/60 px-3 py-2">
                  <span class="nx-label-sm block mb-1">{$_('services.consumerLabel')}</span>
                  <p class="nx-display text-2xl text-zinc-100">{consumers.count}</p>
                  <p class="font-mono text-[10px] text-zinc-500 mt-0.5">
                    {$_('serviceEditor.consumersRoutesCount', { values: { count: consumers.count } })}
                  </p>
                </div>
              </div>
            </PanelCard>

            <PanelCard title={$_('routeEditor.upstreams')} tag="EP-LIST">
              <EndpointQuickPreview endpoints={service.endpoints} limit={5} />
            </PanelCard>

            <PanelCard title={$_('serviceEditor.builder.availability')} tag="AVAIL">
              <div class="space-y-2">
                <div class="flex items-center gap-3">
                  <HealthSummary aggregate={healthAggregate} />
                  <span class="font-mono text-[11px] uppercase tracking-command text-zinc-400">{$_('serviceEditor.reviewHealthStatus')}</span>
                </div>
                <div class="flex flex-wrap items-center gap-2 pt-2 border-t border-carbon-600">
                  {#if service.health_check?.enabled}
                    <StatusBadge variant="active" dot>{$_('serviceEditor.healthCheck')}</StatusBadge>
                  {:else}
                    <StatusBadge variant="muted">{$_('serviceEditor.healthCheck')}</StatusBadge>
                  {/if}
                  {#if service.failover?.enabled}
                    <StatusBadge variant="active" dot>{$_('serviceEditor.failover')}</StatusBadge>
                  {:else}
                    <StatusBadge variant="muted">{$_('serviceEditor.failover')}</StatusBadge>
                  {/if}
                  {#if service.load_balancing}
                    <StatusBadge variant="active" dot>{$_('serviceEditor.builder.loadBalancing')}</StatusBadge>
                  {:else}
                    <StatusBadge variant="muted">{$_('serviceEditor.builder.loadBalancing')}</StatusBadge>
                  {/if}
                </div>
              </div>
            </PanelCard>

            {#if service.plugins && service.plugins.length > 0}
            <PanelCard title={$_('serviceEditor.builder.plugins')} tag={`N=${service.plugins.length}`}>
              <div class="flex flex-wrap gap-2">
                {#each service.plugins as plugin}
                  {@const pluginName = typeof plugin === 'string' ? plugin : plugin.name}
                  <StatusBadge variant="accent">{pluginName}</StatusBadge>
                {/each}
              </div>
            </PanelCard>
            {/if}
          </div>
        {/if}
      </section>
    </div>
  {/if}

  <!-- ===== Bottom action bar ===================================== -->
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
              <button class="font-mono text-[10px] uppercase tracking-command text-zinc-400 hover:text-nexus-300 hover:underline transition-colors" on:click={() => (showValidationDetails = !showValidationDetails)}>
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
          <Button variant="ghost" onclick={handleCancel} disabled={saving}>
            {$_('common.cancel')}
          </Button>
          <Button variant="default" disabled={!isValid || saving} onclick={handleSave} data-testid="service-save-button">
            {#if saving}
              <LoadingIndicator label="" size="xs" centered={false} />
            {:else}
              <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
                <path stroke-linecap="round" stroke-linejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
              </svg>
            {/if}
            {$_('common.save')}
          </Button>
        </div>
      </div>

      {#if showValidationDetails && allErrors.length > 0}
        <div class="mt-3 border border-red-500/40 bg-red-500/5 px-3 py-2">
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

  <!-- Confirm dialog (industrial) -->
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

<style>
  /* Side-nav button — flat industrial row in the BUILDER panel. */
  :global(.nx-side-nav-btn) {
    display: inline-flex;
    width: 100%;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 0.875rem;
    font-family: 'DM Mono', 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #a1a1aa;
    background: transparent;
    transition: color 0.12s ease-out, background-color 0.12s ease-out;
  }
  :global(.nx-side-nav-btn:hover) {
    color: #fdba74;
    background-color: rgba(249, 115, 22, 0.04);
  }
  :global(.nx-side-nav-btn.is-active) {
    color: #fb923c;
    background-color: rgba(249, 115, 22, 0.08);
  }

  /* Industrial keyboard glyph */
  :global(.nx-kbd) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    padding: 0 4px;
    height: 18px;
    border: 1px solid #2a2f3a;
    background: #15171c;
    color: #d4d4d8;
    font-family: 'DM Mono', monospace;
    font-size: 10px;
    line-height: 1;
  }
</style>
