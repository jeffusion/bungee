<script lang="ts">
  /**
   * Industrial async-activity indicator.
   *
   * One hardware-equalizer loading language scaled for different
   * surfaces, plus tiny dots for button busy states:
   *
   *   xs  — 3×2 px breathing dots for button-inline busy state
   *   sm  — compact 4-bar equalizer for inline status
   *   md  — panel-scale 8-bar equalizer for waiting on data
   *   lg  — page-scale 12-bar equalizer for first load
   *
   * Props:
   *   label     — uppercased status text (omit for pure decoration)
   *   size      — one of xs / sm / md / lg
   *   centered  — true ⇒ vertical, motif above label; false ⇒ horizontal, motif then label
   *   height    — reserved vertical space when centered (none / sm / md / lg)
   *   class     — extra classes on the outermost wrapper
   */
  export let label: string = 'LOADING';

  export let size: 'xs' | 'sm' | 'md' | 'lg' = 'md';

  export let centered: boolean = true;

  export let height: 'none' | 'sm' | 'md' | 'lg' = 'md';

  let extraClass = '';
  export { extraClass as class };

  const sizeClass = {
    xs: 'nx-load-xs',
    sm: 'nx-load-sm',
    md: 'nx-load-md',
    lg: 'nx-load-lg',
  } as const;

  const heightClass = {
    none: '',
    sm: 'h-32',
    md: 'h-40',
    lg: 'h-56',
  } as const;

  $: ariaText = label || 'LOADING';
  $: containerClass = centered
    ? `flex justify-center items-center ${heightClass[height]} ${extraClass}`
    : `inline-flex items-center gap-2 ${extraClass}`;
  $: contentClass = centered ? 'flex flex-col items-center gap-2.5' : 'inline-flex items-center gap-2';
</script>

{#if centered}
  <div class={containerClass} role="status" aria-label={ariaText}>
    <div class={contentClass}>
      <span class="nx-load {sizeClass[size]}" aria-hidden="true"></span>
      {#if label}
        <span class="nx-load-label">{label}</span>
      {/if}
    </div>
  </div>
{:else}
  <span class={containerClass} role="status" aria-label={ariaText}>
    <span class={contentClass}>
      <span class="nx-load {sizeClass[size]}" aria-hidden="true"></span>
      {#if label}
        <span class="nx-load-label">{label}</span>
      {/if}
    </span>
  </span>
{/if}

<style>
  .nx-load-label {
    font-family: 'DM Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
    font-size: 10px;
    letter-spacing: 0.16em;
    line-height: 1;
    color: rgb(113 113 122); /* zinc-500 */
    text-transform: uppercase;
  }
</style>
