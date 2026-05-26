<!--
  NxSelect — Industrial dark-theme custom select dropdown.

  Replaces native <select> with a DaisyUI dropdown + styled option list,
  ensuring the popup layer matches the industrial dark theme (carbon-900 bg,
  carbon-500 border, nexus-500 active accent).

  Props:
    options: { value: string; label: string }[]  — available options
    value:   string                              — currently selected value (controlled, two-way)
    placeholder: string                          — text shown when value is empty
    ariaLabel: string                            — accessibility label
    width:  string                               — Tailwind width class for dropdown-content (default 'w-full')
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  type Option = { value: string; label: string };

  /** Available options. */
  export let options: Option[] = [];

  /** Currently selected value (controlled). */
  export let value: string = '';

  /** Placeholder text when no value selected. */
  export let placeholder: string = '';

  /** Accessible label. */
  export let ariaLabel: string = '';

  /** Dropdown content width class. */
  export let width: string = 'w-full';

  let extraClass = '';
  export { extraClass as class };

  const dispatch = createEventDispatcher<{ change: string }>();

  /** Get the label for the current value. */
  $: selectedLabel = options.find(o => o.value === value)?.label ?? placeholder;

  function select(opt: Option) {
    value = opt.value;
    dispatch('change', opt.value);
  }
</script>

<div class="dropdown {extraClass}">
  <div
    role="button"
    tabindex="0"
    aria-label={ariaLabel || undefined}
    class="nx-input flex items-center justify-between cursor-pointer pr-7"
  >
    <span class={value ? 'text-zinc-200' : 'text-zinc-600'}>
      {selectedLabel || placeholder}
    </span>
    <svg
      xmlns="http://www.w3.org/2000/svg"
      class="h-3 w-3 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M19 9l-7 7-7-7"
      />
    </svg>
  </div>
  <ul
    role="listbox"
    tabindex="0"
    class="dropdown-content border border-carbon-500 bg-carbon-900 shadow-industrial-lg {width} z-[1] p-1"
  >
    {#each options as opt}
      <li>
        <button
          type="button"
          role="option"
          aria-selected={value === opt.value}
          class={`block w-full text-left px-3 py-1.5 text-sm font-mono transition-colors ${value === opt.value ? 'bg-nexus-500/20 text-nexus-300' : 'text-zinc-300 hover:bg-carbon-700'}`}
          on:click={() => select(opt)}
        >
          {opt.label}
        </button>
      </li>
    {/each}
  </ul>
</div>
