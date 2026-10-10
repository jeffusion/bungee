<script>
    import { createEventDispatcher } from 'svelte';
    export let options; export let value; export let ariaLabel;
    const dispatch = createEventDispatcher();
    </script>
    {#each options as option}
      <button data-tab={option.value} on:click={() => dispatch('change', option.value)}>{option.label}</button>
    {/each}