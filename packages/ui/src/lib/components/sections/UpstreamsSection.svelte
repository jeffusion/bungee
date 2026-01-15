<script lang="ts">
  import { pop } from 'svelte-spa-router';
  import { sortBy } from 'lodash-es';
  import type { Route, Upstream } from '../../api/routes';
  import type { ValidationError } from '../../validation';
  import { validateUpstreamSync } from '../../validation';
  import UpstreamForm from '../UpstreamForm.svelte';
  import { _ } from '../../i18n';
  import { v4 as uuidv4 } from 'uuid';

  export let route: Route;
  export let errors: ValidationError[] = [];
  export let weightErrors: ValidationError[] = [];

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
  $: groupedUpstreams = groupUpstreams(route.upstreams);

  $: if (showUpstreamModal && editingUpstream) {
    editingUpstreamErrors = validateUpstreamSync(editingUpstream, editingUpstreamIndex === -1 ? route.upstreams.length : editingUpstreamIndex);
  }
  $: isEditingUpstreamValid = showUpstreamModal && editingUpstream && editingUpstreamErrors.length === 0;

  function openUpstreamModal(index: number = -1) {
    editingUpstreamIndex = index;
    if (index >= 0) {
      editingUpstream = JSON.parse(JSON.stringify(route.upstreams[index]));
    } else {
      editingUpstream = {
        _uid: uuidv4(),
        target: '',
        weight: 100,
        priority: route.upstreams.length + 1,
        headers: { add: {}, remove: [], default: {} },
        body: { add: {}, remove: [], replace: {}, default: {} },
        query: { add: {}, remove: [], replace: {}, default: {} }
      };
    }
    showUpstreamModal = true;
  }

  function closeUpstreamModal() {
    showUpstreamModal = false;
    editingUpstream = null;
  }

  function saveUpstream() {
    if (!isEditingUpstreamValid) return;

    if (editingUpstreamIndex >= 0) {
      route.upstreams[editingUpstreamIndex] = editingUpstream;
    } else {
      route.upstreams = [...route.upstreams, editingUpstream];
    }
    closeUpstreamModal();
  }

  function removeUpstream(index: number) {
    if (route.upstreams.length <= 1) {
      alert($_('routeEditor.upstreamRequired'));
      return;
    }
    route.upstreams = route.upstreams.filter((_, i) => i !== index);
  }

  function duplicateUpstream(index: number) {
    const originalUpstream = route.upstreams[index];
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
      duplicatedUpstream.priority = Math.max(...route.upstreams.map(u => u.priority || 1)) + 1;
    }

    route.upstreams = [
      ...route.upstreams.slice(0, index + 1),
      duplicatedUpstream,
      ...route.upstreams.slice(index + 1)
    ];
  }

  function toggleUpstreamStatus(index: number) {
    route.upstreams[index].disabled = !route.upstreams[index].disabled;
    route.upstreams = route.upstreams; // 触发 Svelte 响应式更新
  }

  import UpstreamPriorityGroup from '../UpstreamPriorityGroup.svelte';
  
  // Drag & Drop Handlers
  function handleMerge(event: CustomEvent<{ originalIndex: number }>, targetGroupIndex: number) {
    const { originalIndex } = event.detail;
    const movedUpstream = route.upstreams[originalIndex];
    
    // Calculate new priority: target group's index + 1
    // Note: Since we are merging into an existing group, we just adopt its priority index (1-based)
    const newPriority = targetGroupIndex + 1;
    
    // Optimistic update
    const newUpstreams = [...route.upstreams];
    newUpstreams[originalIndex] = { ...movedUpstream, priority: newPriority };
    
    // Regroup and re-flatten to normalize priorities
    const groups = groupUpstreams(newUpstreams);
    route.upstreams = flattenGroups(groups);
  }

  function handleCreatePriority(event: DragEvent, insertIndex: number) {
    event.preventDefault();
    const data = event.dataTransfer?.getData('application/json');
    if (!data) return;
    
    const { originalIndex } = JSON.parse(data);
    const movedUpstream = route.upstreams[originalIndex];
    
    // Strategy:
    // 1. Convert current upstreams to groups
    // 2. Remove the moved item from its current group
    // 3. Insert a NEW group at `insertIndex` containing only the moved item
    // 4. Flatten back to upstreams
    
    const currentGroups = groupUpstreams(route.upstreams);
    
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
    
    route.upstreams = flattenGroups(cleanGroups);
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
    route.upstreams[originalIndex].weight = weight;
    route.upstreams = route.upstreams;
  }
</script>

