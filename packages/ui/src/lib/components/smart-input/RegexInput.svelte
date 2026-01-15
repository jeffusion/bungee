<script lang="ts">
  import { _ } from 'svelte-i18n';
  import SmartInput from './SmartInput.svelte';

  export let value: string = '';
  export let size: 'xs' | 'sm' | 'md' | 'lg' = 'md';
  export let placeholder: string = '^pattern$';
  export let disabled: boolean = false;
  export let required: boolean = false;

  function validateRegex(val: string): string | null {
    if (!val && !required) return null;
    if (!val && required) return $_('validation.fieldRequired') || 'Required';

    try {
      new RegExp(val);
      return null;
    } catch (e: any) {
      return e.message || 'Invalid Regular Expression';
    }
  }
</script>

<SmartInput
  bind:value
  {size}
  {placeholder}
  {disabled}
  {required}
  validate={validateRegex}
  on:change
  on:validate
/>
