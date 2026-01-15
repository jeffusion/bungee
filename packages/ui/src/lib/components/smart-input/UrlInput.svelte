<script lang="ts">
  import { _ } from 'svelte-i18n';
  import SmartInput from './SmartInput.svelte';

  export let value: string = '';
  export let size: 'xs' | 'sm' | 'md' | 'lg' = 'md';
  export let placeholder: string = 'https://example.com';
  export let disabled: boolean = false;
  export let required: boolean = false;
  export let label: string = '';

  function validateUrl(val: string): string | null {
    if (!val && !required) return null;
    if (!val && required) return $_('validation.fieldRequired') || 'Required';
    
    try {
      // Basic check to see if it looks like a URL at all before strict parsing
      // If it doesn't start with http/https, we might auto-fix it on blur, but for validation we want to be helpful
      let urlToCheck = val;
      if (!val.match(/^https?:\/\//)) {
        urlToCheck = 'https://' + val;
      }
      new URL(urlToCheck);
      return null;
    } catch (e) {
      return $_('validation.invalidUrl') || 'Invalid URL';
    }
  }

  function handleBlur() {
    if (value && !value.match(/^https?:\/\//)) {
      // Auto-complete protocol
      value = 'https://' + value;
    }
  }
</script>

<SmartInput
  bind:value
  {size}
  {placeholder}
  {disabled}
  {required}
  {label}
  validate={validateUrl}
  on:blur={handleBlur}
  on:change
  on:validate
/>
