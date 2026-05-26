<!--
  NxSelect — Industrial dark-theme custom select dropdown.

  Built on Bits UI Select (headless) for robust open/close handling,
  focus management, keyboard navigation, and ARIA — without the
  nested-DaisyUI-dropdown focus conflict that plagues CSS-only
  dropdown-content approaches.

  Props:
    options: { value: string; label: string }[]  — available options
    value:   string                              — currently selected value (controlled, two-way)
    placeholder: string                          — text shown when value is empty
    ariaLabel: string                            — accessibility label
    width:  string                               — Tailwind width class for dropdown content (default 'w-full')
    disabled: boolean                            — disable the select
-->
<script lang="ts">
  import { Select } from 'bits-ui';
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

  /** Disabled state. */
  export let disabled: boolean = false;

  let extraClass = '';
  export { extraClass as class };

  const dispatch = createEventDispatcher<{ change: string }>();

  /** Derived: the currently selected option object (for Bits UI `selected` prop). */
  $: selectedItem = options.find(o => o.value === value)
    ? { value, label: options.find(o => o.value === value)!.label }
    : undefined;

  /** Derived: the display label for the trigger. */
  $: selectedLabel = selectedItem?.label ?? placeholder;

  function handleSelectedChange(next: { value: string; label?: string } | undefined) {
    if (next && next.value !== value) {
      value = next.value;
      dispatch('change', next.value);
    } else if (!next && value !== '') {
      value = '';
      dispatch('change', '');
    }
  }
</script>

<Select.Root
  items={options}
  selected={selectedItem}
  onSelectedChange={handleSelectedChange}
  {disabled}
>
  <Select.Trigger
    aria-label={ariaLabel || undefined}
    class="nx-input flex items-center justify-between cursor-pointer {extraClass}"
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
  </Select.Trigger>
  <Select.Content
    class="z-[100] border border-carbon-500 bg-carbon-900 shadow-industrial-lg {width} p-1 max-h-60 overflow-y-auto"
    sideOffset={4}
  >
    {#each options as opt (opt.value)}
      <Select.Item
        value={opt.value}
        label={opt.label}
        class="flex w-full items-center px-3 py-1.5 text-sm font-mono text-zinc-300 outline-none cursor-pointer transition-colors data-[highlighted]:bg-carbon-700 data-[selected]:bg-nexus-500/20 data-[selected]:text-nexus-300 data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed"
      >
        {opt.label}
      </Select.Item>
    {/each}
  </Select.Content>
</Select.Root>
