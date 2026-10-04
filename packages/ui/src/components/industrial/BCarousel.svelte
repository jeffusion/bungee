<!--
  BCarousel<T> — content carousel; no parent context required.
  Required: items: readonly T[], children: Snippet<[T, number]>.
  index = 0 (bindable); autoplay = true; interval = 5000ms; loop = true.
  effect = 'fade' | 'slide'; compact = false (fixed-height parent, scrollable
  slides, transparent indicator row).
  onchange(index) reports navigation, not external index writes or clamping.
  ariaLabel = 'Carousel'; labels overrides accessible English copy; empty is
  an optional empty-state snippet. class styles the inset (wrap in PanelCard).
  Hover/focus/hidden document pause temporarily. Pause choice persists.
  Reduced motion disables playback/transitions. Inactive content stays mounted
  but inert. Keyboard navigation belongs only to the focusable viewport.
-->
<script lang="ts" generics="T">
  import { onMount, type Snippet } from 'svelte';
  import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-svelte';
  import { cn } from '$utils';

  let {
    items, children, index = $bindable(0), autoplay = true, interval = 5000,
    loop = true, effect: transitionEffect = 'fade', compact = false, onchange, ariaLabel = 'Carousel', labels = {}, empty,
    class: className = '',
  }: {
    items: readonly T[];
    children: Snippet<[T, number]>;
    index?: number;
    autoplay?: boolean;
    interval?: number;
    loop?: boolean;
    effect?: 'fade' | 'slide';
    compact?: boolean;
    onchange?: (index: number) => void;
    ariaLabel?: string;
    labels?: Partial<{
      previous: string; next: string; pause: string; play: string;
      empty: string; reducedMotion: string; slide: string;
      goTo: (position: number, total: number) => string;
      position: (position: number, total: number) => string;
    }>;
    empty?: Snippet;
    class?: string;
  } = $props();

  const id = $props.id();
  let mounted = $state(false);
  let root = $state<HTMLElement>();
  let hovered = $state(false);
  let focused = $state(false);
  let hidden = $state(false);
  let reducedMotion = $state(false);
  let paused = $state(false);
  let restart = $state(0);
  let announcement = $state('');
  let gesture = $state<{ id: number; x: number; y: number } | null>(null);
  const copy = $derived({
    previous: 'Previous slide', next: 'Next slide', pause: 'Pause autoplay',
    play: 'Start autoplay', empty: 'No slides', slide: 'slide',
    reducedMotion: 'Autoplay disabled by reduced motion preference',
    goTo: (position: number) => `Go to slide ${position}`,
    position: (position: number, total: number) => `Slide ${position} of ${total}`,
    ...labels,
  });
  const current = $derived(Math.max(0, Math.min(items.length - 1, Number.isFinite(index) ? Math.trunc(index) : 0)));
  const delay = $derived(Number.isFinite(interval) ? Math.min(2147483647, Math.max(1000, interval)) : 5000);
  const atEnd = $derived(!loop && current === items.length - 1);
  const running = $derived(mounted && autoplay && items.length > 1 && !paused && !hovered && !focused && !hidden && !gesture && !reducedMotion && !atEnd);
  const indicatorPositions = $derived.by(() => {
    const count = Math.min(5, items.length);
    const start = Math.max(0, Math.min(current - Math.floor(count / 2), items.length - count));
    return Array.from({ length: count }, (_, offset) => start + offset);
  });

  $effect(() => { if (index !== current) index = current; });

  $effect(() => {
    // DOM removal/inert changes do not emit focusout consistently in browsers.
    // Effects run after rendering, so reconcile after slides/controls change.
    void items.length;
    void autoplay;
    void current;
    if (mounted && root) focused = root.contains(document.activeElement);
  });

  onMount(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncMotion = () => { reducedMotion = media.matches; };
    const syncVisibility = () => { hidden = document.hidden; };
    syncMotion();
    syncVisibility();
    mounted = true;
    media.addEventListener('change', syncMotion);
    document.addEventListener('visibilitychange', syncVisibility);
    return () => {
      media.removeEventListener('change', syncMotion);
      document.removeEventListener('visibilitychange', syncVisibility);
    };
  });

  function goTo(target: number, manual = true) {
    if (items.length < 2) return;
    const next = loop
      ? (target % items.length + items.length) % items.length
      : Math.max(0, Math.min(items.length - 1, target));
    restart += 1;
    if (next === current) return;
    index = next;
    announcement = manual ? copy.position(next + 1, items.length) : '';
    onchange?.(next);
  }

  $effect(() => {
    // Reading both values restarts the full delay after external/manual changes.
    const selected = current;
    void restart;
    const duration = delay;
    if (!running) return;
    const timer = window.setTimeout(() => goTo(selected + 1, false), duration);
    return () => window.clearTimeout(timer);
  });

  function handleKeydown(event: KeyboardEvent) {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    const targets: Record<string, number> = { ArrowLeft: current - 1, ArrowRight: current + 1, Home: 0, End: items.length - 1 };
    const target = targets[event.key];
    if (target === undefined || items.length < 2) return;
    event.preventDefault();
    goTo(target);
  }

  function togglePlayback() {
    if (atEnd && !paused) {
      goTo(0);
    } else {
      paused = !paused;
      if (!paused && atEnd) goTo(0);
    }
  }

  function startSwipe(event: PointerEvent) {
    if (event.pointerType !== 'touch' || !event.isPrimary || items.length < 2) return;
    const target = event.target;
    if (target instanceof Element && (target.closest('button, a, input, textarea, select, label, summary, [role="button"]') || (target instanceof HTMLElement && target.isContentEditable))) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY };
    // Touch already has implicit capture on its original target. Retargeting
    // it to the viewport would steal native label/summary click activation.
  }

  function finishSwipe(event: PointerEvent) {
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    gesture = null;
    if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy) * 1.5) goTo(current + (dx < 0 ? 1 : -1));
  }
