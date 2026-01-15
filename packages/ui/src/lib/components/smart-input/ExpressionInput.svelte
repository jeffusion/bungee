<script lang="ts">
  import { _ } from 'svelte-i18n';
  import SmartInput from './SmartInput.svelte';
  import { expressionVars } from './data/expression-vars';

  export let value: string = '';
  export let size: 'xs' | 'sm' | 'md' | 'lg' = 'md';
  export let placeholder: string = '{{ headers.Authorization }}';
  export let disabled: boolean = false;
  export let required: boolean = false;
  export let label: string = '';

  let suggestions: Array<{ value: string; label?: string; description?: string }> = [];

  $: {
    // Generate suggestions based on cursor context if possible, or just raw match
    // For simple implementation, we check if user is typing an expression
    if (value.includes('{{')) {
      const parts = value.split('{{');
      const lastPart = parts[parts.length - 1];
      const cleanLastPart = lastPart.trim().replace('}}', '');
      
      // If user typed '{{ hea', we suggest 'headers'
      // If user typed '{{ headers.', we might want to suggest sub-properties if we had them
      
      suggestions = expressionVars.map(v => ({
        value: `{{ ${v.value} }}`, // Suggest full expression wrapper
        label: v.label,
        description: v.description
      }));
    } else {
      suggestions = [];
    }
  }

  function validateExpression(val: string): string | null {
    if (!val && !required) return null;
    if (!val && required) return $_('validation.fieldRequired') || 'Required';

    // Check for unbalanced braces
    const openCount = (val.match(/\{\{/g) || []).length;
    const closeCount = (val.match(/\}\}/g) || []).length;

    if (openCount !== closeCount) {
      return $_('validation.unbalancedBraces') || 'Unbalanced expression braces';
    }

    // Check for empty expressions {{ }}
    if (/\{\{\s*\}\}/.test(val)) {
        return $_('validation.expressionEmpty') || 'Empty expression';
    }

    // Check for unfinished property access like {{ headers. }}
    if (/\{\{[^}]*\.\s*\}\}/.test(val)) {
        return $_('validation.incompleteProperty') || 'Incomplete property access';
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
  {suggestions}
  {label}
  validate={validateExpression}
  on:change
  on:validate
/>
