<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { DropDestination, PriorityGroup, TargetRow } from './sections/upstream-groups';
  import { _ } from '$i18n';
  let { group, row, ondrop }: {
    group: PriorityGroup; row: Snippet<[TargetRow]>;
    ondrop: (event: DragEvent, destination: DropDestination) => void;
  } = $props();
  let isDragOver = $state(false);
  let overKey = $state('');
  let after = $state(false);
  let dragging = $state('');
  function dragOver(event: DragEvent, key = '') {
    event.preventDefault(); event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    isDragOver = true; overKey = key;
    const rect = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : undefined;
    after = !!rect && event.clientY > rect.top + rect.height / 2;
  }
  function drop(event: DragEvent, targetKey?: string) {
    event.preventDefault(); event.stopPropagation();
    const rect = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : undefined;
    isDragOver = false; overKey = '';
    ondrop(event, { groupIndex: group.groupIndex, targetKey, after: !!rect && event.clientY > rect.top + rect.height / 2 });
  }
  function dragStart(event: DragEvent, key: string) {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData('application/json', JSON.stringify({ key }));
    event.dataTransfer.effectAllowed = 'move'; dragging = key;
  }
</script>
<div class="border-2 transition-colors relative p-3 {isDragOver ? 'border-nexus-500 bg-nexus-500/5' : 'border-carbon-600 bg-carbon-950/60'}"
  ondragover={event => dragOver(event)} ondragleave={() => { isDragOver = false; overKey = ''; }}
  ondrop={event => drop(event)} role="group" data-testid="upstream-priority-group" data-priority={group.priority}>
  <div class="flex flex-wrap items-center gap-2.5 mb-3">
    <span class="nx-pill-accent">P{group.priority}</span>
    <span class="font-mono text-[11px] uppercase tracking-command text-zinc-200">{$_('upstream.priorityGroup', { values: { priority: group.priority } })}</span>
    <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">· {$_('upstream.loadBalancingGroup')}</span>
  </div>
  <div role="list" class="flex flex-col gap-2">
    {#each group.targets as target (target.key)}
      <div role="listitem" draggable="true" data-target-key={target.key}
        class="cursor-move {dragging === target.key ? 'opacity-50' : ''} {overKey === target.key ? (after ? 'border-b-2 border-nexus-500' : 'border-t-2 border-nexus-500') : ''}"
        ondragstart={event => dragStart(event, target.key)} ondragend={() => { dragging = ''; isDragOver = false; overKey = ''; }}
        ondragover={event => dragOver(event, target.key)} ondrop={event => drop(event, target.key)}>
        {@render row(target)}
      </div>
    {/each}
  </div>
</div>
