<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { createDefaultMenuLayout, reconcileMenuLayout, defaultMenuGroup, type MenuLayout, type MenuNode, type MenuPage, type MenuSnapshot } from '@jeffusion/bungee-types';
  import { _, isLoading } from '$i18n';
  import { menus, acceptMenus, refreshMenus, menuSessionGuard } from '$stores/menus';
  import { menuDirty } from '$stores/navigation-guard';
  import { confirmAction, confirmation } from '$stores/confirmation';
  import { MenusAPI } from '$api/menus';
  import { ApiError } from '$api/client';
  import { getPluginText } from '$utils/plugin-i18n';
  import { PanelCard, IndustrialDialog } from '$components/industrial';
  import * as DropdownMenu from '$components/ui/dropdown-menu';
  import Ellipsis from 'lucide-svelte/icons/ellipsis';
  import Plus from 'lucide-svelte/icons/plus';
  import Eye from 'lucide-svelte/icons/eye';
  import { Button } from '$components/ui/button';
  import MenuEditorRow from '$components/domain/menu/MenuEditorRow.svelte';
  import MenuTree from '$components/domain/menu/MenuTree.svelte';
  import IconPicker from '$components/domain/menu/IconPicker.svelte';
  import MenuIcon from '$components/domain/menu/MenuIcon.svelte';
  import { effectiveMenu, menuGroupLabel, editableMenuLayout, menuNodeKey, moveMenuNode, moveMenuPage, dissolveMenuGroup, reorderMenuNodes, sameMenuLayout } from '$components/domain/menu/menu-model';
  const t = (key: string) => $isLoading ? '' : $_('menus.' + key);
  const pageLabel = (page: MenuPage) => $isLoading ? '' : page.source === 'plugin' ? getPluginText(page.label, page.pluginName ?? '', $_) : $_(page.label);
  let base = $state<MenuSnapshot | null>(null), draft = $state<MenuLayout>([]), saving = $state(false), status = $state(''), uncertain = $state(false), conflict = $state(false);
  let editorSession = -1;
  let iconTarget = $state<string | null>(null), pickerOpen = $state(false), alive = true;
  let iconOpener = $state<HTMLElement | null>(null);
  const dirty = $derived(base !== null && !sameMenuLayout(draft, base.layout));
  let previewOpen = $state(false), catalogOpen = $state(false), pageActionsOpen = $state(false), renamingGroup = $state<string | null>(null);
  let collapsedGroups = $state<Set<string>>(new Set());
  let pendingPageAction = $state<(() => void) | null>(null);
  let catalogOpener = $state<HTMLElement | null>(null);
  function pageActionLifecycle() { return { destroy() {
    const action = pendingPageAction; pendingPageAction = null; if (alive && !saving) action?.();
  } }; }
  const groupErrors = $derived.by(() => {
    const errors = new Map<string, string>();
    if ($isLoading) return errors;
    const titles = draft.filter(node => node.kind === 'group').map(node => ({ id: node.id, title: menuGroupLabel(node, key => $_(key)).trim() }));
    for (const item of titles) {
      if (!item.title) errors.set(item.id, 'groupNameRequired');
      else if (titles.some(other => other.id !== item.id && other.title === item.title)) errors.set(item.id, 'groupNameDuplicate');
    }
    return errors;
  });
  const invalidGroup = $derived(groupErrors.size > 0);
  const serverChanged = $derived(base !== null && $menus.available && base.revision !== $menus.snapshot.revision);
  const catalog = $derived([...$menus.snapshot.catalog, ...(base?.catalog ?? []).filter(page => !$menus.snapshot.catalog.some(current => current.id === page.id)).map(page => ({ ...page, available: false }))]);
  type DragGesture = { pointerId: number; key: string; group: boolean; startX: number; startY: number; x: number; y: number;
    offsetX: number; offsetY: number; width: number; label: string; icon: string; active: boolean; validDrop: boolean; collapsed: Set<string> };
  let gesture = $state<DragGesture | null>(null), dragLayout = $state<MenuLayout | null>(null), dropInside = $state<string | null>(null);
  const dragging = $derived(gesture?.active ? gesture.key : null);
  const editorLayout = $derived(editableMenuLayout(dragLayout ?? draft, catalog));
  const availableCatalog = $derived(catalog.filter(page => page.available));
  const groups = $derived($isLoading ? [] : draft.filter(node => node.kind === 'group').map(node => ({ id: node.id, label: menuGroupLabel(node, key => $_(key)) })));
  const preview = $derived($isLoading ? [] : effectiveMenu(draft, catalog, '/menus', pageLabel, key => $_(key)));
  const targetNode = $derived(draft.flatMap(node => node.kind === 'page' ? [node] : [node, ...node.children]).find(node => menuNodeKey(node) === iconTarget));
  const targetDefault = $derived(targetNode?.kind === 'page' ? catalog.find(page => page.id === targetNode.pageId)?.defaultIcon ?? 'lucide:file-question' : targetNode?.kind === 'group' ? defaultMenuGroup(targetNode.id)?.icon ?? 'lucide:folder' : 'lucide:folder');
  $effect(() => {
    const snapshot = $menus.snapshot, session = $menus.session, draggingNow = dragging !== null;
    untrack(() => {
      if (session !== editorSession) { editorSession = session; pickerOpen = false; previewOpen = false; catalogOpen = false; renamingGroup = null; collapsedGroups = new Set(); clearDrag(); saving = false; status = ''; apply(snapshot); }
      else if (!dirty && !saving && !draggingNow) apply(snapshot);
    });
  });
  $effect(() => { menuDirty.set(dirty); });
  onDestroy(() => { alive = false; clearDrag(); menuDirty.set(false); });
  function apply(snapshot: MenuSnapshot) { renamingGroup = null; base = structuredClone($state.snapshot(snapshot)); draft = structuredClone($state.snapshot(snapshot.layout)); uncertain = false; conflict = false; }
  function changed(next: MenuLayout) { draft = next; if (!uncertain && !conflict) status = ''; }
  function update(key: string, replacement: MenuNode) {
    // Rows project available children; edits must retain inactive page preferences.
    const original = draft.find(node => node.kind === 'group' && node.id === key);
    if (replacement.kind === 'group' && original?.kind === 'group') replacement = { ...replacement, children: original.children };
    changed(draft.map(node => menuNodeKey(node) === key ? replacement : node.kind === 'group'
      ? { ...node, children: node.children.map(child => child.pageId === key && replacement.kind === 'page' ? replacement : child) } : node));
  }
  function groupLabel(node: MenuNode) { return node.kind === 'group' ? ($isLoading ? '' : menuGroupLabel(node, key => $_(key))) : catalog.find(page => page.id === node.pageId) ? pageLabel(catalog.find(page => page.id === node.pageId)!) : node.pageId; }
  function addGroup() {
    const id = `group:${crypto.randomUUID()}`;
    changed([...draft, { kind: 'group', id, title: t('untitled'), visible: true, children: [] }]);
    renamingGroup = id;
  }
  function toggleGroup(id: string) {
    const next = new Set(collapsedGroups);
    if (next.has(id)) next.delete(id); else next.add(id);
    collapsedGroups = next;
  }
  function movePage(pageId: string, target: string | null, before?: string) {
    changed(moveMenuPage(draft, pageId, target, before));
    if (target && collapsedGroups.has(target)) toggleGroup(target);
  }
  function selectIcon(key: string, event: MouseEvent) { iconOpener = event.currentTarget as HTMLElement; iconTarget = key; pickerOpen = true; }
  function iconChosen(icon?: string) { if (!targetNode || !iconTarget) return; const { icon: previous, ...rest } = targetNode; update(iconTarget, icon ? { ...rest, icon } : rest); }
  let keyboardNavigation = $state(false);
  let scrollFrame = 0;
  function clearDrag() {
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    scrollFrame = 0; gesture = null; dragLayout = null; dropInside = null;
  }
  function cancelDrag() {
    const previous = gesture;
    if (previous?.active) collapsedGroups = previous.collapsed;
    clearDrag();
    if (previous?.active) void tick().then(() => document.getElementById(`menu-row-${encodeURIComponent(previous.key)}-drag`)?.focus({ preventScroll: true }));
  }
  function startDrag(event: PointerEvent, key: string) {
    if (saving || gesture || event.button !== 0 || !event.isPrimary) return;
    const node = draft.flatMap(node => node.kind === 'group' ? [node, ...node.children] : [node]).find(node => menuNodeKey(node) === key);
    if (!node) return;
    event.preventDefault();
    const row = event.currentTarget as HTMLElement;
    row.querySelector<HTMLButtonElement>('[data-menu-drag-handle]')?.focus({ preventScroll: true });
    const bounds = row.getBoundingClientRect();
    gesture = { pointerId: event.pointerId, key, group: node.kind === 'group', startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top,
      width: bounds.width, label: groupLabel(node), icon: node.icon ?? (node.kind === 'group' ? defaultMenuGroup(node.id)?.icon ?? 'lucide:folder' : catalog.find(page => page.id === node.pageId)?.defaultIcon ?? 'lucide:file-question'),
      active: false, validDrop: false, collapsed: new Set(collapsedGroups) };
  }
  function previewAtPointer() {
    if (!gesture?.active) return false;
    const element = document.elementFromPoint(gesture.x, gesture.y);
    if (!element?.closest('[data-testid="menu-layout-tree"]')) return false;
    const hit = element.closest<HTMLElement>('[data-menu-id]');
    if (!hit || hit.dataset.menuId === gesture.key) return true;
    const key = hit.dataset.menuId!, parent = hit.dataset.menuParent || null;
    const parentNode = editorLayout.find(node => node.kind === 'group' && node.id === parent);
    const entries = parent === null ? editorLayout : parentNode?.kind === 'group' ? parentNode.children : [];
    const index = entries.findIndex(node => menuNodeKey(node) === key), node = entries[index];
    if (!node) return false;
    const bounds = hit.getBoundingClientRect(), fraction = (gesture.y - bounds.top) / bounds.height;
    const inside = node.kind === 'group' && !gesture.group && fraction > .25 && fraction < .75;
    const target = inside && node.kind === 'group' ? node.id : parent;
    if (gesture.group && target !== null) { dropInside = null; return false; }
    const before = inside ? undefined : fraction < .5 ? key : entries[index + 1] && menuNodeKey(entries[index + 1]);
    const current = dragLayout ?? draft, next = moveMenuNode(current, gesture.key, target, before);
    if (!sameMenuLayout(current, next)) dragLayout = next;
    dropInside = target;
    if (target && collapsedGroups.has(target)) toggleGroup(target);
    return true;
  }
  function scrollDrag() {
    scrollFrame = 0;
    if (!gesture?.active) return;
    const speed = gesture.y < 48 ? -Math.ceil((48 - gesture.y) / 3) : gesture.y > innerHeight - 48 ? Math.ceil((gesture.y - innerHeight + 48) / 3) : 0;
    if (!speed) return;
    window.scrollBy(0, Math.max(-16, Math.min(16, speed))); gesture.validDrop = previewAtPointer();
    scrollFrame = requestAnimationFrame(scrollDrag);
  }
  function moveDrag(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    gesture.x = event.clientX; gesture.y = event.clientY;
    if (!gesture.active && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 6) return;
    event.preventDefault(); gesture.active = true;
    gesture.validDrop = previewAtPointer();
    if (!scrollFrame) scrollFrame = requestAnimationFrame(scrollDrag);
  }
  function finishDrag(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const previous = gesture;
    if (previous.active) {
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      if (hit?.closest('[data-testid="menu-layout-tree"]') && previous.validDrop) {
        if (dragLayout) changed(dragLayout);
      } else collapsedGroups = previous.collapsed;
    }
    clearDrag();
    if (previous.active) void tick().then(() => document.getElementById(`menu-row-${encodeURIComponent(previous.key)}-drag`)?.focus({ preventScroll: true }));
  }
  $effect(() => { if (saving) cancelDrag(); });
  async function reset() {
    const opener = document.getElementById('menus-page-actions');
    if (await confirmAction({ opener, title: t('reset'), message: t('resetWarning'), confirmText: t('reset'), cancelText: t('keepEditing') })) changed(createDefaultMenuLayout(catalog));
  }
  async function discard() {
    if (!dirty || await confirmAction({ title: t('discard'), message: t('leaveWarning'), confirmText: t('discard'), cancelText: t('keepEditing') })) { apply($menus.snapshot); status = ''; }
  }
  async function reread() {
    const opener = document.getElementById('menus-page-actions');
    if (dirty && !await confirmAction({ opener, title: t('reload'), message: t('reloadWarning'), confirmText: t('reload'), cancelText: t('keepEditing') })) return;
    const current = menuSessionGuard();
    saving = true;
    const snapshot = await refreshMenus();
    if (alive && current()) { if (snapshot) { apply(snapshot); status = ''; } else status = 'loadFailed'; saving = false; }
  }
  async function save() {
    if (!base || !dirty || invalidGroup || saving || dragging || pendingPageAction || uncertain || conflict || serverChanged || !$menus.available) return;
    const current = menuSessionGuard(), expected = base.revision;
    const submitted = structuredClone($state.snapshot(draft)).map(node => node.kind === 'group' && node.title !== null ? { ...node, title: node.title.trim() } : node);
    saving = true; status = '';
    const settle = (snapshot: MenuSnapshot) => { acceptMenus(snapshot); apply(snapshot); status = 'saved'; };
    try {
      const snapshot = await MenusAPI.save({ expected_revision: expected, layout: submitted });
      if (alive && current()) settle(snapshot);
    } catch (error) {
      if (!alive || !current()) return;
      if (error instanceof ApiError && error.status === 409) { conflict = true; status = 'conflict'; }
      else if (error instanceof ApiError && error.status >= 400 && error.status < 500) status = 'saveFailed';
      else {
        // A lost response may follow a committed write. Read once before allowing another write.
        try {
          const snapshot = await MenusAPI.read();
          if (!alive || !current()) return;
          acceptMenus(snapshot);
          if (sameMenuLayout(snapshot.layout, reconcileMenuLayout(submitted, snapshot.catalog))) settle(snapshot);
          else { conflict = snapshot.revision !== expected; status = conflict ? 'conflict' : 'saveFailed'; }
        } catch { if (alive && current()) { uncertain = true; status = 'saveUncertain'; } }
      }
    } finally { if (alive && current()) saving = false; }
  }
