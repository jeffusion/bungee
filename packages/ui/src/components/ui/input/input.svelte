<script lang="ts">
  import type { HTMLInputAttributes, HTMLInputTypeAttribute } from "svelte/elements";
  import { cn, type WithElementRef } from "$utils";

  type InputType = Exclude<HTMLInputTypeAttribute, "file">;

  type Props = WithElementRef<
    Omit<HTMLInputAttributes, "type"> &
      ({ type: "file"; files?: FileList } | { type?: InputType; files?: undefined }),
    HTMLInputElement
  >;

  let {
    ref = $bindable(null),
    value = $bindable(),
    type,
    files = $bindable(),
    class: className,
    "data-slot": dataSlot = "input",
    ...restProps
  }: Props = $props();

  const inputClasses = $derived(cn(
    "flex h-9 w-full min-w-0 border border-carbon-500 bg-carbon-900 px-3 py-1 text-sm font-mono text-zinc-100 shadow-industrial-sm transition-[color,box-shadow,border-color] outline-none placeholder:text-zinc-600 selection:bg-nexus-500/30 selection:text-zinc-50 hover:border-carbon-400 focus-visible:border-nexus-500 focus-visible:ring-1 focus-visible:ring-nexus-500/60 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-red-500 aria-invalid:ring-red-500/30",
    type === "file" && "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:font-mono file:text-xs file:font-semibold file:text-zinc-300",
    className
  ));
</script>

{#if type === "file"}
  <input
    bind:this={ref}
    bind:files
    bind:value
    type="file"
    data-slot={dataSlot}
    class={inputClasses}
    {...restProps}
  />
{:else}
  <input
    bind:this={ref}
    bind:value
    {type}
    data-slot={dataSlot}
    class={inputClasses}
    {...restProps}
  />
{/if}
