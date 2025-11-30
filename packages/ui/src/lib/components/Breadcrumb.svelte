<script lang="ts">
  import { push } from 'svelte-spa-router';

  export interface BreadcrumbItem {
    label: string;
    href?: string;
  }

  export let items: BreadcrumbItem[] = [];
</script>

<div class="breadcrumbs text-sm">
  <ul>
    {#each items as item, index}
      <li>
        {#if item.href && index < items.length - 1}
          <button
            type="button"
            class="link link-hover"
            on:click={() => push(item.href || '')}
          >
            {item.label}
          </button>
        {:else}
          <span class="text-base-content/70">{item.label}</span>
        {/if}
      </li>
    {/each}
  </ul>
</div>
