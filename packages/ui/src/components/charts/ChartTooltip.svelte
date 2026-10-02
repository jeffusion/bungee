<script lang="ts">
  import type { VirtualElement } from '@floating-ui/dom';
  import type { Chart, TooltipModel } from 'chart.js';
  import { SharedContent } from '$components/ui/tooltip';

  let { unit = '' }: { unit?: string } = $props();
  const id = $props.id();
  let anchor = $state<VirtualElement | null>(null);
  let title = $state('');
  let rows = $state<Array<{ label: string; value: string; color: string }>>([]);

  export function update({ chart, tooltip }: { chart: Chart; tooltip: TooltipModel<'line'> }) {
    const first = tooltip.dataPoints?.[0];
    if (!tooltip.opacity || !first) { close(); return; }
    const point = { x: tooltip.caretX, y: tooltip.caretY };
    title = tooltip.title.join(' · ');
    rows = tooltip.dataPoints.map((item, index) => ({
      label: item.dataset.label ?? '',
      value: item.formattedValue,
      color: String(tooltip.labelColors[index]?.borderColor ?? '#f97316'),
    }));
    // Anchor to a canvas point; the shared tooltip handles viewport edges and motion.
    anchor = {
      contextElement: chart.canvas,
      getBoundingClientRect: () => {
        const bounds = chart.canvas.getBoundingClientRect();
        return new DOMRect(bounds.left + point.x * bounds.width / chart.width,
          bounds.top + point.y * bounds.height / chart.height, 0, 0);
      },
    };
  }

  function close() { anchor = null; }
</script>

<SharedContent {anchor} open={anchor !== null} {id} onclose={close} interactive={false}
  class="min-w-48 font-mono text-[11px]" data-testid="line-chart-tooltip">
  <div class="border-b border-carbon-600 pb-2 text-zinc-400">{title}</div>
  <div class="mt-2 space-y-1.5">
    {#each rows as row}
      <div class="flex items-baseline justify-between gap-4">
        <span class="flex min-w-0 items-center gap-1.5">
          <span class="h-2 w-2 shrink-0" style:background={row.color} aria-hidden="true"></span>
          <span>{row.label}</span>
        </span>
        <strong class="shrink-0 font-display text-sm text-zinc-50">{row.value}{unit ? ` ${unit}` : ''}</strong>
      </div>
    {/each}
  </div>
</SharedContent>
