<script lang="ts">
  import type { EffectiveMenu, EffectivePage } from './menu-model';
  import MenuIcon from './MenuIcon.svelte';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  let { items }: { items: EffectiveMenu[] } = $props();
  const rowClass = 'flex min-h-[44px] w-full items-center gap-3 border-l-2 px-3 py-2 text-left font-mono text-sm';
  const interactiveClass = 'hover:bg-carbon-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nexus-500';
</script>
{#snippet pageContents(page: EffectivePage)}
  <MenuIcon icon={page.icon} /><span class="min-w-0 break-words [overflow-wrap:anywhere]">{page.label}</span>
{/snippet}
{#snippet pageRow(page: EffectivePage)}
  {@const colour = page.active ? 'border-nexus-500 bg-nexus-500/10 text-nexus-300' : 'border-transparent text-zinc-300'}
  <div class={`${rowClass} ${colour}`} aria-current={page.active ? 'page' : undefined}>{@render pageContents(page)}</div>
{/snippet}
<ul class="space-y-1" data-testid="menu-preview-tree">
  {#each items as item (item.id)}
    <li>
      {#if item.kind === 'page'}
        {@render pageRow(item)}
      {:else}
        <details open={item.active} class="group">
          <summary class={`${rowClass} ${interactiveClass} cursor-pointer list-none ${item.active ? 'border-nexus-500 text-nexus-300' : 'border-transparent text-zinc-300'}`}>
            <MenuIcon icon={item.icon} /><span class="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{item.label}</span><ChevronDown class="h-3 w-3 shrink-0 group-open:rotate-180" aria-hidden="true" />
          </summary>
          <ul class="ml-5 border-l border-carbon-600">
            {#each item.children as page (page.id)}<li>{@render pageRow(page)}</li>{/each}
          </ul>
        </details>
      {/if}
    </li>
  {/each}
</ul>
