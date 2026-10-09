<script lang="ts">
  // Shared editable single-select renderer for BSelect; adapters own remote I/O.
  import { onMount, tick, untrack } from 'svelte';
  import { on } from 'svelte/events';
  import { autoUpdate, computePosition, offset, flip, shift } from '@floating-ui/dom';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import Loader2 from 'lucide-svelte/icons/loader-2';
  import Check from 'lucide-svelte/icons/check';
  import X from 'lucide-svelte/icons/x';
  import type { SelectSearchOption, SelectRemoteSearch, SelectSearchLabels } from './select-search';

  let { id, value, options, remoteSearch, labels, disabled = false, loading = false,
    creatable = false, allowClear = false, label, placeholder, size = 'middle', status,
    maxLength = 512, rootTestId = 'search-select', searchTestId, onchange }: {
    id?: string; value: string; options: SelectSearchOption[]; remoteSearch?: SelectRemoteSearch;
    labels: SelectSearchLabels; disabled?: boolean; loading?: boolean; creatable?: boolean;
    allowClear?: boolean; label?: string; placeholder: string; size?: 'small' | 'middle' | 'large';
    status?: 'error' | 'warning'; maxLength?: number; rootTestId?: string; searchTestId?: string;
    onchange: (value: string) => void;
  } = $props();
  const componentId = $props.id(), listId = `${componentId}-list`, popupId = `${componentId}-popup`;
  let open = $state(false), keyword = $state(''), highlighted = $state(-1), width = $state(0);
  let accumulated = $state<SelectSearchOption[]>([]), loadedPage = $state(0), requestedPage = $state(1);
  let total = $state(0), pageSize = $state(50), advanceOnLoad = $state(false);
  let input = $state<HTMLInputElement>(), viewport = $state<HTMLDivElement>(), popup = $state<HTMLDivElement>(), anchor = $state<HTMLDivElement>();
  let savedLabel = $state(''), x = $state(0), y = $state(0), positioned = $state(false);
  const visible = $derived(remoteSearch ? accumulated : options.filter(option => !keyword ||
    option.label.toLowerCase().includes(keyword.toLowerCase()) || option.value.toLowerCase().includes(keyword.toLowerCase())));
  const busy = $derived(loading || !!remoteSearch?.result.loading);
  const failed = $derived(!!remoteSearch?.result.error);
  const hasMore = $derived(!!remoteSearch && loadedPage > 0 && loadedPage * pageSize < total);
  const custom = $derived(creatable && !!keyword.trim() && !visible.some(option => option.value === keyword.trim()));
  const confirmedLabel = $derived(options.find(option => option.value === value)?.label || savedLabel || value);
  const fieldHeight = $derived(size === 'small' ? 'h-[30px]' : size === 'large' ? 'h-[38px]' : 'h-[34px]');
  const fieldTone = $derived(status === 'error' ? 'border-red-500' : status === 'warning' ? 'border-amber-500' : 'border-carbon-500');
  const resetKey = $derived(remoteSearch?.resetKey);

  $effect(() => { const next = value; const match = options.find(option => option.value === next); savedLabel = match?.label ?? next; });
  $effect(() => {
    const key = resetKey, inactive = disabled;
    untrack(() => { if (inactive) dismiss(false); else if (open) reset(''); });
  });
  $effect(() => {
    const result = remoteSearch?.result, pageOptions = options;
    if (open && result && !result.loading && !result.error) untrack(() => {
      if (result.page !== requestedPage || result.page <= loadedPage) return;
      const previousLength = accumulated.length;
      accumulated = [...new Map([...accumulated, ...pageOptions].map(option => [option.value, option])).values()];
      loadedPage = result.page; total = result.total; pageSize = Math.max(1, result.pageSize);
      if (advanceOnLoad) {
        highlighted = nextEnabled(previousLength - 1, 1);
        advanceOnLoad = false; void reveal();
      }
    });
  });
  $effect(() => { if (!open) untrack(() => remoteSearch?.cancel()); });

  function reset(next: string) {
    keyword = next; highlighted = -1; accumulated = []; loadedPage = 0;
    requestedPage = 1; total = 0; advanceOnLoad = false; viewport?.scrollTo({ top: 0 });
    remoteSearch?.search(next, 1, next.length > 0);
  }
  function show() { if (disabled) return; input?.focus(); if (open) return; open = true; reset(''); }
  function edit(next: string) { if (!open) open = true; reset(next); }
  function dismiss(focus: boolean) {
    open = false; keyword = ''; highlighted = -1; advanceOnLoad = false;
    remoteSearch?.cancel();
    if (focus) input?.focus();
  }
  function select(option: SelectSearchOption) {
    if (option.disabled) return;
    savedLabel = option.label; onchange(option.value); dismiss(true);
  }
  function loadMore(advance = false) {
    if (open && advance && requestedPage > loadedPage && !failed) { advanceOnLoad = true; return; }
    if (!open || !hasMore || busy || failed || requestedPage > loadedPage) return;
    advanceOnLoad = advance; requestedPage = loadedPage + 1;
    remoteSearch?.search(keyword, requestedPage, false);
  }
  function retry() { input?.focus(); remoteSearch?.search(keyword, requestedPage, false); }
  function scroll() {
    if (viewport && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24) loadMore();
  }
  function nextEnabled(from: number, direction: number) {
    for (let i = from + direction; i >= 0 && i < visible.length; i += direction) if (!visible[i].disabled) return i;
    return from;
  }
  async function reveal() { await tick(); document.getElementById(`${listId}-${highlighted}`)?.scrollIntoView({ block: 'nearest' }); }
  function escape(event: KeyboardEvent) {
    if (event.key === 'Escape' && open && !event.isComposing) {
      event.preventDefault(); event.stopPropagation(); dismiss(true);
    }
  }
  function keydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Escape') { escape(event); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      if (!open) { show(); return; }
      const next = nextEnabled(highlighted < 0 && event.key === 'ArrowUp' ? visible.length : highlighted, event.key === 'ArrowDown' ? 1 : -1);
      if (next === highlighted && event.key === 'ArrowDown') loadMore(true);
      else { highlighted = next; void reveal(); }
    } else if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation();
      if (!open) show();
      else if (highlighted >= 0 && visible[highlighted]) select(visible[highlighted]);
      else if (custom) select({ value: keyword.trim(), label: keyword.trim() });
    }
  }
  // Direct listeners run before a portalled dialog's document-level Escape listener.
  function listen(node: HTMLElement, handlers: Record<string, (event: any) => void>) {
    let cleanup = () => {};
    function update(next: typeof handlers) {
      cleanup(); const removers = Object.entries(next).map(([event, handler]) => on(node, event, handler));
      cleanup = () => removers.forEach(remove => remove());
    }
    update(handlers); return { update, destroy: () => cleanup() };
  }
  $effect(() => {
    const reference = anchor, floating = popup;
    if (!open || !reference || !floating) { positioned = false; return; }
    let active = true, generation = 0;
    const update = async () => {
      const current = ++generation;
      const position = await computePosition(reference, floating, { strategy: 'fixed', placement: 'bottom-start',
        middleware: [offset(4), flip({ padding: 12 }), shift({ padding: 12 })] });
      if (!active || current !== generation) return;
      x = position.x; y = position.y; positioned = true;
    };
    const cleanup = autoUpdate(reference, floating, () => void update());
    return () => { active = false; cleanup(); };
  });
  onMount(() => {
    function outside(event: Event) {
      const target = event.target as Node;
      if (open && !anchor?.contains(target) && !popup?.contains(target)) dismiss(false);
    }
    const offFocus = on(document, 'focusin', outside), offPointer = on(document, 'pointerdown', outside);
    return () => { offFocus(); offPointer(); remoteSearch?.cancel(); };
  });
