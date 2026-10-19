<script lang="ts">
  import type { Snippet } from 'svelte';
  let {title, description, status, actions, children}: {
    title: string; description?: string; status?: Snippet; actions?: Snippet; children?: Snippet;
  } = $props();
  const id = $props.id();
</script>

<section class="border-t border-carbon-600 py-5" aria-labelledby={id}>
  <header class="nx-panel-head settings-section-header">
    <div class="min-w-0 flex-1 space-y-2">
      <div class="flex flex-wrap items-center gap-3">
        <span class="nx-stripe shrink-0" aria-hidden="true"></span>
        <h2 {id} class="text-lg font-semibold text-zinc-100">{title}</h2>
        {#if status}{@render status()}{/if}
      </div>
      {#if description}<p class="max-w-3xl text-sm text-zinc-400">{description}</p>{/if}
    </div>
    {#if actions}<div class="shrink-0">{@render actions()}</div>{/if}
  </header>
  {#if children}<div class="mt-4">{@render children()}</div>{/if}
</section>

<style>
  .settings-section-header {
    padding: 0;
    border: 0;
    background: transparent;
    gap: 1rem;
    flex-wrap: wrap;
  }
</style>
