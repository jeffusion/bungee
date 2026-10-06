<!-- Shared editor rail. Pages supply section data and selection; this component owns all navigation DOM and scoped styles. -->
<script lang="ts" generics="Section extends string">
  import type { Snippet } from 'svelte';
  import PanelCard from '$components/industrial/PanelCard.svelte';
  import { getModifierKey } from '$utils/platform';

  let {
    items, activeSection, onselect, title, tag = '', testId, itemTestIdPrefix,
    shortcuts, betweenPanels,
  }: {
    items: Array<{ id: Section; label: string; icon: string; badge: string }>;
    activeSection: Section;
    onselect: (section: Section) => void;
    title: string;
    tag?: string;
    testId: string;
    itemTestIdPrefix: string;
    shortcuts: { title: string; tag: string; save: string; switchSection: string; cancel: string };
    betweenPanels?: Snippet;
  } = $props();
</script>

<aside class="w-full lg:w-56 flex-shrink-0" data-testid={testId}>
  <div class="lg:sticky lg:top-32 space-y-3">
    <PanelCard {title} {tag} flush>
      <nav aria-label={title}>
        <ul class="divide-y divide-carbon-600">
          {#each items as item (item.id)}
            <li>
              <button
                type="button"
                class="nav-button focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nexus-500"
                class:is-active={activeSection === item.id}
                aria-current={activeSection === item.id ? 'page' : undefined}
                onclick={() => onselect(item.id)}
                data-testid={`${itemTestIdPrefix}-${item.id}`}
              >
                <span class="marker mr-1.5" class:is-active={activeSection === item.id} aria-hidden="true"></span>
                <svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path stroke-linecap="round" stroke-linejoin="round" d={item.icon} />
                </svg>
                <span class="flex-1 min-w-0 text-left truncate">{item.label}</span>
                {#if item.badge}
                  <span class="nav-badge" class:is-tick={item.badge === '✓'}>{item.badge}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      </nav>
    </PanelCard>

    {#if betweenPanels}{@render betweenPanels()}{/if}

    <PanelCard title={shortcuts.title} tag={shortcuts.tag}>
      <ul class="space-y-1.5 font-mono text-[11px]">
        <li class="flex items-center gap-1.5">
          <kbd>{getModifierKey()}</kbd><span class="text-zinc-600">+</span><kbd>S</kbd>
          <span class="text-zinc-400 ml-2">{shortcuts.save}</span>
        </li>
        <li class="flex items-center gap-1.5">
          <kbd>{getModifierKey()}</kbd><span class="text-zinc-600">+</span><kbd>1-{items.length}</kbd>
          <span class="text-zinc-400 ml-2">{shortcuts.switchSection}</span>
        </li>
        <li class="flex items-center gap-1.5">
          <kbd>Esc</kbd>
          <span class="text-zinc-400 ml-2">{shortcuts.cancel}</span>
        </li>
      </ul>
    </PanelCard>
  </div>
</aside>

<style>
  .nav-button {
    display: inline-flex;
    width: 100%;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 0.875rem;
    @apply font-mono;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    @apply text-zinc-400;
    background: transparent;
    transition: color 0.12s ease-out, background-color 0.12s ease-out;
  }
  .nav-button:hover {
    @apply text-nexus-300 bg-nexus-500/[0.04];
  }
  .nav-button.is-active {
    @apply text-nexus-400 bg-nexus-500/[0.08];
  }
  .marker {
    width: 5px;
    height: 8px;
    flex-shrink: 0;
  }
  .marker.is-active {
    width: 0;
    height: 0;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    border-left: 5px solid var(--nx-accent);
  }
  .nav-badge {
    @apply ml-auto inline-flex items-center px-1.5 py-0.5;
    @apply font-mono text-[10px] uppercase tracking-command;
    @apply border border-carbon-500 bg-carbon-950 text-zinc-300;
    @apply truncate max-w-[10ch];
  }
  .nav-badge.is-tick {
    @apply text-emerald-300 border-emerald-500/40 bg-emerald-500/10;
    @apply justify-center min-w-[20px] px-0;
  }
  kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    padding: 0 4px;
    height: 18px;
    @apply border border-carbon-600 bg-carbon-900 text-zinc-300 font-mono;
    font-size: 10px;
    line-height: 1;
  }
</style>
