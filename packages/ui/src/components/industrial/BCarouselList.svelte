<!-- Measured rows share one BCarousel page until the available height is full. -->
<script lang="ts" generics="T">
  import { untrack, type ComponentProps, type Snippet } from 'svelte';
  import BCarousel from './BCarousel.svelte';
  import { paginateCarouselRows } from './carousel-pagination';

  let { items, itemKey, children, ariaLabel, labels, gap = 12, separated = false }:
    { items: readonly T[]; itemKey: (item: T) => string | number;
      children: Snippet<[T, boolean]>; ariaLabel: string;
      labels?: ComponentProps<typeof BCarousel>['labels']; gap?: number; separated?: boolean } = $props();
  let frame = $state<HTMLDivElement>(), measurement = $state<HTMLDivElement>();
  let groups = $state<Array<Array<string | number>>>([]), index = $state(0);
  const rowGap = $derived(Number.isFinite(gap) ? Math.max(0, gap) : 12);
  const keys = $derived(items.map(itemKey));
  const byKey = $derived(new Map(items.map(item => [itemKey(item), item])));
  const pages = $derived((groups.flat().length === items.length && groups.flat().every(key => byKey.has(key))
    ? groups : keys.map(key => [key])).map(group => group.map(key => byKey.get(key)!)));

  $effect(() => {
    void keys;
    const spacing = rowGap, divided = separated;
    if (!frame || !measurement) return;
    const holder = frame;
    const rows = [...measurement.children] as HTMLElement[];
    let active = true;
    const reflow = () => untrack(() => {
      if (!active) return;
      const next = paginateCarouselRows(rows.map(row => row.getBoundingClientRect().height), holder.clientHeight,
        divided ? spacing * 2 + 1 : spacing).map(group => group.map(position => keys[position]));
      if (next.length === groups.length && next.every((group, page) => group.length === groups[page].length && group.every((key, row) => key === groups[page][row]))) return;
      const anchor = groups[index]?.[0];
      const retained = next.findIndex(group => group.includes(anchor));
      groups = next;
      index = retained >= 0 ? retained : Math.min(index, Math.max(0, next.length - 1));
    });
    const observer = new ResizeObserver(reflow);
    observer.observe(holder);
    rows.forEach(row => observer.observe(row));
    reflow();
    return () => { active = false; observer.disconnect(); };
  });
</script>

<div bind:this={frame} class="relative h-full min-h-0 min-w-0" data-carousel-list style:--row-gap={`${rowGap}px`}>
  <div bind:this={measurement} class="pointer-events-none invisible absolute inset-x-0 top-0 flex h-0 flex-col overflow-hidden" aria-hidden="true" inert>
    {#each items as item (itemKey(item))}<div class="min-w-0 shrink-0">{@render children(item, true)}</div>{/each}
  </div>
  <BCarousel items={pages} bind:index effect="slide" compact {ariaLabel} {labels}>
    {#snippet children(page)}
      <div class="carousel-list-page flex min-w-0 flex-col" class:separated data-carousel-page role="list">
        {#each page as item (itemKey(item))}<div class="carousel-list-row min-w-0 shrink-0" role="listitem">{@render children(item, false)}</div>{/each}
      </div>
    {/snippet}
  </BCarousel>
</div>

<style>
  .carousel-list-page { gap: var(--row-gap); }
  .separated > .carousel-list-row + .carousel-list-row { border-top: 1px solid var(--nx-edge); padding-top: var(--row-gap); }
</style>
