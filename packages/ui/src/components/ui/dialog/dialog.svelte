<script lang="ts">
  import { Dialog as BitsDialog } from "bits-ui";
  import { cn } from "$utils";

  let {
    open = $bindable(false),
    title = "",
    description = "",
    children,
    trigger,
  }: {
    open?: boolean;
    title?: string;
    description?: string;
    children?: import("svelte").Snippet;
    trigger?: import("svelte").Snippet<[Record<string, unknown>]>;
  } = $props();
</script>

<BitsDialog.Root bind:open>
  {#if trigger}
    <BitsDialog.Trigger asChild>
      {#snippet child({ props })}
        {@render trigger(props)}
      {/snippet}
    </BitsDialog.Trigger>
  {/if}
  <BitsDialog.Portal>
    <BitsDialog.Overlay class="fixed inset-0 z-[150] bg-black/80" />
    <BitsDialog.Content class="fixed left-[50%] top-[50%] z-[200] w-full max-w-md translate-x-[-50%] translate-y-[-50%] border border-carbon-500 bg-carbon-900 p-6 shadow-industrial-lg outline-none">
      {#if title}
        <BitsDialog.Title class="font-mono text-sm font-bold uppercase tracking-command text-zinc-100 mb-2">
          {title}
        </BitsDialog.Title>
      {/if}
      {#if description}
        <BitsDialog.Description class="text-xs text-zinc-400 mb-4">
          {description}
        </BitsDialog.Description>
      {/if}
      {@render children?.()}
    </BitsDialog.Content>
  </BitsDialog.Portal>
</BitsDialog.Root>