</script>

<section
  bind:this={root}
  aria-label={ariaLabel}
  aria-roledescription="carousel"
  class={cn('carousel relative flex min-w-0 flex-col', compact && 'carousel-compact h-full min-h-0', className)}
  onpointerenter={(event) => { if (event.pointerType === 'mouse' || event.pointerType === 'pen') hovered = true; }}
  onpointerleave={() => hovered = false}
  onfocusin={() => focused = true}
  onfocusout={(event) => focused = event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)}
>
  {#if items.length > 1 && autoplay}
    <button
      type="button" class="carousel-control carousel-playback absolute bottom-0 right-[28px] z-10 h-[24px] w-[24px]"
      class:playback-paused={paused || atEnd}
      aria-label={reducedMotion ? copy.reducedMotion : paused || atEnd ? copy.play : copy.pause}
      title={reducedMotion ? copy.reducedMotion : paused || atEnd ? copy.play : copy.pause}
      disabled={reducedMotion} onclick={togglePlayback}
    >
      {#if paused || atEnd || reducedMotion}<Play class="pointer-events-none h-3 w-3" aria-hidden="true" />{:else}<Pause class="pointer-events-none h-3 w-3" aria-hidden="true" />{/if}
    </button>
  {/if}
  <!-- The viewport is a composite keyboard target, not a button: slide content
       may contain inputs/links. Only keys on the viewport itself are handled. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    id={`${id}-viewport`}
    role="group"
    aria-label={ariaLabel}
    tabindex={items.length > 1 ? 0 : undefined}
    onkeydown={handleKeydown}
    onpointerdown={startSwipe} onpointerup={finishSwipe} onpointercancel={() => gesture = null}
    onlostpointercapture={() => gesture = null}
    style:touch-action={items.length > 1 ? 'pan-y pinch-zoom' : undefined}
    class={cn('grid min-w-0 overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nexus-500', compact ? 'min-h-0 flex-1 grid-rows-[minmax(0,1fr)]' : 'bg-carbon-950')}
  >
    {#each items as item, position}
      <!-- Long compact slides are native keyboard-scrollable regions. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        role="group"
        aria-roledescription={copy.slide}
        aria-label={copy.position(position + 1, items.length)}
        aria-hidden={position !== current}
        inert={position !== current}
        data-carousel-slide={position}
        style:touch-action={compact && items.length > 1 ? 'pan-y pinch-zoom' : undefined}
        tabindex={compact && position === current ? 0 : undefined}
        class={cn('col-start-1 row-start-1 min-w-0 duration-[180ms] ease-out motion-reduce:transition-none',
          compact ? 'min-h-0 overflow-y-auto focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-nexus-500' : 'px-10 py-6',
          transitionEffect === 'slide' ? 'transition-transform' : 'transition-opacity')}
        style:transform={transitionEffect === 'slide' ? `translateX(${(position - current) * 100}%)` : undefined}
        class:invisible={transitionEffect === 'fade' && position !== current}
        class:opacity-0={transitionEffect === 'fade' && position !== current}
      >
        {@render children(item, position)}
      </div>
    {:else}
      <div class="p-6 text-sm text-zinc-400">
        {#if empty}{@render empty()}{:else}{copy.empty}{/if}
      </div>
    {/each}
  </div>

  {#if items.length > 1}
    <div class="flex h-[24px] shrink-0 items-center justify-center px-14" data-carousel-indicators>
      {#each indicatorPositions as position (position)}
        <button
          type="button" class="carousel-indicator flex h-[24px] w-[24px] shrink-0 cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-nexus-500"
          aria-label={copy.goTo(position + 1, items.length)} aria-current={position === current ? 'true' : undefined}
          aria-controls={`${id}-viewport`} onclick={() => goTo(position)}
        >
          <span class={cn('pointer-events-none h-[3px] transition-[width,background-color] duration-[180ms] ease-out motion-reduce:transition-none', position === current ? 'w-4 bg-zinc-300' : 'w-2 bg-zinc-500')} aria-hidden="true"></span>
        </button>
      {/each}
    </div>
    <button type="button" class="carousel-control carousel-previous absolute z-10" aria-label={copy.previous} aria-controls={`${id}-viewport`} disabled={!loop && current === 0} onclick={() => goTo(current - 1)}>
      <ChevronLeft class="pointer-events-none h-4 w-4" aria-hidden="true" />
    </button>
    <button type="button" class="carousel-control carousel-next absolute z-10" aria-label={copy.next} aria-controls={`${id}-viewport`} disabled={atEnd} onclick={() => goTo(current + 1)}>
      <ChevronRight class="pointer-events-none h-4 w-4" aria-hidden="true" />
    </button>
  {/if}
  <span class="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
</section>


<style>
  .carousel-control {
    @apply flex cursor-pointer items-center justify-center border-0 bg-transparent text-zinc-400 transition-opacity duration-[180ms] ease-out;
    opacity: 0;
    pointer-events: none;
  }
  .carousel-control:hover { @apply text-zinc-100; }
  .carousel-control:focus-visible { @apply outline-none ring-1 ring-nexus-500; }
  .carousel:hover .carousel-control,
  .carousel:focus-within .carousel-control,
  .carousel-control.playback-paused {
    opacity: 1;
    pointer-events: auto;
  }
  .carousel-control:disabled { opacity: 0; pointer-events: none; }
  .carousel-previous, .carousel-next {
    @apply h-[32px] w-[32px] bg-carbon-950/90;
    top: calc(50% - 12px);
    transform: translateY(-50%);
  }
  .carousel-previous { left: 0; }
  .carousel-next { right: 0; }
  .carousel-compact .carousel-previous, .carousel-compact .carousel-next {
    @apply h-[24px] w-[24px] bg-transparent;
    top: auto;
    bottom: 0;
    transform: none;
  }
  .carousel-indicator:hover span { @apply bg-zinc-200; }
  @media (hover: none) {
    .carousel-playback:not(:disabled) { opacity: 0.7; pointer-events: auto; }
    .carousel-previous, .carousel-next { visibility: hidden; }
    .carousel:focus-within .carousel-previous, .carousel:focus-within .carousel-next { visibility: visible; }
  }
  @media (prefers-reduced-motion: reduce) {
    .carousel-control { transition: none; }
  }
</style>
