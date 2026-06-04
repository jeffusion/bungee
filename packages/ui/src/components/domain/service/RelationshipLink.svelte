<!--
  RelationshipLink — Clickable mono-link that deep-jumps to a related
  route or service editor. Has a special "broken" state used when a
  route references a service that no longer exists.

  API preserved:
    type: 'route' | 'service'
    name: string
    isBroken: boolean
    className: extra classes
-->
<script lang="ts">
  import { push } from 'svelte-spa-router';
  import { _ } from '$i18n';

  export let type: 'route' | 'service';
  export let name: string;
  export let isBroken = false;
  export let className = '';

  function handleClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (isBroken) return;
    if (type === 'route') {
      push(`/routes/edit/${encodeURIComponent(name)}`);
    } else {
      push(`/services/edit/${encodeURIComponent(name)}`);
    }
  }

  function getTitle(): string {
    if (isBroken) {
      return type === 'service'
        ? $_('relationshipLink.brokenService', { values: { name } })
        : $_('relationshipLink.brokenRoute', { values: { name } });
    }
    return type === 'route'
      ? $_('relationshipLink.editRoute', { values: { name } })
      : $_('relationshipLink.editService', { values: { name } });
  }
</script>

{#if isBroken}
  <!-- Broken: red mono text with warning icon, dotted underline. -->
  <span
    class="inline-flex items-center gap-1 font-mono text-[12px] text-red-300 {className}"
    title={getTitle()}
    data-testid="relationship-link-broken"
  >
    <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
    <span class="underline decoration-dotted">{name}</span>
  </span>
{:else}
  <!-- Active: orange mono-link with the small caret + sector glyph. -->
  <button
    type="button"
    class="inline-flex items-center gap-1 font-mono text-[12px] text-nexus-300 hover:text-nexus-200 hover:underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nexus-500 {className}"
    title={getTitle()}
    on:click={handleClick}
    data-testid="relationship-link"
  >
    {#if type === 'route'}
      <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.4">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    {:else}
      <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
      </svg>
    {/if}
    <span class="truncate max-w-[200px]">{name}</span>
  </button>
{/if}
