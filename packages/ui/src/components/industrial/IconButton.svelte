<!--
  IconButton — Square hardware-key button for icon-only actions (header
  controls, toolbars). Keeps the bordered industrial look at a smaller
  footprint than the regular nx-btn.
-->
<script lang="ts">
  export let variant: 'ghost' | 'primary' | 'danger' = 'ghost';
  export let size: 'sm' | 'md' = 'md';
  export let title: string = '';
  export let href: string | null = null;
  export let type: 'button' | 'submit' = 'button';
  export let disabled: boolean = false;

  let extraClass = '';
  export { extraClass as class };

  const variantCls = {
    ghost:
      'border-carbon-500 bg-transparent text-zinc-300 hover:border-nexus-500 hover:text-nexus-300',
    primary:
      'border-nexus-400 bg-nexus-500 text-black hover:bg-nexus-400',
    danger:
      'border-red-500 bg-red-500/10 text-red-300 hover:bg-red-500/20',
  } as const;

  const sizeCls = {
    sm: 'h-7 w-7',
    md: 'h-9 w-9',
  } as const;

  $: cls = `inline-flex items-center justify-center border-2 transition-colors ${variantCls[variant]} ${sizeCls[size]} ${extraClass}`;
</script>

{#if href}
  <a {href} class={cls} aria-label={title} title={title}>
    <slot />
  </a>
{:else}
  <button {type} {disabled} class={cls} aria-label={title} title={title} on:click>
    <slot />
  </button>
{/if}
