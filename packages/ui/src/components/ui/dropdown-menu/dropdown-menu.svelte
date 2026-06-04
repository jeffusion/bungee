<script lang="ts">
  import { DropdownMenu as BitsDropdownMenu } from "bits-ui";
  import { cn } from "$utils";

  let {
    open = $bindable(false),
    trigger,
    children,
    align = "end",
    width = "w-40",
  }: {
    open?: boolean;
    trigger?: import("svelte").Snippet<[Record<string, unknown>]>;
    children?: import("svelte").Snippet;
    align?: "start" | "end" | "center";
    width?: string;
  } = $props();
</script>

<BitsDropdownMenu.Root open={open} onOpenChange={(v) => open = v}>
  {#if trigger}
    <BitsDropdownMenu.Trigger asChild let:builder>
      {@render trigger({ ...builder, builders: [builder] })}
    </BitsDropdownMenu.Trigger>
  {/if}
  <BitsDropdownMenu.Content
    class={cn(
      "z-[100] border border-carbon-500 bg-carbon-900 shadow-industrial-lg p-1",
      width
    )}
    sideOffset={4}
    {align}
  >
    {@render children?.()}
  </BitsDropdownMenu.Content>
</BitsDropdownMenu.Root>
