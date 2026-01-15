<script lang="ts">
  import { _ } from 'svelte-i18n';
  import SmartInput from './SmartInput.svelte';

  export let value: string = '';
  export let options: Array<{ value: string; label?: string; description?: string }> = [];
  export let allowCustom: boolean = false;
  export let size: 'xs' | 'sm' | 'md' | 'lg' = 'md';
  export let placeholder: string = '';
  export let disabled: boolean = false;
  export let required: boolean = false;

  function validateCombo(val: any): string | null {
    if (!val && !required) return null;
    if (!val && required) return $_('validation.fieldRequired') || 'Required';

    if (!allowCustom) {
        const exists = options.some(o => o.value === val);
        if (!exists) {
            return $_('validation.invalidOption') || 'Invalid option';
        }
    }
    return null;
  }
</script>

<SmartInput
  bind:value
  {size}
  {placeholder}
  {disabled}
  {required}
  suggestions={options}
  validate={validateCombo}
  on:change
  on:validate
  on:select
/>
