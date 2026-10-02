<script lang="ts">
  import { autoUpdate, computePosition, flip, hide, offset, shift, type VirtualElement } from '@floating-ui/dom';
  import type { Snippet } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '$utils';

  let {
    anchor, open, id, children, onclose, interactive = true,
    class: className, onpointerenter, onpointerleave, ...restProps
  }: HTMLAttributes<HTMLDivElement> & {
    anchor: HTMLElement | VirtualElement | null;
    open: boolean;
    id: string;
    children: Snippet;
    onclose: () => void;
    interactive?: boolean;
    class?: string;
    onpointerenter?: (event: PointerEvent) => void;
    onpointerleave?: (event: PointerEvent) => void;
  } = $props();

  let content: HTMLDivElement | undefined = $state();
  let x = $state(0);
  let y = $state(0);
  let positioned = $state(false);
  let movementReady = $state(false);
  function tooltipMotion(node: Element) {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return fly(node, { y: reducedMotion ? 0 : 4, duration: reducedMotion ? 0 : 140, easing: cubicOut });
  }

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  $effect(() => {
    const reference = anchor;
    const floating = content;
    if (floating) {
      // The outgoing branch is paused by Svelte; disable its hit area immediately during fade-out.
      floating.style.pointerEvents = open && interactive ? 'auto' : 'none';
      if (open) floating.removeAttribute('aria-hidden');
      else floating.setAttribute('aria-hidden', 'true');
    }
    if (!floating) {
      positioned = false;
      movementReady = false;
    }
    if (!open || !reference || !floating) return;
    const referenceElement = reference instanceof HTMLElement ? reference : reference.contextElement;
    let active = true;
    let generation = 0;
    let frame: number | undefined;
    const update = async () => {
      const current = ++generation;
      const position = await computePosition(reference, floating, {
        strategy: 'fixed', placement: 'top',
        middleware: [offset(6), flip({ padding: 12 }), shift({ padding: 12, crossAxis: true }), hide()],
      });
      // A pending calculation for the previous anchor must not move the shared tooltip.
      if (!active || current !== generation) return;
      if (position.middlewareData.hide?.referenceHidden) {
        onclose();
        return;
      }
      x = position.x;
      y = position.y;
      positioned = true;
      if (!movementReady && frame === undefined) {
        // Paint the initial coordinates before enabling movement, so entry never slides from (0, 0).
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            frame = undefined;
            if (active) movementReady = true;
          });
        });
      }
    };
    const cleanup = autoUpdate(reference, floating, () => void update());
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !referenceElement?.contains(event.target) && !floating.contains(event.target)) onclose();
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onclose(); };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('blur', onclose);
    return () => {
      active = false;
      if (frame !== undefined) cancelAnimationFrame(frame);
      cleanup();
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('blur', onclose);
    };
  });
</script>

{#if open}
  <div bind:this={content} use:portal {...restProps} {id} role="tooltip"
    transition:tooltipMotion
    class={cn('fixed z-50 max-w-[calc(100vw-24px)] max-h-[min(320px,calc(100dvh-32px))] overflow-y-auto border border-carbon-500 bg-carbon-900 p-3 text-zinc-200 shadow-industrial', movementReady && 'motion-safe:transition-[left,top] motion-safe:duration-150 motion-safe:ease-out', className)}
    style:left={`${x}px`} style:top={`${y}px`} style:visibility={positioned ? 'visible' : 'hidden'}
    {onpointerenter} {onpointerleave} data-shared-tooltip>
    {@render children()}
  </div>
{/if}
