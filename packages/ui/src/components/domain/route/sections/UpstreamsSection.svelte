<script lang="ts">
  import { sortBy } from 'lodash-es';
  import type { Route, Upstream } from '$api/routes';
  import type { ValidationError } from '$validation';
  import { validateUpstreamSync } from '$validation';
  import UpstreamForm from '../UpstreamForm.svelte';
  import { _ } from '$i18n';
  import { v4 as uuidv4 } from 'uuid';

  export let route: Route;
  export let errors: ValidationError[] = [];
  export let weightErrors: ValidationError[] = [];
  export let isService: boolean = false;

  interface PriorityGroup {
    priority: number;
    upstreams: (Upstream & { originalIndex: number })[];
  }

  let upstreamSearchTerm = '';
  let showUpstreamModal = false;
  let editingUpstreamIndex = -1;
  let editingUpstream: any = null;
  let editingUpstreamErrors: ValidationError[] = [];

  // Grouping Logic
  function groupUpstreams(upstreams: Upstream[]): PriorityGroup[] {
    const withIndex = upstreams.map((u, i) => ({ ...u, originalIndex: i }));
    const sorted = sortBy(withIndex, [(u) => u.priority || 1]);
    
    const groups: PriorityGroup[] = [];
    let currentGroup: PriorityGroup | null = null;
    
    for (const u of sorted) {
      const priority = u.priority || 1;
      
      if (!currentGroup || currentGroup.priority !== priority) {
        currentGroup = { priority, upstreams: [] };
        groups.push(currentGroup);
      }
      
      currentGroup.upstreams.push(u);
    }
    
    return groups;
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
  $: endpoints = route.endpoints ?? [];
  $: groupedUpstreams = groupUpstreams(endpoints);

  $: if (showUpstreamModal && editingUpstream) {
    editingUpstreamErrors = validateUpstreamSync(editingUpstream, editingUpstreamIndex === -1 ? (route.endpoints?.length ?? 0) : editingUpstreamIndex);
  }
  $: isEditingUpstreamValid = showUpstreamModal && editingUpstream && editingUpstreamErrors.length === 0;

  function openUpstreamModal(index: number = -1) {
    editingUpstreamIndex = index;
    if (index >= 0) {
      editingUpstream = JSON.parse(JSON.stringify(route.endpoints?.[index]));
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
    const duplicatedUpstream = JSON.parse(JSON.stringify(originalUpstream));

    duplicatedUpstream._uid = uuidv4();

    if (duplicatedUpstream.target) {
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
  
  // Drag & Drop Handlers
  function handleMerge(event: CustomEvent<{ originalIndex: number }>, targetGroupIndex: number) {
    const { originalIndex } = event.detail;
    const movedUpstream = route.endpoints?.[originalIndex];
    if (!movedUpstream) return;
    
    // Calculate new priority: target group's index + 1
    // Note: Since we are merging into an existing group, we just adopt its priority index (1-based)
    const newPriority = targetGroupIndex + 1;
    
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
      priority: 0, // Will be assigned by flattenGroups
      upstreams: [{ ...movedUpstream, originalIndex: -1 }] // index doesn't matter for flatten
    };
    
    // Insert at specific position
    // insertIndex is 0-based index in the VISUAL list of groups
    cleanGroups.splice(insertIndex, 0, newGroup);
    
    route.endpoints = flattenGroups(cleanGroups);
  }
  
  // Spacer Drop Zone Logic
  let dragOverSpacerIndex: number | null = null;
  
  function handleSpacerDragOver(event: DragEvent, index: number) {
    event.preventDefault();
    event.dataTransfer!.dropEffect = 'move';
    dragOverSpacerIndex = index;
  }
  
  function handleSpacerDragLeave(event: DragEvent) {
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

<div class="space-y-4">
  <div class="flex flex-col gap-3 lg:flex-row lg:justify-between lg:items-end">
    <div>
      <h3 class="font-mono text-[12px] font-bold uppercase tracking-command text-zinc-200">
        {$_('routeEditor.upstreams')} <span class="text-red-400">*</span>
      </h3>
      <p class="text-xs text-zinc-500 mt-1">
        {$_('routeEditor.upstreamsHelp')}
      </p>
    </div>
    <div class="flex gap-2 items-stretch">
      <input
        type="text"
        placeholder={$_('common.search')}
        class="nx-input"
        bind:value={upstreamSearchTerm}
      />
      <button
        type="button"
        class="nx-btn-primary"
        on:click={() => openUpstreamModal(-1)}
        data-testid="route-upstream-add-button"
      >
        <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        {$_('routeEditor.addUpstream')}
      </button>
    </div>
  </div>

  {#if errors.some(e => e.field === 'endpoints')}
    <div class="border-l-2 border-l-red-500 bg-red-500/5 px-3 py-2">
      <span class="font-mono text-[11px] uppercase tracking-command text-red-300">
        {errors.find(e => e.field === 'endpoints')?.message}
      </span>
    </div>
  {/if}

  <!-- Priority groups kanban -->
  <div class="flex flex-col gap-4 p-4 bg-carbon-950 border border-carbon-600 min-h-[300px]">

    {#if groupedUpstreams.length > 0}
      <div
        role="group"
        aria-label="Insert New Priority Group"
        class="-my-2 transition-all duration-200 flex items-center justify-center border-2 border-dashed {dragOverSpacerIndex === 0 ? 'h-12 bg-nexus-500/10 border-nexus-500' : 'h-4 border-transparent'}"
        on:dragover={(e) => handleSpacerDragOver(e, 0)}
        on:dragleave={handleSpacerDragLeave}
        on:drop={(e) => handleSpacerDrop(e, 0)}
      >
        {#if dragOverSpacerIndex === 0}
          <span class="font-mono text-[11px] font-bold uppercase tracking-command text-nexus-300">
            {$_('upstream.newPriority1')}
          </span>
        {/if}
      </div>
    {/if}

    {#each groupedUpstreams as group, groupIndex (groupIndex)}
      <UpstreamPriorityGroup
        priority={group.priority}
        upstreams={group.upstreams}
        on:merge={(e) => handleMerge(e, groupIndex)}
        on:edit={(e) => onEdit(e.detail.originalIndex)}
        on:remove={(e) => onRemove(e.detail.originalIndex)}
        on:duplicate={(e) => onDuplicate(e.detail.originalIndex)}
        on:toggleStatus={(e) => onToggleStatus(e.detail.originalIndex)}
        on:updateWeight={(e) => onUpdateWeight(e.detail.originalIndex, e.detail.weight)}
      />

      <div
        role="group"
        aria-label="Insert New Priority Group"
        class="-my-2 transition-all duration-200 flex items-center justify-center border-2 border-dashed z-10 {dragOverSpacerIndex === groupIndex + 1 ? 'h-12 bg-nexus-500/10 border-nexus-500' : 'h-4 border-transparent'}"
        on:dragover={(e) => handleSpacerDragOver(e, groupIndex + 1)}
        on:dragleave={handleSpacerDragLeave}
        on:drop={(e) => handleSpacerDrop(e, groupIndex + 1)}
      >
        {#if dragOverSpacerIndex === groupIndex + 1}
          <span class="font-mono text-[11px] font-bold uppercase tracking-command text-nexus-300">
            {$_('upstream.insertNewPriority', { values: { priority: groupIndex + 2 } })}
          </span>
        {/if}
      </div>
    {/each}

    {#if groupedUpstreams.length === 0}
      <div class="text-center py-12 border border-dashed border-carbon-500">
        <span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">
          {#if upstreamSearchTerm}
            {$_('routes.noMatchingRoutes')}
          {:else}
            {$_('routes.noRoutesMessage')}
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
</div>

<!-- Upstream Edit Modal -->
{#if showUpstreamModal && editingUpstream}
  <div
    class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    on:click={(e) => { if (e.target === e.currentTarget) closeUpstreamModal(); }}
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
        <button type="button" class="nx-btn-ghost" on:click={closeUpstreamModal}>{$_('common.cancel')}</button>
        <button type="button" class="nx-btn-primary" on:click={saveUpstream} disabled={!isEditingUpstreamValid} data-testid="upstream-modal-save">
          {$_('common.save')}
        </button>
      </footer>
    </div>
  </div>
{/if}
