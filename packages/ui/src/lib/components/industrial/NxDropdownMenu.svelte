<!--
  NxDropdownMenu — Industrial dark-theme dropdown menu.

  Built on Bits UI DropdownMenu (headless) for robust open/close handling,
  focus management, keyboard navigation, and ARIA — without the
  nested-DaisyUI-dropdown focus conflict.

  Usage:
    <NxDropdownMenu let:close>
      <svelte:fragment slot="trigger">
        <button class="nx-btn-ghost nx-btn-md">Menu</button>
      </svelte:fragment>
      <NxDropdownMenu.Item on:click={() => doSomething()}>Action</NxDropdownMenu.Item>
      <NxDropdownMenu.Item on:click={() => doOther()}>Other</NxDropdownMenu.Item>
    </NxDropdownMenu>

  Or for simple items:
    <NxDropdownMenu items={[{label:'JSON', value:'json'}, {label:'CSV', value:'csv'}]}
                     on:select={(e) => handle(e.detail)} let:close>
      <svelte:fragment slot="trigger">
        <button class="nx-btn-ghost nx-btn-md">Export</button>
      </svelte:fragment>
    </NxDropdownMenu>
-->
<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  import { createEventDispatcher } from 'svelte';

  type MenuItem = { label: string; value: string; disabled?: boolean };

  /** Simple items list (alternative to slot-based usage). */
  export let items: MenuItem[] = [];

  /** Dropdown content width class. */
  export let width: string = 'w-40';

  /** Align dropdown to end of trigger. */
  export let alignEnd: boolean = true;

  let extraClass = '';
  export { extraClass as class };

  const dispatch = createEventDispatcher<{ select: string }>();

  function handleSelect(item: MenuItem) {
    dispatch('select', item.value);
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger class={extraClass}>
    <slot name="trigger" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Content
    class="z-[100] border border-carbon-500 bg-carbon-900 shadow-industrial-lg {width} p-1"
    sideOffset={4}
    align={alignEnd ? 'end' : 'start'}
  >
    {#if items.length > 0}
      {#each items as item (item.value)}
        <DropdownMenu.Item
          disabled={item.disabled}
          class="flex w-full items-center px-3 py-1.5 text-sm font-mono text-zinc-300 outline-none cursor-pointer transition-colors data-[highlighted]:bg-carbon-700 data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed"
          on:click={() => handleSelect(item)}
        >
          {item.label}
        </DropdownMenu.Item>
      {/each}
    {:else}
      <slot />
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
