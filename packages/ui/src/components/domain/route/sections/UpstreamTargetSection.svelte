<script lang="ts">
  import { createEventDispatcher, untrack } from 'svelte';
  import type { Route, Service } from '$api/routes';
  import type { ValidationError } from '$validation';
  import { ServicesAPI } from '$api/services';
  import { toEditorService, duplicateEditorUpstream } from '$api/config-adapters';
  import { _ } from '$i18n';
  import { toast } from '$stores/toast';
  import ConfirmDialog from '$components/shell/ConfirmDialog.svelte';
  import UpstreamsSection from './UpstreamsSection.svelte';
  import UpstreamTargetList from './UpstreamTargetList.svelte';
  import ServiceReferencePicker from '$components/domain/service/ServiceReferencePicker.svelte';
  import LoadBalancingSection from '$components/domain/service/LoadBalancingSection.svelte';
  import FailoverEditor from '$components/domain/service/FailoverEditor.svelte';
  import { PanelCard, LoadingIndicator } from '$components/industrial';
  import { Input } from '$components/ui/input';
  import { v4 as uuidv4 } from 'uuid';

  let { route = $bindable(), errors = [], weightErrors = [], services = $bindable([]) }: {
    route: Route; errors?: ValidationError[]; weightErrors?: ValidationError[]; services?: Service[];
  } = $props();
  type TargetMode = 'service' | 'custom';
  const dispatch = createEventDispatcher<{ modechange: {mode: TargetMode}; navigatetosection: {section: string} }>();
  let mode = $state<TargetMode>(untrack(() => route.service_references?.length ? 'service' : 'custom'));
  let activeRoute = $state.raw(untrack(() => route));
  let saveServiceName = $state('');
  let savingService = $state(false);
  let showSwitchConfirm = $state(false);
  let showCustomConfirm = $state(false);
  const references = $derived([...(route.service_references ?? [])].sort((a,b) => a.priority - b.priority || a.position - b.position));
  function setMode(next: TargetMode) {
    mode = next;
    if (next === 'service') route.endpoints = undefined;
    else { route.service_references = undefined; route.load_balancing = undefined; route.failover = undefined; }
    dispatch('modechange', {mode: next});
  }
  function switchToService() { if (mode === 'service') return; if (route.endpoints?.length) showSwitchConfirm = true; else setMode('service'); }
  function switchToCustom() { if (mode === 'custom') return; if (route.service_references?.length) showCustomConfirm = true; else setMode('custom'); }
  async function saveAsService() {
    const name = saveServiceName.trim(), endpoints = route.endpoints ?? [];
    if (!name || !endpoints.length) return;
    savingService = true;
    try {
      const saved = await ServicesAPI.create({ name, endpoints: endpoints.map(duplicateEditorUpstream) });
      services = [...services, toEditorService(saved)];
      route.service_references = [{id: uuidv4(), position: 0, service_id: saved.id, weight: 100, priority: 1, is_disabled: false}];
      setMode('service'); saveServiceName = '';
      toast.show($_('routeEditor.serviceCreated'), 'success');
    } catch(error) { toast.show(error instanceof Error ? error.message : $_('common.error'), 'error'); }
    finally { savingService = false; }
  }
  $effect(() => { if (route !== activeRoute) { activeRoute = route; mode = route.service_references?.length ? 'service' : 'custom'; } });
</script>
<div class="space-y-4">
  <div class="flex flex-wrap items-center justify-between gap-3">
  <div class="inline-flex border border-carbon-600 bg-carbon-900">
    <button type="button" class="px-4 py-1.5 font-mono text-[11px] uppercase tracking-command {mode === 'service' ? 'bg-nexus-500 text-black' : 'text-zinc-400 hover:text-nexus-300'}" onclick={switchToService} data-testid="mode-service">{$_('routeEditor.referenceService')}</button>
    <button type="button" class="px-4 py-1.5 font-mono text-[11px] uppercase tracking-command {mode === 'custom' ? 'bg-nexus-500 text-black' : 'text-zinc-400 hover:text-nexus-300'}" onclick={switchToCustom} data-testid="mode-custom">{$_('routeEditor.customEndpoints')}</button>
  </div>
  {#if mode === 'service'}<ServiceReferencePicker bind:owner={route} {services} />{/if}
  </div>
  {#if mode === 'service'}
    <UpstreamTargetList bind:owner={route} {services} />
    {#each errors.filter(error => error.field === 'service_references') as error}
      <p role="alert" class="text-sm text-red-300">{error.message}</p>
    {/each}
    {#if references.length > 1 || route.load_balancing || route.failover}
      <PanelCard title={$_('serviceReferences.pool')}>
        <div class="space-y-5">
          <LoadBalancingSection bind:load_balancing={route.load_balancing} />
          <FailoverEditor bind:failover={route.failover} endpointHealth={false} label={$_('routeEditor.failoverTitle')} />
        </div>
      </PanelCard>
    {/if}
  {:else}
    <UpstreamsSection bind:route {errors} {weightErrors} />
    <PanelCard>
      <div class="flex flex-col gap-2 md:flex-row md:items-center">
        <Input placeholder={$_('routeEditor.saveAsServiceName')} bind:value={saveServiceName} />
        <button type="button" class="nx-btn-primary nx-btn-sm shrink-0 whitespace-nowrap" onclick={saveAsService} disabled={savingService || !saveServiceName.trim() || !route.endpoints?.length}>
          {#if savingService}<LoadingIndicator label="" size="xs" centered={false} />{/if}{$_('routeEditor.saveAsServiceButton')}
        </button>
      </div>
    </PanelCard>
  {/if}
</div>
<ConfirmDialog bind:open={showSwitchConfirm} title={$_('common.confirm')} message={$_('routeEditor.switchToServiceConfirm')}
  confirmText={$_('confirmDialog.yes')} cancelText={$_('confirmDialog.no')} confirmClass="nx-btn-primary"
  on:confirm={() => { showSwitchConfirm = false; setMode('service'); }} on:cancel={() => showSwitchConfirm = false} />
<ConfirmDialog bind:open={showCustomConfirm} title={$_('common.confirm')} message={$_('routeEditor.switchToCustomConfirm')}
  confirmText={$_('confirmDialog.yes')} cancelText={$_('confirmDialog.no')} confirmClass="nx-btn-primary"
  on:confirm={() => { showCustomConfirm = false; setMode('custom'); }} on:cancel={() => showCustomConfirm = false} />
