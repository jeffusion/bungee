<script lang="ts">
  import { DropdownMenu, DropdownMenuItem } from "../ui/dropdown-menu";
  import { cn } from "$utils";

  type MenuItem = { label: string; value: string; disabled?: boolean };

  let {
    items = [],
    width = "w-40",
    align = "end",
    class: className = "",
    onselect,
    trigger,
    children,
  }: {
    items?: MenuItem[];
    width?: string;
    align?: "start" | "end" | "center";
    class?: string;
    onselect?: (value: string) => void;
    trigger?: import("svelte").Snippet<[Record<string, unknown>]>;
    children?: import("svelte").Snippet;
  } = $props();

  let open = $state(false);

  function handleSelect(val: string) {
    open = false;
    if (onselect) onselect(val);
  }
</script>

<DropdownMenu bind:open {trigger} {align} {width}>
  {#if items.length > 0}
    {#each items as item (item.value)}
      <DropdownMenuItem
        disabled={item.disabled}
        onclick={() => handleSelect(item.value)}
      >
        {item.label}
      </DropdownMenuItem>
    {/each}
  {:else if children}
    {@render children()}
  {/if}
</DropdownMenu>
