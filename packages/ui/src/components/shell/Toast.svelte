<!--
  Toast — Industrial floating notification. Variant tones map to the same
  canonical mapping as the rest of the system (success=emerald, warning=
  amber, error=red, info=nexus-orange). Each toast lives inside a
  ToastContainer at the top-right of the viewport.

  Positioning is delegated to ToastContainer so multiple toasts stack
  cleanly.

  Props preserved exactly so call-sites needn't change.
-->
<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';

  export let message: string;
  export let type: 'success' | 'error' | 'warning' | 'info' = 'info';
  export let duration: number = 3000;
  export let visible = true;

  const dispatch = createEventDispatcher();
  let timer: any;

  onMount(() => {
    if (duration > 0) {
      timer = setTimeout(() => {
        visible = false;
        dispatch('close');
      }, duration);
    }
  });

  onDestroy(() => {
    if (timer) clearTimeout(timer);
  });

  function close() {
    visible = false;
    dispatch('close');
    if (timer) clearTimeout(timer);
  }

  const toneClass: Record<typeof type, { border: string; text: string; dot: string }> = {
    success: { border: 'border-l-emerald-500', text: 'text-emerald-300', dot: 'nx-dot-ok' },
    warning: { border: 'border-l-amber-500',   text: 'text-amber-300',   dot: 'nx-dot-warn' },
    error:   { border: 'border-l-red-500',     text: 'text-red-300',     dot: 'nx-dot-danger' },
    info:    { border: 'border-l-nexus-500',   text: 'text-nexus-300',   dot: 'nx-dot-accent' },
  };

  $: tone = toneClass[type];
</script>

{#if visible}
  <div
    class="nx-panel-raised flex items-center gap-3 pl-3 pr-2 py-2.5 border-l-2 {tone.border} min-w-[260px] max-w-md pointer-events-auto"
    role="status"
    aria-live="polite"
  >
    <span class={tone.dot} aria-hidden="true"></span>
    <span class="flex-1 font-mono text-[11px] uppercase tracking-command {tone.text} truncate">
      {message}
    </span>
    <button
      type="button"
      class="inline-flex items-center justify-center h-6 w-6 border border-carbon-500 bg-transparent text-zinc-400 transition-colors hover:border-nexus-500 hover:text-nexus-300"
      on:click={close}
      aria-label="Close"
    >
      <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </div>
{/if}
