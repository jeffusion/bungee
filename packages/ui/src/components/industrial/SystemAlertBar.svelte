<!--
  SystemAlertBar — Full-width attention strip at the bottom of a page.
  Reference layout: icon + title + subtitle on the left, action button on
  the right. Tone shifts colour of the leading icon and outline.

  Slots:
    icon   → leading icon (default: triangle/wrench depending on tone)
    action → right-side action element (e.g. button / link)
    default → optional body content inserted between title and action
-->
<script lang="ts">
  /** Headline of the alert (uppercased visually). */
  export let title: string = '';

  /** Subtitle / supporting text rendered under the title. */
  export let subtitle: string = '';

  /** Tone affects the icon and accent line colour. */
  export let tone: 'info' | 'warn' | 'danger' | 'success' = 'info';

  let extraClass = '';
  export { extraClass as class };

  const toneRingClass = {
    info: 'border-l-2 border-l-nexus-500',
    warn: 'border-l-2 border-l-amber-500',
    danger: 'border-l-2 border-l-red-500',
    success: 'border-l-2 border-l-emerald-500',
  } as const;

  const iconClass = {
    info: 'text-nexus-400',
    warn: 'text-amber-400',
    danger: 'text-red-400',
    success: 'text-emerald-400',
  } as const;
</script>

<div class="nx-panel-raised flex items-center justify-between gap-6 px-5 py-3 {toneRingClass[tone]} {extraClass}">
  <div class="flex items-center gap-4 min-w-0">
    {#if $$slots.icon}
      <span class={iconClass[tone]}><slot name="icon" /></span>
    {:else}
      <svg viewBox="0 0 24 24" class="h-5 w-5 shrink-0 {iconClass[tone]}" fill="none" stroke="currentColor" stroke-width="1.8">
        {#if tone === 'warn' || tone === 'danger'}
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        {:else if tone === 'success'}
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        {:else}
          <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        {/if}
      </svg>
    {/if}

    <div class="min-w-0 flex flex-col">
      {#if title}
        <span class="font-mono text-[12px] font-bold uppercase tracking-command text-zinc-100 truncate">{title}</span>
      {/if}
      {#if subtitle}
        <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500 truncate">{subtitle}</span>
      {/if}
      <slot />
    </div>
  </div>

  {#if $$slots.action}
    <div class="shrink-0"><slot name="action" /></div>
  {/if}
</div>
