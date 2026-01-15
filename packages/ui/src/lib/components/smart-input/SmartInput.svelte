<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { debounce } from 'lodash-es';
  import { _ } from 'svelte-i18n';
  import { v4 as uuidv4 } from 'uuid';

  export let value: string | number = '';
  export let size: 'xs' | 'sm' | 'md' | 'lg' = 'md';
  export let type: string = 'text';
  export let placeholder: string = '';
  export let disabled: boolean = false;
  export let required: boolean = false;
  export let readonly: boolean = false;
  export let label: string = '';
  export let validate: ((value: any) => string | null) | undefined = undefined;
  export let suggestions: Array<{ value: string; label?: string; description?: string }> = [];
  export let showSuggestions: boolean = false;
  export let inputClass: string = '';
  export let id: string = uuidv4();

  const dispatch = createEventDispatcher();
  
  let error: string | null = null;
  let focused: boolean = false;
  let inputElement: HTMLInputElement;
  let activeSuggestionIndex: number = -1;
  let filteredSuggestions: Array<{ value: string; label?: string; description?: string }> = [];

  // Debounced validation
  const debouncedValidate = debounce((val: any) => {
    if (validate) {
      error = validate(val);
      dispatch('validate', error ? [error] : []);
    }
  }, 300);

  $: if (suggestions) {
    updateFilteredSuggestions(value);
  }

  $: {
    debouncedValidate(value);
  }

  function updateFilteredSuggestions(val: string | number) {
    if (!suggestions || suggestions.length === 0) {
      filteredSuggestions = [];
      return;
    }
    
    const strVal = String(val).toLowerCase();
    filteredSuggestions = suggestions.filter(s => 
      String(s.value).toLowerCase().includes(strVal) || 
      (s.label && s.label.toLowerCase().includes(strVal))
    ).slice(0, 10); // Limit to 10 suggestions
  }

  function handleInput(event: Event) {
    const target = event.target as HTMLInputElement;
    value = target.value;
    updateFilteredSuggestions(value);
    showSuggestions = true;
    activeSuggestionIndex = -1;
    dispatch('change', value);
  }

  function handleFocus() {
    focused = true;
    showSuggestions = true;
    updateFilteredSuggestions(value);
    dispatch('focus');
  }

  function handleBlur() {
    // Delay hiding suggestions to allow clicking on them
    setTimeout(() => {
      focused = false;
      showSuggestions = false;
      // Immediate validation on blur
      if (validate) {
        error = validate(value);
        dispatch('validate', error ? [error] : []);
      }
      dispatch('blur');
    }, 200);
  }

  function selectSuggestion(suggestion: { value: string; label?: string }) {
    value = suggestion.value;
    showSuggestions = false;
    error = null; // Clear error on valid selection
    dispatch('change', value);
    dispatch('select', suggestion);
    if (validate) {
      error = validate(value); // Re-validate
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!showSuggestions || filteredSuggestions.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeSuggestionIndex = (activeSuggestionIndex + 1) % filteredSuggestions.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeSuggestionIndex = (activeSuggestionIndex - 1 + filteredSuggestions.length) % filteredSuggestions.length;
    } else if (event.key === 'Enter') {
      if (activeSuggestionIndex >= 0 && activeSuggestionIndex < filteredSuggestions.length) {
        event.preventDefault();
        selectSuggestion(filteredSuggestions[activeSuggestionIndex]);
      }
    } else if (event.key === 'Escape') {
      showSuggestions = false;
    }
  }

  // Ensure scroll into view for active suggestion
  $: if (activeSuggestionIndex >= 0 && typeof document !== 'undefined') {
    const activeEl = document.getElementById(`suggestion-${activeSuggestionIndex}`);
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }
</script>

<div class="form-control w-full relative">
  {#if label}
    <label class="label" for={id}>
      <span class="label-text">{label}</span>
    </label>
  {/if}
  
  <div class="relative w-full">
    <input
      {id}
      bind:this={inputElement}
      {type}
      {value}
      {placeholder}
      {disabled}
      {required}
      {readonly}
      on:input={handleInput}
      on:focus={handleFocus}
      on:blur={handleBlur}
      on:keydown={handleKeydown}
      {...$$restProps}
      class="input input-bordered w-full {inputClass} 
        {size === 'xs' ? 'input-xs' : ''} 
        {size === 'sm' ? 'input-sm' : ''} 
        {size === 'md' ? 'input-md' : ''} 
        {size === 'lg' ? 'input-lg' : ''}
        {error ? 'input-error' : ''}"
      autocomplete="off"
    />

    {#if showSuggestions && filteredSuggestions.length > 0}
      <ul 
        class="dropdown-content menu p-2 shadow bg-base-100 rounded-box w-full absolute z-50 mt-1 max-h-60 overflow-y-auto"
        transition:fly={{ y: -5, duration: 150 }}
      >
        {#each filteredSuggestions as suggestion, index}
          <li>
            <button 
              type="button"
              id="suggestion-{index}"
              class:active={index === activeSuggestionIndex}
              on:click={() => selectSuggestion(suggestion)}
            >
              <div class="flex flex-col items-start">
                <span class="font-medium">{suggestion.label || suggestion.value}</span>
                {#if suggestion.description}
                  <span class="text-xs opacity-70">{suggestion.description}</span>
                {/if}
              </div>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if error}
    <div class="label" transition:fade>
      <span class="label-text-alt text-error">{error}</span>
    </div>
  {/if}
</div>
