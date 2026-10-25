<script lang="ts">
  import UpstreamTargetList from './UpstreamTargetList.svelte';
  import type { Route, Service } from '$api/routes';
  import type { ValidationError } from '$validation';
  import { validateUpstreamSync } from '$validation';
  import UpstreamForm from '../UpstreamForm.svelte';
  import { _ } from '$i18n';
  import { isLoading } from 'svelte-i18n';
  import { v4 as uuidv4 } from 'uuid';
  import { cloneUpstreamDraft, duplicateEditorUpstream, hasInvalidManagedBinding } from '$api/config-adapters';
  import { Input } from '$components/ui/input';
  import { Button } from '$components/ui/button';
  import { IndustrialDialog, PanelCard, SegmentedControl } from '$components/industrial';

  let { route = $bindable(), errors = [], weightErrors = [], isService = false, services = [], ownerId }: {
    route: Pick<Route, 'endpoints' | 'service_references' | '_uid'>; errors?: ValidationError[]; weightErrors?: ValidationError[]; isService?: boolean; services?: Service[]; ownerId?: string;
  } = $props();

  import ServiceReferencePicker from '$components/domain/service/ServiceReferencePicker.svelte';
  let upstreamSearchTerm = $state('');
  function nextPosition() {
    return Math.max(-1, ...(route.endpoints ?? []).map((endpoint, index) => endpoint._position ?? index),
      ...(route.service_references ?? []).map(reference => reference.position)) + 1;
  }

  let showUpstreamModal = $state(false);
  let editingUpstreamIndex = $state(-1);
  let editingUpstream: any = $state(null);
  let dialogKind = $state<'custom' | 'service'>('custom');
  let selectedServiceId = $state('');
  const selectedService = $derived(services.find(service => service._uid === selectedServiceId && service._uid !== ownerId && !route.service_references?.some(reference => reference.service_id === service._uid)));
  const dialogTitle = $derived(!$isLoading ? (editingUpstreamIndex >= 0 ? $_('upstream.title', { values: { index: editingUpstreamIndex + 1 } }) : `${$_('routeEditor.addTarget')} · ${dialogKind === 'custom' ? 'EP' : 'SVC'}`) : '');

  let endpoints = $derived(route.endpoints ?? []);
  let editingUpstreamErrors = $derived(!$isLoading && showUpstreamModal && editingUpstream
    ? validateUpstreamSync(editingUpstream, editingUpstreamIndex === -1 ? (route.endpoints?.length ?? 0) : editingUpstreamIndex) : []);
  let isEditingUpstreamValid = $derived(showUpstreamModal && editingUpstream && editingUpstreamErrors.length === 0 && !hasInvalidManagedBinding(editingUpstream));

  export function openUpstreamModal(index: number = -1) {
    dialogKind = 'custom';
    editingUpstreamIndex = index;
    if (index >= 0) {
      editingUpstream = cloneUpstreamDraft(route.endpoints![index]);
    } else {
      editingUpstream = {
        _uid: uuidv4(),
        _position: nextPosition(),
        target: '',
        weight: 100,
        priority: (route.endpoints?.length ?? 0) + 1,
        request: {},
        response: {}
      };
    }
    showUpstreamModal = true;
  }

  function openServicePicker() {
    dialogKind = 'service';
    editingUpstreamIndex = -1;
    editingUpstream = null;
    selectedServiceId = '';
    showUpstreamModal = true;
  }

  function addService() {
    if (!selectedService?._uid) return;
    route.service_references = [...(route.service_references ?? []), {
      id: uuidv4(), service_id: selectedService._uid, position: nextPosition(), priority: 1, weight: 100, is_disabled: false,
    }];
    closeUpstreamModal();
  }

  function closeUpstreamModal() {
    showUpstreamModal = false;
  }

  function saveUpstream() {
    if (!isEditingUpstreamValid) return;

    route.endpoints = route.endpoints ?? [];

    if (editingUpstreamIndex >= 0) {
      route.endpoints[editingUpstreamIndex] = editingUpstream;
    } else {
      route.endpoints = [...route.endpoints, editingUpstream];
    }
    closeUpstreamModal();
  }

  function removeUpstream(index: number) {
    route.endpoints = (route.endpoints ?? []).filter((_, i) => i !== index);
  }

  function duplicateUpstream(index: number) {
    const originalUpstream = route.endpoints?.[index];
    if (!originalUpstream) return;
    if (hasInvalidManagedBinding(originalUpstream)) {
      alert($_('upstream.managedInvalid'));
      return;
    }
    const duplicatedUpstream = duplicateEditorUpstream(originalUpstream);
    duplicatedUpstream._position = nextPosition();

    if (!duplicatedUpstream.managedBy && duplicatedUpstream.target) {
      const urlMatch = duplicatedUpstream.target.match(/^(.+?)(-\d+)?$/);
      if (urlMatch) {
        const [, baseUrl, suffix] = urlMatch;
        if (suffix) {
          const num = parseInt(suffix.slice(1)) + 1;
          duplicatedUpstream.target = `${baseUrl}-${num}`;
        } else {
          duplicatedUpstream.target = `${baseUrl}-copy`;
        }
      } else {
        duplicatedUpstream.target = `${duplicatedUpstream.target}-copy`;
      }
    }

    if (duplicatedUpstream.priority !== undefined) {
      duplicatedUpstream.priority = Math.max(...(route.endpoints ?? []).map(u => u.priority || 1)) + 1;
    }

    route.endpoints = [
      ...(route.endpoints ?? []).slice(0, index + 1),
      duplicatedUpstream,
      ...(route.endpoints ?? []).slice(index + 1)
    ];
  }

  function toggleUpstreamStatus(index: number) {
    if (!route.endpoints?.[index]) return;
    route.endpoints[index].is_disabled = !route.endpoints[index].is_disabled;
    route.endpoints = route.endpoints; // 触发 Svelte 响应式更新
  }

  // Component Event Proxies
  function onEdit(originalIndex: number) { openUpstreamModal(originalIndex); }
  function onRemove(originalIndex: number) { removeUpstream(originalIndex); }
  function onDuplicate(originalIndex: number) { duplicateUpstream(originalIndex); }
  function onToggleStatus(originalIndex: number) { toggleUpstreamStatus(originalIndex); }
  function onUpdateWeight(originalIndex: number, weight: number | undefined) {
    if (!route.endpoints?.[originalIndex]) return;
    route.endpoints[originalIndex].weight = weight ?? 0;
    route.endpoints = route.endpoints;
  }
