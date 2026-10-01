<script lang="ts">
  import { onMount, tick, untrack, type Snippet } from 'svelte';
  import { GridStack, type GridItemHTMLElement } from 'gridstack';
  import 'gridstack/dist/gridstack.min.css';
  import { _, isLoading } from '$i18n';
  import { Button } from '$components/ui/button';
  import { Input } from '$components/ui/input';
  import * as Sheet from '$components/ui/sheet';
  import { StatusBadge, StatusDot, BSegmentedControl } from '$components/industrial';
  import { confirmAction } from '$stores/confirmation';
  import { dashboardDirty } from '$stores/navigation-guard';
  import { toast } from '$stores/toast';
  import LayoutGrid from 'lucide-svelte/icons/layout-grid';
  import Plus from 'lucide-svelte/icons/plus';
  import Undo2 from 'lucide-svelte/icons/undo-2';
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import Check from 'lucide-svelte/icons/check';
  import Search from 'lucide-svelte/icons/search';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import ChevronUp from 'lucide-svelte/icons/chevron-up';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import X from 'lucide-svelte/icons/x';
  import Plug from 'lucide-svelte/icons/plug';
  import DashboardCard from './DashboardCard.svelte';
  import { BUILTIN_CARDS, GROUPS, GRID_COLUMNS, LAYOUT_KEY, PREVIOUS_LAYOUT_KEY, LEGACY_LAYOUT_KEY, defaultLayout, parseLayout, cloneLayout, layoutSignature, minWidth, minHeight,
    type KpiMetric, type CardDefinition, type DashboardLayout, type LayoutCard, type MobileHeight } from './layout';
  import type { TimeRange } from '$types';

  let { plugins = [], selectedRange = $bindable('1h'), lastUpdated = null, refreshing = false, refreshError = false,
    onrefresh, oneditingchange, content, extra, alerts, metric }:
    { plugins?: CardDefinition[]; selectedRange?: TimeRange; lastUpdated?: number | null; refreshing?: boolean; refreshError?: boolean;
      onrefresh: () => void; oneditingchange: (editing: boolean) => void;
      content: Snippet<[CardDefinition]>; extra: Snippet<[CardDefinition]>; alerts?: Snippet; metric: (definition: CardDefinition) => KpiMetric } = $props();
  let saved = $state<DashboardLayout>(defaultLayout());
  let draft = $state<DashboardLayout>(defaultLayout());
  let editing = $state(false);
  let undoStack = $state<DashboardLayout[]>([]);
  let libraryOpen = $state(false);
  let libraryVisible = $state(false);
  let revealAfterClose: { id: string; block: ScrollLogicalPosition; focus: boolean } | undefined;
  const libraryCloseWaiters: (() => void)[] = [];
  let search = $state('');
  let group = $state('all');
  let mobile = $state(false);
  let hydrated = $state(false);
  let stored = false;
  let defaultPluginsAdded = false;
  let customizeButton = $state<HTMLDivElement>();
  let gridElement = $state<HTMLDivElement>();
  let grid: GridStack | undefined;
  const gridMargin = 6;
  let rowHeight = $state(74);
  let observeKpiSizes = () => {};
  let syncing = false;
  let syncVersion = 0;
  let announcement = $state('');
  let newCardIds = $state<string[]>([]);
  const flashTimers = new Set<ReturnType<typeof setTimeout>>();
  const active = $derived(editing ? draft : saved);
  const dirty = $derived(editing && layoutSignature(draft) !== layoutSignature(saved));
  const catalog = $derived.by(() => {
    const result = [...BUILTIN_CARDS, ...plugins];
    for (const card of active.cards) if (!result.some(definition => definition.id === card.id)) {
      result.push({ id: card.id, title: card.title ?? card.id, description: 'dashboardLayout.pluginUnavailable', group: 'plugin',
        tag: card.pluginName ?? 'PLUGIN', pluginName: card.pluginName, enabled: false, w: card.w, h: card.h });
    }
    return result;
  });
  const registry = $derived(Object.fromEntries(catalog.map(definition => [definition.id, definition])));
  const filtered = $derived($isLoading ? [] : catalog.filter(definition => (group === 'all' || definition.group === group) &&
    `${$_(definition.title)} ${$_(definition.description)} ${definition.tag}`.toLowerCase().includes(search.trim().toLowerCase())));
  const rangeOptions = [{ value: '1h', label: '1h' }, { value: '12h', label: '12h' }, { value: '24h', label: '24h' }];
  const heightOptions = $derived($isLoading ? [] : ['compact', 'standard', 'tall'].map(value => ({ value, label: $_(`dashboardLayout.sizes.${value}`) })));
  const changeSummary = $derived.by(() => {
    if ($isLoading || !editing) return '';
    const before = new Map(saved.cards.map(card => [card.id, card]));
    const after = new Map(draft.cards.map(card => [card.id, card]));
    const added = draft.cards.filter(card => !before.has(card.id)).length;
    const removed = saved.cards.filter(card => !after.has(card.id)).length;
    const adjusted = draft.cards.filter(card => { const old = before.get(card.id); return old && [old.x, old.y, old.w, old.h].join() !== [card.x, card.y, card.w, card.h].join(); }).length;
    const changes = [added && $_('dashboardLayout.addedCount', { values: { count: added } }), removed && $_('dashboardLayout.removedCount', { values: { count: removed } }),
      adjusted && $_('dashboardLayout.adjustedCount', { values: { count: adjusted } }), JSON.stringify(saved.mobile) !== JSON.stringify(draft.mobile) && $_('dashboardLayout.mobileArrangement')].filter(Boolean);
    return changes.join(' · ');
  });

  onMount(() => {
    try { const value = localStorage.getItem(LAYOUT_KEY) ?? localStorage.getItem(PREVIOUS_LAYOUT_KEY) ?? localStorage.getItem(LEGACY_LAYOUT_KEY); if (value) { saved = parseLayout(JSON.parse(value)); stored = true; } }
    catch { toast.show($_('dashboardLayout.loadFailed'), 'warning'); }
    const query = matchMedia('(max-width: 767px)');
    mobile = query.matches;
    const resize = () => { mobile = query.matches; };
    window.addEventListener('resize', resize);
    query.addEventListener('change', resize);
    hydrated = true;
    return () => { query.removeEventListener('change', resize); window.removeEventListener('resize', resize); flashTimers.forEach(clearTimeout); dashboardDirty.set(false); };
  });
  $effect(() => { dashboardDirty.set(dirty); });
  $effect(() => {
    const definitions = plugins;
    if (hydrated && !stored && !defaultPluginsAdded && definitions.some(definition => definition.enabled !== false)) {
      untrack(() => { if (!editing) { saved = defaultLayout(definitions); defaultPluginsAdded = true; } });
    }
  });

  function snapshot() { if (editing) undoStack = [...undoStack.slice(-59), cloneLayout(draft)]; }
  function readGrid() {
    if (!grid || syncing || !editing) return;
    const nodes = new Map(grid.engine.nodes.map(node => [node.id, node]));
    draft = { ...draft, cards: draft.cards.map(card => { const node = nodes.get(card.id); return node ? { ...card, x: node.x!, y: node.y!, w: node.w!, h: node.h! } : card; }) };
  }
  function mountGrid(element: HTMLDivElement) {
    // Top gravity fills vertical gaps while preserving each card's column.
    grid = GridStack.init({ column: GRID_COLUMNS, cellHeight: rowHeight, margin: gridMargin, float: false, animate: !matchMedia('(prefers-reduced-motion: reduce)').matches,
      handle: '.dashboard-card-head', resizable: { handles: 'se' }, alwaysShowResizeHandle: true }, element);
    let frame = 0;
    // Measure intrinsic content, not the flexible body's allocated height.
    const fitKpis = () => {
      frame = 0;
      let nextHeight = 74;
      for (const card of element.querySelectorAll<HTMLElement>('.dashboard-kpi-card')) {
        const header = card.querySelector<HTMLElement>('header');
        const body = card.querySelector<HTMLElement>('.nx-panel-body');
        const metric = body?.querySelector<HTMLElement>('.kpi-metric-row');
        const footer = card.querySelector<HTMLElement>('.kpi-footer');
        if (!header || !body || !metric) continue;
        const bodyStyle = getComputedStyle(body), cardStyle = getComputedStyle(card);
        const contentHeight = metric.getBoundingClientRect().height + parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom);
        const height = header.getBoundingClientRect().height + contentHeight + (footer?.getBoundingClientRect().height ?? 0) + parseFloat(cardStyle.borderTopWidth) + parseFloat(cardStyle.borderBottomWidth);
        nextHeight = Math.max(nextHeight, Math.ceil((height + gridMargin * 2) / 2));
      }
      if (rowHeight !== nextHeight && grid) {
        const animate = !!grid.opts.animate;
        grid.setAnimation(false);
        rowHeight = nextHeight; grid.cellHeight(nextHeight);
        // Apply content sizing immediately so growing text cannot cross the frame.
        void element.offsetHeight;
        grid.setAnimation(animate);
      }
    };
    const scheduleFit = () => { if (!frame) frame = requestAnimationFrame(fitKpis); };
    const observer = new ResizeObserver(scheduleFit);
    observeKpiSizes = () => {
      observer.disconnect(); observer.observe(element);
      for (const node of element.querySelectorAll('.dashboard-kpi-card header, .dashboard-kpi-card .kpi-metric-row, .dashboard-kpi-card .kpi-footer')) observer.observe(node);
      scheduleFit();
    };
    observeKpiSizes();
    grid.enableMove(editing); grid.enableResize(editing);
    grid.on('dragstart resizestart', () => { snapshot(); });
    grid.on('dragstop resizestop', () => { readGrid(); announcement = $_('dashboardLayout.adjusted'); });
    return { destroy() { syncVersion++; observer.disconnect(); cancelAnimationFrame(frame); observeKpiSizes = () => {}; grid?.destroy(false); grid = undefined; } };
  }
  // Svelte owns card DOM and component lifetimes; GridStack only owns geometry.
  $effect(() => {
    const layout = cloneLayout(active);
    const editable = editing;
    const element = gridElement;
    if (!element || mobile || !hydrated) return;
    const currentVersion = ++syncVersion;
    tick().then(() => {
      if (currentVersion !== syncVersion || !grid || element !== gridElement) return;
      syncing = true;
      try {
        grid.batchUpdate();
        for (const node of [...grid.engine.nodes]) if (!layout.cards.some(card => card.id === node.id)) grid.removeWidget(node.el!, false, false);
        const widgets = layout.cards.map(card => ({ ...card, minW: minWidth(registry[card.id]), minH: minHeight(registry[card.id]), maxW: GRID_COLUMNS, maxH: 20 }));
        for (const card of widgets) {
          const child = [...element.children].find(node => (node as HTMLElement).dataset.cardId === card.id) as GridItemHTMLElement | undefined;
          if (!child) continue;
          if (!child.gridstackNode) grid.makeWidget(child, card);
        }
        // Restore geometry as one layout so old positions cannot displace restored cards.
        grid.load(widgets, false);
        grid.enableMove(editable); grid.enableResize(editable);
        // GridStack creates resize handles when resizing is enabled.
        for (const node of grid.engine.nodes) {
          const handle = node.el?.querySelector<HTMLElement>('.ui-resizable-se');
          const definition = registry[node.id!];
          if (!handle || !definition) continue;
          handle.tabIndex = editable ? 0 : -1; handle.setAttribute('role', 'button');
          handle.setAttribute('aria-label', $_('dashboardLayout.resizeCard', { values: { title: $_(definition.title) } }));
          if (!handle.firstElementChild) handle.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true" fill="currentColor"><path d="M12 0V12H0Z"/></svg>';
          handle.onkeydown = (event) => moveCard(node.id!, event, true);
        }
        observeKpiSizes();
      } finally { syncing = false; }
    });
  });
  function beginEdit() {
    draft = cloneLayout(saved); undoStack = []; editing = true; oneditingchange(true);
    void tick().then(() => { if (!libraryOpen) document.querySelector<HTMLButtonElement>(mobile ? '[data-testid=dashboard-cancel-layout]' : '[data-testid=dashboard-add-card]')?.focus(); });
  }
  async function finishEdit() {
    await closeLibrary();
    editing = false; undoStack = []; oneditingchange(false);
    dashboardDirty.set(false); await tick(); customizeButton?.querySelector<HTMLButtonElement>('button')?.focus();
  }
  async function cancel() {
    if (dirty && !await confirmAction({ title: $_('dashboardLayout.discardTitle'), message: $_('dashboardLayout.discardMessage'),
      confirmText: $_('dashboardLayout.discard'), cancelText: $_('dashboardLayout.keepEditing') })) return;
    await finishEdit();
  }
  async function save() {
    if (!editing || !dirty) return;
    try {
      readGrid();
      const layout = parseLayout(cloneLayout(draft));
      for (const card of layout.cards) { const definition = registry[card.id]; if (definition.group === 'plugin') { card.title = definition.title; card.pluginName = definition.pluginName; } }
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
      saved = layout; stored = true; await finishEdit(); toast.show($_('dashboardLayout.saved'), 'success');
    } catch { toast.show($_('dashboardLayout.saveFailed'), 'error'); }
  }
  function undo() { if (!undoStack.length) return; draft = cloneLayout(undoStack.at(-1)!); undoStack = undoStack.slice(0, -1); announcement = $_('dashboardLayout.undone'); }
  function reset() { if (!editing) beginEdit(); snapshot(); draft = defaultLayout(plugins); announcement = $_('dashboardLayout.defaultsLoaded'); }
  async function add(definition: CardDefinition) {
    if (!editing) beginEdit();
    if (draft.cards.some(card => card.id === definition.id) || definition.enabled === false) return;
    snapshot();
    draft = { ...draft, cards: [...draft.cards, { id: definition.id, x: 0, y: Math.max(0, ...draft.cards.map(card => card.y + card.h)), w: definition.w, h: definition.h,
      ...(definition.group === 'plugin' ? { title: definition.title, pluginName: definition.pluginName } : {}) }], mobile: [...draft.mobile, { id: definition.id, height: 'standard' }] };
    await tick(); await tick(); readGrid(); announcement = $_('dashboardLayout.cardAdded', { values: { title: $_(definition.title) } });
    newCardIds = [...newCardIds, definition.id];
    const timer = setTimeout(() => { newCardIds = newCardIds.filter(id => id !== definition.id); flashTimers.delete(timer); }, 1500);
    flashTimers.add(timer);
    if (libraryVisible) revealAfterClose = { id: definition.id, block: 'nearest', focus: false };
    else document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(definition.id)}"]`)?.scrollIntoView({
      block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  async function remove(id: string) {
    const entries = mobile ? draft.mobile : draft.cards;
    const index = entries.findIndex(card => card.id === id);
    const nextId = (entries[index + 1] ?? entries[index - 1])?.id;
    const restoreFocus = (document.activeElement as HTMLElement)?.closest('[data-card-id]')?.getAttribute('data-card-id') === id;
    snapshot(); draft = { ...draft, cards: draft.cards.filter(card => card.id !== id), mobile: draft.mobile.filter(card => card.id !== id) };
    await tick(); await tick(); readGrid(); announcement = $_('dashboardLayout.cardRemoved');
    if (restoreFocus) {
      const next = nextId ? document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(nextId)}"]`)?.querySelector<HTMLButtonElement>('button') : null;
      (next ?? document.querySelector<HTMLButtonElement>(mobile ? '.dashboard-add-row' : '[data-testid=dashboard-add-card]'))?.focus();
    }
  }
  function setSize(id: string, w: number, h: number) {
    if (!grid) return;
    const node = grid.engine.nodes.find(node => node.id === id); if (!node || node.w === w && node.h === h) return;
    snapshot(); grid.update(node.el!, { x: Math.min(node.x!, GRID_COLUMNS - w), w, h }); readGrid();
  }
  function moveCard(id: string, event: KeyboardEvent, resize = false) {
    if (!editing || !grid) return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && !resize) { event.preventDefault(); void remove(id); return; }
    const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = delta[event.key]; if (!direction) return;
    event.preventDefault(); const node = grid.engine.nodes.find(node => node.id === id); if (!node) return;
    snapshot();
    const [dx, dy] = direction;
    grid.update(node.el!, resize || event.shiftKey ? { w: Math.max(node.minW!, Math.min(GRID_COLUMNS - node.x!, node.w! + dx)), h: Math.max(node.minH!, Math.min(20, node.h! + dy)) } :
      { x: Math.max(0, Math.min(GRID_COLUMNS - node.w!, node.x! + dx)), y: Math.max(0, node.y! + dy) });
    readGrid(); announcement = $_('dashboardLayout.adjusted');
  }
  function reorder(id: string, direction: number) {
    const index = draft.mobile.findIndex(card => card.id === id), next = index + direction;
    if (next < 0 || next >= draft.mobile.length) return;
    snapshot(); const entries = [...draft.mobile]; [entries[index], entries[next]] = [entries[next], entries[index]]; draft = { ...draft, mobile: entries };
  }
  function setMobileHeight(id: string, height: string) {
    if (draft.mobile.find(card => card.id === id)?.height === height) return;
    snapshot(); draft = { ...draft, mobile: draft.mobile.map(card => card.id === id ? { ...card, height: height as MobileHeight } : card) };
  }
  function openLibrary() { if (!editing) beginEdit(); revealAfterClose = undefined; libraryVisible = true; libraryOpen = true; }
  async function closeLibrary() {
    if (!libraryVisible) return;
    const closed = new Promise<void>(resolve => libraryCloseWaiters.push(resolve));
    libraryOpen = false;
    await closed;
  }
  function libraryClosed() {
    if (libraryOpen) return;
    libraryVisible = false;
    const reveal = revealAfterClose; revealAfterClose = undefined;
    const target = reveal ? document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(reveal.id)}"]`) : null;
    const focus = reveal?.focus ? target?.querySelector<HTMLButtonElement>('button:not(:disabled)') :
      document.querySelector<HTMLButtonElement>(mobile ? '.dashboard-add-row' : '[data-testid=dashboard-add-card]');
    focus?.focus({ preventScroll: true });
    if (target && reveal) target.scrollIntoView({ block: reveal.block, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    libraryCloseWaiters.splice(0).forEach(resolve => resolve());
  }
  async function locate(id: string) {
    revealAfterClose = { id, block: 'center', focus: true };
    await closeLibrary();
  }
  function shortcuts(event: KeyboardEvent) {
    if (!editing || document.querySelector('[data-testid=industrial-confirmation]')) return;
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
      if (event.key.toLowerCase() === 'z' && !event.shiftKey && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); undo(); }
    }
  }