</script>
<svelte:window onpointerdown={() => keyboardNavigation = false} onpointermove={moveDrag} onpointerup={finishDrag} onpointercancel={cancelDrag} onblur={cancelDrag} onkeydown={event => { if (event.key === 'Tab') keyboardNavigation = true; if (event.key === 'Escape') cancelDrag(); }} />
{#if !$isLoading}
<div class="nx-page space-y-3 py-5" data-testid="page-menus">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="flex items-center gap-3"><span class="nx-stripe" aria-hidden="true"></span><h1 class="nx-display text-xl text-zinc-50">{$_('nav.menus')}</h1></div>
    <div class="flex flex-wrap items-center gap-2">
      {#if dirty}<span class="text-xs text-amber-400">{t('unsaved')}</span><Button variant="ghost" size="sm" class="h-[44px] sm:h-[28px]" disabled={saving} onclick={() => void discard()}>{t('discard')}</Button>{/if}
      <Button class="h-[44px] sm:h-[34px]" disabled={!dirty || invalidGroup || saving || !!dragging || !!pendingPageAction || !$menus.available || uncertain || conflict || serverChanged} onclick={() => void save()} data-testid="menus-save">{saving ? t('saving') : t('save')}</Button>
    </div>
  </div>
  {#if status}<p role="status" class={`border px-3 py-2 text-sm ${status === 'saved' ? 'border-emerald-500/40 text-emerald-400' : 'border-amber-500/40 text-amber-400'}`} data-testid="menus-status">{t(status)}</p>{/if}
  {#if !$menus.available}<p role="alert" class="text-sm text-amber-400">{t('loadFailed')}</p>{/if}
  {#if (serverChanged || conflict) && dirty && status !== 'conflict'}<p role="status" class="text-sm text-amber-400">{t('conflict')}</p>{/if}
  <PanelCard title={t('layout')} flush>
    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-carbon-600 px-3 py-2">
      <p class="max-w-xl text-xs text-zinc-400">{t('editHelp')}</p>
      <div class="flex min-w-0 flex-wrap items-center gap-1">
        <Button id="menus-add-group" variant="ghost" size="sm" class="h-[44px] sm:h-[28px]" disabled={saving} onclick={addGroup}><Plus class="mr-2 hidden h-3.5 w-3.5 sm:block" aria-hidden="true" />{t('addGroup')}</Button>
        <Button id="menus-preview" variant="ghost" size="sm" class="h-[44px] sm:h-[28px]" onclick={() => previewOpen = true}><Eye class="mr-2 hidden h-3.5 w-3.5 sm:block" aria-hidden="true" />{t('preview')}</Button>
        <DropdownMenu.Root bind:open={pageActionsOpen} closeFocus={() => pendingPageAction || $confirmation || catalogOpen ? null : document.getElementById('menus-page-actions')}>
          <DropdownMenu.Trigger id="menus-page-actions" disabled={saving} aria-label={t('pageActions')} title={t('pageActions')} class="inline-flex h-[44px] w-[44px] items-center justify-center text-zinc-400 hover:bg-carbon-700/60 hover:text-nexus-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nexus-500 sm:h-[40px] sm:w-[40px]"><Ellipsis class="h-4 w-4" aria-hidden="true" /></DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" class="z-[60] w-56 border-carbon-500 bg-carbon-900 text-zinc-200 shadow-industrial">
            <div use:pageActionLifecycle>
            <DropdownMenu.Item class="min-h-[44px] px-3" onclick={() => pendingPageAction = () => void reread()}>{t('reload')}</DropdownMenu.Item>
            <DropdownMenu.Item class="min-h-[44px] px-3" onclick={() => pendingPageAction = () => void reset()}>{t('reset')}</DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item class="min-h-[44px] px-3" onclick={() => pendingPageAction = () => { catalogOpener = document.getElementById('menus-page-actions'); catalogOpen = true; }}>{t('catalog')}</DropdownMenu.Item>
            </div>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    </div>
    <fieldset disabled={saving} class="min-w-0">
      <div role="list" aria-label={t('layout')} data-testid="menu-layout-tree">
        {#each editorLayout as node, index (menuNodeKey(node))}
          <div role="listitem" class="border-b border-carbon-600 last:border-b-0">
            <MenuEditorRow {node} page={node.kind === 'page' ? catalog.find(page => page.id === node.pageId) : undefined} label={groupLabel(node)} {groups} first={index === 0} last={index === editorLayout.length - 1} disabled={saving} {keyboardNavigation}
              collapsed={node.kind === 'group' && collapsedGroups.has(node.id)} renaming={node.kind === 'group' && renamingGroup === node.id} error={node.kind === 'group' ? groupErrors.get(node.id) : undefined}
              onToggle={() => { if (node.kind === 'group') toggleGroup(node.id); }} onRename={() => { if (node.kind === 'group') renamingGroup = node.id; }} onRenameEnd={() => renamingGroup = null}
              onChange={replacement => update(menuNodeKey(node), replacement)} onMove={direction => changed(reorderMenuNodes(draft, menuNodeKey(node), direction, null, catalog))}
              onTarget={target => { if (node.kind === 'page') movePage(node.pageId, target); }} onIcon={event => selectIcon(menuNodeKey(node), event)}
              onDissolve={() => { if (node.kind === 'group') changed(dissolveMenuGroup(draft, node.id)); }}
              onDragStart={event => startDrag(event, menuNodeKey(node))} dragging={dragging === menuNodeKey(node)} dropInside={node.kind === 'group' && dropInside === node.id} />
            {#if node.kind === 'group'}<div id={`menu-row-${encodeURIComponent(node.id)}-children`} hidden={collapsedGroups.has(node.id)} class="ml-4 border-l border-carbon-500 sm:ml-6" role="list" aria-label={groupLabel(node)}>
              {#if !collapsedGroups.has(node.id)}
              {#each node.children as child, childIndex (child.pageId)}
              <div role="listitem" class="border-t border-carbon-600/60"><MenuEditorRow node={child} page={catalog.find(page => page.id === child.pageId)} label={groupLabel(child)} {groups} group={node.id} first={childIndex === 0} last={childIndex === node.children.length - 1} disabled={saving} {keyboardNavigation}
                onChange={replacement => update(child.pageId, replacement)} onMove={direction => changed(reorderMenuNodes(draft, child.pageId, direction, node.id, catalog))}
                onTarget={target => movePage(child.pageId, target)} onIcon={event => selectIcon(child.pageId, event)}
                onDragStart={event => startDrag(event, child.pageId)} dragging={dragging === child.pageId} /></div>{/each}
              {#if !node.children.length}<p class="px-3 py-2 text-xs text-zinc-500">{t('emptyGroup')}</p>{/if}
              {/if}
            </div>{/if}
          </div>
        {/each}
      </div>
    </fieldset>
  </PanelCard>
</div>
{#if gesture?.active}
  <div aria-hidden="true" data-testid="menu-drag-preview" class="pointer-events-none fixed z-[250] flex min-h-[48px] max-w-[calc(100vw-16px)] items-center gap-3 border border-nexus-500 bg-carbon-900 px-4 py-2 text-sm text-zinc-200 shadow-industrial" style={`left:${Math.max(8, Math.min(gesture.x - gesture.offsetX, innerWidth - gesture.width - 8))}px;top:${gesture.y - gesture.offsetY}px;width:${gesture.width}px`}>
    <MenuIcon icon={gesture.icon} /><span class="break-words font-mono">{gesture.label}</span>
  </div>
{/if}
<IconPicker bind:open={pickerOpen} value={targetNode?.icon} defaultIcon={targetDefault} onSelect={iconChosen} returnFocus={iconOpener} />
<IndustrialDialog bind:open={previewOpen} title={t('preview')} description={t('previewHelp')} closeLabel={t('close')} returnFocus={document.getElementById('menus-preview')} width="30rem" scrollBody>
  {#snippet body()}<MenuTree items={preview} />{/snippet}
</IndustrialDialog>
<IndustrialDialog bind:open={catalogOpen} title={t('catalog')} description={t('catalogHelp')} closeLabel={t('close')} returnFocus={catalogOpener} width="32rem" scrollBody>
  {#snippet body()}<ul class="divide-y divide-carbon-600">{#each availableCatalog as page (page.id)}<li class="flex min-w-0 items-center gap-3 py-2 text-sm"><MenuIcon icon={page.defaultIcon} /><div class="min-w-0"><p class="break-words text-zinc-200">{pageLabel(page)}</p><p class="text-xs text-zinc-500">{page.source === 'plugin' ? `${t('plugin')} · ${page.pluginName}` : t('builtin')}</p></div></li>{/each}</ul>{/snippet}
</IndustrialDialog>
{/if}
