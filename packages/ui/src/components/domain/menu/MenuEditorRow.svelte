<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { MenuNode, MenuPage } from '@jeffusion/bungee-types';
  import { SYSTEM_MENU_GROUP_ID } from '@jeffusion/bungee-types';
  import { _, isLoading } from '$i18n';
  import { IndustrialToggle } from '$components/industrial';
  import * as DropdownMenu from '$components/ui/dropdown-menu';
  import GripVertical from 'lucide-svelte/icons/grip-vertical';
  import Ellipsis from 'lucide-svelte/icons/ellipsis';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import ArrowUp from 'lucide-svelte/icons/arrow-up';
  import ArrowDown from 'lucide-svelte/icons/arrow-down';
  import MenuIcon from './MenuIcon.svelte';
  let { node, page, label, groups, group = null, first, last, collapsed = false, renaming = false, disabled = false, keyboardNavigation = false, error,
    onChange, onMove, onTarget, onIcon, onDissolve, onDragStart, dragging = false, dropInside = false, onToggle, onRename, onRenameEnd }: {
    node: MenuNode; page?: MenuPage; label: string; groups: { id: string; label: string }[]; group?: string | null;
    first: boolean; last: boolean; collapsed?: boolean; renaming?: boolean; disabled?: boolean; keyboardNavigation?: boolean; error?: string;
    onChange: (node: MenuNode) => void; onMove: (direction: -1 | 1) => void;
    onTarget?: (target: string | null) => void; onIcon: (event: MouseEvent) => void; onDissolve?: () => void;
    dragging?: boolean; dropInside?: boolean; onDragStart: (event: PointerEvent) => void;
    onToggle?: () => void; onRename?: () => void; onRenameEnd?: () => void;
  } = $props();
  const t = (key: string) => $isLoading ? '' : $_('menus.' + key);
  const rowId = $derived(`menu-row-${encodeURIComponent(node.kind === 'page' ? node.pageId : node.id)}`);
  const actionId = $derived(`${rowId}-actions`);
  const controlBaseClass = 'inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center text-zinc-400 hover:bg-carbon-700/60 hover:text-nexus-300 sm:h-[40px] sm:w-[40px]';
  const focusClass = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-nexus-500';
  const controlClass = `${controlBaseClass} ${focusClass}`;
  const itemClass = 'min-h-[44px] gap-2 px-3';
  let actionOpen = $state(false), nameInput = $state<HTMLInputElement>();
  let originalTitle: string | null = null;
  let renamePending = false;
  let focusAfterAction: string | null = null;
  function relocate(action: () => void) { focusAfterAction = actionId; action(); }
  function actionLifecycle() { return { destroy() {
    if (renamePending && !disabled) { renamePending = false; onRename?.(); }
    if (focusAfterAction) {
      const destination = focusAfterAction; focusAfterAction = null;
      void tick().then(() => (document.getElementById(destination) ?? document.getElementById('menus-add-group'))?.focus({ preventScroll: true }));
    }
  } }; }
  $effect(() => {
    if (!renaming) return;
    untrack(() => { originalTitle = node.kind === 'group' ? node.title : null; });
    void tick().then(() => nameInput?.select());
  });
  function finishRename(accept = true, restoreFocus = false) {
    if (!renaming || node.kind !== 'group' || accept && error) return;
    if (!accept) onChange({ ...node, title: originalTitle });
    onRenameEnd?.();
    if (restoreFocus) void tick().then(() => document.getElementById(actionId)?.focus({ preventScroll: true }));
  }
  function restoreIcon() { const { icon, ...rest } = node; onChange(rest); }
  function returnFocus() { return renamePending || focusAfterAction ? null : renaming ? nameInput : document.getElementById(actionId) ?? document.getElementById('menus-add-group'); }
