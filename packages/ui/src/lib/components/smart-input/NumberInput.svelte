<script lang="ts">
  import { _ } from 'svelte-i18n';
  import SmartInput from './SmartInput.svelte';

  export let value: number | string = ''; // Allow string for binding flexibility, but validate as number
  export let min: number | undefined = undefined;
  export let max: number | undefined = undefined;
  export let step: number = 1;
  export let suffix: string = '';
  export let size: 'xs' | 'sm' | 'md' | 'lg' = 'md';
  export let placeholder: string = '';
  export let disabled: boolean = false;
  export let required: boolean = false;
  export let label: string = '';

  $: if (value !== '' && value !== null && value !== undefined) {
    const numVal = Number(value);
    if (!isNaN(numVal) && value !== numVal) {
      value = numVal;
    }
  }

  function validateNumber(val: any): string | null {
    if ((val === '' || val === null || val === undefined) && !required) return null;
    if ((val === '' || val === null || val === undefined) && required) return $_('validation.fieldRequired') || 'Required';

    const num = Number(val);
    if (isNaN(num)) {
      return $_('validation.invalidNumber') || 'Invalid number';
    }

    if (min !== undefined && num < min) {
      return `${$_('validation.minValue') || 'Min value'}: ${min}`;
    }

    if (max !== undefined && num > max) {
      return `${$_('validation.maxValue') || 'Max value'}: ${max}`;
    }

    return null;
  }
</script>

<div class="relative w-full">
  <SmartInput
    bind:value
    type="number"
    {size}
    {placeholder}
    {disabled}
    {required}
    {min}
    {max}
    {step}
    {label}
    validate={validateNumber}
    on:change
    on:validate
    inputClass={suffix ? 'pr-12' : ''}
  />
  {#if suffix}
    <div class="absolute right-3 top-0 h-full flex items-center pointer-events-none text-base-content/50 text-sm">
        <!-- Adjust top position based on if there's a label or not in SmartInput, 
             but SmartInput handles label internally. 
             Ideally SmartInput should support slot or suffix prop. 
             Since I can't easily slot into the input container of SmartInput without modifying it widely,
             I'll just trust CSS positioning here or modify SmartInput slightly if needed.
             Wait, the SmartInput error message might push this off.
             Better to let SmartInput handle suffix if we wanted it perfect, but strict adherence to "SmartInput - 基础组件" specs 
             didn't explicitly ask for suffix support in SmartInput itself, only NumberInput.
             However, positioning absolute over SmartInput component is risky if height changes.
             For now, this is a reasonable approximation for standard inputs.
        -->
        <span class="mt-0">{suffix}</span> 
    </div>
  {/if}
</div>