</script>

<div class="min-w-0 w-full" bind:clientWidth={width} data-testid={rootTestId}>
    <div bind:this={anchor} data-testid="search-select-field" class={`flex w-full min-w-0 items-center gap-1 border-2 bg-carbon-900 px-2 ${fieldHeight} ${fieldTone} focus-within:border-nexus-500 focus-within:ring-1 focus-within:ring-nexus-500/30 ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}>
      <input bind:this={input} id={id ?? `${componentId}-input`} value={open ? keyword : confirmedLabel}
        placeholder={open ? confirmedLabel || labels.search : placeholder} maxlength={maxLength} {disabled}
        role="combobox" aria-label={label} aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? listId : undefined} aria-activedescendant={open && highlighted >= 0 ? `${listId}-${highlighted}` : undefined}
        aria-invalid={status === 'error' ? 'true' : undefined} autocomplete="off" data-testid={searchTestId}
        class="h-full min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[11px] font-normal text-zinc-200 outline-none placeholder:text-zinc-400 placeholder:font-normal"
        use:listen={{ click: show, focus: () => { if (!open) input?.select(); }, input: event => edit(event.currentTarget.value), keydown }} />
      {#if allowClear && value && !disabled && !loading}
        <button type="button" class="shrink-0 text-zinc-400 hover:text-red-300 focus-visible:outline focus-visible:outline-nexus-500" aria-label={labels.clear}
          use:listen={{ mousedown: event => event.preventDefault(), click: () => { onchange(''); dismiss(true); } }}><X class="h-3.5 w-3.5" /></button>
      {:else}
        <button type="button" tabindex="-1" {disabled} aria-label={label} aria-expanded={open} aria-controls={open ? popupId : undefined}
          class="shrink-0 text-zinc-400 hover:text-zinc-200" data-testid="search-select-toggle" use:listen={{ mousedown: event => event.preventDefault(), click: () => { if (open) dismiss(true); else show(); } }}><ChevronDown class="h-4 w-4 opacity-50" /></button>
      {/if}
    </div>
    {#if open}
      <div id={popupId} bind:this={popup} role="presentation" use:listen={{ keydown: escape }}
        class="fixed z-[200] max-w-[calc(100vw-2rem)] border border-carbon-600 bg-carbon-800 shadow-industrial"
        style:width={`${width}px`} style:left={`${x}px`} style:top={`${y}px`} style:visibility={positioned ? 'visible' : 'hidden'}>
        <div class="max-h-52 overflow-y-auto p-1" tabindex="-1" bind:this={viewport} data-testid="search-select-viewport" use:listen={{ scroll }}>
          <div id={listId} role="listbox" aria-label={label} aria-busy={busy}>
            {#each visible as option, index (option.value)}
              <button type="button" role="option" id={`${listId}-${index}`} tabindex="-1" disabled={option.disabled}
                aria-selected={option.value === value} class={`relative flex w-full items-center justify-between gap-2 break-all px-2 py-1.5 text-left text-sm text-zinc-300 outline-none hover:bg-carbon-700 ${option.disabled ? 'opacity-50' : ''} ${highlighted === index ? 'bg-carbon-700 text-zinc-100' : ''} ${option.value === value ? 'bg-nexus-500/15 text-nexus-400' : ''}`}
                use:listen={{ pointermove: () => { if (!option.disabled) highlighted = index; }, mousedown: event => event.preventDefault(), click: () => select(option) }}>
                <span>{option.label}</span><Check class={`h-3 w-3 shrink-0 ${option.value === value ? 'text-nexus-400' : 'invisible'}`} />
              </button>
            {/each}
          </div>
          {#if !busy && !failed && !visible.length}<p role="status" class="px-2 py-3 text-sm text-zinc-400">{labels.empty}</p>{/if}
          {#if custom}
            <button type="button" class="w-full break-all px-2 py-1.5 text-left text-sm text-nexus-300 hover:bg-carbon-700 focus-visible:outline focus-visible:outline-nexus-500"
              use:listen={{ mousedown: event => event.preventDefault(), click: () => select({ value: keyword.trim(), label: keyword.trim() }) }}>{labels.custom} {keyword.trim()}</button>
          {/if}
        </div>
        {#if remoteSearch}
          <div class="flex min-h-9 items-center justify-between gap-2 border-t border-carbon-600/50 px-3 py-1.5 text-xs text-zinc-400" data-testid="search-select-footer">
            {#if failed}
              <span role="alert">{labels.error}</span>
              <button type="button" class="shrink-0 text-nexus-300 hover:text-nexus-400 focus-visible:outline focus-visible:outline-nexus-500" use:listen={{ click: retry }}>{labels.retry}</button>
            {:else}
              <span role="status" aria-live="polite">{busy ? labels.loading : hasMore ? `${labels.loaded} ${visible.length} / ${total}` : labels.complete}</span>
              {#if busy}<Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin" />
              {:else if hasMore}<button type="button" class="shrink-0 text-zinc-400 hover:text-zinc-200 focus-visible:outline focus-visible:outline-nexus-500" use:listen={{ click: () => { input?.focus(); loadMore(); } }}>{labels.loadMore}</button>{/if}
            {/if}
          </div>
        {/if}
      </div>
    {/if}
</div>