</script>
<div role="group" aria-label={label} onpointerdown={event => {
  const target = event.target as Element;
  const handle = target.closest('[data-menu-drag-handle]');
  if (disabled || renaming || event.pointerType === 'touch' && !handle || !handle && target.closest('button, input, a, [role="switch"]')) return;
  onDragStart(event);
}}
  data-menu-parent={group ?? ''} data-drag-source={dragging} data-drop-inside={dropInside}
  class={`min-w-0 ${dragging ? 'opacity-40' : ''} ${dropInside ? 'bg-nexus-500/10 ring-2 ring-inset ring-nexus-500' : ''}`} data-testid="menu-editor-row" data-menu-id={node.kind === 'page' ? node.pageId : node.id}>
  <div class="flex min-h-[52px] min-w-0 items-center gap-1 px-1.5 py-1 hover:bg-carbon-700/20 sm:min-h-[48px] sm:gap-1.5 sm:px-3">
    <button type="button" id={`${rowId}-drag`} data-menu-drag-handle data-keyboard-navigation={keyboardNavigation} aria-label={`${t('drag')} ${label}`} title={t('drag')} class={`${controlBaseClass} ${keyboardNavigation ? focusClass : ''} touch-none cursor-grab active:cursor-grabbing`}><GripVertical class="h-4 w-4" aria-hidden="true" /></button>
    <button type="button" aria-label={`${t('icon')} ${label}`} title={t('chooseIcon')} onclick={onIcon} class={`${controlClass} border border-transparent hover:border-carbon-500`}>
      <MenuIcon icon={node.icon ?? (node.kind === 'group' ? node.id === SYSTEM_MENU_GROUP_ID ? 'lucide:settings' : 'lucide:folder' : page?.defaultIcon ?? 'lucide:file-question')} />
    </button>
    <div class="min-w-0 flex-1">
      {#if node.kind === 'group' && renaming}
        <input bind:this={nameInput} class="nx-input h-[44px] w-full min-w-0 sm:h-[40px]" value={node.title ?? label} maxlength="80" aria-label={t('groupName')} aria-invalid={!!error} aria-describedby={error ? `${rowId}-error` : undefined}
          oninput={event => onChange({ ...node, title: event.currentTarget.value })} onblur={() => finishRename()}
          onkeydown={event => { if (event.isComposing) return; if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finishRename(event.key === 'Enter', true); } }} />
      {:else if node.kind === 'group'}
        <button type="button" class="flex min-h-[44px] w-full min-w-0 items-center gap-2 text-left font-mono text-sm text-zinc-200 hover:text-nexus-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nexus-500 sm:min-h-[40px]"
          aria-label={`${t(collapsed ? 'expand' : 'collapse')} ${label}`} aria-expanded={!collapsed} aria-controls={`${rowId}-children`} onclick={onToggle}>
          <ChevronRight class={`h-3 w-3 shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`} aria-hidden="true" /><span class="min-w-0 break-words [overflow-wrap:anywhere]">{label}</span><span class="shrink-0 font-mono text-xs text-zinc-500">{node.children.length}</span>
        </button>
      {:else}
        <div class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5"><span class="break-words font-mono text-sm text-zinc-200 [overflow-wrap:anywhere]">{label}</span>{#if page?.source === 'plugin'}<span class="min-w-0 break-words text-[11px] text-zinc-500">{t('plugin')} · {page.pluginName}</span>{/if}</div>
      {/if}
      {#if error}<p id={`${rowId}-error`} role="alert" class="pb-1 text-xs text-amber-400">{t(error)}</p>{/if}
    </div>
    <IndustrialToggle checked={node.visible} label={`${t('visibility')} ${label}`} onchange={visible => onChange({ ...node, visible })} />
    <DropdownMenu.Root bind:open={actionOpen} closeFocus={returnFocus}>
      <DropdownMenu.Trigger {disabled} id={actionId} class={controlClass} aria-label={`${t('itemActions')} ${label}`} title={t('itemActions')}><Ellipsis class="h-4 w-4" aria-hidden="true" /></DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" sideOffset={4} class="z-[60] overflow-visible w-56 max-w-[calc(100vw-24px)] border-carbon-500 bg-carbon-900 text-zinc-200 shadow-industrial">
        <div use:actionLifecycle>
        <DropdownMenu.Item class={itemClass} disabled={disabled || first} onclick={() => onMove(-1)}><ArrowUp class="h-4 w-4" aria-hidden="true" />{t('up')}</DropdownMenu.Item>
        <DropdownMenu.Item class={itemClass} disabled={disabled || last} onclick={() => onMove(1)}><ArrowDown class="h-4 w-4" aria-hidden="true" />{t('down')}</DropdownMenu.Item>
        {#if node.kind === 'page'}
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger {disabled} class={itemClass}>{t('moveTo')}</DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent sideOffset={4} fitViewport overlap class="max-h-[min(24rem,calc(100dvh-24px))] w-56 max-w-[calc(100vw-24px)] overflow-y-auto border-carbon-500 bg-carbon-900 text-zinc-200">
              <DropdownMenu.Item class={itemClass} disabled={disabled || group === null} onclick={() => relocate(() => onTarget?.(null))}>{t('root')}</DropdownMenu.Item>
              {#each groups as target}<DropdownMenu.Item class={itemClass} disabled={disabled || target.id === group} onclick={() => relocate(() => onTarget?.(target.id))}>{target.label}</DropdownMenu.Item>{/each}
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
        {:else}<DropdownMenu.Item {disabled} class={itemClass} onclick={() => renamePending = true}>{t('rename')}</DropdownMenu.Item>{/if}
        {#if node.icon}<DropdownMenu.Item {disabled} class={itemClass} onclick={restoreIcon}>{t('restoreIcon')}</DropdownMenu.Item>{/if}
        {#if node.kind === 'group'}<DropdownMenu.Separator /><DropdownMenu.Item {disabled} class={itemClass} onclick={() => relocate(() => onDissolve?.())}>{t('dissolve')}</DropdownMenu.Item>{/if}
        </div>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
</div>

<style>
  [data-menu-drag-handle][data-keyboard-navigation='false'] {
    outline: none;
  }
</style>
