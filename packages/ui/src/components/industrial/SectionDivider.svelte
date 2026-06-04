<!--
  SectionDivider — Two thin rules with an uppercased label sandwiched in
  the middle. Use to separate logical regions of a long page.
-->
<script lang="ts">
  /** Label rendered between the rules (auto-uppercased visually). */
  export let label: string;

  /** Optional accent color of the leading dot. */
  export let accent: 'ok' | 'warn' | 'danger' | 'idle' | 'accent' = 'accent';

  const dotCls = {
    ok: 'nx-dot-ok',
    warn: 'nx-dot-warn',
    danger: 'nx-dot-danger',
    idle: 'nx-dot-idle',
    accent: 'nx-dot-accent',
  } as const;
</script>

<div class="flex items-center gap-3 min-h-6 w-full">
  <span class={dotCls[accent]} aria-hidden="true"></span>
  <h2 class="font-mono text-[11px] font-bold uppercase tracking-command text-zinc-200 shrink-0">// {label}</h2>
  <span class="h-px flex-1 bg-carbon-600"></span>
  {#if $$slots.actions}
    <div class="flex items-center gap-2 shrink-0">
      <slot name="actions" />
    </div>
  {/if}
</div>
