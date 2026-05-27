<!--
  PanelCard — Industrial panel container with the signature orange short bar.
  Slots:
    default      → main content of the panel
    tag          → optional content placed at top-right (overrides `tag` prop)
    actions      → optional row of actions placed at far right of the head bar
    foot         → optional footer block under the body
-->
<script lang="ts">
  import CornerBrackets from './CornerBrackets.svelte';

  /** Title text, rendered uppercase with command tracking. */
  export let title: string = '';

  /** Short tag rendered in the right side of the head bar (e.g. "SEC-A1"). */
  export let tag: string = '';

  /**
   * Accent color of the short stripe shown to the left of the title.
   * Defaults to the primary orange. Use other variants to signal status.
   */
  export let stripe: 'orange' | 'amber' | 'red' | 'emerald' | 'zinc' = 'orange';

  /** Hide the head bar entirely (useful for raw image/chart embeds). */
  export let headless: boolean = false;

  /** Remove default body padding (let the slotted content fill edge-to-edge). */
  export let flush: boolean = false;

  /** Make the body scrollable when content overflows (flex-1 + overflow-y-auto). */
  export let scrollable: boolean = false;

  /**
   * Visual emphasis. `raised` adds a deeper shadow (used on key dashboard
   * panels); `flat` is for nested panels inside another panel.
   */
  export let variant: 'raised' | 'flat' = 'raised';

  /**
   * Render the 4 orange L-shaped corner brackets (the "device chassis"
   * affordance). Default true — set false for nested or low-importance
   * panels where the extra ornament adds noise.
   */
  export let corners: boolean = true;

  /** Optional CSS classes appended to the outer container. */
  let extraClass = '';
  export { extraClass as class };

  const stripeClass = {
    orange: 'nx-stripe',
    amber: 'nx-stripe nx-stripe-amber',
    red: 'nx-stripe nx-stripe-red',
    emerald: 'nx-stripe nx-stripe-emerald',
    zinc: 'nx-stripe nx-stripe-zinc',
  } as const;
</script>

<article
  class="{variant === 'raised' ? 'nx-panel-raised' : 'nx-panel'} {corners ? 'nx-bracketed' : ''} {scrollable ? 'flex flex-col' : ''} {extraClass}"
>
  {#if corners}
  <CornerBrackets />
  {/if}

  {#if !headless}
  <header class="nx-panel-head shrink-0">
    <div class="nx-panel-head-title min-w-0 flex-1">
      <span class={stripeClass[stripe]} aria-hidden="true"></span>
      <span class="truncate" title={title}>{title}</span>
      <slot name="title-extra" />
    </div>
    <div class="flex items-center gap-3 shrink-0">
      <slot name="actions" />
      {#if $$slots.tag}
        <slot name="tag" />
      {:else if tag}
        <span class="nx-panel-head-tag">{tag}</span>
      {/if}
    </div>
  </header>
  {/if}

  <div class="{flush ? '' : 'nx-panel-body'} {scrollable ? 'flex-1 overflow-y-auto min-h-0' : ''}">
    <slot />
  </div>

  {#if $$slots.foot}
  <footer class="border-t border-carbon-600 px-4 py-2.5 bg-carbon-900/60 shrink-0">
    <slot name="foot" />
  </footer>
  {/if}
</article>
