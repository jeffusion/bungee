<!--
  IndustrialToggle — Flat hard-edged ON/OFF switch.

  Visual: carbon track with embedded "OFF" / "ON" mono-text labels. When
  checked, the track turns orange and the knob slides right; the OFF
  label fades out while ON fades in. Designed to be unambiguous on the
  dark carbon background where a round switch becomes a
  shadowy lump.

  Props:
    checked: boolean (two-way bound)
    disabled: boolean
    title: string (a11y / tooltip)
    name: string (form name, optional)
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let checked: boolean = false;
  export let disabled: boolean = false;
  export let title: string = '';
  export let name: string = '';

  let extraClass = '';
  export { extraClass as class };

  const dispatch = createEventDispatcher<{ change: boolean }>();

  function handleChange(event: Event) {
    if (disabled) return;
    const target = event.currentTarget as HTMLInputElement;
    checked = target.checked;
    dispatch('change', checked);
  }
</script>

<label class="nx-toggle {extraClass}" title={title} aria-label={title || undefined}>
  <input
    type="checkbox"
    {name}
    {disabled}
    {checked}
    on:change={handleChange}
  />
  <span class="nx-toggle-track">
    <span class="nx-toggle-knob"></span>
  </span>
</label>
