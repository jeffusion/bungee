<script lang="ts">
  import type { Snippet } from 'svelte';
  import { _ } from '$i18n';
  import CornerBrackets from '$components/industrial/CornerBrackets.svelte';
  import { Button } from '$components/ui/button';
  import * as Dropdown from '$components/ui/dropdown-menu';
  import Maximize2 from 'lucide-svelte/icons/maximize-2';
  import X from 'lucide-svelte/icons/x';
  import KpiCard from '$components/industrial/KpiCard.svelte';
  import { GRID_COLUMNS, type CardDefinition, type LayoutCard, type KpiMetric } from './layout';
  let { definition, card, editing = false, children, extra, metric, onremove, onsize, onmove }:
    { definition: CardDefinition; card: LayoutCard; editing?: boolean; children: Snippet; extra?: Snippet; metric?: KpiMetric;
      onremove: () => void; onsize: (w: number, h: number) => void; onmove: (event: KeyboardEvent, resize?: boolean) => void } = $props();
  const presets = $derived((definition.group === 'kpi' || definition.presentation === 'kpi') ? [['compact', 6, 2], ['wide', GRID_COLUMNS / 3, 2], ['half', GRID_COLUMNS / 2, 2], ['tall', 6, 3]] :
    definition.group === 'plugin' ? [['standard', GRID_COLUMNS / 2, 2], ['tall', GRID_COLUMNS / 2, 3], ['full', GRID_COLUMNS, 2]] :
      [['small', GRID_COLUMNS / 3, 3], ['standard', GRID_COLUMNS / 2, 4], ['tall', GRID_COLUMNS / 2, 5], ['full', GRID_COLUMNS, 4]]);
</script>

{#snippet grip()}
    {#if editing}
      <button type="button" class="dashboard-grip -ml-[6px] flex h-[30px] w-[26px] shrink-0 items-center justify-center text-zinc-500 hover:text-nexus-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nexus-500"
        aria-label={$_('dashboardLayout.moveCard', { values: { title: $_(definition.title) } })}
        title={$_('dashboardLayout.keyboardHint')} onkeydown={onmove}>
        <svg viewBox="0 0 12 18" class="h-[18px] w-3 fill-current" aria-hidden="true">
          {#each [3, 9, 15] as cy}<circle cx="3" {cy} r="1.4" /><circle cx="9" {cy} r="1.4" />{/each}
        </svg>
      </button>
    {/if}
{/snippet}
{#snippet tools()}
    {#if editing}
      <div class="flex shrink-0 items-center gap-0.5" onpointerdown={(event) => event.stopPropagation()} role="group" aria-label={$_('dashboardLayout.cardTools')}>
        <span class="dashboard-size mr-1 whitespace-nowrap border border-carbon-500 bg-carbon-950 px-1.5 font-mono text-[10px] leading-[18px] tabular-nums text-zinc-400" aria-hidden="true">{card.w} × {card.h}</span>
        <Dropdown.Root>
          <Dropdown.Trigger class="dashboard-tool" aria-label={$_('dashboardLayout.resizeCard', { values: { title: $_(definition.title) } })} title={$_('dashboardLayout.size')}><Maximize2 class="h-4 w-4" /></Dropdown.Trigger>
          <Dropdown.Content align="end" sideOffset={6} class="min-w-[220px] border-carbon-500 bg-carbon-900 text-zinc-300">
            <Dropdown.Label class="font-mono text-[10px] font-normal tracking-industrial text-zinc-500">{$_('dashboardLayout.size')} · {card.w} × {card.h}</Dropdown.Label>
            <Dropdown.RadioGroup value={`${card.w}x${card.h}`}>
              {#each presets as [label, w, h]}
                <Dropdown.RadioItem value={`${w}x${h}`} on:click={() => onsize(Number(w), Number(h))} class="dashboard-size-option flex justify-between gap-4 !py-2 !pl-2 text-xs data-[state=checked]:text-nexus-500 [&>span:first-child]:hidden">
                  <span class="flex items-center"><span class="dashboard-size-glyph mr-2" aria-hidden="true">{#each Array(GRID_COLUMNS) as _, i}<i class:filled={i < Number(w)}></i>{/each}</span>{$_(`dashboardLayout.sizes.${label}`)}</span>
                  <span class="font-mono text-[10px] text-zinc-500">{w} × {h}</span>
                </Dropdown.RadioItem>
              {/each}
            </Dropdown.RadioGroup>
          </Dropdown.Content>
        </Dropdown.Root>
        <Button variant="link" size="icon" class="dashboard-tool dashboard-tool-remove !h-[30px] !w-[30px] !p-0 !text-zinc-400 hover:!text-red-300" aria-label={$_('dashboardLayout.removeCard', { values: { title: $_(definition.title) } })}
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
    headerClass={editing ? 'dashboard-card-head editable' : 'dashboard-card-head'} bodyInert={editing} fillHeight
    icon={children} data-testid={definition.id === 'kpi.requests' ? 'dashboard-kpi-total-requests' : undefined} />
{:else if definition.presentation === 'kpi'}
  <KpiCard label={$_(definition.title)} stripe={definition.stripe ?? 'orange'}
    class="dashboard-kpi-card h-full min-w-0 flex flex-col" leading={grip} icon-head={tools}
    headerClass={editing ? 'dashboard-card-head editable' : 'dashboard-card-head'} bodyInert={editing} fillHeight>
    {@render children()}
  </KpiCard>
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
  </div>
</article>

{/if}
<style>
  .dashboard-card-body { container-type: size; }
  :global(.dashboard-kpi-card) { container-type: inline-size; }
  :global(.dashboard-kpi-card .nx-panel-head.editable), .dashboard-card-head.editable { height: 42px; padding: 0 4px 0 8px; gap: 10px; cursor: grab; background: var(--nx-panel); }
  :global(.dashboard-kpi-card .nx-panel-head.editable:active), .dashboard-card-head.editable:active { cursor: grabbing; }
  @container (max-width: 190px) {
    :global(.dashboard-kpi-card .nx-panel-head.editable) { padding-inline: 8px; gap: 4px; }
    .dashboard-size { display: none; }
    .dashboard-grip { width: 18px; }
  }
  .dashboard-grip { cursor: grab; touch-action: none; outline-offset: -2px; }
  .dashboard-grip:active { cursor: grabbing; }
  .dashboard-size-glyph { display: inline-grid; grid-template-columns: repeat(30, 1px); gap: 1px; }
  .dashboard-size-glyph i { height: 8px; background: var(--nx-edge); }
  .dashboard-size-glyph i.filled { background: currentColor; }
  .is-off { border-style: dashed; box-shadow: none; background: repeating-linear-gradient(-45deg, var(--nx-panel) 0 10px, var(--nx-panel-2) 10px 20px); }
  :global(.dashboard-tool) { display: inline-grid; place-items: center; width: 30px; height: 30px; border: 1px solid transparent; color: var(--nx-text-dim); cursor: pointer; }
  :global(.dashboard-tool:hover), :global(.dashboard-tool:focus-visible), :global(.dashboard-tool[aria-expanded=true]) { border-color: var(--nx-edge-strong); background: var(--nx-panel-2); color: var(--nx-accent); outline: 2px solid transparent; }
  :global(.dashboard-tool[aria-expanded=true]) { border-color: var(--nx-accent); }
  :global(.dashboard-tool-remove:hover), :global(.dashboard-tool-remove:focus-visible) { border-color: rgb(239 68 68 / .5); background: rgb(239 68 68 / .1); color: var(--nx-danger) !important; }
</style>