</script>

{#snippet toolbar()}
  <div class="flex w-full min-w-0 flex-wrap items-center gap-3">
    <div class="ml-auto flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
      <Input
        type="text"
        placeholder={$_('common.search')}
        aria-label={$_('routeEditor.targetSearch')}
        bind:value={upstreamSearchTerm}
        class="h-7 flex-1 min-w-0 text-xs sm:w-40"
      />
      <Button
        variant="default"
        size="sm"
        class="shrink-0 whitespace-nowrap h-[28px]"
        onclick={() => openUpstreamModal()}
        data-testid="route-upstream-add-button"
      >
        <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        {$_('routeEditor.addTarget')}
      </Button>
    </div>
  </div>
{/snippet}

{#snippet contents()}
  {#if errors.some(e => e.field === 'endpoints')}
    <div class="border-l-2 border-l-red-500 bg-red-500/5 px-3 py-2">
      <span class="font-mono text-[11px] uppercase tracking-command text-red-300">
        {errors.find(e => e.field === 'endpoints')?.message}
      </span>
    </div>
  {/if}

  <UpstreamTargetList bind:owner={route} {services} stateKey={ownerId ?? route._uid ?? ''} searchTerm={upstreamSearchTerm}
    onedit={onEdit} onremove={onRemove} onduplicate={onDuplicate} ontogglestatus={onToggleStatus} onupdateweight={onUpdateWeight} />
  {#each errors.filter(error => error.field === 'service_references') as error}
    <p role="alert" class="text-red-300 text-sm">{error.message}</p>
  {/each}

  {#if weightErrors.length > 0}
    <div class="border-l-2 border-l-amber-500 bg-amber-500/5 px-3 py-2">
      <span class="font-mono text-[11px] uppercase tracking-command text-amber-300">
        {weightErrors[0].message}
      </span>
    </div>
  {/if}
{/snippet}

{#if isService}
  <PanelCard title={$_('serviceEditor.builder.endpoints')} tag={`EP·${endpoints.length} SVC·${route.service_references?.length ?? 0}`}
    class="[&>.nx-panel-head]:flex-wrap [&>.nx-panel-head]:gap-y-2 [&>.nx-panel-head>div:first-child]:basis-full sm:[&>.nx-panel-head>div:first-child]:basis-auto [&>.nx-panel-head>div:last-child]:w-full sm:[&>.nx-panel-head>div:last-child]:w-auto [&>.nx-panel-head>div:last-child]:min-w-0">
    {#snippet actions()}{@render toolbar()}{/snippet}
    {@render contents()}
  </PanelCard>
{:else}
  <div class="space-y-4">{@render toolbar()}{@render contents()}</div>
{/if}

<IndustrialDialog bind:open={showUpstreamModal} title={dialogTitle} description="" closeLabel={$_('common.close')} width="48rem" scrollBody>
  {#snippet body()}
    {#if editingUpstreamIndex < 0}
      <SegmentedControl value={dialogKind} ariaLabel={$_('routeEditor.targetType')}
        options={[{ value: 'custom', label: `EP ${$_('services.endpointLabel')}` }, { value: 'service', label: `SVC ${$_('services.serviceLabel')}` }]}
        onchange={kind => kind === 'service' ? openServicePicker() : openUpstreamModal()} />
    {/if}
    {#if dialogKind === 'service'}
      <ServiceReferencePicker bind:value={selectedServiceId} {services} {ownerId} excludedIds={(route.service_references ?? []).map(reference => reference.service_id)} />
    {:else if editingUpstream}
        <UpstreamForm
          bind:upstream={editingUpstream}
          index={editingUpstreamIndex}
          showHeader={false}
          onRemove={() => {}}
          onDuplicate={() => {}}
          {isService}
        />
    {/if}
  {/snippet}
  {#snippet footer()}
    <Button variant="ghost" onclick={closeUpstreamModal}>{$_('common.cancel')}</Button>
    <Button variant="default" onclick={dialogKind === 'service' ? addService : saveUpstream}
      disabled={dialogKind === 'service' ? !selectedService : !isEditingUpstreamValid}
      data-testid={dialogKind === 'service' ? 'service-reference-confirm' : 'upstream-modal-save'}>
      {editingUpstreamIndex >= 0 ? $_('common.save') : $_('common.add')}
    </Button>
  {/snippet}
</IndustrialDialog>
