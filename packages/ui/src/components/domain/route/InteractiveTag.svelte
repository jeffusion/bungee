<script lang="ts">
  export let href: string | undefined = undefined;
  export let title: string | undefined = undefined;
  export let className = '';

  const baseClass = 'inline-flex cursor-pointer items-center border border-carbon-500 bg-carbon-900 px-2 py-0.5 font-mono text-[10px] uppercase tracking-command text-zinc-300 no-underline transition-colors duration-150 hover:border-nexus-500 hover:bg-nexus-500/10 hover:text-nexus-300 focus-visible:border-nexus-500 focus-visible:bg-nexus-500/10 focus-visible:text-nexus-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nexus-500';
</script>

{#if href}
  <a {href} {title} class={`${baseClass} ${className}`} on:click {...$$restProps}>
    <slot />
  </a>
{:else}
  <span 
    {title} 
    class={`${baseClass} ${className}`} 
    on:click 
    {...$$restProps} 
    role="button" 
    tabindex="0"
    on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && e.currentTarget.click()}
  >
    <slot />
  </span>
{/if}
