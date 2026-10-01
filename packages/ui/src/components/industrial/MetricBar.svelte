<!--
  MetricBar — Compact horizontal allocation bar with leading label and
  trailing value. Used for things like load, utilisation, capacity.
  Colour automatically shifts (emerald → amber → red) when the value
  crosses warn/danger thresholds; pass an explicit `tone` to override.
-->
<script lang="ts">
  type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'neutral';
  let { label = 'LOAD', value = 0, max = 100, valueLabel = '', tone = 'auto', warnAt = 70,
    dangerAt = 90, headless = false, class: extraClass = '', segments = [] }:
    { label?: string; value?: number; max?: number; valueLabel?: string; tone?: 'auto' | Tone;
      warnAt?: number; dangerAt?: number; headless?: boolean; class?: string;
      segments?: { value: number; tone: Tone; label: string }[] } = $props();
  const percent = $derived(max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0);
  const text = $derived(valueLabel || `${percent.toFixed(0)}%`);
  const resolvedTone = $derived(tone !== 'auto' ? tone : percent >= dangerAt ? 'danger' : percent >= warnAt ? 'warn' : 'ok');
  const portions = $derived.by(() => {
    let used = 0;
    return segments.map(segment => {
      const width = max > 0 ? Math.max(0, Math.min(100 - used, segment.value / max * 100)) : 0;
      const portion = { ...segment, left: used, width }; used += width; return portion;
    });
  });

  const fillCls = {
    ok: 'metric-bar-fill-ok',
    warn: 'metric-bar-fill-warn',
    danger: 'metric-bar-fill-danger',
    accent: 'metric-bar-fill-accent',
    neutral: 'metric-bar-fill-neutral',
  } as const;

  const textCls = {
    ok: 'text-zinc-300',
    warn: 'text-amber-300',
    danger: 'text-red-300',
    accent: 'text-nexus-300',
    neutral: 'text-zinc-400',
  } as const;
</script>

<div class="metric-bar {extraClass}">
  {#if !headless}
  <div class="metric-bar-head">
    <span class="metric-bar-label" title={label}>{label}</span>
    <span class="metric-bar-value {textCls[resolvedTone]}">{text}</span>
  </div>
  {/if}
  <div class="metric-bar-track" role="meter" aria-label={label} aria-valuemin="0" aria-valuemax={max} aria-valuenow={Math.max(0, Math.min(max, value))} aria-valuetext={text}>
    {#if portions.length}
      {#each portions as segment}
        <div class="metric-bar-fill {fillCls[segment.tone]}" style:left="{segment.left}%" style:width="{segment.width}%" title="{segment.label}: {segment.value}"></div>
      {/each}
    {:else}<div class="metric-bar-fill {fillCls[resolvedTone]}" style:width="{percent}%"></div>{/if}
  </div>
</div>

<style>
  .metric-bar {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .metric-bar-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .metric-bar-label {
    font-family: 'DM Mono', monospace;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--nx-text-dim);
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .metric-bar-value {
    flex: none;
    font-family: 'DM Mono', monospace;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-variant-numeric: tabular-nums;
  }

  .metric-bar-track {
    position: relative;
    height: 8px;
    overflow: hidden;
    border: 1px solid var(--nx-edge-strong);
    background:
      var(--nx-bg),
      repeating-linear-gradient(135deg, rgb(55 61 74 / 0.15) 0 6px, transparent 6px 12px);
  }

  .metric-bar-fill {
    position: absolute;
    inset-block: 0;
    left: 0;
    width: 0;
    min-width: 0;
    background-size: 12px 12px, 100% 100%;
  }

  .metric-bar-fill-ok {
    background: var(--nx-text);
  }

  .metric-bar-fill-warn {
    background-image:
      repeating-linear-gradient(45deg, rgb(0 0 0 / 0.1) 0 4px, transparent 4px 8px),
      linear-gradient(90deg, var(--nx-warn), var(--nx-warn));
  }

  .metric-bar-fill-danger {
    background-image:
      repeating-linear-gradient(45deg, rgb(0 0 0 / 0.12) 0 4px, transparent 4px 8px),
      linear-gradient(90deg, var(--nx-danger), var(--nx-danger));
  }

  .metric-bar-fill-accent {
    background: var(--nx-accent);
  }

  .metric-bar-fill-neutral {
    background: var(--nx-text-mute);
  }
</style>
