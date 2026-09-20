<script lang="ts">
  import { Button } from '$components/ui/button';

  // Industrial ON/OFF key: visible state and a full-size keyboard/touch target.
  let { id, checked = $bindable(false), disabled = false, label, onchange }:
    { id?: string; checked?: boolean; disabled?: boolean; label: string; onchange?: (checked: boolean) => void } = $props();
</script>

<Button {id} variant="ghost" role="switch" aria-checked={checked} aria-label={label} {disabled}
  class="group h-[44px] w-[72px] shrink-0 border-0 p-2 sm:h-[40px]"
  onclick={() => { checked = !checked; onchange?.(checked); }}>
  <span aria-hidden="true" class="relative flex h-[24px] w-[56px] items-center border transition-colors duration-150 {checked ? 'border-nexus-500 bg-nexus-500 text-carbon-950' : 'border-carbon-500 bg-carbon-950 text-zinc-300'}">
    <span class="w-full font-mono text-[10px] leading-none {checked ? 'pr-[22px]' : 'pl-[22px]'}">{checked ? 'ON' : 'OFF'}</span>
    <span class="absolute left-[2px] top-[2px] h-[18px] w-[18px] transition-transform duration-150 {checked ? 'translate-x-[30px] bg-carbon-950' : 'bg-carbon-500'}"></span>
  </span>
</Button>
