<!--
  BCarousel<T> — content carousel; no parent context required.
  Required: items: readonly T[], children: Snippet<[T, number]>.
  index = 0 (bindable); autoplay = true; interval = 5000ms; loop = true.
  effect = 'fade' | 'slide'; compact = false (fixed-height parent, scrollable
  slides, compact footer without numbered keys).
  onchange(index) reports navigation, not external index writes or clamping.
  ariaLabel = 'Carousel'; labels overrides accessible English copy; empty is
  an optional empty-state snippet. class styles the inset (wrap in PanelCard).
  Hover/focus/hidden document pause temporarily. Pause choice persists.
  Reduced motion disables playback/transitions. Inactive content stays mounted
  but inert. Keyboard navigation belongs only to the focusable viewport.
-->
<script lang="ts" generics="T">
  import { onMount, type Snippet } from 'svelte';
  import { Button } from '$components/ui/button';
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
      goTo: (position: number) => string;
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
  const running = $derived(mounted && autoplay && items.length > 1 && !paused && !hovered && !focused && !hidden && !reducedMotion && !atEnd);

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
</script>

<section
  bind:this={root}
  aria-label={ariaLabel}
  aria-roledescription="carousel"
  class={cn('min-w-0 bg-carbon-900', compact && 'flex h-full min-h-0 flex-col', className)}
  onpointerenter={(event) => { if (event.pointerType === 'mouse' || event.pointerType === 'pen') hovered = true; }}
  onpointerleave={() => hovered = false}
  onfocusin={() => focused = true}
  onfocusout={(event) => focused = event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)}
>
  <!-- The viewport is a composite keyboard target, not a button: slide content
       may contain inputs/links. Only keys on the viewport itself are handled. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    id={`${id}-viewport`}
    role="group"
    aria-label={ariaLabel}
    tabindex={items.length > 1 ? 0 : undefined}
    onkeydown={handleKeydown}
    class={cn('grid min-w-0 overflow-hidden border border-carbon-600 bg-carbon-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nexus-500', compact && 'min-h-0 flex-1 grid-rows-[minmax(0,1fr)]')}
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
        tabindex={compact && position === current ? 0 : undefined}
        class={cn('col-start-1 row-start-1 min-w-0 duration-[180ms] ease-out motion-reduce:transition-none',
          compact ? 'min-h-0 overflow-y-auto overscroll-contain p-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-nexus-500' : 'p-6',
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
    <div class={cn('flex shrink-0 flex-wrap items-center border-x border-b border-carbon-600', compact ? 'gap-1.5 p-1.5' : 'gap-3 p-3')}>
      {#if autoplay}
        <Button
          variant="ghost" size="icon" class={cn('shrink-0 font-mono duration-[180ms] ease-out', compact ? 'h-[28px] w-[28px]' : 'h-11 w-11')}
          aria-label={reducedMotion ? copy.reducedMotion : paused || atEnd ? copy.play : copy.pause}
          title={reducedMotion ? copy.reducedMotion : paused || atEnd ? copy.play : copy.pause}
          disabled={reducedMotion} onclick={togglePlayback}
        >
          {#if paused || atEnd || reducedMotion}<Play class="pointer-events-none h-4 w-4" aria-hidden="true" />{:else}<Pause class="pointer-events-none h-4 w-4" aria-hidden="true" />{/if}
        </Button>
      {/if}
      {#if !compact}
      <div class="order-last flex w-full min-w-0 flex-wrap gap-1.5 sm:order-none sm:w-auto sm:flex-1">
        {#each items as _, position}
          <Button
            variant={position === current ? 'default' : 'ghost'} size="icon"
            class="h-11 w-11 shrink-0 font-mono duration-[180ms] ease-out"
            aria-label={copy.goTo(position + 1)} aria-current={position === current ? 'true' : undefined}
            aria-controls={`${id}-viewport`} onclick={() => goTo(position)}
          >{String(position + 1).padStart(2, '0')}</Button>
        {/each}
      </div>
      {/if}
      <div class="ml-auto flex items-center gap-1.5">
        <span class="nx-display px-1.5 text-sm text-zinc-50" aria-hidden="true">{String(current + 1).padStart(2, '0')} / {String(items.length).padStart(2, '0')}</span>
        <Button variant="ghost" size="icon" class={cn('font-mono duration-[180ms] ease-out', compact ? 'h-[28px] w-[28px]' : 'h-11 w-11')} aria-label={copy.previous} aria-controls={`${id}-viewport`} disabled={!loop && current === 0} onclick={() => goTo(current - 1)}>
          <ChevronLeft class="pointer-events-none h-4 w-4" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon" class={cn('font-mono duration-[180ms] ease-out', compact ? 'h-[28px] w-[28px]' : 'h-11 w-11')} aria-label={copy.next} aria-controls={`${id}-viewport`} disabled={atEnd} onclick={() => goTo(current + 1)}>
          <ChevronRight class="pointer-events-none h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  {/if}
  <span class="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
</section>
