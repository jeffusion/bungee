<script lang="ts">
  import { NumberInput } from '$components/ui/number-input';
  let value = $state<number | undefined>(15);
  let readonly = $state(false);
  let disabled = $state(false);
  let submits = $state(0);
</script>

<form onsubmit={(event) => { event.preventDefault(); submits++; }}>
  <label for="fixture-number">Seconds</label>
  <NumberInput id="fixture-number" data-testid="number" bind:value min={5} max={120} {readonly} {disabled} required
    increaseLabel="Increase seconds" decreaseLabel="Decrease seconds" invalidMessage="Enter 5–120 whole seconds" />
  <button type="submit">Save</button>
</form>
<output data-testid="bound-value">{value === undefined ? 'empty' : value}</output>
<output data-testid="submits">{submits}</output>
<button type="button" onclick={() => { readonly = !readonly; }}>Toggle readonly</button>
<button type="button" onclick={() => { disabled = !disabled; }}>Toggle disabled</button>
<button type="button" onclick={() => { value = 20; }}>Set external value</button>
<button type="button" onclick={() => { value = undefined; }}>Clear external value</button>
