<script lang="ts">
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { cn } from "$utils";

  type MenuItem = { label: string; value: string; disabled?: boolean };

  let {
    items = [],
    width = "w-40",
    align = "end",
    class: className = "",
    triggerClass = "nx-btn-ghost nx-btn-md",
    onselect,
    trigger,
    children,
  }: {
    items?: MenuItem[];
    width?: string;
    align?: "start" | "end" | "center";
    class?: string;
    triggerClass?: string;
    onselect?: (value: string) => void;
    trigger?: import("svelte").Snippet;
    children?: import("svelte").Snippet;
  } = $props();

  let open = $state(false);

  function handleSelect(val: string) {
    open = false;
    if (onselect) onselect(val);
  }
</script>

<!--
  The Bits UI DropdownMenu.Trigger renders the root <button> for us;
  snippet consumers must NOT wrap the trigger content in a <button> or
  <div>. Instead, render svg + text children directly inside the trigger
  button. Use `triggerClass` to style the button shell (e.g. nx-btn-*).
-->
<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger class={triggerClass}>
    {#if trigger}
      {@render trigger()}
    {/if}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content class={cn(width, "p-1", className)} align={align}>
    {#if items.length > 0}
      {#each items as item (item.value)}
        <DropdownMenu.Item
          disabled={item.disabled}
          onclick={() => handleSelect(item.value)}
        >
          {item.label}
        </DropdownMenu.Item>
      {/each}
    {:else if children}
      {@render children()}
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