</script>

<svelte:window onkeydown={shortcuts} />
{#snippet heightGauge(value: string)}
  <span class="dashboard-height-gauge" aria-hidden="true">{#each [0, 1, 2] as index}<i class:filled={index <= ['compact', 'standard', 'tall'].indexOf(value)}></i>{/each}</span>
{/snippet}
<div class="sr-only" aria-live="polite">{announcement}</div>
<div class="dashboard-heading mb-[18px] flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
  <div class="flex min-w-0 items-center gap-3"><span class="nx-stripe !h-8 shrink-0" aria-hidden="true"></span>
    <div><div class="nx-label">// {$_('dashboardLayout.operations')}</div><h1 class="mt-1 font-display text-[20px] font-bold leading-[1.1] tracking-tight text-zinc-100">{$_('dashboard.title')}</h1></div>
  </div>
  <div class="dashboard-heading-actions flex flex-wrap items-center gap-3">
    <div class="dashboard-live flex h-[34px] items-center gap-2 border border-carbon-600 bg-carbon-900 pl-2.5 pr-1 font-mono text-[10px] tracking-industrial text-zinc-400" role="status">
      <StatusDot status={editing ? 'idle' : refreshError ? 'warn' : lastUpdated ? 'ok' : 'idle'} />
      {#if editing}{$_('dashboardLayout.paused')}
      {:else}<span>{$_(refreshError ? 'dashboardLayout.refreshFailed' : 'dashboardLayout.live')} · {$_('dashboardLayout.every30s')} · {$_('dashboardLayout.updatedAt')}
        <b class="font-normal text-zinc-200">{lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : '—'}</b></span>
        <Button variant="link" size="icon" class="!h-6 !w-6 !p-0 !text-zinc-400 hover:!text-nexus-300" aria-label={$_('dashboardLayout.refresh')} disabled={refreshing} onclick={onrefresh}><RefreshCw class={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /></Button>
      {/if}
    </div>
    <BSegmentedControl options={rangeOptions} bind:value={selectedRange} ariaLabel={$_('dashboard.dataRange')} class="dashboard-range h-[34px]" />
    {#if !editing}<div bind:this={customizeButton} class="dashboard-customize"><Button variant="ghost" class="!h-[34px]" onclick={beginEdit} data-testid="dashboard-customize"><LayoutGrid class="mr-2 h-4 w-4" />{$_('dashboardLayout.customize')}</Button></div>{/if}
  </div>
</div>
{#if alerts}<div class="space-y-4">{@render alerts()}</div>{/if}
{#if editing}
  <section class="dashboard-editbar sticky top-[64px] z-30 mb-4 flex flex-wrap items-center gap-x-5 gap-y-3 border border-nexus-500/55 bg-carbon-800 py-2.5 pl-[22px] pr-2.5 shadow-industrial-lg" aria-label={$_('dashboardLayout.editing')}>
    <div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2.5 font-mono text-xs font-bold tracking-command text-zinc-100">{$_('dashboardLayout.editing')}
      <StatusBadge variant={dirty ? 'standby' : 'muted'}>{dirty ? `${$_('dashboardLayout.unsaved')} · ${changeSummary}` : $_('dashboardLayout.noChanges')}</StatusBadge></div>
      <p class="dashboard-edit-hint mt-1 text-xs text-zinc-400">{$_('dashboardLayout.editHint')} <kbd>← → ↑ ↓</kbd> · <kbd>Shift</kbd> · <kbd>Ctrl Z</kbd></p>
    </div>
    <div class="dashboard-edit-actions flex flex-wrap items-center gap-2">
      <Button variant="ghost" onclick={openLibrary} aria-expanded={libraryOpen} data-testid="dashboard-add-card"><Plus class="h-4 w-4" /><span class="dashboard-action-label ml-2">{$_('dashboardLayout.addCard')}</span></Button>
      <span class="dashboard-action-divider mx-0.5 h-6 w-px bg-carbon-600"></span>
      <Button variant="ghost" onclick={undo} disabled={!undoStack.length} aria-label={$_('dashboardLayout.undo')} title={$_('dashboardLayout.undo')}><Undo2 class="h-4 w-4" /><span class="dashboard-action-label ml-2">{$_('dashboardLayout.undo')}</span></Button>
      <Button variant="ghost" onclick={reset} aria-label={$_('dashboardLayout.reset')} title={$_('dashboardLayout.reset')}><RotateCcw class="h-4 w-4" /><span class="dashboard-action-label ml-2">{$_('dashboardLayout.reset')}</span></Button>
      <span class="dashboard-action-divider mx-0.5 h-6 w-px bg-carbon-600"></span>
      <Button variant="ghost" onclick={cancel} data-testid="dashboard-cancel-layout"><X class="mr-2 h-4 w-4" />{$_('common.cancel')}</Button>
      <Button onclick={save} disabled={!dirty} data-testid="dashboard-save-layout"><Check class="mr-2 h-4 w-4" />{$_('dashboardLayout.save')}</Button>
    </div>
  </section>
{/if}
<section class="dashboard-board" class:editing aria-label={$_('dashboardLayout.board')} data-testid="dashboard-board">
  {#if hydrated && !mobile}
    <div class="grid-stack dashboard-grid" style:--dashboard-columns={GRID_COLUMNS} style:--dashboard-row-height={`${rowHeight}px`} bind:this={gridElement} use:mountGrid>
      {#each active.cards as card (card.id)}
        {@const definition = registry[card.id]}
        <div class="grid-stack-item" class:is-new={newCardIds.includes(card.id)} data-card-id={card.id} gs-id={card.id} gs-x={card.x} gs-y={card.y} gs-w={card.w} gs-h={card.h}>
          <div class="grid-stack-item-content">
            <DashboardCard metric={definition.group === 'kpi' ? metric(definition) : undefined} {definition} {card} {editing} onremove={() => remove(card.id)} onsize={(w, h) => setSize(card.id, w, h)} onmove={(event) => moveCard(card.id, event)}>
              {#snippet children()}{@render content(definition)}{/snippet}
              {#snippet extra()}{@render extra(definition)}{/snippet}
            </DashboardCard>
          </div>
        </div>
      {/each}
    </div>
  {:else if hydrated && editing}
    <p class="mb-3 text-xs text-zinc-400">{$_('dashboardLayout.mobileHint')}</p>
    <ol class="flex flex-col gap-2">
      {#each draft.mobile as entry, index (entry.id)}
        {@const definition = registry[entry.id]}
        <li class="dashboard-manage-row grid min-w-0 grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5 border border-carbon-600 bg-carbon-800 p-2.5" class:is-new={newCardIds.includes(entry.id)} data-card-id={entry.id}>
          <span class="font-display text-xs font-bold text-zinc-500">{String(index + 1).padStart(2, '0')}</span>
          <div class="min-w-0"><strong class="block truncate text-[13px] text-zinc-100">{$_(definition.title)}</strong><span class="font-mono text-[10px] tracking-command text-zinc-500">{$_(`dashboardLayout.groups.${definition.group}`)} · {definition.tag}</span></div>
          <div class="flex justify-end gap-1">
            <Button variant="ghost" size="icon" class="!h-11 !w-11 bg-carbon-900" aria-label={$_('dashboardLayout.moveUp')} disabled={index === 0} onclick={() => reorder(entry.id, -1)}><ChevronUp class="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" class="!h-11 !w-11 bg-carbon-900" aria-label={$_('dashboardLayout.moveDown')} disabled={index === draft.mobile.length - 1} onclick={() => reorder(entry.id, 1)}><ChevronDown class="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" class="!h-11 !w-11 bg-carbon-900 hover:!text-red-300" aria-label={$_('dashboardLayout.removeCard', { values: { title: $_(definition.title) } })} onclick={() => remove(entry.id)}><X class="h-4 w-4" /></Button>
          </div>
          <BSegmentedControl options={heightOptions} value={entry.height} onchange={(value) => setMobileHeight(entry.id, value)} leading={heightGauge} stretch ariaLabel={$_('dashboardLayout.mobileHeight')} class="dashboard-mobile-heights col-span-3" />
        </li>
      {/each}
    </ol>
    <button type="button" class="dashboard-add-row mt-2 flex h-[52px] w-full items-center justify-center gap-2 border border-dashed border-carbon-500 text-xs font-bold text-zinc-300 hover:border-nexus-500 hover:text-nexus-300" onclick={openLibrary}><Plus class="h-4 w-4" />{$_('dashboardLayout.addCard')}</button>
  {:else if hydrated}
    <div class="space-y-3">
      {#each saved.mobile as entry (entry.id)}
        {@const card = saved.cards.find(card => card.id === entry.id)!}
        {@const definition = registry[entry.id]}
        <div class="dashboard-mobile-card" data-group={definition.group} data-height={entry.height} data-card-id={entry.id}>
          <DashboardCard metric={definition.group === 'kpi' ? metric(definition) : undefined} {definition} {card} onremove={() => {}} onsize={() => {}} onmove={() => {}}>
            {#snippet children()}{@render content(definition)}{/snippet}
            {#snippet extra()}{@render extra(definition)}{/snippet}
          </DashboardCard>
        </div>
      {/each}
    </div>
  {/if}
  {#if !active.cards.length}
    <div class="flex flex-col items-center gap-2.5 border border-dashed border-carbon-500 bg-carbon-900/50 px-5 py-16 text-center" data-testid="dashboard-empty">
      <span class="grid h-12 w-12 place-items-center border border-carbon-500 text-zinc-500"><LayoutGrid class="h-6 w-6" /></span>
      <strong class="font-mono text-xs tracking-command text-zinc-100">{$_('dashboardLayout.emptyTitle')}</strong>
      <p class="max-w-[360px] text-[12.5px] text-zinc-400">{$_('dashboardLayout.emptyDescription')}</p>
      <div class="mt-1.5 flex flex-wrap justify-center gap-2"><Button onclick={openLibrary}><Plus class="mr-2 h-4 w-4" />{$_('dashboardLayout.addCard')}</Button><Button variant="ghost" onclick={reset}><RotateCcw class="mr-2 h-4 w-4" />{$_('dashboardLayout.reset')}</Button></div>
    </div>
  {/if}
</section>

{#snippet tilePreview(definition: CardDefinition)}
  {@const category = definition.group}
                <span class="dashboard-thumbnail grid h-[46px] w-[68px] place-items-center border border-carbon-600 bg-carbon-950 text-nexus-500" aria-hidden="true">
                  <svg viewBox="0 0 52 32" class="h-8 w-[52px]">
                    {#if category === 'trend'}<path d="M2 28V22L10 18L18 21L26 12L34 15L42 7L50 10V28Z" fill="currentColor" opacity=".18" /><polyline points="2,22 10,18 18,21 26,12 34,15 42,7 50,10" fill="none" stroke="currentColor" stroke-width="1.6" />
                    {:else if category === 'upstream'}{#each [46,32,20,11] as width, i}<rect x="2" y={3+i*7.5} {width} height="4" fill="currentColor" opacity={1-i*.2} />{/each}
                    {:else if category === 'health'}{#each [0,1,2] as i}<circle cx="5" cy={6+i*10} r="2.2" class="fill-emerald-400" /><rect x="11" y={4.5+i*10} width={22-i*4} height="3" class="fill-zinc-400" /><rect x="40" y={4.5+i*10} width="10" height="3" class="fill-zinc-600" />{/each}
                    {:else if category === 'kpi'}<rect x="2" y="3" width="3" height="7" fill="currentColor" /><rect x="8" y="5" width="16" height="3" class="fill-zinc-600" /><rect x="2" y="15" width="26" height="9" class="fill-zinc-300" /><polyline points="33,24 38,20 42,22 50,13" fill="none" stroke="currentColor" stroke-width="1.5" />
                    {:else}<Plug x="14" y="3" width="24" height="24" />{/if}
                  </svg>
                </span>
                <div class="min-w-0"><strong class="block truncate text-[13px] font-semibold text-zinc-100">{$_(definition.title)}</strong><p class="dashboard-tile-description mt-0.5 text-[11.5px] leading-snug text-zinc-400">{$_(definition.description)}</p><span class="mt-1 block font-mono text-[10px] tracking-industrial text-zinc-500">{definition.tag} · {definition.w} × {definition.h}</span></div>
{/snippet}
{#snippet libraryContents()}
    <header class="relative shrink-0 border-b border-carbon-600 py-3.5 pl-4 pr-12"><h2 id="dashboard-library-title" class="flex items-center gap-2.5 font-mono text-xs font-bold tracking-command text-zinc-100"><span class="nx-stripe"></span>{$_('dashboardLayout.library')}</h2><p class="sr-only">{$_('dashboardLayout.libraryDescription')}</p></header>
    <div class="shrink-0 space-y-2.5 border-b border-carbon-600 px-4 pt-3.5 pb-3">
      <div class="relative"><Search class="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-zinc-500" /><Input bind:value={search} class="!h-9 !bg-carbon-950 pl-[34px]" placeholder={$_('dashboardLayout.search')} aria-label={$_('dashboardLayout.search')} /></div>
      <div class="flex flex-wrap gap-1.5">
        {#each ['all', ...GROUPS] as value}<Button variant="ghost" class={`dashboard-chip !h-[26px] !border !border-carbon-600 !bg-carbon-950 !px-2.5 !font-mono !text-[10px] !font-normal !tracking-industrial !text-zinc-400 hover:!text-nexus-300 ${group === value ? 'selected' : ''}`} aria-pressed={group === value} onclick={() => group = value}>{$_(`dashboardLayout.groups.${value}`)} {value === 'all' ? catalog.length : catalog.filter(card => card.group === value).length}</Button>{/each}
      </div>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4" data-testid="dashboard-library-list">
      {#each GROUPS as category}
        {@const definitions = filtered.filter(definition => definition.group === category)}
        {#if definitions.length}
          <section><h3 class="mt-4 mb-2 flex justify-between font-mono text-[10px] tracking-chiseled text-zinc-500"><span>{$_(`dashboardLayout.groups.${category}`)}</span><span>{definitions.filter(definition => active.cards.some(card => card.id === definition.id)).length}/{definitions.length} {$_('dashboardLayout.added')}</span></h3>
            {#each definitions as definition (definition.id)}
              {@const added = active.cards.some(card => card.id === definition.id)}
              {#if added || definition.enabled === false}
              <div class="dashboard-library-tile mb-2 grid grid-cols-[68px_minmax(0,1fr)_auto] items-center gap-3 border border-carbon-600 bg-carbon-800 p-2.5" class:added class:disabled={definition.enabled === false}>
                {@render tilePreview(definition)}
                <div class="flex flex-col items-end gap-1">
                  {#if added}<StatusBadge variant="active">{$_('dashboardLayout.added')}</StatusBadge><Button variant="ghost" size="sm" class="!h-6 !border !px-2" onclick={() => locate(definition.id)}>{$_('dashboardLayout.locate')}</Button>
                  {:else if definition.enabled === false}<span class="font-mono text-[10px] text-zinc-500">{$_('dashboardLayout.disabled')}</span>
                  {/if}
                </div>
              </div>
              {:else}
                <Button variant="ghost" class="dashboard-library-tile group mb-2 !grid !h-auto !w-full grid-cols-[68px_minmax(0,1fr)_auto] !items-center !gap-3 !whitespace-normal !border !border-carbon-600 !bg-carbon-800 !p-2.5 !text-left !font-normal !normal-case !tracking-normal hover:!border-nexus-500/55 hover:!bg-carbon-700"
                  aria-label={$_('dashboardLayout.addNamedCard', { values: { title: $_(definition.title) } })} onclick={() => add(definition)}>
                  {@render tilePreview(definition)}
                  <span class="grid h-[30px] w-[30px] place-items-center border-2 border-carbon-500 text-zinc-300 group-hover:border-nexus-400 group-hover:bg-nexus-500 group-hover:text-black"><Plus class="h-4 w-4" /></span>
                </Button>
              {/if}
            {/each}
          </section>
        {/if}
      {/each}
      {#if !filtered.length}<p class="py-8 text-center text-xs text-zinc-500">{$_('dashboardLayout.noMatches')}</p>{/if}
    </div>
    <footer class="flex shrink-0 justify-between border-t border-carbon-600 bg-carbon-950/40 px-4 py-3 font-mono text-[10px] tracking-command text-zinc-500"><span>{$_('dashboardLayout.added')} <b class="font-normal text-zinc-200">{active.cards.length}</b> / {catalog.length}</span><span>{$_('dashboardLayout.localOnly')}</span></footer>
{/snippet}
<Sheet.Root bind:open={libraryOpen} preventScroll
  openFocus={() => { document.querySelector<HTMLInputElement>('.dashboard-library input')?.focus({ preventScroll: true }); }}
  closeFocus={() => undefined}>
  <Sheet.Content side={mobile ? 'bottom' : 'right'} aria-labelledby="dashboard-library-title"
    class="dashboard-library !top-0 !h-dvh !w-[392px] !max-w-full !gap-0 !p-0 flex flex-col overflow-hidden border-carbon-500 bg-carbon-900"
    closeLabel={$_('common.close')} closeClass="right-3 top-2.5 flex h-[30px] w-[30px] items-center justify-center !p-0 !text-zinc-400 !opacity-100"
    onClosed={libraryClosed}>
    <Sheet.Title class="sr-only">{$_('dashboardLayout.library')}</Sheet.Title><Sheet.Description class="sr-only">{$_('dashboardLayout.libraryDescription')}</Sheet.Description>
    {@render libraryContents()}
  </Sheet.Content>
</Sheet.Root>

<style>
  :global(.dashboard-range button + button), :global(.dashboard-mobile-heights button + button) { border-left: 1px solid var(--nx-edge); }
  :global(.dashboard-grid) { margin: -6px; }
  :global(.dashboard-grid > .grid-stack-item > .grid-stack-item-content) { overflow: visible; }
  .editing :global(.dashboard-grid) { min-height: calc(var(--dashboard-row-height) * 4); outline: 1px dashed var(--nx-edge); outline-offset: 4px;
    background: linear-gradient(rgb(148 163 184 / .045) 1px, transparent 1px) 0 0/100% var(--dashboard-row-height),
      repeating-linear-gradient(90deg, transparent 0 6px, rgb(249 115 22 / .035) 6px calc(100% / var(--dashboard-columns) - 6px), transparent calc(100% / var(--dashboard-columns) - 6px) calc(100% / var(--dashboard-columns))); }
  .dashboard-editbar::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 6px; background: repeating-linear-gradient(-45deg, var(--nx-panel) 0 4px, var(--nx-accent) 4px 8px); }
  kbd { border: 1px solid var(--nx-edge-strong); border-bottom-width: 2px; padding: 0 4px; font-size: 10px; background: var(--nx-panel); }
  :global(.dashboard-grid .ui-resizable-handle) { display: none !important; }
  .editing :global(.dashboard-grid .ui-resizable-se) { display: grid !important; align-items: end; justify-items: end; width: 18px; height: 18px; right: calc(var(--gs-item-margin-right) + 3px); bottom: calc(var(--gs-item-margin-bottom) + 3px); transform: none; background: none; color: var(--nx-text-mute); clip-path: polygon(100% 0, 0 100%, 100% 100%); z-index: 5 !important; cursor: se-resize; }
  .editing :global(.dashboard-grid .ui-resizable-se svg) { width: 12px; height: 12px; pointer-events: none; }
  .editing :global(.dashboard-grid .grid-stack-item:hover > .ui-resizable-se), .editing :global(.dashboard-grid .ui-resizable-se:focus-visible), .editing :global(.dashboard-grid .ui-resizable-resizing > .ui-resizable-se) { color: var(--nx-accent); }
  .editing :global(.dashboard-grid .ui-resizable-se:focus-visible) { outline: 0; background: none; }
  .editing :global(.grid-stack-item:hover .dashboard-grip), .editing :global(.dashboard-grip:focus-visible) { color: var(--nx-accent); }
  .editing :global(.grid-stack-item:hover > .grid-stack-item-content > article), .editing :global(.grid-stack-item:focus-within > .grid-stack-item-content > article), .dashboard-manage-row:focus-within { border-color: color-mix(in srgb, var(--nx-accent) 55%, transparent); }
  .editing :global(.ui-draggable-dragging > .grid-stack-item-content > article) { border-color: var(--nx-accent); box-shadow: 0 8px 24px rgb(0 0 0 / .6), 0 0 0 1px var(--nx-accent); cursor: grabbing; }
  .editing :global(.ui-draggable-dragging .dashboard-card-head), .editing :global(.ui-draggable-dragging .dashboard-grip) { cursor: grabbing; }
  .editing :global(.nx-panel-body[inert]) { position: relative; pointer-events: none; user-select: none; }
  .editing :global(.nx-panel-body[inert]::after) { content: ''; position: absolute; inset: 0; background: rgb(10 11 14 / .18); pointer-events: none; }
  :global(.dashboard-grid .is-new > .grid-stack-item-content > article), .dashboard-manage-row.is-new { animation: dashboard-card-added 1.4s ease-out; }
  @keyframes dashboard-card-added { 0%, 35% { border-color: var(--nx-accent); box-shadow: 0 4px 14px rgb(0 0 0 / .45), 0 0 0 3px color-mix(in srgb, var(--nx-accent) 35%, transparent); } }
  :global(.dashboard-grid .grid-stack-placeholder > .placeholder-content) { border: 1px dashed var(--nx-accent); background: repeating-linear-gradient(-45deg, var(--nx-accent-soft) 0 8px, transparent 8px 16px) !important; }
  .dashboard-mobile-card { --compact: 128px; --standard: 156px; --tall: 196px; }
  .dashboard-height-gauge { display: inline-flex; flex-direction: column-reverse; gap: 1px; }
  .dashboard-height-gauge i { width: 10px; height: 3px; background: currentColor; opacity: .3; }
  .dashboard-height-gauge i.filled { opacity: 1; }
  .dashboard-mobile-card[data-group=trend], .dashboard-mobile-card[data-group=upstream] { --compact: 210px; --standard: 270px; --tall: 350px; }
  .dashboard-mobile-card[data-group=health] { --compact: 200px; --standard: 260px; --tall: 340px; }
  .dashboard-mobile-card[data-group=plugin] { --compact: 128px; --standard: 168px; --tall: 220px; }
  .dashboard-mobile-card[data-height=compact] { height: var(--compact); }
  .dashboard-mobile-card[data-height=standard] { height: var(--standard); }
  .dashboard-mobile-card[data-height=tall] { height: var(--tall); }
  .dashboard-mobile-card[data-card-id="plugin:native:token-stats:token-stats-chart"] { --compact: 300px; --standard: 320px; --tall: 400px; }
  .dashboard-mobile-card[data-group=kpi] { --compact: 144px; }
  .dashboard-mobile-card[data-group=kpi][data-height=compact] :global(.nx-panel-body) { padding-block: 10px; }
  :global(.dashboard-chip.selected) { border-color: var(--nx-accent) !important; color: var(--nx-accent) !important; background: var(--nx-accent-soft) !important; }
  .dashboard-library-tile.added { background: transparent; }
  .dashboard-library-tile.disabled { opacity: .65; }
  .dashboard-tile-description { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  @media (max-width: 767px) {
    .dashboard-heading { flex-direction: column; align-items: stretch; gap: 14px; }
    .dashboard-heading-actions { justify-content: space-between; }
    .dashboard-live { display: none; }
    :global(.dashboard-range) { flex: 1; } :global(.dashboard-range button) { flex: 1; }
    .dashboard-customize { width: 100%; } .dashboard-customize :global(button) { width: 100%; }
    .dashboard-editbar { top: 62px; padding: 10px 12px 10px 18px; }
    .dashboard-edit-hint { display: none; }
    .dashboard-edit-actions { position: fixed; inset: auto 0 0; z-index: 44; display: grid; grid-template-columns: auto auto 1fr 1fr; gap: 8px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); background: var(--nx-panel); border-top: 1px solid var(--nx-edge-strong); box-shadow: 0 -8px 18px rgba(0,0,0,.45); }
    .dashboard-edit-actions :global(button) { height: 44px; }
    .dashboard-action-label, .dashboard-action-divider, .dashboard-edit-actions :global([data-testid=dashboard-add-card]) { display: none; }
    :global(.dashboard-mobile-heights button) { height: 40px; }
    :global(.dashboard-library) { width: 100% !important; border-left: 0; border-top: 1px solid var(--nx-edge-strong); }
    :global(.dashboard-library .dashboard-chip) { height: 34px !important; }
    :global(.dashboard-library input) { height: 40px !important; }
  }
  @media (max-width: 360px) { :global(.dashboard-library-tile) { grid-template-columns: 48px minmax(0,1fr) auto; gap: 8px; padding: 8px; } :global(.dashboard-thumbnail) { width: 48px; } .dashboard-edit-actions { gap: 6px; padding-left: 10px; padding-right: 10px; } .dashboard-edit-actions :global(button) { padding-left: 9px; padding-right: 9px; letter-spacing: .04em; } }
  @media (prefers-reduced-motion: reduce) { :global(.dashboard-board *), :global(.dashboard-library *) { animation: none !important; transition: none !important; } }
</style>