<div class="space-y-4">
  <div class="flex justify-between items-center">
    <div>
      <h3 class="text-lg font-semibold">
        {$_('routeEditor.upstreams')} <span class="text-error">*</span>
      </h3>
      <p class="text-sm text-gray-500 mt-1">
        {$_('routeEditor.upstreamsHelp')}
      </p>
    </div>
    <div class="flex gap-2">
      <input
        type="text"
        placeholder={$_('common.search')}
        class="input input-bordered input-sm"
        bind:value={upstreamSearchTerm}
      />
      <button
        type="button"
        class="btn btn-sm btn-primary"
        on:click={() => openUpstreamModal(-1)}
      >
        {$_('routeEditor.addUpstream')}
      </button>
    </div>
  </div>

  {#if errors.some(e => e.field === 'upstreams')}
    <div class="alert alert-error">
      <span>{errors.find(e => e.field === 'upstreams')?.message}</span>
    </div>
  {/if}

  <!-- Kanban / Priority Groups List -->
  <div class="flex flex-col gap-4 p-4 bg-base-200/30 rounded-box border border-base-200 min-h-[300px]">
    
    <!-- Top Spacer (Create Priority 1) -->
    <!-- Only show if there are existing groups, otherwise the empty state handles it or the first group is P1 -->
    {#if groupedUpstreams.length > 0}
        <div 
          role="group"
          aria-label="Insert New Priority Group"
          class="h-4 -my-2 transition-all duration-200 flex items-center justify-center rounded border-2 border-dashed border-transparent {dragOverSpacerIndex === 0 ? 'bg-primary/10' : ''}"
          class:h-12={dragOverSpacerIndex === 0}
          class:border-primary={dragOverSpacerIndex === 0}
          on:dragover={(e) => handleSpacerDragOver(e, 0)}
          on:dragleave={handleSpacerDragLeave}
          on:drop={(e) => handleSpacerDrop(e, 0)}
        >
          {#if dragOverSpacerIndex === 0}
            <span class="text-sm font-bold text-primary">{$_('upstream.newPriority1')}</span>
          {/if}
        </div>
    {/if}

    {#each groupedUpstreams as group, groupIndex (groupIndex)}
      <!-- Priority Group -->
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
      
      <!-- Spacer between groups (Create New Priority) -->
      <div 
        role="group"
        aria-label="Insert New Priority Group"
        class="h-4 -my-2 transition-all duration-200 flex items-center justify-center rounded border-2 border-dashed border-transparent z-10 {dragOverSpacerIndex === groupIndex + 1 ? 'bg-primary/10' : ''}"
        class:h-12={dragOverSpacerIndex === groupIndex + 1}
        class:border-primary={dragOverSpacerIndex === groupIndex + 1}
        on:dragover={(e) => handleSpacerDragOver(e, groupIndex + 1)}
        on:dragleave={handleSpacerDragLeave}
        on:drop={(e) => handleSpacerDrop(e, groupIndex + 1)}
      >
        {#if dragOverSpacerIndex === groupIndex + 1}
          <span class="text-sm font-bold text-primary">{$_('upstream.insertNewPriority', { values: { priority: groupIndex + 2 } })}</span>
        {/if}
      </div>
    {/each}

    {#if groupedUpstreams.length === 0}
      <div class="text-center py-12 text-gray-400 border-2 border-dashed border-base-300 rounded-lg">
        {#if upstreamSearchTerm}
            {$_('routes.noMatchingRoutes')}
        {:else}
            {$_('routes.noRoutesMessage')}
        {/if}
      </div>
    {/if}
  </div>

  {#if weightErrors.length > 0}
    <div class="alert alert-warning">
      <span>{weightErrors[0].message}</span>
    </div>
  {/if}
</div>

<!-- Upstream Edit Modal -->
{#if showUpstreamModal && editingUpstream}
  <div class="modal modal-open">
    <div class="modal-box w-11/12 max-w-3xl">
      <h3 class="font-bold text-lg mb-4">
        {editingUpstreamIndex >= 0 ? $_('upstream.title', { values: { index: editingUpstreamIndex + 1 } }) : $_('routeEditor.addUpstream')}
      </h3>

      <div class="max-h-[70vh] overflow-y-auto">
        <UpstreamForm
          bind:upstream={editingUpstream}
          index={editingUpstreamIndex}
          showHeader={false}
          onRemove={() => {}}
          onDuplicate={() => {}}
        />
      </div>

      <div class="modal-action">
        <button type="button" class="btn" on:click={closeUpstreamModal}>{$_('common.cancel')}</button>
        <button type="button" class="btn btn-primary" on:click={saveUpstream} disabled={!isEditingUpstreamValid}>
          {$_('common.save')}
        </button>
      </div>
    </div>
  </div>
{/if}