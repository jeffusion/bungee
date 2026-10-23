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

  let { route = $bindable(), errors = [], weightErrors = [], isService = false, services = [], ownerId }: {
    route: Pick<Route, 'endpoints' | 'service_references'>; errors?: ValidationError[]; weightErrors?: ValidationError[]; isService?: boolean; services?: Service[]; ownerId?: string;
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

  let endpoints = $derived(route.endpoints ?? []);
  let editingUpstreamErrors = $derived(!$isLoading && showUpstreamModal && editingUpstream
    ? validateUpstreamSync(editingUpstream, editingUpstreamIndex === -1 ? (route.endpoints?.length ?? 0) : editingUpstreamIndex) : []);
  let isEditingUpstreamValid = $derived(showUpstreamModal && editingUpstream && editingUpstreamErrors.length === 0 && !hasInvalidManagedBinding(editingUpstream));

  export function openUpstreamModal(index: number = -1) {
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
    if ((route.endpoints?.length ?? 0) + (route.service_references?.length ?? 0) <= 1) {
      alert($_('routeEditor.upstreamRequired'));
      return;
    }
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

  import { Input } from '$components/ui/input';
  import { Button } from '$components/ui/button';
  import { PanelCard } from '$components/industrial';

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

<PanelCard
  title={isService ? $_('serviceEditor.builder.endpoints') : $_('routeEditor.customEndpoints')}
  tag={isService ? `EP·${endpoints.length} SVC·${route.service_references?.length ?? 0}` : ''}
  class={isService ? '[&>.nx-panel-head]:flex-wrap [&>.nx-panel-head]:gap-y-2 [&>.nx-panel-head>div:first-child]:basis-full sm:[&>.nx-panel-head>div:first-child]:basis-auto [&>.nx-panel-head>div:last-child]:w-full sm:[&>.nx-panel-head>div:last-child]:w-auto [&>.nx-panel-head>div:last-child]:min-w-0' : ''}
>
  {#snippet actions()}
    <div class={isService ? 'flex flex-wrap gap-2 items-center w-full min-w-0' : 'flex gap-2 items-center'}>
      <Input
        type="text"
        placeholder={$_('common.search')}
        aria-label={$_('serviceEditor.endpointSearch')}
        bind:value={upstreamSearchTerm}
        class={isService ? 'h-[28px] text-[12px] w-full sm:w-40 min-w-0' : 'h-[28px] text-[12px] w-40'}
      />
      <Button
        variant="default"
        size="sm"
        class="shrink-0 whitespace-nowrap h-[28px]"
        onclick={() => openUpstreamModal(-1)}
        data-testid="route-upstream-add-button"
      >
        <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        {$_('routeEditor.addUpstream')}
      </Button>
      {#if isService}<ServiceReferencePicker bind:owner={route} {services} {ownerId} />{/if}
    </div>
  {/snippet}

  {#if errors.some(e => e.field === 'endpoints')}
    <div class="border-l-2 border-l-red-500 bg-red-500/5 px-3 py-2">
      <span class="font-mono text-[11px] uppercase tracking-command text-red-300">
        {errors.find(e => e.field === 'endpoints')?.message}
      </span>
    </div>
  {/if}

  <UpstreamTargetList bind:owner={route} {services} searchTerm={upstreamSearchTerm}
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
</PanelCard>

<!-- Upstream Edit Modal -->
{#if showUpstreamModal && editingUpstream}
  <div
    class="fixed inset-0 z-[45] flex items-center justify-center p-4 bg-carbon-950/80"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) closeUpstreamModal(); }}
    onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeUpstreamModal(); } }}
  >
    <div class="nx-panel-raised nx-bracketed relative w-11/12 max-w-3xl flex flex-col max-h-[90vh]">
      <span class="nx-corner nx-corner-tl" aria-hidden="true"></span>
      <span class="nx-corner nx-corner-tr" aria-hidden="true"></span>
      <span class="nx-corner nx-corner-bl" aria-hidden="true"></span>
      <span class="nx-corner nx-corner-br" aria-hidden="true"></span>

      <header class="nx-panel-head">
        <div class="nx-panel-head-title">
          <span class="nx-stripe" aria-hidden="true"></span>
          <span>
            {editingUpstreamIndex >= 0
              ? $_('upstream.title', { values: { index: editingUpstreamIndex + 1 } })
              : $_('routeEditor.addUpstream')}
          </span>
        </div>
      </header>

      <div class="flex-1 overflow-y-auto p-4">
        <UpstreamForm
          bind:upstream={editingUpstream}
          index={editingUpstreamIndex}
          showHeader={false}
          onRemove={() => {}}
          onDuplicate={() => {}}
          {isService}
        />
      </div>

      <footer class="border-t border-carbon-600 px-4 py-3 flex justify-end gap-2 bg-carbon-900/60">
        <Button variant="ghost" onclick={closeUpstreamModal}>{$_('common.cancel')}</Button>
        <Button variant="default" onclick={saveUpstream} disabled={!isEditingUpstreamValid} data-testid="upstream-modal-save">
          {$_('common.save')}
        </Button>
      </footer>
    </div>
  </div>
{/if}
