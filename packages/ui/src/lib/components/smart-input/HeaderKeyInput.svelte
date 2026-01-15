<script lang="ts">
  import { _ } from 'svelte-i18n';
  import SmartInput from './SmartInput.svelte';
  import { commonHttpHeaders } from './data/http-headers';

  export let value: string = '';
  export let size: 'xs' | 'sm' | 'md' | 'lg' = 'md';
  export let placeholder: string = 'Header-Name';
  export let disabled: boolean = false;
  export let required: boolean = false;

  const suggestions = commonHttpHeaders.map(h => ({
    value: h,
    label: h
  }));
</script>

<SmartInput
  bind:value
  {size}
  {placeholder}
  {disabled}
  {required}
  {suggestions}
  on:change
  on:validate
/>
