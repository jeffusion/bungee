<script lang="ts">
  import { sortBy } from 'lodash-es';
  import type { Route, Upstream } from '$api/routes';
  import type { ValidationError } from '$validation';
  import { validateUpstreamSync } from '$validation';
  import UpstreamForm from '../UpstreamForm.svelte';
  import { _ } from '$i18n';
  import { isLoading } from 'svelte-i18n';
  import * as Dialog from '$components/ui/dialog';
  import { v4 as uuidv4 } from 'uuid';
  import { cloneUpstreamDraft, duplicateEditorUpstream, hasInvalidManagedBinding } from '$api/config-adapters';

  let { route = $bindable(), errors = [], weightErrors = [], isService = false }: {
    route: Pick<Route, 'endpoints'>; errors?: ValidationError[]; weightErrors?: ValidationError[]; isService?: boolean;
  } = $props();

  let upstreamSearchTerm = $state('');

  interface PriorityGroup {
    priority: number;
    groupIndex: number;
    upstreams: (Upstream & { originalIndex: number })[];
  }

  let showUpstreamModal = $state(false);
  let editingUpstreamIndex = $state(-1);
  let editingUpstream: any = $state(null);

  // Grouping Logic
  function groupUpstreams(upstreams: Upstream[], searchTerm = ''): PriorityGroup[] {
    const withIndex = upstreams.map((u, i) => ({ ...u, originalIndex: i }));
    const sorted = sortBy(withIndex, [(u) => u.priority || 1]);
    
    const groups: PriorityGroup[] = [];
    let currentGroup: PriorityGroup | null = null;
    
    for (const u of sorted) {
      const priority = u.priority || 1;
      
      if (!currentGroup || currentGroup.priority !== priority) {
        currentGroup = { priority, groupIndex: groups.length, upstreams: [] };
        groups.push(currentGroup);
      }
      
      currentGroup.upstreams.push(u);
    }
    
    const query = searchTerm.trim().toLowerCase();
    if (!query) return groups;
    // Preserve full-list endpoint and group indices; search is only a projection.
    return groups.map(group => ({
      ...group,
      upstreams: group.upstreams.filter(upstream =>
        [upstream.target, upstream.description].some(value => value?.toLowerCase().includes(query))),
    })).filter(group => group.upstreams.length > 0);
  }

  function flattenGroups(groups: PriorityGroup[]): Upstream[] {
    const flattened: Upstream[] = [];
    
    groups.forEach((group, index) => {
      // Priority is 1-based index of the group
      const newPriority = index + 1;
      
      group.upstreams.forEach(u => {
        const { originalIndex, ...upstreamData } = u;
        flattened.push({
          ...upstreamData,
          priority: newPriority
        });
      });
    });
    
    return flattened;
  }

  // Reactive grouping
  let endpoints = $derived(route.endpoints ?? []);
  let groupedUpstreams = $derived(groupUpstreams(endpoints, upstreamSearchTerm));
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
        target: '',
        weight: 100,
        priority: (route.endpoints?.length ?? 0) + 1,
        headers: { add: {}, remove: [], default: {} },
        body: { add: {}, remove: [], replace: {}, default: {} },
        query: { add: {}, remove: [], replace: {}, default: {} }
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
    if ((route.endpoints?.length ?? 0) <= 1) {
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

  import UpstreamPriorityGroup from '../UpstreamPriorityGroup.svelte';
import { Input } from '$components/ui/input';
import { Button } from '$components/ui/button';
import { PanelCard } from '$components/industrial';
  
  // Drag & Drop Handlers
  function handleMerge(event: CustomEvent<{ originalIndex: number }>, targetGroupIndex: number) {
    const { originalIndex } = event.detail;
    const movedUpstream = route.endpoints?.[originalIndex];
    if (!movedUpstream) return;
    
    const targetGroup = groupUpstreams(route.endpoints ?? [])[targetGroupIndex];
    if (!targetGroup) return;
    const newPriority = targetGroup.priority;
    
    // Optimistic update
    const newUpstreams = [...(route.endpoints ?? [])];
    newUpstreams[originalIndex] = { ...movedUpstream, priority: newPriority };
    
    // Regroup and re-flatten to normalize priorities
    const groups = groupUpstreams(newUpstreams);
    route.endpoints = flattenGroups(groups);
  }

  function handleCreatePriority(event: DragEvent, insertIndex: number) {
    event.preventDefault();
    const data = event.dataTransfer?.getData('application/json');
    if (!data) return;
    
    const { originalIndex } = JSON.parse(data);
    const movedUpstream = route.endpoints?.[originalIndex];
    if (!movedUpstream) return;
    
    // Strategy:
    // 1. Convert current upstreams to groups
    // 2. Remove the moved item from its current group
    // 3. Insert a NEW group at `insertIndex` containing only the moved item
    // 4. Flatten back to upstreams
    
    const currentGroups = groupUpstreams(route.endpoints ?? []);
    const insertionIndex = currentGroups.slice(0, insertIndex)
      .filter(group => group.upstreams.some(upstream => upstream.originalIndex !== originalIndex)).length;
    
    // Find and remove the item from its source group
    for (const group of currentGroups) {
      const idx = group.upstreams.findIndex(u => u.originalIndex === originalIndex);
      if (idx !== -1) {
        group.upstreams.splice(idx, 1);
        // If group becomes empty, remove it (unless it's the only one? No, remove it)
        if (group.upstreams.length === 0) {
             // We need to be careful about indices shifting if we remove a group
             // But we are going to rebuild anyway
        }
        break;
      }
    }
    
    // Filter out empty groups before inserting
    const cleanGroups = currentGroups.filter(g => g.upstreams.length > 0);
    
    // Create new group
    const newGroup: PriorityGroup = {
      groupIndex: insertionIndex,
      priority: 0, // Will be assigned by flattenGroups
      upstreams: [{ ...movedUpstream, originalIndex: -1 }] // index doesn't matter for flatten
    };
    
    // The drop boundary is in the full list; account for a removed source group.
    cleanGroups.splice(insertionIndex, 0, newGroup);
    
    route.endpoints = flattenGroups(cleanGroups);
  }
  
  // Spacer Drop Zone Logic
  let dragOverSpacerIndex = $state<number | null>(null);
  
  function handleSpacerDragOver(event: DragEvent, index: number) {
    event.preventDefault();
    event.dataTransfer!.dropEffect = 'move';
    dragOverSpacerIndex = index;
  }
  
  function handleSpacerDragLeave() {
     dragOverSpacerIndex = null;
  }
  
  function handleSpacerDrop(event: DragEvent, index: number) {
    dragOverSpacerIndex = null;
    handleCreatePriority(event, index);
  }

  // Component Event Proxies
  function onEdit(originalIndex: number) { openUpstreamModal(originalIndex); }
  function onRemove(originalIndex: number) { removeUpstream(originalIndex); }
  function onDuplicate(originalIndex: number) { duplicateUpstream(originalIndex); }
  function onToggleStatus(originalIndex: number) { toggleUpstreamStatus(originalIndex); }
  function onUpdateWeight(originalIndex: number, weight: number) {
    if (!route.endpoints?.[originalIndex]) return;
    route.endpoints[originalIndex].weight = weight;
    route.endpoints = route.endpoints;
  }
</script>

<PanelCard
  title={isService ? $_('serviceEditor.builder.endpoints') : $_('routeEditor.customEndpoints')}
  tag={isService ? `EP·${endpoints.length}` : ''}
  class={isService ? '[&>.nx-panel-head]:flex-wrap [&>.nx-panel-head]:gap-y-2 [&>.nx-panel-head>div:last-child]:w-full sm:[&>.nx-panel-head>div:last-child]:w-auto [&>.nx-panel-head>div:last-child]:min-w-0' : ''}
>
  <svelte:fragment slot="actions">
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
    </div>
  </svelte:fragment>

  {#if errors.some(e => e.field === 'endpoints')}
    <div class="border-l-2 border-l-red-500 bg-red-500/5 px-3 py-2">
      <span class="font-mono text-[11px] uppercase tracking-command text-red-300">
        {errors.find(e => e.field === 'endpoints')?.message}
      </span>
    </div>
  {/if}

  <!-- Priority groups kanban -->
  <div class={isService ? 'flex flex-col gap-4 min-h-[120px]' : 'flex flex-col gap-4 p-4 bg-carbon-950 border border-carbon-600 min-h-[120px]'}>

    {#if groupedUpstreams.length > 0}
      <div
        role="group"
        aria-label="Insert New Priority Group"
        class="-my-2 transition-all duration-200 flex items-center justify-center border-2 border-dashed {dragOverSpacerIndex === groupedUpstreams[0].groupIndex ? 'h-12 bg-nexus-500/10 border-nexus-500' : 'h-4 border-transparent'}"
        ondragover={(e) => handleSpacerDragOver(e, groupedUpstreams[0].groupIndex)}
        ondragleave={handleSpacerDragLeave}
        ondrop={(e) => handleSpacerDrop(e, groupedUpstreams[0].groupIndex)}
      >
        {#if dragOverSpacerIndex === groupedUpstreams[0].groupIndex}
          <span class="font-mono text-[11px] font-bold uppercase tracking-command text-nexus-300">
            {$_('upstream.insertNewPriority', { values: { priority: groupedUpstreams[0].groupIndex + 1 } })}
          </span>
        {/if}
      </div>
    {/if}

    {#each groupedUpstreams as group (group.priority)}
      <UpstreamPriorityGroup
        priority={group.priority}
        upstreams={group.upstreams}
        on:merge={(e) => handleMerge(e, group.groupIndex)}
        on:edit={(e) => onEdit(e.detail.originalIndex)}
        on:remove={(e) => onRemove(e.detail.originalIndex)}
        on:duplicate={(e) => onDuplicate(e.detail.originalIndex)}
        on:toggleStatus={(e) => onToggleStatus(e.detail.originalIndex)}
        on:updateWeight={(e) => onUpdateWeight(e.detail.originalIndex, e.detail.weight)}
      />

      <div
        role="group"
        aria-label="Insert New Priority Group"
        class="-my-2 transition-all duration-200 flex items-center justify-center border-2 border-dashed z-10 {dragOverSpacerIndex === group.groupIndex + 1 ? 'h-12 bg-nexus-500/10 border-nexus-500' : 'h-4 border-transparent'}"
        ondragover={(e) => handleSpacerDragOver(e, group.groupIndex + 1)}
        ondragleave={handleSpacerDragLeave}
        ondrop={(e) => handleSpacerDrop(e, group.groupIndex + 1)}
      >
        {#if dragOverSpacerIndex === group.groupIndex + 1}
          <span class="font-mono text-[11px] font-bold uppercase tracking-command text-nexus-300">
            {$_('upstream.insertNewPriority', { values: { priority: group.groupIndex + 2 } })}
          </span>
        {/if}
      </div>
    {/each}

    {#if groupedUpstreams.length === 0}
      <div class="flex-1 flex items-center justify-center border border-dashed border-carbon-500">
        <span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">
          {#if upstreamSearchTerm.trim()}
            {$_('serviceEditor.noMatchingEndpoints')}
          {:else}
            {$_('serviceEditor.noEndpoints')}
          {/if}
        </span>
      </div>
    {/if}
  </div>

  {#if weightErrors.length > 0}
    <div class="border-l-2 border-l-amber-500 bg-amber-500/5 px-3 py-2">
      <span class="font-mono text-[11px] uppercase tracking-command text-amber-300">
        {weightErrors[0].message}
      </span>
    </div>
  {/if}
</PanelCard>

<!-- Upstream Edit Modal -->
<Dialog.Root bind:open={showUpstreamModal}>
  <Dialog.Content class="max-w-3xl max-h-[90dvh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>{editingUpstreamIndex >= 0 ? $_('upstream.title', { values: { index: editingUpstreamIndex + 1 } }) : $_('routeEditor.addUpstream')}</Dialog.Title>
      <Dialog.Description>{isService ? '此处仅修改服务草稿，发布配置仍需保存服务。' : '此处仅修改路由草稿，发布配置仍需保存路由。'}</Dialog.Description>
    </Dialog.Header>
    {#if editingUpstream}
        <UpstreamForm
          bind:upstream={editingUpstream}
          index={editingUpstreamIndex}
          showHeader={false}
          onRemove={() => {}}
          onDuplicate={() => {}}
          {isService}
        />
      <Dialog.Footer>
        <Button variant="ghost" onclick={closeUpstreamModal}>{$_('common.cancel')}</Button>
        <Button variant="default" onclick={saveUpstream} disabled={!isEditingUpstreamValid} data-testid="upstream-modal-save">
          {$_('common.save')}
        </Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
