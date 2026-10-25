<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Route, Service } from '$api/routes';
  import type { ValidationError } from '$validation';
  import { ServicesAPI } from '$api/services';
  import { toEditorService, duplicateEditorUpstream } from '$api/config-adapters';
  import { _ } from '$i18n';
  import { toast } from '$stores/toast';
  import UpstreamsSection from './UpstreamsSection.svelte';
  import LoadBalancingSection from '$components/domain/service/LoadBalancingSection.svelte';
  import FailoverEditor from '$components/domain/service/FailoverEditor.svelte';
  import { PanelCard, LoadingIndicator } from '$components/industrial';
  import { Input } from '$components/ui/input';
  import { v4 as uuidv4 } from 'uuid';

  let { route = $bindable(), errors = [], weightErrors = [], services = $bindable([]) }: {
    route: Route; errors?: ValidationError[]; weightErrors?: ValidationError[]; services?: Service[];
  } = $props();
  let saveServiceName = $state('');
  let savingService = $state(false);
  let disposed = false;
  onDestroy(() => disposed = true);
  const targetCount = $derived((route.endpoints?.length ?? 0) + (route.service_references?.length ?? 0));
  function extractionPool() {
    return { endpoints: route.endpoints, service_references: route.service_references,
      load_balancing: route.load_balancing, failover: route.failover };
  }
  async function saveAsService() {
    const submittedName = saveServiceName, name = submittedName.trim();
    if (!name || !targetCount || savingService) return;
    const owner = route, ownerId = route._uid, poolJson = JSON.stringify(extractionPool());
    const pool: ReturnType<typeof extractionPool> = JSON.parse(poolJson);
    savingService = true;
    try {
      const saved = await ServicesAPI.create({ name, endpoints: (pool.endpoints ?? []).map((endpoint, index) => ({ ...duplicateEditorUpstream(endpoint), _position: endpoint._position ?? index })),
        service_references: pool.service_references?.map(reference => ({ ...reference, id: uuidv4() })),
        load_balancing: pool.load_balancing, failover: pool.failover });
      services = [...services, toEditorService(saved)];
      if (disposed || route !== owner || route._uid !== ownerId || JSON.stringify(extractionPool()) !== poolJson) {
        toast.show($_('routeEditor.serviceCreatedDraftRetained', { values: { name } }), 'warning');
        return;
      }
      route.endpoints = undefined;
      route.service_references = [{id: uuidv4(), position: 0, service_id: saved.id, weight: 100, priority: 1, is_disabled: false}];
      route.load_balancing = undefined;
      route.failover = undefined;
      if (saveServiceName === submittedName) saveServiceName = '';
      toast.show($_('routeEditor.serviceCreated'), 'success');
    } catch(error) { toast.show(error instanceof Error ? error.message : $_('common.error'), 'error'); }
    finally { savingService = false; }
  }
</script>
<div class="space-y-4">
  <UpstreamsSection bind:route {errors} {weightErrors} {services} />
    {#if targetCount > 1 || route.load_balancing || route.failover}
      <PanelCard title={$_('serviceReferences.pool')}>
        <div class="space-y-5">
          <LoadBalancingSection bind:load_balancing={route.load_balancing} />
          <FailoverEditor bind:failover={route.failover} endpointHealth={false} label={$_('routeEditor.failoverTitle')} />
        </div>
      </PanelCard>
    {/if}
    <div class="space-y-2 border-t border-carbon-600 pt-3">
      <p class="text-sm text-zinc-400">{$_('routeEditor.saveAsServiceHelp')}</p>
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Input placeholder={$_('routeEditor.saveAsServiceName')} aria-label={$_('routeEditor.saveAsServiceName')} bind:value={saveServiceName} class="sm:max-w-xs" />
      <button type="button" class="nx-btn-ghost nx-btn-sm shrink-0 whitespace-nowrap" onclick={saveAsService} disabled={savingService || !saveServiceName.trim() || !targetCount || errors.length > 0}>
        {#if savingService}<LoadingIndicator label="" size="xs" centered={false} />{/if}{$_('routeEditor.saveAsServiceButton')}
      </button>
      </div>
    </div>
</div>
