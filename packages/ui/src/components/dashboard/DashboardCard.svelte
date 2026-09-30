<script lang="ts">
  import type { Snippet } from 'svelte';
  import { _ } from '$i18n';
  import CornerBrackets from '$components/industrial/CornerBrackets.svelte';
  import { Button } from '$components/ui/button';
  import * as Dropdown from '$components/ui/dropdown-menu';
  import GripVertical from 'lucide-svelte/icons/grip-vertical';
  import Expand from 'lucide-svelte/icons/expand';
  import X from 'lucide-svelte/icons/x';
  import Check from 'lucide-svelte/icons/check';
  import KpiCard from '$components/industrial/KpiCard.svelte';
  import type { CardDefinition, LayoutCard, KpiMetric } from './layout';
  let { definition, card, editing = false, children, extra, metric, onremove, onsize, onmove }:
    { definition: CardDefinition; card: LayoutCard; editing?: boolean; children: Snippet; extra?: Snippet; metric?: KpiMetric;
      onremove: () => void; onsize: (w: number, h: number) => void; onmove: (event: KeyboardEvent, resize?: boolean) => void } = $props();
  const presets = $derived(definition.group === 'kpi' ? [['compact', 3, 2], ['wide', 4, 2], ['half', 8, 2], ['tall', 3, 3]] :
    definition.group === 'plugin' ? [['standard', 8, 2], ['tall', 8, 3], ['full', 15, 2]] :
      [['small', 5, 3], ['standard', 8, 4], ['tall', 8, 5], ['full', 15, 4]]);
</script>

{#snippet grip()}
    {#if editing}
      <button type="button" class="dashboard-grip -ml-1 flex h-[30px] w-[26px] shrink-0 items-center justify-center text-zinc-500 hover:text-nexus-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nexus-500"
        aria-label={$_('dashboardLayout.moveCard', { values: { title: $_(definition.title) } })}
        title={$_('dashboardLayout.keyboardHint')} onkeydown={onmove}><GripVertical class="h-[18px] w-3" /></button>
    {/if}
{/snippet}
{#snippet tools()}
    {#if editing}
      <div class="flex shrink-0 items-center gap-0.5" onpointerdown={(event) => event.stopPropagation()} role="group" aria-label={$_('dashboardLayout.cardTools')}>
        <span class="dashboard-size mr-1 border border-carbon-500 bg-carbon-950 px-1.5 font-mono text-[10px] leading-[18px] text-zinc-400">{card.w} × {card.h}</span>
        <Dropdown.Root>
          <Dropdown.Trigger class="dashboard-tool" aria-label={$_('dashboardLayout.resizeCard', { values: { title: $_(definition.title) } })} title={$_('dashboardLayout.size')}><Expand class="h-4 w-4" /></Dropdown.Trigger>
          <Dropdown.Content class="min-w-[200px] border-carbon-500 bg-carbon-900 text-zinc-300">
            <Dropdown.Label class="font-mono text-[10px] tracking-industrial text-zinc-500">{$_('dashboardLayout.size')}</Dropdown.Label>
            {#each presets as [label, w, h]}
              <Dropdown.Item on:click={() => onsize(Number(w), Number(h))} class="flex justify-between gap-4">
                <span>{$_(`dashboardLayout.sizes.${label}`)}</span><span class="flex items-center gap-2 font-mono text-[10px] text-zinc-500">{w} × {h}{#if card.w === w && card.h === h}<Check class="h-3 w-3 text-nexus-500" />{/if}</span>
              </Dropdown.Item>
            {/each}
          </Dropdown.Content>
        </Dropdown.Root>
        <Button variant="link" size="icon" class="dashboard-tool !h-[30px] !w-[30px] !p-0 !text-zinc-400 hover:!text-red-300" aria-label={$_('dashboardLayout.removeCard', { values: { title: $_(definition.title) } })}
          onclick={onremove}><X class="h-4 w-4" /></Button>
      </div>
    {:else}
      <div class="flex min-w-0 shrink-0 items-center gap-2">
        {#if definition.enabled === false}<span class="nx-panel-head-tag">{$_('dashboardLayout.disabled')}</span>
        {:else if extra}{@render extra()}
        {:else}<span class="nx-panel-head-tag">{definition.tag}</span>{/if}
      </div>
    {/if}
{/snippet}
{#if definition.group === 'kpi' && metric}
  <KpiCard {...metric} label={$_(definition.title)} stripe={metric.stripe ?? definition.stripe ?? 'orange'}
    class="dashboard-kpi-card h-full min-w-0 flex flex-col" leading={grip} icon-head={tools}
    headerClass={editing ? 'dashboard-card-head editable' : 'dashboard-card-head'} bodyInert={editing}
    icon={children} data-testid={definition.id === 'kpi.requests' ? 'dashboard-kpi-total-requests' : undefined} />
{:else}
<article class="dashboard-card nx-panel-raised nx-bracketed h-full min-w-0 flex flex-col" class:is-off={definition.enabled === false}>
  <CornerBrackets />
  <header class="dashboard-card-head nx-panel-head shrink-0 gap-2" class:editable={editing}>
    {@render grip()}
    <div class="nx-panel-head-title min-w-0 flex-1">
      <span class="nx-stripe shrink-0" class:nx-stripe-red={definition.stripe === 'red'} class:nx-stripe-emerald={definition.stripe === 'emerald'}
        class:nx-stripe-amber={definition.stripe === 'amber'} class:nx-stripe-zinc={definition.enabled === false} aria-hidden="true"></span>
      <span class="truncate" title={$_(definition.title)}>{$_(definition.title)}</span>
    </div>
    {@render tools()}
  </header>
  <div class="dashboard-card-body relative min-h-0 flex-1 overflow-hidden nx-panel-body" inert={editing}>
    {@render children()}
    {#if editing}<div class="pointer-events-none absolute inset-0 bg-carbon-950/20" aria-hidden="true"></div>{/if}
  </div>
</article>

{/if}
<style>
  .dashboard-card-body { container-type: size; }
  :global(.dashboard-kpi-card) { container-type: inline-size; }
  :global(.dashboard-kpi-card .nx-panel-head.editable) { cursor: grab; background: var(--nx-panel); }
  .dashboard-card-head.editable { cursor: grab; background: var(--nx-panel);  }
  .dashboard-card-head.editable:active { cursor: grabbing; }
  @container (max-width: 260px) { .dashboard-size { display: none; } }
  @container (max-width: 190px) {
    :global(.dashboard-kpi-card .nx-panel-head.editable) { padding-inline: 8px; gap: 4px; }
    .dashboard-grip { width: 18px; }
  }
  .dashboard-grip { cursor: grab; touch-action: none; }
  .is-off { border-style: dashed; box-shadow: none; background: repeating-linear-gradient(-45deg, var(--nx-panel) 0 10px, var(--nx-panel-2) 10px 20px); }
  :global(.dashboard-tool) { display: inline-grid; place-items: center; width: 30px; height: 30px; border: 1px solid transparent; color: var(--nx-text-dim); cursor: pointer; }
  :global(.dashboard-tool:hover), :global(.dashboard-tool:focus-visible) { border-color: var(--nx-edge-strong); background: var(--nx-panel); color: var(--nx-accent); outline: 2px solid transparent; }
</style>
